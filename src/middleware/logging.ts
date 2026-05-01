import { type Request, type Response, type NextFunction } from "express";
import { createLogger, isHealthHttpLoggingEnabled, isHttpLoggingEnabled } from "../lib/logger.js";

const logger = createLogger("http");

function shouldSkipRequestLog(req: Request, statusCode: number): boolean {
	if (!isHttpLoggingEnabled()) {
		return true;
	}

	return req.path === "/health" && statusCode >= 200 && statusCode < 300 && !isHealthHttpLoggingEnabled();
}

export function requestLogger() {
	return (req: Request, res: Response, next: NextFunction): void => {
		const startTime = Date.now();

		res.on("finish", () => {
			const durationMs = Date.now() - startTime;

			if (shouldSkipRequestLog(req, res.statusCode)) {
				return;
			}

			const context = {
				method: req.method,
				url: req.originalUrl || req.url,
				status: res.statusCode,
				duration_ms: durationMs,
			};

			if (res.statusCode >= 500) {
				logger.error("request completed", context);
				return;
			}

			if (res.statusCode >= 400) {
				logger.warn("request completed", context);
				return;
			}

			logger.info("request completed", context);
		});

		next();
	};
}
