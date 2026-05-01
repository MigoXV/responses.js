const LOG_LEVEL_PRIORITY = {
	silent: 0,
	error: 1,
	warn: 2,
	info: 3,
	debug: 4,
} as const;

export type LogLevel = keyof typeof LOG_LEVEL_PRIORITY;
export type LogContext = Record<string, unknown>;

export interface Logger {
	// eslint-disable-next-line no-unused-vars
	error(message: string, context?: LogContext): void;
	// eslint-disable-next-line no-unused-vars
	warn(message: string, context?: LogContext): void;
	// eslint-disable-next-line no-unused-vars
	info(message: string, context?: LogContext): void;
	// eslint-disable-next-line no-unused-vars
	debug(message: string, context?: LogContext): void;
}

export interface LogConfig {
	level: LogLevel;
	httpEnabled: boolean;
	httpHealthEnabled: boolean;
	streamEventsEnabled: boolean;
}

const DEFAULT_LOG_LEVEL: LogLevel = "info";

function parseBooleanEnv(value: string | undefined, defaultValue: boolean): boolean {
	if (value === undefined) {
		return defaultValue;
	}

	const normalized = value.trim().toLowerCase();
	if (["1", "true", "yes", "on"].includes(normalized)) {
		return true;
	}
	if (["0", "false", "no", "off"].includes(normalized)) {
		return false;
	}

	return defaultValue;
}

function parseLogLevel(value: string | undefined): LogLevel {
	if (value === undefined) {
		return DEFAULT_LOG_LEVEL;
	}

	const normalized = value.trim().toLowerCase();
	if (normalized in LOG_LEVEL_PRIORITY) {
		return normalized as LogLevel;
	}

	return DEFAULT_LOG_LEVEL;
}

export function getLogConfig(): LogConfig {
	return {
		level: parseLogLevel(process.env.LOG_LEVEL),
		httpEnabled: parseBooleanEnv(process.env.LOG_HTTP, true),
		httpHealthEnabled: parseBooleanEnv(process.env.LOG_HTTP_HEALTH, false),
		streamEventsEnabled: parseBooleanEnv(process.env.LOG_STREAM_EVENTS, false),
	};
}

export function isLogLevelEnabled(level: LogLevel): boolean {
	const currentLevel = getLogConfig().level;
	return LOG_LEVEL_PRIORITY[currentLevel] >= LOG_LEVEL_PRIORITY[level];
}

export function isHttpLoggingEnabled(): boolean {
	return getLogConfig().httpEnabled;
}

export function isHealthHttpLoggingEnabled(): boolean {
	return getLogConfig().httpHealthEnabled;
}

export function isStreamEventsLoggingEnabled(): boolean {
	return getLogConfig().streamEventsEnabled;
}

function isSimpleToken(value: string): boolean {
	return /^[A-Za-z0-9_./:@-]+$/.test(value);
}

function serializeValue(value: unknown, includeErrorStack: boolean): string {
	if (value instanceof Error) {
		const errorValue = includeErrorStack && value.stack ? value.stack : value.message;
		return JSON.stringify(errorValue);
	}

	if (typeof value === "string") {
		return isSimpleToken(value) ? value : JSON.stringify(value);
	}

	if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
		return String(value);
	}

	if (value === null) {
		return "null";
	}

	if (value === undefined) {
		return "";
	}

	try {
		return JSON.stringify(value);
	} catch {
		return JSON.stringify(String(value));
	}
}

function formatContext(context: LogContext | undefined, includeErrorStack: boolean): string {
	if (!context) {
		return "";
	}

	const pairs = Object.entries(context)
		.filter(([, value]) => value !== undefined)
		.map(([key, value]) => `${key}=${serializeValue(value, includeErrorStack)}`);

	return pairs.length > 0 ? ` ${pairs.join(" ")}` : "";
}

function writeLog(level: LogLevel, line: string): void {
	switch (level) {
		case "error":
			console.error(line);
			break;
		case "warn":
			console.warn(line);
			break;
		case "debug":
			console.debug(line);
			break;
		default:
			console.log(line);
			break;
	}
}

function log(level: LogLevel, component: string, message: string, context?: LogContext): void {
	if (!isLogLevelEnabled(level)) {
		return;
	}

	const includeErrorStack = isLogLevelEnabled("debug");
	const line = `${new Date().toISOString()} ${level.toUpperCase()} [${component}] ${message}${formatContext(
		context,
		includeErrorStack
	)}`;

	writeLog(level, line);
}

export function createLogger(component: string): Logger {
	return {
		error(message: string, context?: LogContext): void {
			log("error", component, message, context);
		},
		warn(message: string, context?: LogContext): void {
			log("warn", component, message, context);
		},
		info(message: string, context?: LogContext): void {
			log("info", component, message, context);
		},
		debug(message: string, context?: LogContext): void {
			log("debug", component, message, context);
		},
	};
}
