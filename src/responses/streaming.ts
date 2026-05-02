import type {
	ResponseContentPartAddedEvent,
	ResponseFunctionToolCall,
	ResponseOutputItem,
	ResponseOutputMessage,
} from "openai/resources/responses/responses";
import type { ChatCompletionCreateParamsStreaming } from "openai/resources/chat/completions.js";
import { generateUniqueId } from "../lib/generateUniqueId.js";
import { createLogger } from "../lib/logger.js";
import { callMcpTool } from "../mcp.js";
import type {
	PatchedDeltaWithReasoning,
	PatchedResponseContentPart,
	PatchedResponseReasoningItem,
	PatchedResponseStreamEvent,
	ReasoningTextContent,
} from "../openai_patch.js";
import type { McpServerParams } from "../schemas.js";
import { createOpenAIClient } from "./openaiClient.js";
import type { IncompleteResponse } from "./types.js";
import { SEQUENCE_NUMBER_PLACEHOLDER, StreamingError } from "./types.js";
import { requiresApproval } from "./tools.js";

const logger = createLogger("responses");

export async function* emitOutputTextMessageStream(
	responseObject: IncompleteResponse,
	text: string
): AsyncGenerator<PatchedResponseStreamEvent> {
	const outputObject: ResponseOutputMessage = {
		id: generateUniqueId("msg"),
		type: "message",
		role: "assistant",
		status: "in_progress",
		content: [],
	};
	responseObject.output.push(outputObject);

	yield {
		type: "response.output_item.added",
		output_index: responseObject.output.length - 1,
		item: outputObject,
		sequence_number: SEQUENCE_NUMBER_PLACEHOLDER,
	};

	const contentPart: ResponseContentPartAddedEvent["part"] = {
		type: "output_text",
		text: "",
		annotations: [],
	};
	outputObject.content.push(contentPart);
	yield {
		type: "response.content_part.added",
		item_id: outputObject.id,
		output_index: responseObject.output.length - 1,
		content_index: 0,
		part: contentPart,
		sequence_number: SEQUENCE_NUMBER_PLACEHOLDER,
	};

	contentPart.text = text;
	yield {
		type: "response.output_text.delta",
		item_id: outputObject.id,
		output_index: responseObject.output.length - 1,
		content_index: 0,
		delta: text,
		sequence_number: SEQUENCE_NUMBER_PLACEHOLDER,
	};

	yield {
		type: "response.output_text.done",
		item_id: outputObject.id,
		output_index: responseObject.output.length - 1,
		content_index: 0,
		text,
		sequence_number: SEQUENCE_NUMBER_PLACEHOLDER,
	};

	yield {
		type: "response.content_part.done",
		item_id: outputObject.id,
		output_index: responseObject.output.length - 1,
		content_index: 0,
		part: contentPart,
		sequence_number: SEQUENCE_NUMBER_PLACEHOLDER,
	};

	outputObject.status = "completed";
	yield {
		type: "response.output_item.done",
		output_index: responseObject.output.length - 1,
		item: outputObject,
		sequence_number: SEQUENCE_NUMBER_PLACEHOLDER,
	};
}

export async function* handleOneTurnStream(
	apiKey: string | undefined,
	payload: ChatCompletionCreateParamsStreaming,
	responseObject: IncompleteResponse,
	mcpToolsMapping: Record<string, McpServerParams>,
	defaultHeaders: Record<string, string>
): AsyncGenerator<PatchedResponseStreamEvent> {
	const client = createOpenAIClient(apiKey, defaultHeaders);
	const stream = await client.chat.completions.create(payload);
	const previousInputTokens = responseObject.usage?.input_tokens ?? 0;
	const previousOutputTokens = responseObject.usage?.output_tokens ?? 0;
	const previousTotalTokens = responseObject.usage?.total_tokens ?? 0;
	let currentTextMode: "text" | "reasoning" = "text";

	for await (const chunk of stream) {
		if (chunk.usage) {
			// Overwrite usage with the latest chunk's usage
			responseObject.usage = {
				input_tokens: previousInputTokens + chunk.usage.prompt_tokens,
				input_tokens_details: { cached_tokens: 0 },
				output_tokens: previousOutputTokens + chunk.usage.completion_tokens,
				output_tokens_details: { reasoning_tokens: 0 },
				total_tokens: previousTotalTokens + chunk.usage.total_tokens,
			};
		}

		if (!chunk.choices[0]) {
			continue;
		}

		const delta = chunk.choices[0].delta as PatchedDeltaWithReasoning;
		const reasoningText = delta.reasoning ?? delta.reasoning_content;

		if (delta.content || reasoningText) {
			let currentOutputItem = responseObject.output.at(-1);

			// If start or end of reasoning, skip token and update the current text mode
			if (reasoningText) {
				if (currentTextMode === "text") {
					for await (const event of closeLastOutputItem(responseObject, payload, mcpToolsMapping)) {
						yield event;
					}
				}
				currentTextMode = "reasoning";
			} else if (delta.content) {
				if (currentTextMode === "reasoning") {
					for await (const event of closeLastOutputItem(responseObject, payload, mcpToolsMapping)) {
						yield event;
					}
				}
				currentTextMode = "text";
			}

			if (currentTextMode === "text") {
				if (currentOutputItem?.type !== "message" || currentOutputItem?.status !== "in_progress") {
					const outputObject: ResponseOutputMessage = {
						id: generateUniqueId("msg"),
						type: "message",
						role: "assistant",
						status: "in_progress",
						content: [],
					};
					responseObject.output.push(outputObject);

					yield {
						type: "response.output_item.added",
						output_index: 0,
						item: outputObject,
						sequence_number: SEQUENCE_NUMBER_PLACEHOLDER,
					};
				}
			} else if (currentTextMode === "reasoning") {
				if (currentOutputItem?.type !== "reasoning" || currentOutputItem?.status !== "in_progress") {
					const outputObject: PatchedResponseReasoningItem = {
						id: generateUniqueId("rs"),
						type: "reasoning",
						status: "in_progress",
						content: [],
						summary: [],
					};
					responseObject.output.push(outputObject);

					yield {
						type: "response.output_item.added",
						output_index: 0,
						item: outputObject,
						sequence_number: SEQUENCE_NUMBER_PLACEHOLDER,
					};
				}
			}

			if (currentTextMode === "text") {
				const currentOutputMessage = responseObject.output.at(-1) as ResponseOutputMessage;
				if (currentOutputMessage.content.length === 0) {
					const contentPart: ResponseContentPartAddedEvent["part"] = {
						type: "output_text",
						text: "",
						annotations: [],
					};
					currentOutputMessage.content.push(contentPart);

					yield {
						type: "response.content_part.added",
						item_id: currentOutputMessage.id,
						output_index: responseObject.output.length - 1,
						content_index: currentOutputMessage.content.length - 1,
						part: contentPart,
						sequence_number: SEQUENCE_NUMBER_PLACEHOLDER,
					};
				}

				const contentPart = currentOutputMessage.content.at(-1);
				if (!contentPart || contentPart.type !== "output_text") {
					throw new StreamingError(
						`Not implemented: only output_text is supported in response.output[].content[].type. Got ${contentPart?.type}`
					);
				}

				contentPart.text += delta.content;
				yield {
					type: "response.output_text.delta",
					item_id: currentOutputMessage.id,
					output_index: responseObject.output.length - 1,
					content_index: currentOutputMessage.content.length - 1,
					delta: delta.content as string,
					sequence_number: SEQUENCE_NUMBER_PLACEHOLDER,
				};
			} else if (currentTextMode === "reasoning") {
				const currentReasoningItem = responseObject.output.at(-1) as PatchedResponseReasoningItem;
				if (currentReasoningItem.content.length === 0) {
					const contentPart: ReasoningTextContent = {
						type: "reasoning_text",
						text: "",
					};
					currentReasoningItem.content.push(contentPart);

					yield {
						type: "response.content_part.added",
						item_id: currentReasoningItem.id,
						output_index: responseObject.output.length - 1,
						content_index: currentReasoningItem.content.length - 1,
						part: contentPart as unknown as PatchedResponseContentPart, // TODO: adapt once openai-node is updated
						sequence_number: SEQUENCE_NUMBER_PLACEHOLDER,
					};
				}

				const contentPart = currentReasoningItem.content.at(-1) as ReasoningTextContent;
				contentPart.text += reasoningText;
				yield {
					type: "response.reasoning_text.delta",
					item_id: currentReasoningItem.id,
					output_index: responseObject.output.length - 1,
					content_index: currentReasoningItem.content.length - 1,
					delta: reasoningText as string,
					sequence_number: SEQUENCE_NUMBER_PLACEHOLDER,
				};
			}
		} else if (delta.tool_calls && delta.tool_calls.length > 0) {
			if (delta.tool_calls.length > 1) {
				logger.warn("multiple tool calls are not supported; only the first call will be processed", {
					tool_call_count: delta.tool_calls.length,
				});
			}

			let currentOutputItem = responseObject.output.at(-1);
			if (delta.tool_calls[0].function?.name) {
				const functionName = delta.tool_calls[0].function.name;
				let newOutputObject:
					| ResponseOutputItem.McpCall
					| ResponseFunctionToolCall
					| ResponseOutputItem.McpApprovalRequest;
				if (functionName in mcpToolsMapping) {
					if (requiresApproval(functionName, mcpToolsMapping)) {
						newOutputObject = {
							id: generateUniqueId("mcpr"),
							type: "mcp_approval_request",
							name: functionName,
							server_label: mcpToolsMapping[functionName].server_label,
							arguments: "",
						};
					} else {
						newOutputObject = {
							type: "mcp_call",
							id: generateUniqueId("mcp"),
							name: functionName,
							server_label: mcpToolsMapping[functionName].server_label,
							arguments: "",
						};
					}
				} else {
					newOutputObject = {
						type: "function_call",
						id: generateUniqueId("fc"),
						call_id: delta.tool_calls[0].id ?? "",
						name: functionName,
						arguments: "",
					};
				}

				responseObject.output.push(newOutputObject);
				yield {
					type: "response.output_item.added",
					output_index: responseObject.output.length - 1,
					item: newOutputObject,
					sequence_number: SEQUENCE_NUMBER_PLACEHOLDER,
				};
				if (newOutputObject.type === "mcp_call") {
					yield {
						type: "response.mcp_call.in_progress",
						sequence_number: SEQUENCE_NUMBER_PLACEHOLDER,
						item_id: newOutputObject.id,
						output_index: responseObject.output.length - 1,
					};
				}
			}

			if (delta.tool_calls[0].function?.arguments) {
				currentOutputItem = responseObject.output.at(-1) as
					| ResponseOutputItem.McpCall
					| ResponseFunctionToolCall
					| ResponseOutputItem.McpApprovalRequest;
				currentOutputItem.arguments += delta.tool_calls[0].function.arguments;
				if (currentOutputItem.type === "mcp_call" || currentOutputItem.type === "function_call") {
					yield {
						type:
							currentOutputItem.type === "mcp_call"
								? ("response.mcp_call_arguments.delta" as "response.mcp_call.arguments_delta") // bug workaround (see https://github.com/openai/openai-node/issues/1562)
								: "response.function_call_arguments.delta",
						item_id: currentOutputItem.id as string,
						output_index: responseObject.output.length - 1,
						delta: delta.tool_calls[0].function.arguments,
						sequence_number: SEQUENCE_NUMBER_PLACEHOLDER,
					};
				}
			}
		}
	}

	for await (const event of closeLastOutputItem(responseObject, payload, mcpToolsMapping)) {
		yield event;
	}
}

async function* closeLastOutputItem(
	responseObject: IncompleteResponse,
	payload: ChatCompletionCreateParamsStreaming,
	mcpToolsMapping: Record<string, McpServerParams>
): AsyncGenerator<PatchedResponseStreamEvent> {
	const lastOutputItem = responseObject.output.at(-1);
	if (lastOutputItem) {
		if (lastOutputItem?.type === "message") {
			const contentPart = lastOutputItem.content.at(-1);
			if (contentPart?.type === "output_text") {
				yield {
					type: "response.output_text.done",
					item_id: lastOutputItem.id,
					output_index: responseObject.output.length - 1,
					content_index: lastOutputItem.content.length - 1,
					text: contentPart.text,
					sequence_number: SEQUENCE_NUMBER_PLACEHOLDER,
				};

				yield {
					type: "response.content_part.done",
					item_id: lastOutputItem.id,
					output_index: responseObject.output.length - 1,
					content_index: lastOutputItem.content.length - 1,
					part: contentPart,
					sequence_number: SEQUENCE_NUMBER_PLACEHOLDER,
				};
			} else {
				throw new StreamingError("Not implemented: only output_text is supported in streaming mode.");
			}

			lastOutputItem.status = "completed";
			yield {
				type: "response.output_item.done",
				output_index: responseObject.output.length - 1,
				item: lastOutputItem,
				sequence_number: SEQUENCE_NUMBER_PLACEHOLDER,
			};
		} else if (lastOutputItem?.type === "reasoning") {
			const contentPart = (lastOutputItem as PatchedResponseReasoningItem).content.at(-1);
			if (contentPart !== undefined) {
				yield {
					type: "response.reasoning_text.done",
					item_id: lastOutputItem.id,
					output_index: responseObject.output.length - 1,
					content_index: (lastOutputItem as PatchedResponseReasoningItem).content.length - 1,
					text: contentPart.text,
					sequence_number: SEQUENCE_NUMBER_PLACEHOLDER,
				};

				yield {
					type: "response.content_part.done",
					item_id: lastOutputItem.id,
					output_index: responseObject.output.length - 1,
					content_index: (lastOutputItem as PatchedResponseReasoningItem).content.length - 1,
					part: contentPart as unknown as PatchedResponseContentPart, // TODO: adapt once openai-node is updated
					sequence_number: SEQUENCE_NUMBER_PLACEHOLDER,
				};
			}
			lastOutputItem.status = "completed";
			yield {
				type: "response.output_item.done",
				output_index: responseObject.output.length - 1,
				item: lastOutputItem,
				sequence_number: SEQUENCE_NUMBER_PLACEHOLDER,
			};
		} else if (lastOutputItem?.type === "function_call") {
			yield {
				type: "response.function_call_arguments.done",
				item_id: lastOutputItem.id as string,
				output_index: responseObject.output.length - 1,
				arguments: lastOutputItem.arguments,
				sequence_number: SEQUENCE_NUMBER_PLACEHOLDER,
			};

			lastOutputItem.status = "completed";
			yield {
				type: "response.output_item.done",
				output_index: responseObject.output.length - 1,
				item: lastOutputItem,
				sequence_number: SEQUENCE_NUMBER_PLACEHOLDER,
			};
		} else if (lastOutputItem?.type === "mcp_call") {
			yield {
				type: "response.mcp_call_arguments.done" as "response.mcp_call.arguments_done", // bug workaround (see https://github.com/openai/openai-node/issues/1562)
				item_id: lastOutputItem.id as string,
				output_index: responseObject.output.length - 1,
				arguments: lastOutputItem.arguments,
				sequence_number: SEQUENCE_NUMBER_PLACEHOLDER,
			};

			const toolParams = mcpToolsMapping[lastOutputItem.name];
			const toolResult = await callMcpTool(toolParams, lastOutputItem.name, lastOutputItem.arguments);
			if (toolResult.error) {
				lastOutputItem.error = toolResult.error;
				yield {
					type: "response.mcp_call.failed",
					sequence_number: SEQUENCE_NUMBER_PLACEHOLDER,
				};
			} else {
				lastOutputItem.output = toolResult.output;
				yield {
					type: "response.mcp_call.completed",
					sequence_number: SEQUENCE_NUMBER_PLACEHOLDER,
				};
			}

			yield {
				type: "response.output_item.done",
				output_index: responseObject.output.length - 1,
				item: lastOutputItem,
				sequence_number: SEQUENCE_NUMBER_PLACEHOLDER,
			};

			payload.messages.push(
				{
					role: "assistant",
					tool_calls: [
						{
							id: lastOutputItem.id,
							type: "function",
							function: {
								name: lastOutputItem.name,
								arguments: lastOutputItem.arguments,
								// Hacky: type is not correct in inference.js. Will fix it but in the meantime we need to cast it.
								// TODO: fix it in the inference.js package. Should be "arguments" and not "parameters".
							},
						},
					],
				},
				{
					role: "tool",
					tool_call_id: lastOutputItem.id,
					content: lastOutputItem.output
						? lastOutputItem.output
						: lastOutputItem.error
							? `Error: ${lastOutputItem.error}`
							: "",
				}
			);
		} else if (lastOutputItem?.type === "mcp_approval_request" || lastOutputItem?.type === "mcp_list_tools") {
			yield {
				type: "response.output_item.done",
				output_index: responseObject.output.length - 1,
				item: lastOutputItem,
				sequence_number: SEQUENCE_NUMBER_PLACEHOLDER,
			};
		} else {
			throw new StreamingError(
				`Not implemented: expected message, function_call, or mcp_call, got ${lastOutputItem?.type}`
			);
		}
	}
}
