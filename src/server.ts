import express, { type Express } from "express";
import {
	createResponseParamsSchema,
	createConversationParamsSchema,
	createConversationItemsParamsSchema,
	updateConversationParamsSchema,
} from "./schemas.js";
import { sanitizeResponseCreateBody } from "./middleware/sanitizeResponseCreateBody.js";
import { validateBody } from "./middleware/validation.js";
import { requestLogger } from "./middleware/logging.js";
import {
	getLandingPageHtml,
	postCreateResponse,
	getHealth,
	getModels,
	getModelById,
	postCreateConversation,
	getConversation,
	postUpdateConversation,
	deleteConversation,
	postCreateConversationItems,
	getConversationItems,
	getConversationItem,
	deleteConversationItem,
	handleMcpRequest,
} from "./routes/index.js";

export const createApp = (): Express => {
	const app: Express = express();

	// Middleware
	app.use(requestLogger());
	app.use(express.json({ limit: "20mb" }));
	app.use(express.urlencoded({ extended: true, limit: "20mb" }));

	// Routes
	app.get("/", getLandingPageHtml);

	app.get("/health", getHealth);
	app.get("/v1/models", getModels);
	app.get("/v1/models/:modelId", getModelById);
	app.all("/mcp", handleMcpRequest);

	app.post("/v1/conversations", validateBody(createConversationParamsSchema), postCreateConversation);
	app.get("/v1/conversations/:conversationId", getConversation);
	app.post("/v1/conversations/:conversationId", validateBody(updateConversationParamsSchema), postUpdateConversation);
	app.delete("/v1/conversations/:conversationId", deleteConversation);
	app.post(
		"/v1/conversations/:conversationId/items",
		validateBody(createConversationItemsParamsSchema),
		postCreateConversationItems
	);
	app.get("/v1/conversations/:conversationId/items", getConversationItems);
	app.get("/v1/conversations/:conversationId/items/:itemId", getConversationItem);
	app.delete("/v1/conversations/:conversationId/items/:itemId", deleteConversationItem);

	app.post("/v1/responses", sanitizeResponseCreateBody, validateBody(createResponseParamsSchema), postCreateResponse);

	return app;
};
