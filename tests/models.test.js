import http from "http";
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

describe("GET /v1/models", function () {
	it("returns 401 when no upstream API key is available", async function () {
		await withEnv(
			{
				OPENAI_API_KEY: undefined,
				OPENAI_BASE_URL: undefined,
				LOG_HTTP: "false",
			},
			async () => {
				const appServer = await startServer(createApp());

				try {
					const response = await fetch(`${appServer.baseUrl}/v1/models`);
					const body = await response.json();

					assert.equal(response.status, 401);
					assert.deepEqual(body, {
						success: false,
						error: "Unauthorized",
					});
				} finally {
					await appServer.close();
				}
			}
		);
	});

	it("proxies the upstream models list", async function () {
		await withEnv(
			{
				OPENAI_API_KEY: undefined,
				LOG_HTTP: "false",
			},
			async () => {
				let seenAuthorization;
				let seenPath;
				const upstreamServer = await startServer((req, res) => {
					seenAuthorization = req.headers.authorization;
					seenPath = req.url;
					res.setHeader("Content-Type", "application/json");
					res.end(
						JSON.stringify({
							object: "list",
							data: [
								{
									id: "provider/model-a",
									object: "model",
								},
							],
						})
					);
				});

				try {
					await withEnv(
						{
							OPENAI_BASE_URL: `${upstreamServer.baseUrl}/v1`,
						},
						async () => {
							const appServer = await startServer(createApp());

							try {
								const response = await fetch(`${appServer.baseUrl}/v1/models`, {
									headers: {
										Authorization: "Bearer request-key",
									},
								});
								const body = await response.json();

								assert.equal(response.status, 200);
								assert.equal(seenAuthorization, "Bearer request-key");
								assert.equal(seenPath, "/v1/models");
								assert.deepEqual(body, {
									object: "list",
									data: [
										{
											id: "provider/model-a",
											object: "model",
										},
									],
								});
							} finally {
								await appServer.close();
							}
						}
					);
				} finally {
					await upstreamServer.close();
				}
			}
		);
	});
});

describe("GET /v1/models/:id", function () {
	it("returns 401 when no upstream API key is available", async function () {
		await withEnv(
			{
				OPENAI_API_KEY: undefined,
				OPENAI_BASE_URL: undefined,
				LOG_HTTP: "false",
			},
			async () => {
				const appServer = await startServer(createApp());

				try {
					const response = await fetch(`${appServer.baseUrl}/v1/models/test-model`);
					const body = await response.json();

					assert.equal(response.status, 401);
					assert.deepEqual(body, {
						success: false,
						error: "Unauthorized",
					});
				} finally {
					await appServer.close();
				}
			}
		);
	});

	it("proxies the upstream model detail request", async function () {
		await withEnv(
			{
				OPENAI_API_KEY: undefined,
				LOG_HTTP: "false",
			},
			async () => {
				let seenAuthorization;
				let seenPath;
				const upstreamServer = await startServer((req, res) => {
					seenAuthorization = req.headers.authorization;
					seenPath = req.url;
					res.setHeader("Content-Type", "application/json");
					res.end(
						JSON.stringify({
							id: "provider/model-a",
							object: "model",
						})
					);
				});

				try {
					await withEnv(
						{
							OPENAI_BASE_URL: `${upstreamServer.baseUrl}/v1`,
						},
						async () => {
							const appServer = await startServer(createApp());

							try {
								const response = await fetch(`${appServer.baseUrl}/v1/models/provider%2Fmodel-a`, {
									headers: {
										Authorization: "Bearer request-key",
									},
								});
								const body = await response.json();

								assert.equal(response.status, 200);
								assert.equal(seenAuthorization, "Bearer request-key");
								assert.equal(seenPath, "/v1/models/provider%2Fmodel-a");
								assert.deepEqual(body, {
									id: "provider/model-a",
									object: "model",
								});
							} finally {
								await appServer.close();
							}
						}
					);
				} finally {
					await upstreamServer.close();
				}
			}
		);
	});
});
