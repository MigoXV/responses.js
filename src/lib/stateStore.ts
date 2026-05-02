import { clearInterval, setInterval } from "node:timers";
import { generateUniqueId } from "./generateUniqueId.js";
import type { ResponseInputItem } from "../schemas.js";

export interface StoredConversation {
	id: string;
	object: "conversation";
	created_at: number;
	updated_at: number;
	metadata: Record<string, string> | null;
	expires_at?: number;
}

interface ConversationRecord extends StoredConversation {
	items: ResponseInputItem[];
}

interface ResponseHistoryRecord {
	id: string;
	items: ResponseInputItem[];
	expires_at?: number;
}

const DEFAULT_STATE_TTL_SECONDS = 300;
const CLEANUP_INTERVAL_MS = 60_000;

function cloneItems(items: ResponseInputItem[]): ResponseInputItem[] {
	return JSON.parse(JSON.stringify(items)) as ResponseInputItem[];
}

export function getStateTtlSeconds(value = process.env.RESPONSES_STATE_TTL_SECONDS): number {
	if (value === undefined) {
		return DEFAULT_STATE_TTL_SECONDS;
	}

	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : DEFAULT_STATE_TTL_SECONDS;
}

function getExpiresAt(nowSeconds: number, ttlSeconds: number): number | undefined {
	return ttlSeconds > 0 ? nowSeconds + ttlSeconds : undefined;
}

function isExpired(expiresAt: number | undefined, nowSeconds: number): boolean {
	return expiresAt !== undefined && expiresAt <= nowSeconds;
}

function toConversation(record: ConversationRecord): StoredConversation {
	const conversation: StoredConversation = {
		id: record.id,
		object: "conversation",
		created_at: record.created_at,
		updated_at: record.updated_at,
		metadata: record.metadata,
	};

	if (record.expires_at !== undefined) {
		conversation.expires_at = record.expires_at;
	}

	return conversation;
}

export class InMemoryStateStore {
	private readonly conversations = new Map<string, ConversationRecord>();
	private readonly responseHistories = new Map<string, ResponseHistoryRecord>();
	private readonly cleanupTimer: ReturnType<typeof setInterval> | undefined;

	constructor(private readonly ttlSeconds = getStateTtlSeconds()) {
		if (ttlSeconds > 0) {
			this.cleanupTimer = setInterval(() => {
				this.cleanupExpired();
			}, CLEANUP_INTERVAL_MS);
			this.cleanupTimer.unref?.();
		}
	}

	dispose(): void {
		if (this.cleanupTimer) {
			clearInterval(this.cleanupTimer);
		}
	}

	cleanupExpired(nowSeconds = Math.floor(Date.now() / 1000)): void {
		if (this.ttlSeconds <= 0) {
			return;
		}

		for (const [id, conversation] of this.conversations) {
			if (isExpired(conversation.expires_at, nowSeconds)) {
				this.conversations.delete(id);
			}
		}

		for (const [id, history] of this.responseHistories) {
			if (isExpired(history.expires_at, nowSeconds)) {
				this.responseHistories.delete(id);
			}
		}
	}

	createConversation(params: {
		metadata?: Record<string, string> | null;
		items?: ResponseInputItem[];
	}): StoredConversation {
		const nowSeconds = Math.floor(Date.now() / 1000);
		this.cleanupExpired(nowSeconds);

		const id = generateUniqueId("conv");
		const record: ConversationRecord = {
			id,
			object: "conversation",
			created_at: nowSeconds,
			updated_at: nowSeconds,
			metadata: params.metadata ?? null,
			items: cloneItems(params.items ?? []).map(normalizeItemForStorage),
			expires_at: getExpiresAt(nowSeconds, this.ttlSeconds),
		};
		this.conversations.set(id, record);
		return toConversation(record);
	}

	getConversation(id: string): StoredConversation | undefined {
		const record = this.getConversationRecord(id);
		return record ? toConversation(record) : undefined;
	}

	updateConversation(id: string, params: { metadata: Record<string, string> | null }): StoredConversation | undefined {
		const record = this.getConversationRecord(id);
		if (!record) {
			return undefined;
		}

		const nowSeconds = Math.floor(Date.now() / 1000);
		record.metadata = params.metadata;
		record.updated_at = nowSeconds;
		record.expires_at = getExpiresAt(nowSeconds, this.ttlSeconds);
		return toConversation(record);
	}

	deleteConversation(id: string): boolean {
		this.cleanupExpired();
		return this.conversations.delete(id);
	}

	appendConversationItems(id: string, items: ResponseInputItem[]): ResponseInputItem[] | undefined {
		const record = this.getConversationRecord(id);
		if (!record) {
			return undefined;
		}

		const nowSeconds = Math.floor(Date.now() / 1000);
		const normalizedItems = cloneItems(items).map(normalizeItemForStorage);
		record.items.push(...normalizedItems);
		record.updated_at = nowSeconds;
		record.expires_at = getExpiresAt(nowSeconds, this.ttlSeconds);
		return cloneItems(normalizedItems);
	}

	listConversationItems(id: string): ResponseInputItem[] | undefined {
		const record = this.getConversationRecord(id);
		return record ? cloneItems(record.items) : undefined;
	}

	getConversationItem(id: string, itemId: string): ResponseInputItem | undefined {
		const record = this.getConversationRecord(id);
		const item = record?.items.find((storedItem) => getItemId(storedItem) === itemId);
		return item ? (JSON.parse(JSON.stringify(item)) as ResponseInputItem) : undefined;
	}

	deleteConversationItem(id: string, itemId: string): boolean | undefined {
		const record = this.getConversationRecord(id);
		if (!record) {
			return undefined;
		}

		const index = record.items.findIndex((item) => getItemId(item) === itemId);
		if (index === -1) {
			return false;
		}

		const nowSeconds = Math.floor(Date.now() / 1000);
		record.items.splice(index, 1);
		record.updated_at = nowSeconds;
		record.expires_at = getExpiresAt(nowSeconds, this.ttlSeconds);
		return true;
	}

	storeResponseHistory(id: string, items: ResponseInputItem[]): void {
		const nowSeconds = Math.floor(Date.now() / 1000);
		this.cleanupExpired(nowSeconds);
		this.responseHistories.set(id, {
			id,
			items: cloneItems(items),
			expires_at: getExpiresAt(nowSeconds, this.ttlSeconds),
		});
	}

	getResponseHistory(id: string): ResponseInputItem[] | undefined {
		this.cleanupExpired();
		const record = this.responseHistories.get(id);
		if (!record) {
			return undefined;
		}
		return cloneItems(record.items);
	}

	private getConversationRecord(id: string): ConversationRecord | undefined {
		this.cleanupExpired();
		return this.conversations.get(id);
	}
}

function getItemId(item: ResponseInputItem): string | undefined {
	return "id" in item && typeof item.id === "string" ? item.id : undefined;
}

function normalizeItemForStorage(item: ResponseInputItem): ResponseInputItem {
	if (!("id" in item) || item.id === undefined || item.id === null) {
		Object.assign(item, { id: generateItemId(item) });
	}

	if (shouldDefaultStatus(item) && (!("status" in item) || item.status === undefined || item.status === null)) {
		Object.assign(item, { status: "completed" });
	}

	return item;
}

function shouldDefaultStatus(item: ResponseInputItem): boolean {
	return item.type === "message" || item.type === "function_call" || item.type === "function_call_output";
}

function generateItemId(item: ResponseInputItem): string {
	switch (item.type) {
		case "function_call":
			return generateUniqueId("fc");
		case "function_call_output":
			return generateUniqueId("fco");
		case "mcp_list_tools":
			return generateUniqueId("mcpl");
		case "mcp_approval_request":
			return generateUniqueId("mcpr");
		case "mcp_approval_response":
			return generateUniqueId("mcpa");
		case "mcp_call":
			return generateUniqueId("mcp");
		case "message":
		case undefined:
			return generateUniqueId("msg");
	}
}

export const stateStore = new InMemoryStateStore();
