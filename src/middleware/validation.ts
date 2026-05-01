/**
 * AI-generated file using Cursor + Claude 4
 */

import { type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import { createLogger } from "../lib/logger.js";

const logger = createLogger("validation");

/**
 * Middleware to validate request body against a Zod schema
 * @param schema - Zod schema to validate against
 * @returns Express middleware function
 */
export function validateBody<T extends z.ZodTypeAny>(schema: T) {
	return (req: Request, res: Response, next: NextFunction): void => {
		try {
			const validatedBody = schema.parse(req.body);
			req.body = validatedBody;
			next();
		} catch (error) {
			if (error instanceof z.ZodError) {
				const firstIssue = error.errors[0];
				logger.warn("request validation failed", {
					method: req.method,
					url: req.originalUrl || req.url,
					error_count: error.errors.length,
					first_error_path: firstIssue?.path.join(".") || "(root)",
					first_error_message: firstIssue?.message,
				});
				res.status(400).json({
					success: false,
					error: error.errors,
					details: error.errors,
				});
			} else {
				logger.error("request validation failed with unexpected error", {
					method: req.method,
					url: req.originalUrl || req.url,
					error,
				});
				res.status(500).json({
					success: false,
					error: "Internal server error",
				});
			}
		}
	};
}

/**
 * Type helper to create a properly typed request with validated body
 */
export interface ValidatedRequest<T> extends Request {
	body: T;
}
