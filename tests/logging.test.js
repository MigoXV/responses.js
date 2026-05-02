import http from "http";
import express from "express";
import { strict as assert } from "assert";

import { createApp } from "../src/server.ts";
import { createLogger } from "../src/lib/logger.ts";
import { requestLogger } from "../src/middleware/logging.ts";

const ENV_KEYS = ["LOG_LEVEL", "LOG_HTTP", "LOG_HTTP_HEALTH", "LOG_STREAM_EVENTS", "OPENAI_API_KEY"];

function captureConsole() {
	const entries = {
		log: [],
		warn: [],
		error: [],
		debug: [],
	};
	const originalConsole = {
		log: console.log,
		warn: console.warn,
		error: console.error,
		debug: console.debug,
	};

	for (const method of Object.keys(entries)) {
		console[method] = (...args) => {
			entries[method].push(args.map((arg) => String(arg)).join(" "));
		};
	}

	return {
		entries,
		restore() {
			console.log = originalConsole.log;
			console.warn = originalConsole.warn;
			console.error = originalConsole.error;
			console.debug = originalConsole.debug;
		},
	};
}

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

async function startServer(app) {
	const server = http.createServer(app);
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

describe("logging", function () {
	it("filters logs by level", async function () {
		await withEnv(
			{
				LOG_LEVEL: "warn",
			},
			async () => {
				const capture = captureConsole();
				try {
					const logger = createLogger("test");
					logger.info("info message");
					logger.warn("warn message");
					logger.error("error message");
					logger.debug("debug message");

					assert.equal(capture.entries.log.length, 0);
					assert.equal(capture.entries.warn.length, 1);
					assert.equal(capture.entries.error.length, 1);
					assert.equal(capture.entries.debug.length, 0);
				} finally {
					capture.restore();
				}
			}
		);
	});

	it("skips successful health checks by default", async function () {
		await withEnv(
			{
				LOG_LEVEL: "info",
				LOG_HTTP: "true",
				LOG_HTTP_HEALTH: undefined,
			},
			async () => {
				const capture = captureConsole();
				const app = express();
				app.use(requestLogger());
				app.get("/health", (_req, res) => {
					res.status(200).send("OK");
				});

				const server = await startServer(app);
				try {
					const response = await fetch(`${server.baseUrl}/health`);
					assert.equal(response.status, 200);
					assert.equal(capture.entries.log.length, 0);
					assert.equal(capture.entries.warn.length, 0);
					assert.equal(capture.entries.error.length, 0);
				} finally {
					await server.close();
					capture.restore();
				}
			}
		);
	});

	it("logs failing health checks even when health logging is disabled", async function () {
		await withEnv(
			{
				LOG_LEVEL: "info",
				LOG_HTTP: "true",
				LOG_HTTP_HEALTH: "false",
			},
			async () => {
				const capture = captureConsole();
				const app = express();
				app.use(requestLogger());
				app.get("/health", (_req, res) => {
					res.status(503).send("unhealthy");
				});

				const server = await startServer(app);
				try {
					const response = await fetch(`${server.baseUrl}/health`);
					assert.equal(response.status, 503);
					assert.equal(capture.entries.error.length, 1);
					assert.match(capture.entries.error[0], /status=503/);
					assert.match(capture.entries.error[0], /url=\/health/);
				} finally {
					await server.close();
					capture.restore();
				}
			}
		);
	});

	it("does not log request bodies on validation failures", async function () {
		await withEnv(
			{
				LOG_LEVEL: "info",
				LOG_HTTP: "false",
			},
			async () => {
				const capture = captureConsole();
				const server = await startServer(createApp());
				const secretMarker = "sensitive-body-marker";

				try {
					const response = await fetch(`${server.baseUrl}/v1/responses`, {
						method: "POST",
						headers: {
							"Content-Type": "application/json",
						},
						body: JSON.stringify({
							input: secretMarker,
						}),
					});

					assert.equal(response.status, 400);
					assert.equal(capture.entries.warn.length, 1);

					const allLogLines = Object.values(capture.entries).flat().join("\n");
					assert.ok(!allLogLines.includes(secretMarker));
				} finally {
					await server.close();
					capture.restore();
				}
			}
		);
	});

	it("does not emit stream debug logs when LOG_STREAM_EVENTS is disabled", async function () {
		await withEnv(
			{
				LOG_LEVEL: "debug",
				LOG_HTTP: "false",
				LOG_STREAM_EVENTS: "false",
				OPENAI_API_KEY: "test-key",
			},
			async () => {
				const capture = captureConsole();
				const server = await startServer(createApp());

				try {
					const response = await fetch(`${server.baseUrl}/v1/responses`, {
						method: "POST",
						headers: {
							"Content-Type": "application/json",
						},
						body: JSON.stringify({
							model: "test-model",
							input: "hello",
							stream: true,
							reasoning: {
								summary: "concise",
							},
						}),
					});

					assert.equal(response.status, 200);
					assert.equal(capture.entries.debug.length, 0);
				} finally {
					await server.close();
					capture.restore();
				}
			}
		);
	});

	it("emits stream debug logs when LOG_STREAM_EVENTS is enabled", async function () {
		await withEnv(
			{
				LOG_LEVEL: "debug",
				LOG_HTTP: "false",
				LOG_STREAM_EVENTS: "true",
				OPENAI_API_KEY: "test-key",
			},
			async () => {
				const capture = captureConsole();
				const server = await startServer(createApp());

				try {
					const response = await fetch(`${server.baseUrl}/v1/responses`, {
						method: "POST",
						headers: {
							"Content-Type": "application/json",
						},
						body: JSON.stringify({
							model: "test-model",
							input: "hello",
							stream: true,
							reasoning: {
								summary: "concise",
							},
						}),
					});

					assert.equal(response.status, 200);
					assert.ok(capture.entries.debug.some((line) => line.includes("stream request started")));
					assert.ok(capture.entries.debug.some((line) => line.includes("stream event")));
				} finally {
					await server.close();
					capture.restore();
				}
			}
		);
	});
});
