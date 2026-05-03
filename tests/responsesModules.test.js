import { strict as assert } from "assert";
import { buildChatCompletionPayload, buildResponseInputMessages } from "../src/responses/chatPayload.ts";
import { mapTextFormatToChatResponseFormat, buildDeepseekSystemInstruction } from "../src/responses/deepseek.ts";
import { createResponseParamsSchema } from "../src/schemas.ts";
import { buildMcpRequestHeaders } from "../src/mcp.ts";
import { createInitialResponseObject } from "../src/responses/responseState.ts";
import { prepareToolsStream } from "../src/responses/tools.ts";

const schemaFormat = {
	type: "json_schema",
	name: "person",
	schema: {
		type: "object",
		properties: {
			name: { type: "string" },
		},
		required: ["name"],
	},
	strict: true,
};

describe("responses module helpers", function () {
	it("maps DeepSeek json_schema response format to json_object", function () {
		assert.deepEqual(mapTextFormatToChatResponseFormat(schemaFormat, { deepseekCompatible: true }), {
			type: "json_object",
		});
	});

	it("keeps non-DeepSeek json_schema response format in OpenAI shape", function () {
		assert.deepEqual(mapTextFormatToChatResponseFormat(schemaFormat, { deepseekCompatible: false }), {
			type: "json_schema",
			json_schema: {
				description: undefined,
				name: "person",
				schema: schemaFormat.schema,
				strict: false,
			},
		});
	});

	it("builds DeepSeek schema instructions with validation context", function () {
		const instruction = buildDeepseekSystemInstruction(schemaFormat);

		assert.match(instruction, /single JSON object/);
		assert.match(instruction, /Schema name: person/);
		assert.match(instruction, /Strict requested by client: true/);
		assert.match(instruction, /"required"/);
	});

	it("converts tool history differently for normal and DeepSeek-compatible modes", function () {
		const input = [
			{
				type: "function_call",
				call_id: "call_1",
				name: "get_weather",
				arguments: "{}",
			},
		];

		const normalMessages = buildResponseInputMessages({
			input,
			instructions: null,
			deepseekCompatible: false,
		});
		const deepseekMessages = buildResponseInputMessages({
			input,
			instructions: null,
			deepseekCompatible: true,
		});

		assert.deepEqual(normalMessages[0], {
			role: "tool",
			content: "{}",
			tool_call_id: "call_1",
		});
		assert.equal(deepseekMessages[0].role, "assistant");
		assert.match(deepseekMessages[0].content, /Function call/);
	});

	it("disables DeepSeek thinking mode when tools are present", function () {
		const payload = buildChatCompletionPayload({
			body: {
				model: "deepseek-v4-pro",
				input: "hello",
				metadata: null,
				instructions: null,
				max_output_tokens: null,
				conversation: null,
				previous_response_id: null,
				stream: true,
				temperature: 1,
				top_p: 1,
			},
			messages: [{ role: "user", content: "hello" }],
			tools: [
				{
					type: "function",
					function: {
						name: "get_weather",
						parameters: { type: "object", properties: {} },
					},
				},
			],
			deepseekCompatible: true,
		});

		assert.deepEqual(payload.thinking, { type: "disabled" });
	});

	it("disables DeepSeek thinking mode when tool_choice is present", function () {
		const payload = buildChatCompletionPayload({
			body: {
				model: "deepseek-v4-pro",
				input: "hello",
				metadata: null,
				instructions: null,
				max_output_tokens: null,
				conversation: null,
				previous_response_id: null,
				stream: true,
				temperature: 1,
				top_p: 1,
				tool_choice: {
					type: "function",
					name: "get_weather",
				},
			},
			messages: [{ role: "user", content: "hello" }],
			tools: undefined,
			deepseekCompatible: true,
		});

		assert.deepEqual(payload.thinking, { type: "disabled" });
	});

	it("keeps DeepSeek thinking mode default when no tools or tool_choice are present", function () {
		const payload = buildChatCompletionPayload({
			body: {
				model: "deepseek-v4-pro",
				input: "hello",
				metadata: null,
				instructions: null,
				max_output_tokens: null,
				conversation: null,
				previous_response_id: null,
				stream: true,
				temperature: 1,
				top_p: 1,
			},
			messages: [{ role: "user", content: "hello" }],
			tools: undefined,
			deepseekCompatible: true,
		});

		assert.equal(payload.thinking, undefined);
	});

	it("accepts web search tools with filters", function () {
		const parsed = createResponseParamsSchema.parse({
			model: "deepseek-v4-flash",
			input: "search today",
			tools: [
				{
					type: "web_search",
					search_context_size: "low",
					filters: {
						allowed_domains: ["www.gov.cn", "www.news.cn"],
					},
				},
				{
					type: "web_search_preview_2025_03_11",
					search_context_size: "medium",
				},
			],
			tool_choice: "required",
		});

		assert.equal(parsed.tools[0].type, "web_search");
		assert.deepEqual(parsed.tools[0].filters.allowed_domains, ["www.gov.cn", "www.news.cn"]);
		assert.equal(parsed.tools[1].type, "web_search_preview_2025_03_11");
	});

	it("omits required tool_choice when no chat tools are forwarded", function () {
		const payload = buildChatCompletionPayload({
			body: {
				model: "deepseek-v4-flash",
				input: "hello",
				metadata: null,
				instructions: null,
				max_output_tokens: null,
				conversation: null,
				previous_response_id: null,
				stream: true,
				temperature: 1,
				top_p: 1,
				tool_choice: "required",
			},
			messages: [{ role: "user", content: "hello" }],
			tools: undefined,
			deepseekCompatible: false,
		});

		assert.equal(payload.tool_choice, undefined);
	});

	it("keeps required tool_choice when chat tools are forwarded", function () {
		const payload = buildChatCompletionPayload({
			body: {
				model: "deepseek-v4-flash",
				input: "hello",
				metadata: null,
				instructions: null,
				max_output_tokens: null,
				conversation: null,
				previous_response_id: null,
				stream: true,
				temperature: 1,
				top_p: 1,
				tool_choice: "required",
			},
			messages: [{ role: "user", content: "hello" }],
			tools: [
				{
					type: "function",
					function: {
						name: "get_weather",
						parameters: { type: "object", properties: {} },
					},
				},
			],
			deepseekCompatible: false,
		});

		assert.equal(payload.tool_choice, "required");
	});

	it("maps MCP authorization to request headers without overriding explicit headers", function () {
		assert.deepEqual(
			buildMcpRequestHeaders({
				type: "mcp",
				server_label: "docs",
				server_url: "https://example.com/mcp",
				authorization: "Bearer token",
				headers: null,
				allowed_tools: null,
				require_approval: "never",
			}),
			{ Authorization: "Bearer token" }
		);

		assert.deepEqual(
			buildMcpRequestHeaders({
				type: "mcp",
				server_label: "docs",
				server_url: "https://example.com/mcp",
				authorization: "Bearer token",
				headers: { authorization: "Bearer explicit", "x-test": "1" },
				allowed_tools: null,
				require_approval: "never",
			}),
			{ authorization: "Bearer explicit", "x-test": "1" }
		);
	});

	it("redacts MCP auth fields from response tools", function () {
		const response = createInitialResponseObject({
			model: "deepseek-v4-flash",
			input: "hello",
			metadata: null,
			instructions: null,
			max_output_tokens: null,
			conversation: null,
			previous_response_id: null,
			stream: false,
			temperature: 1,
			top_p: 1,
			tools: [
				{
					type: "mcp",
					server_label: "docs",
					server_url: "https://example.com/mcp",
					authorization: "Bearer token",
					headers: { "x-secret": "secret" },
					allowed_tools: null,
					require_approval: "never",
				},
			],
		});

		assert.equal(response.tools[0].type, "mcp");
		assert.equal("authorization" in response.tools[0], false);
		assert.equal("headers" in response.tools[0], false);
	});

	it("fails required MCP when listed tools are empty", async function () {
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
					input: [
						{
							id: "mcp_list_tools_1",
							type: "mcp_list_tools",
							server_label: "local",
							tools: [],
						},
					],
					instructions: null,
					metadata: null,
					max_output_tokens: null,
					conversation: null,
					previous_response_id: null,
					stream: false,
					temperature: 1,
					top_p: 1,
					tool_choice: "required",
					tools: [
						{
							type: "mcp",
							server_label: "local",
							server_url: "http://127.0.0.1:3000/mcp",
							allowed_tools: null,
							require_approval: "never",
						},
					],
				},
				responseObject,
				toolContext
			)) {
				assert.ok(event.type);
			}
		}, /MCP server 'local' returned no tools/);
		assert.equal(toolContext.tools.length, 0);
		assert.equal(responseObject.output.length, 0);
	});
});
