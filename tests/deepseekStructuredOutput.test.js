import http from "http";
import { Buffer } from "node:buffer";
import { strict as assert } from "assert";

import { createApp } from "../src/server.ts";

const ENV_KEYS = ["OPENAI_API_KEY", "OPENAI_BASE_URL", "LOG_HTTP"];

function withEnv(overrides, callback) {
	const previousValues = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

	for (const key of ENV_KEYS) {
		if (Object.prototype.hasOwnProperty.call(overrides, key)) {
			const value = overrides[key];
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
	}

	return Promise.resolve()
		.then(callback)
		.finally(() => {
			for (const key of ENV_KEYS) {
				const previousValue = previousValues[key];
				if (previousValue === undefined) {
					delete process.env[key];
				} else {
					process.env[key] = previousValue;
				}
			}
		});
}

async function startServer(requestListener) {
	const server = http.createServer(requestListener);
	await new Promise((resolve) => {
		server.listen(0, "127.0.0.1", resolve);
	});

	const address = server.address();
	if (!address || typeof address === "string") {
		throw new Error("Failed to start test server");
	}

	return {
		baseUrl: `http://127.0.0.1:${address.port}`,
		close: () =>
			new Promise((resolve, reject) => {
				server.close((error) => {
					if (error) {
						reject(error);
						return;
					}
					resolve();
				});
			}),
	};
}

async function readJsonBody(req) {
	const chunks = [];
	for await (const chunk of req) {
		chunks.push(chunk);
	}
	return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function writeChatCompletionStream(res, content) {
	res.statusCode = 200;
	res.setHeader("Content-Type", "text/event-stream");
	const baseChunk = {
		id: "chatcmpl_test",
		object: "chat.completion.chunk",
		created: 1,
		model: "deepseek-chat",
	};
	res.write(
		`data: ${JSON.stringify({
			...baseChunk,
			choices: [{ index: 0, delta: { content }, finish_reason: null }],
		})}\n\n`
	);
	res.write(
		`data: ${JSON.stringify({
			...baseChunk,
			choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
		})}\n\n`
	);
	res.write("data: [DONE]\n\n");
	res.end();
}

async function runWithFakeUpstream(upstreamContents, callback) {
	const upstreamRequests = [];
	const upstreamServer = await startServer(async (req, res) => {
		assert.equal(req.method, "POST");
		assert.equal(req.url, "/v1/chat/completions");
		upstreamRequests.push(await readJsonBody(req));
		const content = upstreamContents[Math.min(upstreamRequests.length - 1, upstreamContents.length - 1)];
		writeChatCompletionStream(res, content);
	});

	try {
		await withEnv(
			{
				OPENAI_API_KEY: undefined,
				OPENAI_BASE_URL: `${upstreamServer.baseUrl}/v1`,
				LOG_HTTP: "false",
			},
			async () => {
				const appServer = await startServer(createApp());
				try {
					await callback({ appServer, upstreamRequests });
				} finally {
					await appServer.close();
				}
			}
		);
	} finally {
		await upstreamServer.close();
	}
}

async function createResponse(baseUrl, body) {
	const response = await fetch(`${baseUrl}/v1/responses`, {
		method: "POST",
		headers: {
			Authorization: "Bearer test-key",
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			model: "deepseek-chat",
			input: "Extract the requested data.",
			...body,
		}),
	});
	assert.equal(response.status, 200);
	return response.json();
}

const schemaFormat = {
	type: "json_schema",
	name: "person",
	schema: {
		type: "object",
		properties: {
			name: { type: "string" },
			age: { type: "number" },
		},
		required: ["name", "age"],
		additionalProperties: false,
	},
	strict: true,
};

describe("DeepSeek structured output fallback", function () {
	it("maps json_object to DeepSeek response_format json_object", async function () {
		await runWithFakeUpstream(['{"ok":true}'], async ({ appServer, upstreamRequests }) => {
			const body = await createResponse(appServer.baseUrl, {
				text: { format: { type: "json_object" } },
			});

			assert.equal(body.status, "completed");
			assert.deepEqual(upstreamRequests[0].response_format, { type: "json_object" });
		});
	});

	it("does not forward OpenAI json_schema response_format to DeepSeek", async function () {
		await runWithFakeUpstream(['{"name":"Alice","age":30}'], async ({ appServer, upstreamRequests }) => {
			const body = await createResponse(appServer.baseUrl, {
				text: { format: schemaFormat },
			});

			assert.equal(body.status, "completed");
			assert.deepEqual(upstreamRequests[0].response_format, { type: "json_object" });
			assert.ok(!("json_schema" in upstreamRequests[0].response_format));
		});
	});

	it("returns completed with pure JSON output_text when json_schema fallback succeeds", async function () {
		await runWithFakeUpstream(
			['```json\n{"name":"Alice","age":30}\n```', '{"name":"Alice","age":30}'],
			async ({ appServer }) => {
				const body = await createResponse(appServer.baseUrl, {
					text: { format: schemaFormat },
				});

				assert.equal(body.status, "completed");
				assert.equal(body.output[0].type, "message");
				assert.equal(body.output[0].content[0].type, "output_text");
				assert.equal(body.output[0].content[0].text, '{"name":"Alice","age":30}');
				assert.deepEqual(JSON.parse(body.output[0].content[0].text), { name: "Alice", age: 30 });
			}
		);
	});

	it("retries with validation errors when the first DeepSeek output fails schema validation", async function () {
		await runWithFakeUpstream(
			['{"name":"Alice"}', '{"name":"Alice","age":30}'],
			async ({ appServer, upstreamRequests }) => {
				const body = await createResponse(appServer.baseUrl, {
					text: { format: schemaFormat },
				});

				assert.equal(body.status, "completed");
				assert.equal(upstreamRequests.length, 2);
				const retryMessages = upstreamRequests[1].messages.map((message) => message.content).join("\n");
				assert.match(retryMessages, /Validation error:/);
				assert.match(retryMessages, /required property 'age'/);
			}
		);
	});

	it("returns failed after all json_schema fallback retries fail", async function () {
		await runWithFakeUpstream(
			['{"name":"Alice"}', '{"name":"Alice"}', '{"name":"Alice"}'],
			async ({ appServer, upstreamRequests }) => {
				const body = await createResponse(appServer.baseUrl, {
					text: { format: schemaFormat },
				});

				assert.equal(body.status, "failed");
				assert.equal(body.error.code, "server_error");
				assert.match(body.error.message, /JSON Schema validation failed/);
				assert.equal(upstreamRequests.length, 3);
			}
		);
	});

	it("returns a Python SDK responses.parse-compatible output_text JSON string", async function () {
		await runWithFakeUpstream(['{"name":"Alice","age":30}'], async ({ appServer }) => {
			const pythonSdkLikeTextFormat = {
				type: "json_schema",
				name: "PersonModel",
				schema: {
					type: "object",
					properties: {
						name: { title: "Name", type: "string" },
						age: { title: "Age", type: "integer" },
					},
					required: ["name", "age"],
					additionalProperties: false,
				},
				strict: true,
			};

			const body = await createResponse(appServer.baseUrl, {
				text: { format: pythonSdkLikeTextFormat },
			});

			assert.equal(body.status, "completed");
			const parsed = JSON.parse(body.output[0].content[0].text);
			assert.deepEqual(parsed, { name: "Alice", age: 30 });
		});
	});
});
