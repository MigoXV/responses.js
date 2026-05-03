import type { ResponseOutputItem } from "openai/resources/responses/responses";
import { generateUniqueId } from "../lib/generateUniqueId.js";
import { createLogger } from "../lib/logger.js";
import type { CreateResponseParams, ResponseInputItem } from "../schemas.js";
import type { PatchedResponseStreamEvent } from "../openai_patch.js";
import type { IncompleteResponse } from "./types.js";
import { SEQUENCE_NUMBER_PLACEHOLDER } from "./types.js";
import { applyDomainFilters, normalizeDomains } from "./webSearch/domainFilters.js";
import { searchWithConfiguredProvider } from "./webSearch/providers.js";
import type { WebSearchExecution, WebSearchResult, WebSearchToolConfig } from "./webSearch/types.js";

const logger = createLogger("web-search");

export { applyDomainFilters, normalizeDomains } from "./webSearch/domainFilters.js";
export type { WebSearchExecution, WebSearchResult, WebSearchToolConfig } from "./webSearch/types.js";

export function isWebSearchToolType(type: string): boolean {
	return type === "web_search" || type === "web_search_preview" || type === "web_search_preview_2025_03_11";
}

export function extractWebSearchQuery(body: CreateResponseParams): string {
	const inputText = extractLastUserText(body.input);
	const query = inputText ?? body.instructions ?? "";
	return query.trim();
}

export async function executeWebSearch(
	tool: WebSearchToolConfig,
	body: CreateResponseParams
): Promise<WebSearchExecution> {
	const query = extractWebSearchQuery(body);
	return executeWebSearchQuery(query, tool);
}

export async function executeWebSearchQuery(
	query: string,
	tool: WebSearchToolConfig = {}
): Promise<WebSearchExecution> {
	const allowedDomains = normalizeDomains(tool.filters?.allowed_domains ?? []);
	const blockedDomains = normalizeDomains(tool.filters?.blocked_domains ?? []);
	const searchQuery = applyDomainFilters(query, allowedDomains, blockedDomains);
	const resultLimit = getResultLimit(tool.search_context_size);

	let results: WebSearchResult[] = [];
	let lastError: string | undefined;
	try {
		results = await searchWithConfiguredProvider(searchQuery, resultLimit, allowedDomains, blockedDomains);
	} catch (error) {
		lastError = error instanceof Error ? error.message : String(error);
		logger.warn("web search request failed", {
			error,
		});
	}

	const error = lastError ?? (results.length === 0 ? "No search results were available." : undefined);
	return {
		query: searchQuery,
		results,
		contextMessage: buildSearchContextMessage(searchQuery, results, error),
		error,
	};
}

export async function* webSearchCallStream(
	execution: WebSearchExecution,
	responseObject: IncompleteResponse
): AsyncGenerator<PatchedResponseStreamEvent> {
	const outputObject = {
		id: generateUniqueId("ws"),
		type: "web_search_call",
		status: "in_progress",
		action: {
			type: "search",
			query: execution.query,
			sources: execution.results,
		},
	} as ResponseOutputItem & {
		type: "web_search_call";
		status: "in_progress" | "searching" | "completed" | "failed";
		action: { type: "search"; query: string; sources: WebSearchResult[] };
		error?: string;
	};

	responseObject.output.push(outputObject);

	yield {
		type: "response.output_item.added",
		output_index: responseObject.output.length - 1,
		item: outputObject,
		sequence_number: SEQUENCE_NUMBER_PLACEHOLDER,
	};

	yield {
		type: "response.web_search_call.in_progress",
		item_id: outputObject.id,
		output_index: responseObject.output.length - 1,
		sequence_number: SEQUENCE_NUMBER_PLACEHOLDER,
	};

	outputObject.status = "searching";
	yield {
		type: "response.web_search_call.searching",
		item_id: outputObject.id,
		output_index: responseObject.output.length - 1,
		sequence_number: SEQUENCE_NUMBER_PLACEHOLDER,
	};

	if (execution.error) {
		outputObject.status = "failed";
		outputObject.error = execution.error;
	} else {
		outputObject.status = "completed";
		yield {
			type: "response.web_search_call.completed",
			item_id: outputObject.id,
			output_index: responseObject.output.length - 1,
			sequence_number: SEQUENCE_NUMBER_PLACEHOLDER,
		};
	}

	yield {
		type: "response.output_item.done",
		output_index: responseObject.output.length - 1,
		item: outputObject,
		sequence_number: SEQUENCE_NUMBER_PLACEHOLDER,
	};
}

function extractLastUserText(input: CreateResponseParams["input"]): string | undefined {
	if (typeof input === "string") {
		return input;
	}
	if (!Array.isArray(input)) {
		return undefined;
	}

	for (let index = input.length - 1; index >= 0; index--) {
		const item = input[index];
		if (item.type === "message" && item.role === "user") {
			const text = extractMessageText(item);
			if (text) {
				return text;
			}
		}
	}

	return undefined;
}

function extractMessageText(item: ResponseInputItem): string | undefined {
	if (item.type !== "message") {
		return undefined;
	}
	if (typeof item.content === "string") {
		return item.content;
	}

	const text = item.content
		.filter((content) => content.type === "input_text")
		.map((content) => content.text)
		.join("\n")
		.trim();

	return text || undefined;
}

function getResultLimit(size: WebSearchToolConfig["search_context_size"]): number {
	switch (size) {
		case "low":
			return 3;
		case "high":
			return 8;
		default:
			return 5;
	}
}

function buildSearchContextMessage(query: string, results: WebSearchResult[], error: string | undefined): string {
	const timeAnchor = buildSearchTimeAnchor();
	if (results.length === 0) {
		return `Server-side web search was attempted for query: ${query}\n${timeAnchor}\nSearch failed: ${error ?? "No search results were available."}`;
	}

	const formattedResults = results
		.map((result, index) => `${index + 1}. ${result.title}\nURL: ${result.url}\nSnippet: ${result.snippet}`)
		.join("\n\n");

	return `Server-side web search has already been completed for query: ${query}\n${timeAnchor}\nYou have current web search results below. Do not say that you cannot search the web, cannot directly access the internet, or cannot perform network searches. Answer directly from these results and cite source URLs when relevant.\n\n${formattedResults}`;
}

function buildSearchTimeAnchor(now = new Date()): string {
	const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
	return `Current server date: ${formatDateInTimeZone(now, timeZone)}\nCurrent server time zone: ${timeZone}`;
}

function formatDateInTimeZone(date: Date, timeZone: string): string {
	const parts = new Intl.DateTimeFormat("en-CA", {
		timeZone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).formatToParts(date);
	const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
	return `${values.year}-${values.month}-${values.day}`;
}
