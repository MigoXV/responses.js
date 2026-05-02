import Ajv2020 from "ajv/dist/2020.js";
import type { ErrorObject } from "ajv";
import type { ChatCompletionCreateParamsStreaming } from "openai/resources/chat/completions.js";
import type { PatchedDeltaWithReasoning, PatchedResponseStreamEvent } from "../openai_patch.js";
import { createOpenAIClient } from "./openaiClient.js";
import type { IncompleteResponse, JsonSchemaTextFormat, TextFormat } from "./types.js";
import { StructuredOutputValidationError } from "./types.js";
import { emitOutputTextMessageStream } from "./streaming.js";

const DEEPSEEK_STRUCTURED_OUTPUT_MAX_RETRIES = 2;

export const isDeepseekModel = (model: string): boolean => model.toLowerCase().includes("deepseek");

export function getDeepseekJsonSchemaFormat(
	model: string,
	format: TextFormat | undefined
): JsonSchemaTextFormat | undefined {
	return isDeepseekModel(model) && format?.type === "json_schema" ? format : undefined;
}

export function mapTextFormatToChatResponseFormat(
	format: TextFormat | undefined,
	options: { deepseekCompatible: boolean }
): ChatCompletionCreateParamsStreaming["response_format"] {
	if (!format) {
		return undefined;
	}

	if (options.deepseekCompatible && (format.type === "json_object" || format.type === "json_schema")) {
		return { type: "json_object" };
	}

	if (format.type === "json_schema") {
		return {
			type: "json_schema",
			json_schema: {
				description: format.description,
				name: format.name,
				schema: format.schema,
				strict: false, // format.strict,
			},
		};
	}

	return { type: format.type };
}

export function buildDeepseekSystemInstruction(format: JsonSchemaTextFormat): string {
	const schemaLines = JSON.stringify(format.schema, null, 2);
	const description = format.description ? `\nDescription: ${format.description}` : "";
	return [
		"You must respond with a single JSON object that validates against the JSON Schema below.",
		"Return only raw JSON. Do not include markdown, code fences, comments, explanations, or any natural language outside the JSON value.",
		`Schema name: ${format.name}${description}`,
		`Strict requested by client: ${format.strict}`,
		"JSON Schema:",
		schemaLines,
	].join("\n");
}

export async function* runDeepseekJsonSchemaFallbackStream(
	apiKey: string | undefined,
	payload: ChatCompletionCreateParamsStreaming,
	responseObject: IncompleteResponse,
	defaultHeaders: Record<string, string>,
	format: JsonSchemaTextFormat
): AsyncGenerator<PatchedResponseStreamEvent> {
	let lastError = "Structured output validation failed.";

	for (let attempt = 0; attempt <= DEEPSEEK_STRUCTURED_OUTPUT_MAX_RETRIES; attempt++) {
		const text = await collectChatCompletionText(apiKey, payload, responseObject, defaultHeaders);
		const validation = validateStructuredOutput(text, format);
		if (validation.ok) {
			for await (const event of emitOutputTextMessageStream(responseObject, validation.text)) {
				yield event;
			}
			return;
		}

		lastError = validation.error;
		if (attempt < DEEPSEEK_STRUCTURED_OUTPUT_MAX_RETRIES) {
			payload.messages.push(
				{
					role: "assistant",
					content: truncateForRetryInstruction(text),
				},
				{
					role: "user",
					content: [
						"The previous response did not satisfy the required JSON Schema.",
						`Validation error: ${lastError}`,
						"Return a corrected response as raw JSON only. Do not include markdown, code fences, or explanations.",
					].join("\n"),
				}
			);
		}
	}

	throw new StructuredOutputValidationError(lastError);
}

function formatAjvErrors(errors: ErrorObject[] | null | undefined): string {
	if (!errors || errors.length === 0) {
		return "JSON Schema validation failed.";
	}
	return errors
		.slice(0, 8)
		.map((error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`)
		.join("; ");
}

function truncateForRetryInstruction(value: string): string {
	const MAX_RETRY_TEXT_LENGTH = 4000;
	return value.length > MAX_RETRY_TEXT_LENGTH ? `${value.slice(0, MAX_RETRY_TEXT_LENGTH)}...` : value;
}

function validateStructuredOutput(
	text: string,
	format: JsonSchemaTextFormat
): { ok: true; text: string } | { ok: false; error: string } {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		const message = error instanceof Error ? error.message : "Invalid JSON.";
		return { ok: false, error: `JSON.parse failed: ${message}` };
	}

	const ajv = new Ajv2020({ allErrors: true, strict: false });
	const validate = ajv.compile(format.schema);
	if (!validate(parsed)) {
		return { ok: false, error: `JSON Schema validation failed: ${formatAjvErrors(validate.errors)}` };
	}

	return { ok: true, text: JSON.stringify(parsed) };
}

async function collectChatCompletionText(
	apiKey: string | undefined,
	payload: ChatCompletionCreateParamsStreaming,
	responseObject: IncompleteResponse,
	defaultHeaders: Record<string, string>
): Promise<string> {
	const client = createOpenAIClient(apiKey, defaultHeaders);
	const stream = await client.chat.completions.create(payload);
	let text = "";
	const previousInputTokens = responseObject.usage?.input_tokens ?? 0;
	const previousOutputTokens = responseObject.usage?.output_tokens ?? 0;
	const previousTotalTokens = responseObject.usage?.total_tokens ?? 0;

	for await (const chunk of stream) {
		if (chunk.usage) {
			responseObject.usage = {
				input_tokens: previousInputTokens + chunk.usage.prompt_tokens,
				input_tokens_details: { cached_tokens: 0 },
				output_tokens: previousOutputTokens + chunk.usage.completion_tokens,
				output_tokens_details: { reasoning_tokens: 0 },
				total_tokens: previousTotalTokens + chunk.usage.total_tokens,
			};
		}

		const delta = chunk.choices[0]?.delta as PatchedDeltaWithReasoning | undefined;
		if (delta?.content) {
			text += delta.content;
		}
	}

	return text;
}
