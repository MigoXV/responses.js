import { strict as assert } from "assert";
import { resolveUpstreamApiKey } from "../src/lib/auth.ts";

describe("resolveUpstreamApiKey", function () {
	it("uses OPENAI_API_KEY when both environment and request keys are present", function () {
		const result = resolveUpstreamApiKey("Bearer request-key", "env-key");

		assert.deepEqual(result, {
			apiKey: "env-key",
			source: "environment",
		});
	});

	it("uses OPENAI_API_KEY when request authorization is missing", function () {
		const result = resolveUpstreamApiKey(undefined, "env-key");

		assert.deepEqual(result, {
			apiKey: "env-key",
			source: "environment",
		});
	});

	it("uses request bearer token when OPENAI_API_KEY is missing", function () {
		const result = resolveUpstreamApiKey("Bearer request-key", undefined);

		assert.deepEqual(result, {
			apiKey: "request-key",
			source: "request",
		});
	});

	it("reports missing key when neither OPENAI_API_KEY nor request bearer token is present", function () {
		const result = resolveUpstreamApiKey(undefined, undefined);

		assert.deepEqual(result, {
			apiKey: undefined,
			source: "missing",
		});
	});
});
