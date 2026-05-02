import { type Response as ExpressResponse } from "express";
import { resolveUpstreamApiKey } from "../lib/auth.js";
import { createLogger, isStreamEventsLoggingEnabled } from "../lib/logger.js";
import { type ValidatedRequest } from "../middleware/validation.js";
import { runCreateResponseStream } from "../responses/runCreateResponseStream.js";
import { resolveResponseStateContext } from "../responses/responseState.js";
import type { CreateResponseParams } from "../schemas.js";

const logger = createLogger("responses");

function shouldLogStreamDebug(): boolean {
	return isStreamEventsLoggingEnabled();
}

export const postCreateResponse = async (
	req: ValidatedRequest<CreateResponseParams>,
	res: ExpressResponse
): Promise<void> => {
	const upstreamApiKey = resolveUpstreamApiKey(req.headers.authorization);
	if (!upstreamApiKey.apiKey) {
		res.status(401).json({
			success: false,
			error: "Unauthorized",
		});
		return;
	}

	const stateContext = resolveResponseStateContext(req.body);
	if ("error" in stateContext) {
		res.status(404).json({
			success: false,
			error: stateContext.error,
		});
		return;
	}

	req.body = {
		...req.body,
		input: stateContext.effectiveInput,
	};

	// To avoid duplicated code, we run all requests as stream.
	const events = runCreateResponseStream(req, upstreamApiKey.apiKey, stateContext);

	// Then we return in the correct format depending on the user 'stream' flag.
	if (req.body.stream) {
		res.setHeader("Content-Type", "text/event-stream");
		res.setHeader("Connection", "keep-alive");
		if (shouldLogStreamDebug()) {
			logger.debug("stream request started", {
				response_id: req.body.metadata?.response_id,
			});
		}
		for await (const event of events) {
			if (shouldLogStreamDebug()) {
				logger.debug("stream event", {
					sequence_number: event.sequence_number,
					event_type: event.type,
				});
			}
			res.write(`data: ${JSON.stringify(event)}\n\n`);
		}
		res.end();
	} else {
		if (shouldLogStreamDebug()) {
			logger.debug("non-stream request started");
		}
		for await (const event of events) {
			if (event.type === "response.completed" || event.type === "response.failed") {
				if (shouldLogStreamDebug()) {
					logger.debug("non-stream terminal event", {
						event_type: event.type,
					});
				}
				res.json(event.response);
			}
		}
	}
};
