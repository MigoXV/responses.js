export interface WebSearchResult {
	title: string;
	url: string;
	snippet: string;
}

export interface WebSearchExecution {
	query: string;
	results: WebSearchResult[];
	contextMessage: string;
	error?: string;
}

export interface WebSearchToolConfig {
	search_context_size?: "low" | "medium" | "high";
	filters?: {
		allowed_domains?: string[];
		blocked_domains?: string[];
	} | null;
}

export type WebSearchProvider = "auto" | "bocha" | "searxng" | "tavily" | "brave" | "bing" | "duckduckgo_html";
