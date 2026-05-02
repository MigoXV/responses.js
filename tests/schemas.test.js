import { strict as assert } from "assert";
import { createResponseParamsSchema } from "../src/schemas.ts";

describe("createResponseParamsSchema state fields", function () {
	it("requires input without previous_response_id or conversation", function () {
		const result = createResponseParamsSchema.safeParse({
			model: "test-model",
		});

		assert.equal(result.success, false);
		assert.equal(result.error.errors[0].path.join("."), "input");
	});

	it("allows omitted input when previous_response_id is provided", function () {
		const result = createResponseParamsSchema.safeParse({
			model: "test-model",
			previous_response_id: "resp_123",
		});

		assert.equal(result.success, true);
	});

	it("allows omitted input when conversation is provided", function () {
		const result = createResponseParamsSchema.safeParse({
			model: "test-model",
			conversation: "conv_123",
		});

		assert.equal(result.success, true);
	});

	it("rejects previous_response_id with conversation", function () {
		const result = createResponseParamsSchema.safeParse({
			model: "test-model",
			input: "hello",
			previous_response_id: "resp_123",
			conversation: "conv_123",
		});

		assert.equal(result.success, false);
		assert.equal(result.error.errors[0].path.join("."), "conversation");
	});
});
