import { strict as assert } from "assert";
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
			],
		});

		assert.deepEqual(
			body.tools.map((tool) => tool.type),
			["function", "web_search"]
		);
	});
});
