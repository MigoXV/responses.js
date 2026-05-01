import express, { type Express } from "express";
import { createResponseParamsSchema } from "./schemas.js";
import { sanitizeResponseCreateBody } from "./middleware/sanitizeResponseCreateBody.js";
import { validateBody } from "./middleware/validation.js";
import { requestLogger } from "./middleware/logging.js";
import { getLandingPageHtml, postCreateResponse, getHealth, getModels, getModelById } from "./routes/index.js";

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

	app.post("/v1/responses", sanitizeResponseCreateBody, validateBody(createResponseParamsSchema), postCreateResponse);

	return app;
};
