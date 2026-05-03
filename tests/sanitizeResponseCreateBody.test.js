import { strict as assert } from "assert";
import { createResponseParamsSchema } from "../src/schemas.ts";
import { sanitizeResponseCreateBodyPayload } from "../src/middleware/sanitizeResponseCreateBody.ts";

describe("sanitizeResponseCreateBodyPayload", function () {
	it("removes unsupported tools before validation", function () {
		const body = sanitizeResponseCreateBodyPayload({
			model: "deepseek-v4-flash",
			input: "hello",
			tools: [
				{
					type: "function",
					name: "get_weather",
					parameters: {
						type: "object",
						properties: {},
					},
				},
				{
					type: "image_generation",
				},
				{
					type: "namespace",
					name: "shell",
				},
				{
					type: "web_search",
				},
				{
					type: "web_search_preview",
					search_context_size: "low",
				},
			],
		});

		assert.deepEqual(
			body.tools.map((tool) => tool.type),
			["function", "web_search", "web_search_preview"]
		);
	});

	it("removes unsupported response output items before validation", function () {
		const body = sanitizeResponseCreateBodyPayload({
			model: "deepseek-v4-flash",
			input: [
				{
					type: "message",
					role: "system",
					content: "You are helpful.",
				},
				{
					type: "message",
					role: "user",
					content: "今天新闻",
				},
				{
					type: "web_search_call",
					id: "ws_123",
					status: "failed",
					action: { type: "search", query: "今天新闻" },
					error: "No search results were available.",
				},
				{
					type: "message",
					role: "assistant",
					content: [{ type: "output_text", text: "没有找到结果。" }],
				},
			],
		});

		assert.equal(Array.isArray(body.input), true);
		assert.equal(body.input.length, 3);
		assert.equal(body.input.some((item) => item.type === "web_search_call"), false);
		assert.equal(createResponseParamsSchema.safeParse(body).success, true);
	});
});
