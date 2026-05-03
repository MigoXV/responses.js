import { type NextFunction, type Request, type Response } from "express";

const sanitizeInputItem = (item: unknown): unknown => {
	if (!item || typeof item !== "object") {
		return item;
	}

	const typedItem = item as { type?: string; role?: string; content?: unknown };

	if (typedItem.type === "reasoning") {
		return null;
	}

	if (!typedItem.type || typedItem.type === "message") {
		if (!Array.isArray(typedItem.content)) {
			return item;
		}

		if (typedItem.role === "assistant") {
			const content = typedItem.content.filter((contentItem) => {
				if (!contentItem || typeof contentItem !== "object") {
					return false;
				}
				const type = (contentItem as { type?: string }).type;
				return type === "output_text" || type === "refusal";
			});
			return content.length > 0 ? { ...typedItem, content } : null;
		}

		if (typedItem.role === "user" || typedItem.role === "system" || typedItem.role === "developer") {
			const content = typedItem.content.filter((contentItem) => {
				if (!contentItem || typeof contentItem !== "object") {
					return false;
				}
				const type = (contentItem as { type?: string }).type;
				return type === "input_text" || type === "input_image";
			});
			return content.length > 0 ? { ...typedItem, content } : null;
		}
	}

	return item;
};

const sanitizeTool = (tool: unknown): unknown => {
	if (!tool || typeof tool !== "object") {
		return null;
	}

	const typedTool = tool as {
		type?: string;
		name?: unknown;
		parameters?: unknown;
		server_label?: unknown;
		server_url?: unknown;
	};
	switch (typedTool.type) {
		case "function":
			return typeof typedTool.name === "string" && typedTool.parameters && typeof typedTool.parameters === "object"
				? tool
				: null;
		case "web_search":
		case "web_search_preview":
		case "web_search_preview_2025_03_11":
			return tool;
		case "mcp":
			return typeof typedTool.server_label === "string" && typeof typedTool.server_url === "string" ? tool : null;
		default:
			return null;
	}
};

export const sanitizeResponseCreateBodyPayload = (body: unknown): unknown => {
	if (!body || typeof body !== "object") {
		return body;
	}

	const typedBody = body as { input?: unknown; tools?: unknown };
	const sanitizedBody = { ...typedBody };

	if (Array.isArray(typedBody.input)) {
		sanitizedBody.input = typedBody.input.map(sanitizeInputItem).filter((item) => item !== null);
	}

	if (Array.isArray(typedBody.tools)) {
		const tools = typedBody.tools.map(sanitizeTool).filter((tool) => tool !== null);
		sanitizedBody.tools = tools.length > 0 ? tools : undefined;
	}

	return sanitizedBody;
};

export const sanitizeResponseCreateBody = (req: Request, _res: Response, next: NextFunction): void => {
	req.body = sanitizeResponseCreateBodyPayload(req.body);
	next();
};
