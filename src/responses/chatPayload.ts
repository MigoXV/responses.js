import type {
	ChatCompletionCreateParamsStreaming,
	ChatCompletionMessageParam,
	ChatCompletionTool,
} from "openai/resources/chat/completions.js";
import type { CreateResponseParams, ResponseInputItem } from "../schemas.js";
import { buildDeepseekSystemInstruction, mapTextFormatToChatResponseFormat } from "./deepseek.js";
import type { JsonSchemaTextFormat } from "./types.js";

export function buildResponseInputMessages(options: {
	input: CreateResponseParams["input"];
	instructions: CreateResponseParams["instructions"];
	deepseekCompatible: boolean;
	deepseekJsonSchemaFormat?: JsonSchemaTextFormat;
}): ChatCompletionMessageParam[] {
	const messages: ChatCompletionMessageParam[] = options.instructions
		? [{ role: "system", content: options.instructions }]
		: [];

	if (options.deepseekJsonSchemaFormat) {
		messages.push({
			role: "system",
			content: buildDeepseekSystemInstruction(options.deepseekJsonSchemaFormat),
		});
	}

	if (Array.isArray(options.input)) {
		messages.push(
			...options.input
				.map((item) => inputItemToChatMessage(item, options.deepseekCompatible))
				.filter(
					(message): message is NonNullable<typeof message> =>
						message !== undefined &&
						(typeof message.content === "string" || (Array.isArray(message.content) && message.content.length !== 0))
				)
		);
	} else if (typeof options.input === "string") {
		messages.push({ role: "user", content: options.input } as const);
	}

	return messages;
}

export function buildChatCompletionPayload(options: {
	body: CreateResponseParams;
	messages: ChatCompletionMessageParam[];
	tools: ChatCompletionTool[] | undefined;
	deepseekCompatible: boolean;
}): ChatCompletionCreateParamsStreaming {
	return {
		// main params
		model: options.body.model,
		messages: options.messages,
		stream: true,
		// options
		max_tokens: options.body.max_output_tokens === null ? undefined : options.body.max_output_tokens,
		response_format: mapTextFormatToChatResponseFormat(options.body.text?.format, {
			deepseekCompatible: options.deepseekCompatible,
		}),
		reasoning_effort: options.body.reasoning?.effort,
		temperature: options.body.temperature,
		tool_choice:
			typeof options.body.tool_choice === "string"
				? options.body.tool_choice
				: options.body.tool_choice
					? {
							type: "function",
							function: {
								name: options.body.tool_choice.name,
							},
						}
					: undefined,
		tools: options.tools,
		top_p: options.body.top_p,
	};
}

function inputItemToChatMessage(
	item: ResponseInputItem,
	deepseekCompatible: boolean
): ChatCompletionMessageParam | undefined {
	switch (item.type) {
		case "function_call":
			if (deepseekCompatible) {
				return {
					role: "assistant" as const,
					content: `Function call (${item.call_id}). Name: '${item.name}'. Arguments: '${item.arguments}'.`,
				};
			}
			return {
				role: "tool" as const,
				content: item.arguments,
				tool_call_id: item.call_id,
			};
		case "function_call_output":
			if (deepseekCompatible) {
				return {
					role: "assistant" as const,
					content: `Function call output (${item.call_id}). Output: '${item.output}'.`,
				};
			}
			return {
				role: "tool" as const,
				content: item.output,
				tool_call_id: item.call_id,
			};
		case "message":
		case undefined:
			if (item.role === "assistant" || item.role === "user" || item.role === "system") {
				const content =
					typeof item.content === "string"
						? item.content
						: item.content
								.map((content) => {
									switch (content.type) {
										case "input_image":
											return {
												type: "image_url" as const,
												image_url: {
													url: content.image_url,
												},
											};
										case "output_text":
											return content.text
												? {
														type: "text" as const,
														text: content.text,
													}
												: undefined;
										case "refusal":
											return undefined;
										case "input_text":
											return {
												type: "text" as const,
												text: content.text,
											};
									}
								})
								.filter((contentItem) => {
									return contentItem !== undefined;
								});
				const maybeFlatContent =
					content.length === 1 && typeof content[0] === "object" && "type" in content[0] && content[0].type === "text"
						? content[0].text
						: content;
				return {
					role: item.role,
					content: maybeFlatContent,
				} as ChatCompletionMessageParam;
			}
			return undefined;
		case "mcp_list_tools": {
			if (deepseekCompatible) {
				return {
					role: "assistant" as const,
					content: `MCP list tools. Server: '${item.server_label}'.`,
				};
			}
			return {
				role: "tool" as const,
				content: "MCP list tools. Server: '${item.server_label}'.",
				tool_call_id: "mcp_list_tools",
			};
		}
		case "mcp_call": {
			if (deepseekCompatible) {
				return {
					role: "assistant" as const,
					content: `MCP call (${item.id}). Server: '${item.server_label}'. Tool: '${item.name}'. Arguments: '${item.arguments}'.`,
				};
			}
			return {
				role: "tool" as const,
				content: `MCP call (${item.id}). Server: '${item.server_label}'. Tool: '${item.name}'. Arguments: '${item.arguments}'.`,
				tool_call_id: "mcp_call",
			};
		}
		case "mcp_approval_request": {
			if (deepseekCompatible) {
				return {
					role: "assistant" as const,
					content: `MCP approval request (${item.id}). Server: '${item.server_label}'. Tool: '${item.name}'. Arguments: '${item.arguments}'.`,
				};
			}
			return {
				role: "tool" as const,
				content: `MCP approval request (${item.id}). Server: '${item.server_label}'. Tool: '${item.name}'. Arguments: '${item.arguments}'.`,
				tool_call_id: "mcp_approval_request",
			};
		}
		case "mcp_approval_response": {
			if (deepseekCompatible) {
				return {
					role: "assistant" as const,
					content: `MCP approval response (${item.id}). Approved: ${item.approve}. Reason: ${item.reason}.`,
				};
			}
			return {
				role: "tool" as const,
				content: `MCP approval response (${item.id}). Approved: ${item.approve}. Reason: ${item.reason}.`,
				tool_call_id: "mcp_approval_response",
			};
		}
	}
}
