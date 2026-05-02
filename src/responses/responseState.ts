import type { ResponseOutputItem } from "openai/resources/responses/responses";
import { generateUniqueId } from "../lib/generateUniqueId.js";
import { stateStore } from "../lib/stateStore.js";
import { responseInputItemSchema, type CreateResponseParams, type ResponseInputItem } from "../schemas.js";
import type { IncompleteResponse, ResponseStateContext } from "./types.js";

function resolveConversationId(conversation: CreateResponseParams["conversation"]): string | undefined {
	if (!conversation) {
		return undefined;
	}
	return typeof conversation === "string" ? conversation : conversation.id;
}

function responseInputToItems(input: CreateResponseParams["input"]): ResponseInputItem[] {
	if (input === undefined) {
		return [];
	}
	if (typeof input === "string") {
		return [
			{
				type: "message",
				role: "user",
				content: input,
			},
		];
	}
	return JSON.parse(JSON.stringify(input)) as ResponseInputItem[];
}

export function resolveResponseStateContext(body: CreateResponseParams): ResponseStateContext | { error: string } {
	const requestInput = responseInputToItems(body.input);
	const conversationId = resolveConversationId(body.conversation);

	if (body.previous_response_id) {
		const history = stateStore.getResponseHistory(body.previous_response_id);
		if (!history) {
			return { error: `Previous response '${body.previous_response_id}' not found` };
		}
		return {
			effectiveInput: [...history, ...requestInput],
			requestInput,
		};
	}

	if (conversationId) {
		const conversationItems = stateStore.listConversationItems(conversationId);
		if (!conversationItems) {
			return { error: `Conversation '${conversationId}' not found` };
		}
		return {
			conversationId,
			effectiveInput: [...conversationItems, ...requestInput],
			requestInput,
		};
	}

	return {
		effectiveInput: requestInput,
		requestInput,
	};
}

export function createInitialResponseObject(body: CreateResponseParams): IncompleteResponse {
	return {
		created_at: Math.floor(new Date().getTime() / 1000),
		error: null,
		id: generateUniqueId("resp"),
		instructions: body.instructions,
		max_output_tokens: body.max_output_tokens,
		metadata: body.metadata,
		model: body.model,
		object: "response",
		output: [],
		// parallel_tool_calls: body.parallel_tool_calls,
		status: "in_progress",
		text: body.text,
		tool_choice: body.tool_choice ?? "auto",
		tools: body.tools ?? [],
		temperature: body.temperature,
		top_p: body.top_p,
		usage: {
			input_tokens: 0,
			input_tokens_details: { cached_tokens: 0 },
			output_tokens: 0,
			output_tokens_details: { reasoning_tokens: 0 },
			total_tokens: 0,
		},
	};
}

export function persistCompletedResponseState(
	responseObject: IncompleteResponse,
	stateContext: ResponseStateContext
): void {
	const responseOutputItems = getStorableResponseOutputItems(responseObject.output);
	stateStore.storeResponseHistory(responseObject.id, [...stateContext.effectiveInput, ...responseOutputItems]);
	if (stateContext.conversationId) {
		stateStore.appendConversationItems(stateContext.conversationId, [
			...stateContext.requestInput,
			...responseOutputItems,
		]);
	}
}

function getStorableResponseOutputItems(output: ResponseOutputItem[]): ResponseInputItem[] {
	return output
		.map((item) => responseInputItemSchema.safeParse(item))
		.filter((result): result is { success: true; data: ResponseInputItem } => result.success)
		.map((result) => result.data);
}
