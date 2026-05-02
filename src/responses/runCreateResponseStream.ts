import type { Response } from "openai/resources/responses/responses";
import type { ValidatedRequest } from "../middleware/validation.js";
import type { CreateResponseParams, McpApprovalRequestParams } from "../schemas.js";
import type { PatchedResponseStreamEvent } from "../openai_patch.js";
import { createLogger } from "../lib/logger.js";
import { buildChatCompletionPayload, buildResponseInputMessages } from "./chatPayload.js";
import { getDeepseekJsonSchemaFormat, isDeepseekModel, runDeepseekJsonSchemaFallbackStream } from "./deepseek.js";
import { createInitialResponseObject, persistCompletedResponseState } from "./responseState.js";
import { handleOneTurnStream } from "./streaming.js";
import { callApprovedMCPToolStream, prepareToolsStream, type ToolContext } from "./tools.js";
import type { IncompleteResponse, ResponseStateContext } from "./types.js";

const logger = createLogger("responses");
const MAX_ITERATIONS = 5;

// All headers are forwarded by default, except these ones.
const NOT_FORWARDED_HEADERS = new Set([
	"accept",
	"accept-encoding",
	"authorization",
	"connection",
	"content-length",
	"content-type",
	"host",
	"keep-alive",
	"te",
	"trailer",
	"trailers",
	"transfer-encoding",
	"upgrade",
]);

export async function* runCreateResponseStream(
	req: ValidatedRequest<CreateResponseParams>,
	upstreamApiKey: string,
	stateContext: ResponseStateContext
): AsyncGenerator<PatchedResponseStreamEvent> {
	let sequenceNumber = 0;
	const responseObject = createInitialResponseObject(req.body);

	yield {
		type: "response.created",
		response: responseObject as Response,
		sequence_number: sequenceNumber++,
	};

	yield {
		type: "response.in_progress",
		response: responseObject as Response,
		sequence_number: sequenceNumber++,
	};

	try {
		for await (const event of runModelLoopStream(req, responseObject, upstreamApiKey)) {
			yield { ...event, sequence_number: sequenceNumber++ };
		}
	} catch (error) {
		logger.error("response stream failed", {
			error,
		});

		const message =
			typeof error === "object" &&
			error &&
			"message" in error &&
			typeof (error as { message: unknown }).message === "string"
				? (error as { message: string }).message
				: "An error occurred in stream";

		responseObject.status = "failed";
		responseObject.error = {
			code: "server_error",
			message,
		};
		yield {
			type: "response.failed",
			response: responseObject as Response,
			sequence_number: sequenceNumber++,
		};
		return;
	}

	responseObject.status = "completed";
	persistCompletedResponseState(responseObject, stateContext);
	yield {
		type: "response.completed",
		response: responseObject as Response,
		sequence_number: sequenceNumber++,
	};
}

async function* runModelLoopStream(
	req: ValidatedRequest<CreateResponseParams>,
	responseObject: IncompleteResponse,
	upstreamApiKey: string
): AsyncGenerator<PatchedResponseStreamEvent> {
	const defaultHeaders = Object.fromEntries(
		Object.entries(req.headers).filter(([key]) => !NOT_FORWARDED_HEADERS.has(key.toLowerCase()))
	) as Record<string, string>;

	if (req.body.reasoning?.summary && req.body.reasoning?.summary !== "auto") {
		throw new Error(`Not implemented: only 'auto' summary is supported. Got '${req.body.reasoning?.summary}'`);
	}

	const toolContext: ToolContext = {
		tools: [],
		mcpToolsMapping: {},
	};
	for await (const event of prepareToolsStream(req.body, responseObject, toolContext)) {
		yield event;
	}
	const tools = toolContext.tools.length === 0 ? undefined : toolContext.tools;

	const deepseekCompatible = isDeepseekModel(req.body.model);
	const deepseekJsonSchemaFormat = getDeepseekJsonSchemaFormat(req.body.model, req.body.text?.format);
	const messages = buildResponseInputMessages({
		input: req.body.input,
		instructions: req.body.instructions,
		deepseekCompatible,
		deepseekJsonSchemaFormat,
	});
	const payload = buildChatCompletionPayload({
		body: req.body,
		messages,
		tools,
		deepseekCompatible,
	});

	if (Array.isArray(req.body.input)) {
		for (const item of req.body.input) {
			if (item.type === "mcp_approval_response" && item.approve) {
				const approvalRequest = req.body.input.find(
					(i) => i.type === "mcp_approval_request" && i.id === item.approval_request_id
				) as McpApprovalRequestParams | undefined;
				const mcpCallId = "mcp_" + item.approval_request_id.split("_")[1];
				const mcpCall = req.body.input.find((i) => i.type === "mcp_call" && i.id === mcpCallId);
				if (mcpCall) {
					continue;
				}

				for await (const event of callApprovedMCPToolStream(
					item.approval_request_id,
					mcpCallId,
					approvalRequest,
					toolContext.mcpToolsMapping,
					responseObject,
					payload
				)) {
					yield event;
				}
			}
		}
	}

	if (deepseekJsonSchemaFormat) {
		for await (const event of runDeepseekJsonSchemaFallbackStream(
			upstreamApiKey,
			payload,
			responseObject,
			defaultHeaders,
			deepseekJsonSchemaFormat
		)) {
			yield event;
		}
		return;
	}

	let previousMessageCount: number;
	let currentMessageCount = payload.messages.length;
	let iterations = 0;
	do {
		previousMessageCount = currentMessageCount;

		for await (const event of handleOneTurnStream(
			upstreamApiKey,
			payload,
			responseObject,
			toolContext.mcpToolsMapping,
			defaultHeaders
		)) {
			yield event;
		}

		currentMessageCount = payload.messages.length;
		iterations++;
	} while (currentMessageCount > previousMessageCount && iterations < MAX_ITERATIONS);
}
