import { strict as assert } from "assert";
import { buildChatCompletionPayload, buildResponseInputMessages } from "../src/responses/chatPayload.ts";
import { mapTextFormatToChatResponseFormat, buildDeepseekSystemInstruction } from "../src/responses/deepseek.ts";

const schemaFormat = {
	type: "json_schema",
	name: "person",
	schema: {
		type: "object",
		properties: {
			name: { type: "string" },
		},
		required: ["name"],
	},
	strict: true,
};

describe("responses module helpers", function () {
	it("maps DeepSeek json_schema response format to json_object", function () {
		assert.deepEqual(mapTextFormatToChatResponseFormat(schemaFormat, { deepseekCompatible: true }), {
			type: "json_object",
		});
	});

	it("keeps non-DeepSeek json_schema response format in OpenAI shape", function () {
		assert.deepEqual(mapTextFormatToChatResponseFormat(schemaFormat, { deepseekCompatible: false }), {
			type: "json_schema",
			json_schema: {
				description: undefined,
				name: "person",
				schema: schemaFormat.schema,
				strict: false,
			},
		});
	});

	it("builds DeepSeek schema instructions with validation context", function () {
		const instruction = buildDeepseekSystemInstruction(schemaFormat);

		assert.match(instruction, /single JSON object/);
		assert.match(instruction, /Schema name: person/);
		assert.match(instruction, /Strict requested by client: true/);
		assert.match(instruction, /"required"/);
	});

	it("converts tool history differently for normal and DeepSeek-compatible modes", function () {
		const input = [
			{
				type: "function_call",
				call_id: "call_1",
				name: "get_weather",
				arguments: "{}",
			},
		];

		const normalMessages = buildResponseInputMessages({
			input,
			instructions: null,
			deepseekCompatible: false,
		});
		const deepseekMessages = buildResponseInputMessages({
			input,
			instructions: null,
			deepseekCompatible: true,
		});

		assert.deepEqual(normalMessages[0], {
			role: "tool",
			content: "{}",
			tool_call_id: "call_1",
		});
		assert.equal(deepseekMessages[0].role, "assistant");
		assert.match(deepseekMessages[0].content, /Function call/);
	});

	it("disables DeepSeek thinking mode when tools are present", function () {
		const payload = buildChatCompletionPayload({
			body: {
				model: "deepseek-v4-pro",
				input: "hello",
				metadata: null,
				instructions: null,
				max_output_tokens: null,
				conversation: null,
				previous_response_id: null,
				stream: true,
				temperature: 1,
				top_p: 1,
			},
			messages: [{ role: "user", content: "hello" }],
			tools: [
				{
					type: "function",
					function: {
						name: "get_weather",
						parameters: { type: "object", properties: {} },
					},
				},
			],
			deepseekCompatible: true,
		});

		assert.deepEqual(payload.thinking, { type: "disabled" });
	});

	it("disables DeepSeek thinking mode when tool_choice is present", function () {
		const payload = buildChatCompletionPayload({
			body: {
				model: "deepseek-v4-pro",
				input: "hello",
				metadata: null,
				instructions: null,
				max_output_tokens: null,
				conversation: null,
				previous_response_id: null,
				stream: true,
				temperature: 1,
				top_p: 1,
				tool_choice: {
					type: "function",
					name: "get_weather",
				},
			},
			messages: [{ role: "user", content: "hello" }],
			tools: undefined,
			deepseekCompatible: true,
		});

		assert.deepEqual(payload.thinking, { type: "disabled" });
	});

	it("keeps DeepSeek thinking mode default when no tools or tool_choice are present", function () {
		const payload = buildChatCompletionPayload({
			body: {
				model: "deepseek-v4-pro",
				input: "hello",
				metadata: null,
				instructions: null,
				max_output_tokens: null,
				conversation: null,
				previous_response_id: null,
				stream: true,
				temperature: 1,
				top_p: 1,
			},
			messages: [{ role: "user", content: "hello" }],
			tools: undefined,
			deepseekCompatible: true,
		});

		assert.equal(payload.thinking, undefined);
	});
});
