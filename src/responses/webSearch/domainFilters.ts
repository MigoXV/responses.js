import { URL } from "url";

export function normalizeDomains(domains: string[]): string[] {
	return domains
		.map((domain) => {
			const trimmed = domain.trim().toLowerCase();
			if (!trimmed) {
				return "";
			}
			try {
				return new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`).hostname.replace(/^www\./, "");
			} catch {
				return trimmed
					.replace(/^https?:\/\//, "")
					.replace(/\/.*$/, "")
					.replace(/^www\./, "");
			}
		})
		.filter((domain, index, all) => domain.length > 0 && all.indexOf(domain) === index);
}

export function applyDomainFilters(query: string, allowedDomains: string[], blockedDomains: string[]): string {
	const clauses = [
		...allowedDomains.map((domain) => `site:${domain}`),
		...blockedDomains.map((domain) => `-site:${domain}`),
	];
	if (clauses.length === 0) {
		return query;
	}
	return `${query} ${clauses.join(" ")}`.trim();
}

export function isAllowedResult(url: string, allowedDomains: string[], blockedDomains: string[]): boolean {
	let hostname: string;
	try {
		hostname = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
	} catch {
		return false;
	}

	if (blockedDomains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`))) {
		return false;
	}
	if (allowedDomains.length === 0) {
		return true;
	}
	return allowedDomains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
}
