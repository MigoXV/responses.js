import http from "http";
import { strict as assert } from "assert";

import { connectMcpServer } from "../src/mcp.ts";
import { createApp } from "../src/server.ts";

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

describe("MCP smoke route", function () {
	it("lists and calls readonly smoke tools", async function () {
		const appServer = await startServer(createApp());
		let client;

		try {
			client = await connectMcpServer({
				type: "mcp",
				server_label: "local",
				server_url: `${appServer.baseUrl}/mcp`,
				allowed_tools: null,
				require_approval: "never",
			});
			const list = await client.listTools();
			const toolNames = list.tools.map((tool) => tool.name).sort();

			assert.deepEqual(toolNames, ["get_current_date", "search_news"]);

			const result = await client.callTool({
				name: "get_current_date",
				arguments: {},
			});

			assert.equal(result.content[0].type, "text");
			assert.match(result.content[0].text, /"asia_shanghai"/);
		} finally {
			if (client) {
				await client.close();
			}
			await appServer.close();
		}
	});
});
