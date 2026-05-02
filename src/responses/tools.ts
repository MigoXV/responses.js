import type { ChatCompletionCreateParamsStreaming, ChatCompletionTool } from "openai/resources/chat/completions.js";
import type { FunctionParameters } from "openai/resources/shared.js";
import type { ResponseOutputItem } from "openai/resources/responses/responses";
import { generateUniqueId } from "../lib/generateUniqueId.js";
import { createLogger, isStreamEventsLoggingEnabled } from "../lib/logger.js";
import { callMcpTool, connectMcpServer } from "../mcp.js";
import type { CreateResponseParams, McpApprovalRequestParams, McpServerParams } from "../schemas.js";
import type { IncompleteResponse } from "./types.js";
import { SEQUENCE_NUMBER_PLACEHOLDER } from "./types.js";
import type { PatchedResponseStreamEvent } from "../openai_patch.js";

export interface ToolContext {
	tools: ChatCompletionTool[];
	mcpToolsMapping: Record<string, McpServerParams>;
}

const logger = createLogger("responses");

function shouldLogStreamDebug(): boolean {
	return isStreamEventsLoggingEnabled();
}

export async function* prepareToolsStream(
	body: CreateResponseParams,
	responseObject: IncompleteResponse,
	toolContext: ToolContext
): AsyncGenerator<PatchedResponseStreamEvent> {
	if (!body.tools) {
		return;
	}

	for (const tool of body.tools) {
		switch (tool.type) {
			case "function":
				toolContext.tools.push({
					type: tool.type,
					function: {
						name: tool.name,
						parameters: tool.parameters,
						description: tool.description,
						strict: tool.strict,
					},
				});
				break;
			case "web_search":
				// Responses hosted tools do not have a Chat Completions equivalent here,
				// so accept them at the API boundary but do not forward them downstream.
				break;
			case "mcp": {
				let mcpListTools: ResponseOutputItem.McpListTools | undefined;

				// If MCP list tools is already in the input, use it.
				if (Array.isArray(body.input)) {
					for (const item of body.input) {
						if (item.type === "mcp_list_tools" && item.server_label === tool.server_label) {
							mcpListTools = item;
							if (shouldLogStreamDebug()) {
								logger.debug("using MCP tools from request input", {
									server_label: tool.server_label,
								});
							}
							break;
						}
					}
				}

				// Otherwise, list tools from MCP server.
				if (!mcpListTools) {
					for await (const event of listMcpToolsStream(tool, responseObject)) {
						yield event;
					}
					mcpListTools = responseObject.output.at(-1) as ResponseOutputItem.McpListTools;
				}

				// Only allowed tools are forwarded to the LLM.
				const allowedTools = tool.allowed_tools
					? Array.isArray(tool.allowed_tools)
						? tool.allowed_tools
						: tool.allowed_tools.tool_names
					: [];
				if (mcpListTools?.tools) {
					for (const mcpTool of mcpListTools.tools) {
						if (allowedTools.length === 0 || allowedTools.includes(mcpTool.name)) {
							toolContext.tools.push({
								type: "function" as const,
								function: {
									name: mcpTool.name,
									parameters: mcpTool.input_schema as FunctionParameters,
									description: mcpTool.description ?? undefined,
								},
							});
						}
						toolContext.mcpToolsMapping[mcpTool.name] = tool;
					}
					break;
				}
			}
		}
	}
}

export async function* callApprovedMCPToolStream(
	approval_request_id: string,
	mcpCallId: string,
	approvalRequest: McpApprovalRequestParams | undefined,
	mcpToolsMapping: Record<string, McpServerParams>,
	responseObject: IncompleteResponse,
	payload: ChatCompletionCreateParamsStreaming
): AsyncGenerator<PatchedResponseStreamEvent> {
	if (!approvalRequest) {
		throw new Error(`MCP approval request '${approval_request_id}' not found`);
	}

	const outputObject: ResponseOutputItem.McpCall = {
		type: "mcp_call",
		id: mcpCallId,
		name: approvalRequest.name,
		server_label: approvalRequest.server_label,
		arguments: approvalRequest.arguments,
	};
	responseObject.output.push(outputObject);

	yield {
		type: "response.output_item.added",
		output_index: responseObject.output.length - 1,
		item: outputObject,
		sequence_number: SEQUENCE_NUMBER_PLACEHOLDER,
	};

	yield {
		type: "response.mcp_call.in_progress",
		item_id: outputObject.id,
		output_index: responseObject.output.length - 1,
		sequence_number: SEQUENCE_NUMBER_PLACEHOLDER,
	};

	const toolParams = mcpToolsMapping[approvalRequest.name];
	const toolResult = await callMcpTool(toolParams, approvalRequest.name, approvalRequest.arguments);

	if (toolResult.error) {
		outputObject.error = toolResult.error;
		yield {
			type: "response.mcp_call.failed",
			sequence_number: SEQUENCE_NUMBER_PLACEHOLDER,
		};
	} else {
		outputObject.output = toolResult.output;
		yield {
			type: "response.mcp_call.completed",
			sequence_number: SEQUENCE_NUMBER_PLACEHOLDER,
		};
	}

	yield {
		type: "response.output_item.done",
		output_index: responseObject.output.length - 1,
		item: outputObject,
		sequence_number: SEQUENCE_NUMBER_PLACEHOLDER,
	};

	payload.messages.push(
		{
			role: "assistant",
			tool_calls: [
				{
					id: outputObject.id,
					type: "function",
					function: {
						name: outputObject.name,
						arguments: outputObject.arguments,
						// Hacky: type is not correct in inference.js. Will fix it but in the meantime we need to cast it.
						// TODO: fix it in the inference.js package. Should be "arguments" and not "parameters".
					},
				},
			],
		},
		{
			role: "tool",
			tool_call_id: outputObject.id,
			content: outputObject.output ? outputObject.output : outputObject.error ? `Error: ${outputObject.error}` : "",
		}
	);
}

export function requiresApproval(toolName: string, mcpToolsMapping: Record<string, McpServerParams>): boolean {
	const toolParams = mcpToolsMapping[toolName];
	return toolParams.require_approval === "always"
		? true
		: toolParams.require_approval === "never"
			? false
			: toolParams.require_approval.always?.tool_names?.includes(toolName)
				? true
				: toolParams.require_approval.never?.tool_names?.includes(toolName)
					? false
					: true; // behavior is undefined in specs, let's default to true
}

async function* listMcpToolsStream(
	tool: McpServerParams,
	responseObject: IncompleteResponse
): AsyncGenerator<PatchedResponseStreamEvent> {
	const outputObject: ResponseOutputItem.McpListTools = {
		id: generateUniqueId("mcpl"),
		type: "mcp_list_tools",
		server_label: tool.server_label,
		tools: [],
	};
	responseObject.output.push(outputObject);

	yield {
		type: "response.output_item.added",
		output_index: responseObject.output.length - 1,
		item: outputObject,
		sequence_number: SEQUENCE_NUMBER_PLACEHOLDER,
	};

	yield {
		type: "response.mcp_list_tools.in_progress",
		sequence_number: SEQUENCE_NUMBER_PLACEHOLDER,
	};

	try {
		const mcp = await connectMcpServer(tool);
		const mcpTools = await mcp.listTools();
		yield {
			type: "response.mcp_list_tools.completed",
			sequence_number: SEQUENCE_NUMBER_PLACEHOLDER,
		};
		outputObject.tools = mcpTools.tools.map((mcpTool) => ({
			input_schema: mcpTool.inputSchema,
			name: mcpTool.name,
			annotations: mcpTool.annotations,
			description: mcpTool.description,
		}));
		yield {
			type: "response.output_item.done",
			output_index: responseObject.output.length - 1,
			item: outputObject,
			sequence_number: SEQUENCE_NUMBER_PLACEHOLDER,
		};
	} catch (error) {
		const errorMessage = `Failed to list tools from MCP server '${tool.server_label}': ${error instanceof Error ? error.message : "Unknown error"}`;
		logger.error("failed to list MCP tools", {
			server_label: tool.server_label,
			error,
		});
		yield {
			type: "response.mcp_list_tools.failed",
			sequence_number: SEQUENCE_NUMBER_PLACEHOLDER,
		};
		throw new Error(errorMessage);
	}
}
