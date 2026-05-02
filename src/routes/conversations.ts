import { type Request, type Response as ExpressResponse } from "express";
import type {
	CreateConversationItemsParams,
	CreateConversationParams,
	UpdateConversationParams,
	ResponseInputItem,
} from "../schemas.js";
import { stateStore } from "../lib/stateStore.js";
import { resolveUpstreamApiKey } from "../lib/auth.js";
import { type ValidatedRequest } from "../middleware/validation.js";

function ensureAuthorized(req: Request, res: ExpressResponse): boolean {
	const upstreamApiKey = resolveUpstreamApiKey(req.headers.authorization);
	if (!upstreamApiKey.apiKey) {
		res.status(401).json({
			success: false,
			error: "Unauthorized",
		});
		return false;
	}
	return true;
}

function notFound(res: ExpressResponse, message: string): void {
	res.status(404).json({
		success: false,
		error: message,
	});
}

function createListResponse(items: ResponseInputItem[]) {
	return {
		object: "list",
		data: items,
		first_id: getItemId(items[0]) ?? null,
		last_id: getItemId(items.at(-1)) ?? null,
		has_more: false,
	};
}

function getItemId(item: ResponseInputItem | undefined): string | null {
	return item && "id" in item && typeof item.id === "string" ? item.id : null;
}

export const postCreateConversation = (req: ValidatedRequest<CreateConversationParams>, res: ExpressResponse): void => {
	if (!ensureAuthorized(req, res)) {
		return;
	}

	const conversation = stateStore.createConversation({
		metadata: req.body.metadata,
		items: req.body.items,
	});
	res.json(conversation);
};

export const getConversation = (req: Request, res: ExpressResponse): void => {
	if (!ensureAuthorized(req, res)) {
		return;
	}

	const conversation = stateStore.getConversation(req.params.conversationId);
	if (!conversation) {
		notFound(res, `Conversation '${req.params.conversationId}' not found`);
		return;
	}

	res.json(conversation);
};

export const postUpdateConversation = (req: ValidatedRequest<UpdateConversationParams>, res: ExpressResponse): void => {
	if (!ensureAuthorized(req, res)) {
		return;
	}

	const conversation = stateStore.updateConversation(req.params.conversationId, {
		metadata: req.body.metadata,
	});
	if (!conversation) {
		notFound(res, `Conversation '${req.params.conversationId}' not found`);
		return;
	}

	res.json(conversation);
};

export const deleteConversation = (req: Request, res: ExpressResponse): void => {
	if (!ensureAuthorized(req, res)) {
		return;
	}

	const deleted = stateStore.deleteConversation(req.params.conversationId);
	if (!deleted) {
		notFound(res, `Conversation '${req.params.conversationId}' not found`);
		return;
	}

	res.json({
		id: req.params.conversationId,
		object: "conversation.deleted",
		deleted: true,
	});
};

export const postCreateConversationItems = (
	req: ValidatedRequest<CreateConversationItemsParams>,
	res: ExpressResponse
): void => {
	if (!ensureAuthorized(req, res)) {
		return;
	}

	const items = stateStore.appendConversationItems(req.params.conversationId, req.body.items);
	if (!items) {
		notFound(res, `Conversation '${req.params.conversationId}' not found`);
		return;
	}

	res.json(createListResponse(items));
};

export const getConversationItems = (req: Request, res: ExpressResponse): void => {
	if (!ensureAuthorized(req, res)) {
		return;
	}

	const items = stateStore.listConversationItems(req.params.conversationId);
	if (!items) {
		notFound(res, `Conversation '${req.params.conversationId}' not found`);
		return;
	}

	res.json(createListResponse(items));
};

export const getConversationItem = (req: Request, res: ExpressResponse): void => {
	if (!ensureAuthorized(req, res)) {
		return;
	}

	const conversation = stateStore.getConversation(req.params.conversationId);
	if (!conversation) {
		notFound(res, `Conversation '${req.params.conversationId}' not found`);
		return;
	}

	const item = stateStore.getConversationItem(req.params.conversationId, req.params.itemId);
	if (!item) {
		notFound(res, `Conversation item '${req.params.itemId}' not found`);
		return;
	}

	res.json(item);
};

export const deleteConversationItem = (req: Request, res: ExpressResponse): void => {
	if (!ensureAuthorized(req, res)) {
		return;
	}

	const deleted = stateStore.deleteConversationItem(req.params.conversationId, req.params.itemId);
	if (deleted === undefined) {
		notFound(res, `Conversation '${req.params.conversationId}' not found`);
		return;
	}
	if (!deleted) {
		notFound(res, `Conversation item '${req.params.itemId}' not found`);
		return;
	}

	res.json({
		id: req.params.itemId,
		object: "conversation.item.deleted",
		deleted: true,
	});
};
