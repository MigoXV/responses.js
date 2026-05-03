import { URL, URLSearchParams } from "url";
import { isAllowedResult } from "./domainFilters.js";
import type { WebSearchProvider, WebSearchResult } from "./types.js";

const DUCKDUCKGO_SEARCH_URL = "https://html.duckduckgo.com/html/";
const BOCHA_SEARCH_URL = "https://api.bochaai.com/v1/web-search";
const BRAVE_SEARCH_URL = "https://api.search.brave.com/res/v1/web/search";
const BING_SEARCH_URL = "https://api.bing.microsoft.com/v7.0/search";
const TAVILY_SEARCH_URL = "https://api.tavily.com/search";

export async function searchWithConfiguredProvider(
	query: string,
	limit: number,
	allowedDomains: string[],
	blockedDomains: string[]
): Promise<WebSearchResult[]> {
	const provider = parseProvider(process.env.OPENAI_RESPONSES_WEB_SEARCH_PROVIDER);
	const providers = provider === "auto" ? getAutoProviders() : [provider];
	const errors: string[] = [];

	if (providers.length === 0) {
		throw new Error("No web search provider is configured");
	}

	for (const candidate of providers) {
		try {
			const results = await searchWithProvider(candidate, query, limit, allowedDomains, blockedDomains);
			if (results.length > 0 || provider !== "auto") {
				return results;
			}
		} catch (error) {
			errors.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`);
			if (provider !== "auto") {
				throw error;
			}
		}
	}

	if (errors.length > 0) {
		throw new Error(errors.join("; "));
	}
	return [];
}

function parseProvider(value: string | undefined): WebSearchProvider {
	const normalized = value?.trim().toLowerCase();
	switch (normalized) {
		case "bocha":
		case "searxng":
		case "tavily":
		case "brave":
		case "bing":
		case "duckduckgo_html":
			return normalized;
		default:
			return "auto";
	}
}

function getAutoProviders(): WebSearchProvider[] {
	const providers: WebSearchProvider[] = [];
	if (process.env.OPENAI_RESPONSES_WEB_SEARCH_BOCHA_API_KEY) {
		providers.push("bocha");
	}
	if (process.env.OPENAI_RESPONSES_WEB_SEARCH_SEARXNG_URL) {
		providers.push("searxng");
	}
	if (process.env.OPENAI_RESPONSES_WEB_SEARCH_TAVILY_API_KEY) {
		providers.push("tavily");
	}
	if (process.env.OPENAI_RESPONSES_WEB_SEARCH_BRAVE_API_KEY) {
		providers.push("brave");
	}
	if (process.env.OPENAI_RESPONSES_WEB_SEARCH_BING_API_KEY) {
		providers.push("bing");
	}
	return providers;
}

async function searchWithProvider(
	provider: WebSearchProvider,
	query: string,
	limit: number,
	allowedDomains: string[],
	blockedDomains: string[]
): Promise<WebSearchResult[]> {
	switch (provider) {
		case "bocha":
			return bochaSearch(query, limit, allowedDomains, blockedDomains);
		case "searxng":
			return searxngSearch(query, limit, allowedDomains, blockedDomains);
		case "tavily":
			return tavilySearch(query, limit, allowedDomains, blockedDomains);
		case "brave":
			return braveSearch(query, limit, allowedDomains, blockedDomains);
		case "bing":
			return bingSearch(query, limit, allowedDomains, blockedDomains);
		case "duckduckgo_html":
		case "auto":
			return duckDuckGoHtmlSearch(query, limit, allowedDomains, blockedDomains);
	}
}

async function bochaSearch(
	query: string,
	limit: number,
	allowedDomains: string[],
	blockedDomains: string[]
): Promise<WebSearchResult[]> {
	const apiKey = process.env.OPENAI_RESPONSES_WEB_SEARCH_BOCHA_API_KEY;
	if (!apiKey) {
		throw new Error("OPENAI_RESPONSES_WEB_SEARCH_BOCHA_API_KEY is not set");
	}
	const requestCount = allowedDomains.length > 0 ? Math.max(limit, 50) : limit;

	const response = await fetch(process.env.OPENAI_RESPONSES_WEB_SEARCH_BOCHA_URL ?? BOCHA_SEARCH_URL, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${apiKey}`,
			"content-type": "application/json",
		},
		body: JSON.stringify({
			query,
			freshness: process.env.OPENAI_RESPONSES_WEB_SEARCH_BOCHA_FRESHNESS ?? "noLimit",
			summary: true,
			count: requestCount,
		}),
	});
	if (!response.ok) {
		throw new Error(`Bocha returned HTTP ${response.status}`);
	}

	const json = (await response.json()) as {
		code?: number | string;
		msg?: string;
		webPages?: {
			value?: Array<{
				name?: string;
				url?: string;
				snippet?: string;
				summary?: string;
			}>;
		};
		data?: {
			webPages?: {
				value?: Array<{
					name?: string;
					url?: string;
					snippet?: string;
					summary?: string;
				}>;
			};
		};
	};
	if (json.code !== undefined && Number(json.code) !== 200) {
		throw new Error(`Bocha returned code ${json.code}${json.msg ? `: ${json.msg}` : ""}`);
	}

	return (json.webPages?.value ?? json.data?.webPages?.value ?? [])
		.map((result) => ({
			title: result.name ?? "",
			url: result.url ?? "",
			snippet: result.summary ?? result.snippet ?? "",
		}))
		.filter((result) => result.title && result.url)
		.filter((result) => isAllowedResult(result.url, allowedDomains, blockedDomains))
		.slice(0, limit);
}

async function searxngSearch(
	query: string,
	limit: number,
	allowedDomains: string[],
	blockedDomains: string[]
): Promise<WebSearchResult[]> {
	const baseUrl = process.env.OPENAI_RESPONSES_WEB_SEARCH_SEARXNG_URL;
	if (!baseUrl) {
		throw new Error("OPENAI_RESPONSES_WEB_SEARCH_SEARXNG_URL is not set");
	}

	const url = new URL("/search", baseUrl);
	url.searchParams.set("format", "json");
	url.searchParams.set("q", query);
	const response = await fetch(url);
	if (!response.ok) {
		throw new Error(`SearXNG returned HTTP ${response.status}`);
	}

	const json = (await response.json()) as {
		results?: Array<{
			title?: string;
			url?: string;
			content?: string;
		}>;
	};
	return (json.results ?? [])
		.map((result) => ({
			title: result.title ?? "",
			url: result.url ?? "",
			snippet: result.content ?? "",
		}))
		.filter((result) => result.title && result.url)
		.filter((result) => isAllowedResult(result.url, allowedDomains, blockedDomains))
		.slice(0, limit);
}

async function tavilySearch(
	query: string,
	limit: number,
	allowedDomains: string[],
	blockedDomains: string[]
): Promise<WebSearchResult[]> {
	const apiKey = process.env.OPENAI_RESPONSES_WEB_SEARCH_TAVILY_API_KEY;
	if (!apiKey) {
		throw new Error("OPENAI_RESPONSES_WEB_SEARCH_TAVILY_API_KEY is not set");
	}

	const response = await fetch(TAVILY_SEARCH_URL, {
		method: "POST",
		headers: {
			"content-type": "application/json",
		},
		body: JSON.stringify({
			api_key: apiKey,
			query,
			max_results: limit,
			include_answer: false,
		}),
	});
	if (!response.ok) {
		throw new Error(`Tavily returned HTTP ${response.status}`);
	}

	const json = (await response.json()) as {
		results?: Array<{
			title?: string;
			url?: string;
			content?: string;
		}>;
	};
	return (json.results ?? [])
		.map((result) => ({
			title: result.title ?? "",
			url: result.url ?? "",
			snippet: result.content ?? "",
		}))
		.filter((result) => result.title && result.url)
		.filter((result) => isAllowedResult(result.url, allowedDomains, blockedDomains))
		.slice(0, limit);
}

async function braveSearch(
	query: string,
	limit: number,
	allowedDomains: string[],
	blockedDomains: string[]
): Promise<WebSearchResult[]> {
	const apiKey = process.env.OPENAI_RESPONSES_WEB_SEARCH_BRAVE_API_KEY;
	if (!apiKey) {
		throw new Error("OPENAI_RESPONSES_WEB_SEARCH_BRAVE_API_KEY is not set");
	}

	const url = new URL(BRAVE_SEARCH_URL);
	url.searchParams.set("q", query);
	url.searchParams.set("count", String(limit));
	const response = await fetch(url, {
		headers: {
			"x-subscription-token": apiKey,
		},
	});
	if (!response.ok) {
		throw new Error(`Brave Search returned HTTP ${response.status}`);
	}

	const json = (await response.json()) as {
		web?: {
			results?: Array<{
				title?: string;
				url?: string;
				description?: string;
			}>;
		};
	};
	return (json.web?.results ?? [])
		.map((result) => ({
			title: result.title ?? "",
			url: result.url ?? "",
			snippet: result.description ?? "",
		}))
		.filter((result) => result.title && result.url)
		.filter((result) => isAllowedResult(result.url, allowedDomains, blockedDomains))
		.slice(0, limit);
}

async function bingSearch(
	query: string,
	limit: number,
	allowedDomains: string[],
	blockedDomains: string[]
): Promise<WebSearchResult[]> {
	const apiKey = process.env.OPENAI_RESPONSES_WEB_SEARCH_BING_API_KEY;
	if (!apiKey) {
		throw new Error("OPENAI_RESPONSES_WEB_SEARCH_BING_API_KEY is not set");
	}

	const url = new URL(BING_SEARCH_URL);
	url.searchParams.set("q", query);
	url.searchParams.set("count", String(limit));
	const response = await fetch(url, {
		headers: {
			"Ocp-Apim-Subscription-Key": apiKey,
		},
	});
	if (!response.ok) {
		throw new Error(`Bing Search returned HTTP ${response.status}`);
	}

	const json = (await response.json()) as {
		webPages?: {
			value?: Array<{
				name?: string;
				url?: string;
				snippet?: string;
			}>;
		};
	};
	return (json.webPages?.value ?? [])
		.map((result) => ({
			title: result.name ?? "",
			url: result.url ?? "",
			snippet: result.snippet ?? "",
		}))
		.filter((result) => result.title && result.url)
		.filter((result) => isAllowedResult(result.url, allowedDomains, blockedDomains))
		.slice(0, limit);
}

async function duckDuckGoHtmlSearch(
	query: string,
	limit: number,
	allowedDomains: string[],
	blockedDomains: string[]
): Promise<WebSearchResult[]> {
	if (!query) {
		return [];
	}

	const response = await fetch(DUCKDUCKGO_SEARCH_URL, {
		method: "POST",
		headers: {
			"content-type": "application/x-www-form-urlencoded",
			"user-agent": "responses.js/0.1 web-search",
		},
		body: new URLSearchParams({ q: query }),
	});

	if (!response.ok) {
		throw new Error(`Search backend returned HTTP ${response.status}`);
	}

	const html = await response.text();
	return parseDuckDuckGoResults(html)
		.filter((result) => isAllowedResult(result.url, allowedDomains, blockedDomains))
		.slice(0, limit);
}

function parseDuckDuckGoResults(html: string): WebSearchResult[] {
	const results: WebSearchResult[] = [];
	const resultPattern =
		/<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g;

	for (const match of html.matchAll(resultPattern)) {
		const url = decodeDuckDuckGoUrl(decodeHtml(match[1]));
		const title = cleanHtmlText(match[2]);
		const snippet = cleanHtmlText(match[3]);
		if (url && title) {
			results.push({ title, url, snippet });
		}
	}

	return results;
}

function decodeDuckDuckGoUrl(rawUrl: string): string {
	try {
		const url = new URL(rawUrl, DUCKDUCKGO_SEARCH_URL);
		const redirectedUrl = url.searchParams.get("uddg");
		return redirectedUrl ? decodeURIComponent(redirectedUrl) : url.toString();
	} catch {
		return rawUrl;
	}
}

function cleanHtmlText(value: string): string {
	return decodeHtml(value.replace(/<[^>]*>/g, " "))
		.replace(/\s+/g, " ")
		.trim();
}

function decodeHtml(value: string): string {
	return value
		.replace(/&amp;/g, "&")
		.replace(/&quot;/g, '"')
		.replace(/&#x27;/g, "'")
		.replace(/&#39;/g, "'")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">");
}
