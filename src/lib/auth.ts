type AuthorizationHeader = string | string[] | undefined;

export type UpstreamApiKeyResolution =
	| {
			apiKey: string;
			source: "environment" | "request";
	  }
	| {
			apiKey: undefined;
			source: "missing";
	  };

const extractBearerToken = (authorization: AuthorizationHeader): string | undefined => {
	const value = Array.isArray(authorization) ? authorization[0] : authorization;
	if (!value) {
		return undefined;
	}

	const match = value.match(/^Bearer\s+(.+)$/i);
	const token = match?.[1]?.trim();
	return token || undefined;
};

export const resolveUpstreamApiKey = (
	authorization: AuthorizationHeader,
	envApiKey = process.env.OPENAI_API_KEY
): UpstreamApiKeyResolution => {
	if (envApiKey) {
		return {
			apiKey: envApiKey,
			source: "environment",
		};
	}

	const clientApiKey = extractBearerToken(authorization);
	if (clientApiKey) {
		return {
			apiKey: clientApiKey,
			source: "request",
		};
	}

	return {
		apiKey: undefined,
		source: "missing",
	};
};
