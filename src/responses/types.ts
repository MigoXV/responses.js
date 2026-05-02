import type { Response } from "openai/resources/responses/responses";
import type { CreateResponseParams, ResponseInputItem } from "../schemas.js";

export type ResponseRequestTool = NonNullable<CreateResponseParams["tools"]>[number];
export type TextFormat = NonNullable<CreateResponseParams["text"]>["format"];
export type JsonSchemaTextFormat = Extract<TextFormat, { type: "json_schema" }>;

export type IncompleteResponse = Omit<
	Response,
	"incomplete_details" | "output_text" | "parallel_tool_calls" | "tools"
> & {
	tools: ResponseRequestTool[];
};

export interface ResponseStateContext {
	conversationId?: string;
	effectiveInput: ResponseInputItem[];
	requestInput: ResponseInputItem[];
}

export const SEQUENCE_NUMBER_PLACEHOLDER = -1;

export class StreamingError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "StreamingError";
	}
}

export class StructuredOutputValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "StructuredOutputValidationError";
	}
}
