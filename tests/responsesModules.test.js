import { strict as assert } from "assert";
import { buildResponseInputMessages } from "../src/responses/chatPayload.ts";
import { mapTextFormatToChatResponseFormat, buildDeepseekSystemInstruction } from "../src/responses/deepseek.ts";

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
});
