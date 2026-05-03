import { strict as assert } from "assert";
import {
	applyDomainFilters,
	executeWebSearch,
	normalizeDomains,
	webSearchCallStream,
} from "../src/responses/webSearch.ts";
import { prepareToolsStream } from "../src/responses/tools.ts";

const ENV_KEYS = [
	"OPENAI_RESPONSES_WEB_SEARCH_PROVIDER",
	"OPENAI_RESPONSES_WEB_SEARCH_BOCHA_API_KEY",
	"OPENAI_RESPONSES_WEB_SEARCH_BOCHA_URL",
	"OPENAI_RESPONSES_WEB_SEARCH_BOCHA_FRESHNESS",
	"OPENAI_RESPONSES_WEB_SEARCH_SEARXNG_URL",
];

describe("web search helpers", function () {
	const originalFetch = globalThis.fetch;
	const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
	const OriginalDate = Date;

	afterEach(function () {
		globalThis.fetch = originalFetch;
		globalThis.Date = OriginalDate;
		for (const key of ENV_KEYS) {
			const value = originalEnv[key];
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
	});

	it("normalizes and applies domain filters", function () {
		const allowed = normalizeDomains(["https://www.gov.cn/news", "www.news.cn", "people.com.cn"]);
		const blocked = normalizeDomains(["https://example.com/path"]);

		assert.deepEqual(allowed, ["gov.cn", "news.cn", "people.com.cn"]);
		assert.deepEqual(blocked, ["example.com"]);
		assert.equal(
			applyDomainFilters("今天 中国 时政 新闻", allowed, blocked),
			"今天 中国 时政 新闻 site:gov.cn site:news.cn site:people.com.cn -site:example.com"
		);
	});

	it("executes SearXNG search with allowed domain filtering", async function () {
		process.env.OPENAI_RESPONSES_WEB_SEARCH_PROVIDER = "searxng";
		process.env.OPENAI_RESPONSES_WEB_SEARCH_SEARXNG_URL = "http://127.0.0.1:8080";
		globalThis.fetch = async (url) => {
			assert.equal(url.origin, "http://127.0.0.1:8080");
			assert.equal(url.pathname, "/search");
			assert.equal(url.searchParams.get("format"), "json");
			assert.match(url.searchParams.get("q"), /site:gov\.cn/);
			return {
				ok: true,
				json: async () => ({
					results: [
						{
							title: "Gov title",
							url: "https://www.gov.cn/news/a.html",
							content: "Gov snippet",
						},
						{
							title: "Other title",
							url: "https://example.com/a.html",
							content: "Other snippet",
						},
					],
				}),
			};
		};

		const execution = await executeWebSearch(
			{
				search_context_size: "low",
				filters: {
					allowed_domains: ["www.gov.cn"],
				},
			},
			{
				model: "deepseek-v4-flash",
				input: "今天新闻",
				instructions: null,
				metadata: null,
				max_output_tokens: null,
				conversation: null,
				previous_response_id: null,
				stream: false,
				temperature: 1,
				top_p: 1,
			}
		);

		assert.equal(execution.results.length, 1);
		assert.equal(execution.results[0].url, "https://www.gov.cn/news/a.html");
		assert.equal(execution.error, undefined);
		assert.match(execution.contextMessage, /Gov title/);
		assert.match(execution.contextMessage, /https:\/\/www\.gov\.cn\/news\/a\.html/);
	});

	it("executes Bocha search with auth, freshness, summary, and domain filtering", async function () {
		process.env.OPENAI_RESPONSES_WEB_SEARCH_PROVIDER = "bocha";
		process.env.OPENAI_RESPONSES_WEB_SEARCH_BOCHA_API_KEY = "bocha-test-key";
		process.env.OPENAI_RESPONSES_WEB_SEARCH_BOCHA_URL = "https://api.example.test/v1/web-search";
		process.env.OPENAI_RESPONSES_WEB_SEARCH_BOCHA_FRESHNESS = "oneYear";
		globalThis.fetch = async (url, init) => {
			assert.equal(url, "https://api.example.test/v1/web-search");
			assert.equal(init.method, "POST");
			assert.equal(init.headers.Authorization, "Bearer bocha-test-key");
			assert.equal(init.headers["content-type"], "application/json");

			const payload = JSON.parse(init.body);
			assert.match(payload.query, /site:gov\.cn/);
			assert.deepEqual(payload, {
				query: "今天新闻 site:gov.cn",
				freshness: "oneYear",
				summary: true,
				count: 50,
			});

			return {
				ok: true,
				json: async () => ({
					code: 200,
					data: {
						webPages: {
							value: [
								{
									name: "Gov title",
									url: "https://www.gov.cn/news/a.html",
									snippet: "Gov snippet",
									summary: "Gov summary",
								},
								{
									name: "Other title",
									url: "https://example.com/a.html",
									snippet: "Other snippet",
									summary: "Other summary",
								},
							],
						},
					},
				}),
			};
		};

		const execution = await executeWebSearch(
			{
				search_context_size: "low",
				filters: {
					allowed_domains: ["www.gov.cn"],
				},
			},
			{
				model: "deepseek-v4-flash",
				input: "今天新闻",
				instructions: null,
				metadata: null,
				max_output_tokens: null,
				conversation: null,
				previous_response_id: null,
				stream: false,
				temperature: 1,
				top_p: 1,
			}
		);

		assert.deepEqual(execution.results, [
			{
				title: "Gov title",
				url: "https://www.gov.cn/news/a.html",
				snippet: "Gov summary",
			},
		]);
		assert.equal(execution.error, undefined);
		assert.match(execution.contextMessage, /Gov summary/);
	});

	it("adds the current server date and time zone to successful search context", async function () {
		process.env.TZ = "Asia/Shanghai";
		process.env.OPENAI_RESPONSES_WEB_SEARCH_PROVIDER = "bocha";
		process.env.OPENAI_RESPONSES_WEB_SEARCH_BOCHA_API_KEY = "bocha-test-key";
		globalThis.Date = class extends OriginalDate {
			constructor(...args) {
				return args.length === 0 ? new OriginalDate("2026-05-02T08:00:00+08:00") : new OriginalDate(...args);
			}
			static now() {
				return new OriginalDate("2026-05-02T08:00:00+08:00").getTime();
			}
		};
		globalThis.fetch = async () => ({
			ok: true,
			json: async () => ({
				code: 200,
				data: {
					webPages: {
						value: [
							{
								name: "News title",
								url: "https://www.news.cn/20260502/example.html",
								snippet: "News snippet",
							},
						],
					},
				},
			}),
		});

		const execution = await executeWebSearch(
			{
				search_context_size: "low",
			},
			{
				model: "deepseek-v4-flash",
				input: "今天新闻",
				instructions: null,
				metadata: null,
				max_output_tokens: null,
				conversation: null,
				previous_response_id: null,
				stream: false,
				temperature: 1,
				top_p: 1,
			}
		);

		assert.match(execution.contextMessage, /Current server date: 2026-05-02/);
		assert.match(execution.contextMessage, /Current server time zone: Asia\/Shanghai/);
	});

	it("instructs the model not to disclaim web search access after successful search", async function () {
		process.env.OPENAI_RESPONSES_WEB_SEARCH_PROVIDER = "bocha";
		process.env.OPENAI_RESPONSES_WEB_SEARCH_BOCHA_API_KEY = "bocha-test-key";
		globalThis.fetch = async () => ({
			ok: true,
			json: async () => ({
				code: 200,
				data: {
					webPages: {
						value: [
							{
								name: "News title",
								url: "https://www.news.cn/20260502/example.html",
								snippet: "News snippet",
							},
						],
					},
				},
			}),
		});

		const execution = await executeWebSearch(
			{
				search_context_size: "low",
			},
			{
				model: "deepseek-v4-flash",
				input: "今天新闻",
				instructions: null,
				metadata: null,
				max_output_tokens: null,
				conversation: null,
				previous_response_id: null,
				stream: false,
				temperature: 1,
				top_p: 1,
			}
		);

		assert.match(execution.contextMessage, /Server-side web search has already been completed/);
		assert.match(execution.contextMessage, /Do not say that you cannot search the web/);
		assert.match(execution.contextMessage, /cannot directly access the internet/);
	});

	it("uses Bocha in auto mode when its API key is configured", async function () {
		process.env.OPENAI_RESPONSES_WEB_SEARCH_BOCHA_API_KEY = "bocha-test-key";
		let requestedUrl;
		globalThis.fetch = async (url, init) => {
			requestedUrl = url;
			assert.equal(init.headers.Authorization, "Bearer bocha-test-key");
			assert.equal(JSON.parse(init.body).count, 5);
			return {
				ok: true,
				json: async () => ({
					code: 200,
					data: {
						webPages: {
							value: [
								{
									name: "Bocha title",
									url: "https://news.cn/a.html",
									snippet: "Bocha snippet",
								},
							],
						},
					},
				}),
			};
		};

		const execution = await executeWebSearch(
			{
				search_context_size: "medium",
			},
			{
				model: "deepseek-v4-flash",
				input: "今天新闻",
				instructions: null,
				metadata: null,
				max_output_tokens: null,
				conversation: null,
				previous_response_id: null,
				stream: false,
				temperature: 1,
				top_p: 1,
			}
		);

		assert.equal(requestedUrl, "https://api.bochaai.com/v1/web-search");
		assert.equal(execution.results[0].title, "Bocha title");
		assert.equal(execution.error, undefined);
	});

	it("does not use DuckDuckGo HTML as an automatic fallback", async function () {
		globalThis.fetch = async () => {
			throw new Error("fetch should not be called");
		};

		const execution = await executeWebSearch(
			{
				search_context_size: "low",
			},
			{
				model: "deepseek-v4-flash",
				input: "今天新闻",
				instructions: null,
				metadata: null,
				max_output_tokens: null,
				conversation: null,
				previous_response_id: null,
				stream: false,
				temperature: 1,
				top_p: 1,
			}
		);

		assert.equal(execution.results.length, 0);
		assert.equal(execution.error, "No web search provider is configured");
	});

	it("still supports DuckDuckGo HTML when explicitly configured", async function () {
		process.env.OPENAI_RESPONSES_WEB_SEARCH_PROVIDER = "duckduckgo_html";
		globalThis.fetch = async (url, init) => {
			assert.equal(url, "https://html.duckduckgo.com/html/");
			assert.match(init.body.toString(), /q=/);
			return {
				ok: true,
				text: async () => `
					<a class="result__a" href="/l/?uddg=${encodeURIComponent("https://www.gov.cn/news/a.html")}">Gov title</a>
					<a class="result__snippet">Gov snippet</a>
				`,
			};
		};

		const execution = await executeWebSearch(
			{
				search_context_size: "low",
			},
			{
				model: "deepseek-v4-flash",
				input: "今天新闻",
				instructions: null,
				metadata: null,
				max_output_tokens: null,
				conversation: null,
				previous_response_id: null,
				stream: false,
				temperature: 1,
				top_p: 1,
			}
		);

		assert.equal(execution.results.length, 1);
		assert.equal(execution.results[0].url, "https://www.gov.cn/news/a.html");
		assert.equal(execution.error, undefined);
	});

	it("marks empty SearXNG results as failed", async function () {
		process.env.OPENAI_RESPONSES_WEB_SEARCH_PROVIDER = "searxng";
		process.env.OPENAI_RESPONSES_WEB_SEARCH_SEARXNG_URL = "http://127.0.0.1:8080";
		globalThis.fetch = async () => ({
			ok: true,
			json: async () => ({ results: [] }),
		});

		const execution = await executeWebSearch(
			{
				search_context_size: "low",
			},
			{
				model: "deepseek-v4-flash",
				input: "今天新闻",
				instructions: null,
				metadata: null,
				max_output_tokens: null,
				conversation: null,
				previous_response_id: null,
				stream: false,
				temperature: 1,
				top_p: 1,
			}
		);

		assert.equal(execution.results.length, 0);
		assert.equal(execution.error, "No search results were available.");
		assert.match(execution.contextMessage, /Search failed/);
	});

	it("emits completed web_search_call output item events with sources", async function () {
		const responseObject = {
			id: "resp_1",
			object: "response",
			created_at: 1,
			status: "in_progress",
			error: null,
			instructions: null,
			max_output_tokens: null,
			metadata: null,
			model: "deepseek-v4-flash",
			output: [],
			text: undefined,
			tool_choice: "required",
			tools: [],
			temperature: 1,
			top_p: 1,
			usage: null,
		};

		const events = [];
		for await (const event of webSearchCallStream(
			{
				query: "today",
				results: [{ title: "Title", url: "https://example.com/a", snippet: "Snippet" }],
				contextMessage: "context",
			},
			responseObject
		)) {
			events.push(event);
		}

		assert.deepEqual(
			events.map((event) => event.type),
			[
				"response.output_item.added",
				"response.web_search_call.in_progress",
				"response.web_search_call.searching",
				"response.web_search_call.completed",
				"response.output_item.done",
			]
		);
		assert.equal(responseObject.output[0].type, "web_search_call");
		assert.equal(responseObject.output[0].status, "completed");
		assert.equal(responseObject.output[0].action.query, "today");
		assert.deepEqual(responseObject.output[0].action.sources, [
			{ title: "Title", url: "https://example.com/a", snippet: "Snippet" },
		]);
	});

	it("emits failed web_search_call output item events without completed event", async function () {
		const responseObject = {
			id: "resp_1",
			object: "response",
			created_at: 1,
			status: "in_progress",
			error: null,
			instructions: null,
			max_output_tokens: null,
			metadata: null,
			model: "deepseek-v4-flash",
			output: [],
			text: undefined,
			tool_choice: "required",
			tools: [],
			temperature: 1,
			top_p: 1,
			usage: null,
		};

		const events = [];
		for await (const event of webSearchCallStream(
			{
				query: "today",
				results: [],
				contextMessage: "context",
				error: "No search results were available.",
			},
			responseObject
		)) {
			events.push(event);
		}

		assert.deepEqual(
			events.map((event) => event.type),
			[
				"response.output_item.added",
				"response.web_search_call.in_progress",
				"response.web_search_call.searching",
				"response.output_item.done",
			]
		);
		assert.equal(responseObject.output[0].status, "failed");
		assert.equal(responseObject.output[0].error, "No search results were available.");
	});

	it("throws for required web search when Bocha returns no results", async function () {
		process.env.OPENAI_RESPONSES_WEB_SEARCH_PROVIDER = "bocha";
		process.env.OPENAI_RESPONSES_WEB_SEARCH_BOCHA_API_KEY = "bocha-test-key";
		globalThis.fetch = async () => ({
			ok: true,
			json: async () => ({ code: 200, data: { webPages: { value: [] } } }),
		});

		const responseObject = {
			id: "resp_1",
			object: "response",
			created_at: 1,
			status: "in_progress",
			error: null,
			instructions: null,
			max_output_tokens: null,
			metadata: null,
			model: "deepseek-v4-flash",
			output: [],
			text: undefined,
			tool_choice: "required",
			tools: [],
			temperature: 1,
			top_p: 1,
			usage: null,
		};
		const toolContext = {
			tools: [],
			mcpToolsMapping: {},
			webSearchContextMessages: [],
		};

		await assert.rejects(async () => {
			for await (const event of prepareToolsStream(
				{
					model: "deepseek-v4-flash",
					input: "今天新闻",
					instructions: null,
					metadata: null,
					max_output_tokens: null,
					conversation: null,
					previous_response_id: null,
					stream: false,
					temperature: 1,
					top_p: 1,
					tool_choice: "required",
					tools: [{ type: "web_search", search_context_size: "low" }],
				},
				responseObject,
				toolContext
			)) {
				assert.ok(event.type);
			}
		}, /Web search failed: No search results were available/);
		assert.equal(responseObject.output[0].type, "web_search_call");
		assert.equal(responseObject.output[0].status, "failed");
		assert.equal(toolContext.webSearchContextMessages.length, 0);
	});
});
