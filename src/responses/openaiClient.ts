import { OpenAI } from "openai";

export function createOpenAIClient(apiKey: string | undefined, defaultHeaders: Record<string, string>): OpenAI {
	return new OpenAI({
		baseURL: process.env.OPENAI_BASE_URL ?? "https://router.huggingface.co/v1",
		apiKey,
		defaultHeaders,
	});
}
