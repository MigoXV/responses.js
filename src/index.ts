import "dotenv/config";
import { createApp } from "./server.js";
import { createLogger } from "./lib/logger.js";

const app = createApp();
const port = process.env.PORT || 3000;
const logger = createLogger("server");

// Start server
app.listen(port, () => {
	logger.info("server started", {
		port,
		url: `http://localhost:${port}`,
	});
	if (process.env.OPENAI_API_KEY) {
		logger.info("OPENAI_API_KEY is set; request Authorization headers will be ignored");
	}
});

// Graceful shutdown logging
process.on("SIGINT", () => {
	logger.info("server shutting down", {
		signal: "SIGINT",
	});
	process.exit(0);
});

process.on("SIGTERM", () => {
	logger.info("server shutting down", {
		signal: "SIGTERM",
	});
	process.exit(0);
});

export default app;
