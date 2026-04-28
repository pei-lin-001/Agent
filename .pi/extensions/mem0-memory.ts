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
	/** Half-life in days for time-based score decay. 0 = no decay. Default: 30. */
	decayHalfLifeDays: number;
}

interface MemoryItem {
	id?: string;
	memory?: string;
	text?: string;
	score?: number;
	metadata?: Record<string, unknown>;
	created_at?: string;
	updated_at?: string;
}

interface MemorySearchResponse {
	results?: MemoryItem[];
	memories?: MemoryItem[];
	data?: MemoryItem[] | { results?: MemoryItem[]; memories?: MemoryItem[] };
}

type MemoryRole = "user" | "assistant";

export interface MemoryMessage {
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
	requestTimeoutMs: 10_000,
	failureCooldownMs: 60_000,
	minPromptChars: 12,
	maxTurnChars: 12_000,
	maxMemoryChars: 1200,
	debug: false,
	decayHalfLifeDays: 30,
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

// ── Network helpers ─────────────────────────────────────────────────────────

async function fetchJson(
	config: MemoryConfig,
	url: string,
	body: Record<string, unknown>,
	method: string = "POST",
	timeoutMs?: number,
): Promise<unknown> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs ?? config.requestTimeoutMs);
	const headers: Record<string, string> = { "content-type": "application/json" };
	const apiKey = resolveApiKey(config);
	if (apiKey) {
		headers[config.apiKeyHeader] = apiKey;
	}
	try {
		const response = await fetch(url, {
			method,
			headers,
			body: method !== "DELETE" && method !== "GET" ? JSON.stringify(body) : undefined,
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

async function fetchDelete(config: MemoryConfig, url: string): Promise<void> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);
	const headers: Record<string, string> = {};
	const apiKey = resolveApiKey(config);
	if (apiKey) {
		headers[config.apiKeyHeader] = apiKey;
	}
	try {
		const response = await fetch(url, {
			method: "DELETE",
			headers,
			signal: controller.signal,
		});
		if (!response.ok) {
			throw new Error(`mem0 delete failed: ${response.status} ${response.statusText}`);
		}
	} finally {
		clearTimeout(timeout);
	}
}

// ── Response normalization ─────────────────────────────────────────────────

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

function normalizeAddResponse(response: unknown): string[] {
	const items = normalizeSearchResponse(response);
	return items.map((item) => item.id).filter((id): id is string => !!id);
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

// ── Extension ──────────────────────────────────────────────────────────────

const DEDUP_SEED_QUERIES = [
	"multi-agent orchestrator implementation task dispatcher",
	"project status step completed",
	"memory system mem0 cleanup stale",
	"Ollama Cloud model provider",
	"personal agent extension worker",
];

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

	/** Apply time-based score decay. Score decays exponentially based on memory age.
	 *  A memory created `halfLife` days ago has its score multiplied by 0.5.
	 *  decay_factor = 0.5 ^ (age_days / halfLife_days)
	 */
	const applyDecay = (items: MemoryItem[], halfLifeDays: number): MemoryItem[] => {
		if (halfLifeDays <= 0) return items;
		const now = Date.now();
		const halfLifeMs = halfLifeDays * 24 * 60 * 60 * 1000;
		return items.map((item) => {
			if (item.score === undefined || item.score === null || !item.created_at) return item;
			const createdMs = new Date(item.created_at).getTime();
			if (isNaN(createdMs)) return item;
			const ageMs = now - createdMs;
			if (ageMs <= 0) return item;
			const decayFactor = Math.pow(0.5, ageMs / halfLifeMs);
			return { ...item, score: item.score * decayFactor };
		});
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
		const raw = normalizeSearchResponse(response).slice(0, config.topK);
		return applyDecay(raw, config.decayHalfLifeDays);
	};

	const addMemory = async (messages: MemoryMessage[], metadata: Record<string, unknown>): Promise<string[]> => {
		if (!config || !isAvailable()) return [];
		// mem0 add triggers LLM fact extraction — needs longer timeout
		const response = await fetchJson(
			config,
			joinUrl(config.baseUrl, config.addPath),
			createMemoryBody(config, {
				messages,
				metadata,
			}),
			"POST",
			60_000,
		);
		return normalizeAddResponse(response);
	};

	const deleteMemory = async (memoryId: string): Promise<void> => {
		if (!config || !isAvailable()) return;
		await fetchDelete(config, joinUrl(config.baseUrl, `/memories/${memoryId}`));
	};

	// ── Per-turn cleanup: after writing, search for same-topic stale entries ──

	const cleanupStaleMemories = async (query: string, newIds: string[]): Promise<void> => {
		if (!config || !isAvailable() || newIds.length === 0) return;
		// Brief delay to allow mem0 vector indexing to complete
		await new Promise((r) => setTimeout(r, 1000));
		const results = await searchMemories(query);
		if (results.length <= 1) return;

		const newIdSet = new Set(newIds);
		// Guard: if the newly added memory isn't in the top results, indexing may not be complete yet
		const topIds = new Set(results.slice(0, 3).map((r) => r.id));
		const newInTop = [...newIdSet].some((id) => topIds.has(id));
		if (!newInTop) return;

		// Delete older entries with high similarity (same topic cluster)
		const sorted = results
			.filter((m) => m.id && m.score !== undefined && m.score !== null)
			.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

		const topScore = sorted[0]?.score ?? 0;
		// Only cleanup when results clearly cluster
		if (topScore < 0.6) return;

		// Collect candidates above score threshold
		const candidates = sorted.filter(
			(m) => m.id && !newIdSet.has(m.id) && (m.score ?? 0) >= topScore * 0.75,
		);

		// LLM-assisted dedup: ask mem0 server which candidates are superseded/contradicted
		const newMemoryText = results.find((m) => m.id && newIdSet.has(m.id))?.memory ?? "";

		async function llmDedup(newText: string, cands: MemoryItem[]): Promise<string[]> {
			if (!config || !isAvailable() || cands.length === 0) return [];
			try {
				const dedupUrl = joinUrl(config.baseUrl, "/dedup");
				const response = await fetchJson(
					config,
					dedupUrl,
					createMemoryBody(config, {
						new_memory: newText,
						candidates: cands.map((m) => ({
							id: m.id!,
							text: m.memory ?? m.text ?? "",
							score: m.score ?? 0,
						})),
					}),
				);
				if (response && typeof response === "object" && "delete_ids" in (response as Record<string, unknown>)) {
					return ((response as Record<string, unknown>).delete_ids as string[]).filter((id): id is string => typeof id === "string");
				}
				return [];
			} catch (_e) {
				logDebug(`LLM dedup failed, falling back to score-based: ${_e instanceof Error ? _e.message : String(_e)}`);
				return [];
			}
		}

		const deleteIds = await llmDedup(newMemoryText, candidates);

		if (deleteIds.length > 0) {
			// LLM identified specific memories to delete
			logDebug(`LLM dedup identified ${deleteIds.length} stale memories`);
			for (const id of deleteIds) {
				try {
					await deleteMemory(id);
					logDebug(`LLM dedup: deleted ${id}`);
				} catch (_e) {
					// cleanup failure is non-critical
				}
			}
		} else {
			// LLM didn't identify any, or call failed: fall back to score-based
			logDebug(`LLM dedup returned no deletions, using score-based fallback`);
			for (const mem of candidates) {
				if (mem.id) {
					try {
					await deleteMemory(mem.id);
					logDebug(`score-based dedup: deleted ${mem.id} (score ${(mem.score ?? 0).toFixed(3)})`);
				} catch (_e) {
					// cleanup failure is non-critical
				}
				}
			}
		}
	};

	// ── Session-start full dedup: sweep seed queries for stale clusters ──

	const runFullDedup = async (): Promise<void> => {
		if (!config || !isAvailable()) return;
		logDebug("full dedup sweep started");
		let deleted = 0;
		for (const query of DEDUP_SEED_QUERIES) {
			try {
				// Use higher limit for full dedup sweep
				const response = await fetchJson(
					config,
					joinUrl(config.baseUrl, config.searchPath),
					createMemoryBody(config, { query, limit: 20, top_k: 20 }),
				);
				const results = normalizeSearchResponse(response);
				if (results.length <= 2) continue;
				const sorted = results
					.filter((m) => m.id && m.score !== undefined && m.score !== null)
					.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
				const topScore = sorted[0]?.score ?? 0;
				if (topScore < 0.6) continue;
				for (let i = 1; i < sorted.length; i++) {
					const mem = sorted[i]!;
					if ((mem.score ?? 0) >= topScore * 0.75 && mem.id) {
						await deleteMemory(mem.id);
						deleted++;
						logDebug(`full dedup: deleted ${mem.id} (score ${mem.score!.toFixed(3)})`);
					}
				}
			} catch (_e) {
				// single query failure doesn't stop the sweep
			}
		}
		logDebug(`full dedup sweep finished: ${deleted} deleted`);
	};

	// ── Lifecycle hooks ──────────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		config = readConfig(ctx.cwd);
		unavailableUntil = 0;
		lastUserText = "";
		logDebug(`enabled=${config.enabled} baseUrl=${config.baseUrl}`);
		// Background full dedup: sweep all memories for stale clusters
		if (config?.enabled) {
			runFullDedup().catch(() => {});
		}
	});

	pi.on("before_agent_start", async (event) => {
		if (!config || !isAvailable()) {
			return undefined;
		}

		// Wait for pending writes to complete before searching, so the next turn
		// always sees the latest memories from the previous turn.
		await writeQueue.catch(() => {});

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
			.then((newIds) => {
				if (newIds.length > 0) {
					// Use combined user+assistant query for broader topic coverage
					const combinedQuery = truncateText(
						`${lastUserText}\n${assistantText.slice(0, 3000)}`,
						config?.maxTurnChars ?? DEFAULT_CONFIG.maxTurnChars,
					);
					cleanupStaleMemories(combinedQuery, newIds).catch(() => {});
				}
			})
			.catch((error) => {
				const msg = error instanceof Error ? error.message : String(error);
				// Timeouts are transient — don't mark unavailable, just log and retry next turn
				if (msg.includes("aborted") || msg.includes("AbortError") || msg.includes("timeout")) {
					logDebug(`write timed out (will retry): ${msg}`);
				} else {
					logDebug(`write failed: ${msg}`);
					markUnavailable();
				}
			});
	});

	pi.on("session_shutdown", async () => {
		await writeQueue.catch(() => {});
	});
}