import { type Request, type Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "crypto";
import { z } from "zod";
import { version as packageVersion } from "../../package.json";
import { createLogger } from "../lib/logger.js";
import { executeWebSearchQuery } from "../responses/webSearch.js";

const logger = createLogger("mcp-route");

const mcpSessions: Record<
	string,
	{
		server: McpServer;
		transport: StreamableHTTPServerTransport;
	}
> = {};

function createSmokeMcpServer(): McpServer {
	const server = new McpServer({
		name: "@huggingface/responses.js-smoke-mcp",
		version: packageVersion,
	});

	server.tool("get_current_date", "Return the current date and time for smoke testing MCP calls.", async () => {
		const now = new Date();
		return {
			content: [
				{
					type: "text",
					text: JSON.stringify(
						{
							date: now.toISOString().slice(0, 10),
							iso: now.toISOString(),
							asia_shanghai: now.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" }),
						},
						null,
						2
					),
				},
			],
		};
	});

	server.tool(
		"search_news",
		"Search current web/news information through the configured responses.js web search provider.",
		{
			query: z.string().describe("The search query."),
			allowed_domains: z.array(z.string()).optional().describe("Optional domain allow list."),
		},
		async ({ query, allowed_domains }) => {
			const execution = await executeWebSearchQuery(query, {
				search_context_size: "low",
				filters: allowed_domains?.length ? { allowed_domains } : undefined,
			});
			return {
				isError: Boolean(execution.error),
				content: [
					{
						type: "text",
						text: JSON.stringify(
							{
								query: execution.query,
								error: execution.error ?? null,
								results: execution.results,
							},
							null,
							2
						),
					},
				],
			};
		}
	);

	return server;
}

export async function handleMcpRequest(req: Request, res: Response): Promise<void> {
	if (req.method !== "POST" && req.method !== "GET" && req.method !== "DELETE") {
		res
			.status(405)
			.set("Allow", "POST, GET, DELETE")
			.json({
				jsonrpc: "2.0",
				error: {
					code: -32000,
					message: "Method not allowed.",
				},
				id: null,
			});
		return;
	}

	try {
		const sessionId = getMcpSessionId(req);
		const existingSession = sessionId ? mcpSessions[sessionId] : undefined;

		if (req.method === "GET" || req.method === "DELETE") {
			if (!existingSession) {
				res.status(400).json({
					jsonrpc: "2.0",
					error: {
						code: -32000,
						message: "Bad Request: invalid or missing MCP session ID.",
					},
					id: null,
				});
				return;
			}
			await existingSession.transport.handleRequest(req, res);
			if (req.method === "DELETE") {
				delete mcpSessions[sessionId as string];
			}
			return;
		}

		if (existingSession) {
			await existingSession.transport.handleRequest(req, res, req.body);
			return;
		}

		if (sessionId || !isInitializeRequest(req.body)) {
			res.status(400).json({
				jsonrpc: "2.0",
				error: {
					code: -32000,
					message: "Bad Request: no valid MCP session.",
				},
				id: null,
			});
			return;
		}

		const server = createSmokeMcpServer();
		let transport: StreamableHTTPServerTransport;
		transport = new StreamableHTTPServerTransport({
			sessionIdGenerator: randomUUID,
			enableJsonResponse: true,
			onsessioninitialized: (newSessionId) => {
				mcpSessions[newSessionId] = { server, transport };
			},
		});
		transport.onclose = () => {
			if (transport.sessionId) {
				delete mcpSessions[transport.sessionId];
			}
		};
		await server.connect(transport);
		await transport.handleRequest(req, res, req.body);
	} catch (error) {
		logger.error("failed to handle MCP request", { error });
		if (!res.headersSent) {
			res.status(500).json({
				jsonrpc: "2.0",
				error: {
					code: -32603,
					message: "Internal server error",
				},
				id: null,
			});
		}
	}
}

function getMcpSessionId(req: Request): string | undefined {
	const header = req.headers["mcp-session-id"];
	return Array.isArray(header) ? header[0] : header;
}
