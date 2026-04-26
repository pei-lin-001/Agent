import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, TextContent } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

interface MemoryConfig {
	enabled: boolean;
	baseUrl: string;
	addPath: string;
	searchPath: string;
	apiKey?: string;
	apiKeyCommand?: string;
	apiKeyHeader: string;
	userId: string;
	agentId: string;
	topK: number;
	requestTimeoutMs: number;
	failureCooldownMs: number;
	minPromptChars: number;
	maxTurnChars: number;
	maxMemoryChars: number;
	debug: boolean;
}

interface MemoryItem {
	id?: string;
	memory?: string;
	text?: string;
	score?: number;
	metadata?: Record<string, unknown>;
}

interface MemorySearchResponse {
	results?: MemoryItem[];
	memories?: MemoryItem[];
	data?: MemoryItem[] | { results?: MemoryItem[]; memories?: MemoryItem[] };
}

type MemoryRole = "user" | "assistant";

interface MemoryMessage {
	role: MemoryRole;
	content: string;
}

const DEFAULT_CONFIG: MemoryConfig = {
	enabled: true,
	baseUrl: process.env.MEM0_BASE_URL ?? "http://localhost:8000",
	addPath: "/memories",
	searchPath: "/search",
	apiKey: process.env.MEM0_API_KEY,
	apiKeyCommand: undefined,
	apiKeyHeader: "x-api-key",
	userId: process.env.MEM0_USER_ID ?? userInfo().username,
	agentId: process.env.MEM0_AGENT_ID ?? "personal-agent",
	topK: 5,
	requestTimeoutMs: 3000,
	failureCooldownMs: 60_000,
	minPromptChars: 12,
	maxTurnChars: 12_000,
	maxMemoryChars: 1200,
	debug: false,
};

function readConfigFile(configPath: string): { exists: boolean; config: Partial<MemoryConfig> } {
	if (!existsSync(configPath)) {
		return { exists: false, config: {} };
	}
	try {
		return { exists: true, config: JSON.parse(readFileSync(configPath, "utf-8")) as Partial<MemoryConfig> };
	} catch {
		return { exists: true, config: { enabled: false } };
	}
}

function readConfig(cwd: string): MemoryConfig {
	const globalConfigFile = readConfigFile(join(homedir(), ".pi", "agent", "memory.config.json"));
	const projectConfigFile = readConfigFile(join(cwd, ".pi", "memory.config.json"));
	const globalConfig = globalConfigFile.config;
	const projectConfig = projectConfigFile.config;
	const hasExplicitConfig = globalConfigFile.exists || projectConfigFile.exists || !!process.env.MEM0_BASE_URL;
	const merged = { ...DEFAULT_CONFIG, ...globalConfig, ...projectConfig };
	return {
		...merged,
		enabled: hasExplicitConfig ? merged.enabled : false,
		baseUrl: projectConfig.baseUrl ?? globalConfig.baseUrl ?? process.env.MEM0_BASE_URL ?? DEFAULT_CONFIG.baseUrl,
		apiKey: projectConfig.apiKey ?? globalConfig.apiKey ?? process.env.MEM0_API_KEY,
		apiKeyCommand: projectConfig.apiKeyCommand ?? globalConfig.apiKeyCommand,
		apiKeyHeader: projectConfig.apiKeyHeader ?? globalConfig.apiKeyHeader ?? DEFAULT_CONFIG.apiKeyHeader,
		userId: projectConfig.userId ?? globalConfig.userId ?? process.env.MEM0_USER_ID ?? DEFAULT_CONFIG.userId,
		agentId: projectConfig.agentId ?? globalConfig.agentId ?? process.env.MEM0_AGENT_ID ?? DEFAULT_CONFIG.agentId,
	};
}

function resolveSecretValue(value: string | undefined): string | undefined {
	if (!value) {
		return undefined;
	}
	return process.env[value] ?? value;
}

function resolveApiKey(config: MemoryConfig): string | undefined {
	if (config.apiKeyCommand) {
		return execSync(config.apiKeyCommand, {
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
	}
	return resolveSecretValue(config.apiKey);
}

function joinUrl(baseUrl: string, path: string): string {
	return `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

function truncateText(text: string, maxChars: number): string {
	const normalized = text.replace(/\s+\n/g, "\n").trim();
	if (normalized.length <= maxChars) {
		return normalized;
	}
	return `${normalized.slice(0, maxChars)}\n[truncated]`;
}

function extractTextContent(content: unknown): string {
	if (typeof content === "string") {
		return content;
	}
	if (!Array.isArray(content)) {
		return "";
	}

	return content
		.filter((part): part is TextContent => {
			return (
				typeof part === "object" &&
				part !== null &&
				"type" in part &&
				(part as { type?: unknown }).type === "text" &&
				"text" in part &&
				typeof (part as { text?: unknown }).text === "string"
			);
		})
		.map((part) => part.text)
		.join("\n");
}

function extractAssistantText(message: AssistantMessage): string {
	return message.content
		.filter((part): part is TextContent => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

function isAssistantMessage(message: unknown): message is AssistantMessage {
	if (!message || typeof message !== "object") {
		return false;
	}
	return (message as { role?: unknown }).role === "assistant";
}

async function fetchJson(
	config: MemoryConfig,
	url: string,
	body: Record<string, unknown>,
): Promise<unknown> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);
	const headers: Record<string, string> = { "content-type": "application/json" };
	const apiKey = resolveApiKey(config);
	if (apiKey) {
		headers[config.apiKeyHeader] = apiKey;
	}
	try {
		const response = await fetch(url, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
			signal: controller.signal,
		});
		if (!response.ok) {
			throw new Error(`mem0 request failed: ${response.status} ${response.statusText}`);
		}
		return await response.json();
	} finally {
		clearTimeout(timeout);
	}
}

function normalizeSearchResponse(response: unknown): MemoryItem[] {
	if (Array.isArray(response)) {
		return response.filter((item): item is MemoryItem => typeof item === "object" && item !== null);
	}
	if (!response || typeof response !== "object") {
		return [];
	}

	const value = response as MemorySearchResponse;
	if (Array.isArray(value.results)) return value.results;
	if (Array.isArray(value.memories)) return value.memories;
	if (Array.isArray(value.data)) return value.data;
	if (value.data && typeof value.data === "object") {
		if (Array.isArray(value.data.results)) return value.data.results;
		if (Array.isArray(value.data.memories)) return value.data.memories;
	}
	return [];
}

function memoryText(memory: MemoryItem): string | undefined {
	const text = memory.memory ?? memory.text;
	if (!text?.trim()) {
		return undefined;
	}
	return text.trim();
}

function formatMemories(memories: MemoryItem[], maxMemoryChars: number): string {
	const lines = memories
		.map(memoryText)
		.filter((text): text is string => text !== undefined)
		.map((text) => `- ${truncateText(text, maxMemoryChars)}`);

	if (lines.length === 0) {
		return "";
	}

	return `\n\n# Relevant Long-Term Memory\n\nThe following memories were retrieved automatically. Use them only when relevant to the user's current request; do not mention that memory retrieval happened unless the user asks.\n\n${lines.join("\n")}`;
}

function createMemoryBody(config: MemoryConfig, extra: Record<string, unknown>): Record<string, unknown> {
	return {
		user_id: config.userId,
		agent_id: config.agentId,
		...extra,
	};
}

export default function mem0MemoryExtension(pi: ExtensionAPI) {
	let config: MemoryConfig | undefined;
	let unavailableUntil = 0;
	let lastUserText = "";
	let writeQueue: Promise<void> = Promise.resolve();

	const isAvailable = (): boolean => {
		if (!config?.enabled) return false;
		return Date.now() >= unavailableUntil;
	};

	const markUnavailable = () => {
		if (!config) return;
		unavailableUntil = Date.now() + config.failureCooldownMs;
	};

	const logDebug = (message: string) => {
		if (config?.debug) {
			console.error(`[mem0-memory] ${message}`);
		}
	};

	const searchMemories = async (query: string): Promise<MemoryItem[]> => {
		if (!config || !isAvailable()) return [];
		const response = await fetchJson(
			config,
			joinUrl(config.baseUrl, config.searchPath),
			createMemoryBody(config, {
				query,
				limit: config.topK,
				top_k: config.topK,
			}),
		);
		return normalizeSearchResponse(response).slice(0, config.topK);
	};

	const addMemory = async (messages: MemoryMessage[], metadata: Record<string, unknown>): Promise<void> => {
		if (!config || !isAvailable()) return;
		await fetchJson(
			config,
			joinUrl(config.baseUrl, config.addPath),
			createMemoryBody(config, {
				messages,
				metadata,
			}),
		);
	};

	pi.on("session_start", async (_event, ctx) => {
		config = readConfig(ctx.cwd);
		unavailableUntil = 0;
		lastUserText = "";
		logDebug(`enabled=${config.enabled} baseUrl=${config.baseUrl}`);
	});

	pi.on("before_agent_start", async (event) => {
		if (!config || !isAvailable()) {
			return undefined;
		}

		const query = truncateText(event.prompt, config.maxTurnChars);
		if (query.length < config.minPromptChars) {
			return undefined;
		}

		try {
			const memories = await searchMemories(query);
			logDebug(`retrieved ${memories.length} memories`);
			const memorySection = formatMemories(memories, config.maxMemoryChars);
			if (!memorySection) {
				return undefined;
			}
			return {
				systemPrompt: `${event.systemPrompt}${memorySection}`,
			};
		} catch (error) {
			logDebug(`search failed: ${error instanceof Error ? error.message : String(error)}`);
			markUnavailable();
			return undefined;
		}
	});

	pi.on("message_end", async (event) => {
		if (event.message.role !== "user") {
			return;
		}
		lastUserText = truncateText(
			extractTextContent(event.message.content),
			config?.maxTurnChars ?? DEFAULT_CONFIG.maxTurnChars,
		);
	});

	pi.on("turn_end", async (event, ctx) => {
		if (!config || !isAvailable() || !lastUserText) {
			return;
		}
		if (
			!isAssistantMessage(event.message) ||
			event.message.stopReason === "error" ||
			event.message.stopReason === "aborted"
		) {
			return;
		}

		const assistantText = truncateText(extractAssistantText(event.message), config.maxTurnChars);
		if (!assistantText) {
			return;
		}

		const messages: MemoryMessage[] = [
			{ role: "user", content: lastUserText },
			{ role: "assistant", content: assistantText },
		];
		const metadata = {
			cwd: ctx.cwd,
			sessionId: ctx.sessionManager.getSessionId(),
			sessionFile: ctx.sessionManager.getSessionFile(),
			source: "pi-mem0-memory-extension",
		};

		writeQueue = writeQueue
			.then(() => addMemory(messages, metadata))
			.catch((error) => {
				logDebug(`write failed: ${error instanceof Error ? error.message : String(error)}`);
				markUnavailable();
			});
	});

	pi.on("session_shutdown", async () => {
		await writeQueue.catch(() => {});
	});
}
