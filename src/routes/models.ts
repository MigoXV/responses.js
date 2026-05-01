import type { Request, Response } from "express";
import { URL } from "url";
import { resolveUpstreamApiKey } from "../lib/auth.js";
import { createLogger } from "../lib/logger.js";

const logger = createLogger("models");

const NOT_FORWARDED_HEADERS = new Set([
	"accept-encoding",
	"authorization",
	"connection",
	"content-length",
	"host",
	"keep-alive",
	"te",
	"trailer",
	"trailers",
	"transfer-encoding",
	"upgrade",
]);

function getUpstreamModelsUrl(req: Request): URL {
	const baseUrl = process.env.OPENAI_BASE_URL ?? "https://router.huggingface.co/v1";
	const normalizedBaseUrl = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
	const path = req.path.startsWith("/v1/") ? req.path.slice(4) : req.path.replace(/^\//, "");
	const upstreamUrl = new URL(path, normalizedBaseUrl);
	const queryString = req.originalUrl.split("?")[1];
	if (queryString) {
		upstreamUrl.search = queryString;
	}

	return upstreamUrl;
}

function getForwardHeaders(req: Request, apiKey: string): Record<string, string> {
	const headers: Record<string, string> = {
		Authorization: `Bearer ${apiKey}`,
	};

	for (const [key, value] of Object.entries(req.headers)) {
		if (NOT_FORWARDED_HEADERS.has(key.toLowerCase())) {
			continue;
		}

		if (Array.isArray(value)) {
			headers[key] = value.join(", ");
			continue;
		}

		if (value !== undefined) {
			headers[key] = value;
		}
	}

	return headers;
}

async function proxyModelsRequest(req: Request, res: Response): Promise<void> {
	const upstreamApiKey = resolveUpstreamApiKey(req.headers.authorization);
	if (!upstreamApiKey.apiKey) {
		res.status(401).json({
			success: false,
			error: "Unauthorized",
		});
		return;
	}

	const upstreamUrl = getUpstreamModelsUrl(req);

	try {
		const upstreamResponse = await fetch(upstreamUrl, {
			method: "GET",
			headers: getForwardHeaders(req, upstreamApiKey.apiKey),
		});
		const bodyText = await upstreamResponse.text();
		const contentType = upstreamResponse.headers.get("content-type");

		if (contentType) {
			res.setHeader("Content-Type", contentType);
		}

		res.status(upstreamResponse.status).send(bodyText);
	} catch (error) {
		logger.error("failed to proxy upstream models request", {
			upstream_url: upstreamUrl.toString(),
			error,
		});
		res.status(502).json({
			success: false,
			error: "Failed to fetch models from upstream provider",
		});
	}
}

export async function getModels(req: Request, res: Response): Promise<void> {
	await proxyModelsRequest(req, res);
}

export async function getModelById(req: Request, res: Response): Promise<void> {
	await proxyModelsRequest(req, res);
}
