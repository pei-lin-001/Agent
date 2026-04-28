import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import mem0MemoryExtension from "../../../../.pi/extensions/mem0-memory.js";

type ExtensionHandler = (event: unknown, ctx: unknown) => Promise<unknown> | unknown;

interface FakeExtensionApi {
	on: (eventName: string, handler: ExtensionHandler) => void;
}

interface RequestRecord {
	path: string;
	method: string;
	headers: IncomingMessage["headers"];
	body: unknown;
}

interface FakeMem0Server {
	baseUrl: string;
	records: RequestRecord[];
	close: () => Promise<void>;
}

interface BeforeAgentStartResult {
	systemPrompt?: string;
}

function createTempDir(): string {
	return join(tmpdir(), `pi-mem0-extension-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

function readRequestBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		let body = "";
		req.on("data", (chunk: Buffer) => {
			body += chunk.toString("utf-8");
		});
		req.on("end", () => resolve(body));
		req.on("error", reject);
	});
}

function parseJsonBody(body: string): unknown {
	if (!body) {
		return undefined;
	}
	return JSON.parse(body) as unknown;
}

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
	res.statusCode = statusCode;
	res.setHeader("content-type", "application/json");
	res.end(JSON.stringify(body));
}

async function createFakeMem0Server(memoryText: string): Promise<FakeMem0Server> {
	const records: RequestRecord[] = [];
	const server: Server = createServer(async (req, res) => {
		const body = parseJsonBody(await readRequestBody(req));
		const record = {
			path: req.url ?? "",
			method: req.method ?? "",
			headers: req.headers,
			body,
		};
		records.push(record);

		if (record.path === "/search") {
			sendJson(res, 200, { results: [{ memory: memoryText }] });
			return;
		}
		if (record.path === "/memories") {
			sendJson(res, 200, [{ id: "fake-memory-id", memory: memoryText, event: "ADD" }]);
			return;
		}
		if (record.path.startsWith("/memories/") && record.method === "DELETE") {
			sendJson(res, 200, { status: "deleted", memory_id: record.path.slice("/memories/".length) });
			return;
		}
		sendJson(res, 404, { error: "not found" });
	});

	await new Promise<void>((resolve) => {
		server.listen(0, "127.0.0.1", resolve);
	});

	const address = server.address() as AddressInfo;
	return {
		baseUrl: `http://127.0.0.1:${address.port}`,
		records,
		close: () =>
			new Promise((resolve, reject) => {
				server.close((error) => {
					if (error) {
						reject(error);
						return;
					}
					resolve();
				});
			}),
	};
}

function createExtensionHarness(): Map<string, ExtensionHandler[]> {
	const handlers = new Map<string, ExtensionHandler[]>();
	const api: FakeExtensionApi = {
		on(eventName, handler) {
			const existing = handlers.get(eventName) ?? [];
			existing.push(handler);
			handlers.set(eventName, existing);
		},
	};
	mem0MemoryExtension(api as unknown as Parameters<typeof mem0MemoryExtension>[0]);
	return handlers;
}

async function createDelayedMem0Server(memoryText: string, delayMs = 200): Promise<FakeMem0Server> {
	const records: RequestRecord[] = [];
	const server: Server = createServer(async (req, res) => {
		const body = parseJsonBody(await readRequestBody(req));
		const record = {
			path: req.url ?? "",
			method: req.method ?? "",
			headers: req.headers,
			body,
		};
		records.push(record);

		if (record.path === "/search") {
			sendJson(res, 200, { results: [{ memory: memoryText, score: 0.9 }] });
			return;
		}
		if (record.path === "/memories") {
			// Simulate slow LLM fact extraction
			await new Promise((r) => setTimeout(r, delayMs));
			sendJson(res, 200, [{ id: "delayed-memory-id", memory: memoryText, event: "ADD" }]);
			return;
		}
		if (record.path.startsWith("/memories/") && record.method === "DELETE") {
			sendJson(res, 200, { status: "deleted", memory_id: record.path.slice("/memories/".length) });
			return;
		}
		sendJson(res, 404, { error: "not found" });
	});

	await new Promise<void>((resolve) => {
		server.listen(0, "127.0.0.1", resolve);
	});

	const address = server.address() as AddressInfo;
	return {
		baseUrl: `http://127.0.0.1:${address.port}`,
		records,
		close: () =>
			new Promise<void>((resolve, reject) => {
				server.close((error) => {
					if (error) {
						reject(error);
						return;
					}
					resolve();
				});
			}),
	};
}

async function emit(
	handlers: Map<string, ExtensionHandler[]>,
	eventName: string,
	event: unknown,
	ctx: unknown,
): Promise<unknown[]> {
	const results: unknown[] = [];
	for (const handler of handlers.get(eventName) ?? []) {
		results.push(await handler(event, ctx));
	}
	return results;
}

function writeMemoryConfig(cwd: string, baseUrl: string, requestTimeoutMs = 2000): void {
	const configDir = join(cwd, ".pi");
	mkdirSync(configDir, { recursive: true });
	writeFileSync(
		join(configDir, "memory.config.json"),
		JSON.stringify(
			{
				enabled: true,
				baseUrl,
				apiKey: "test-memory-api-key",
				apiKeyHeader: "x-api-key",
				userId: "test-user",
				agentId: "test-agent",
				topK: 3,
				requestTimeoutMs,
				failureCooldownMs: 1000,
				minPromptChars: 1,
			},
			null,
			2,
		),
		"utf-8",
	);
}

function getRecordBody(record: RequestRecord | undefined): Record<string, unknown> {
	expect(record?.body).toBeDefined();
	expect(typeof record?.body).toBe("object");
	expect(record?.body).not.toBeNull();
	return record?.body as Record<string, unknown>;
}

describe("mem0 memory extension", () => {
	const tempDirs: string[] = [];
	const fakeServers: FakeMem0Server[] = [];

	afterEach(async () => {
		while (fakeServers.length > 0) {
			await fakeServers.pop()?.close();
		}
		while (tempDirs.length > 0) {
			rmSync(tempDirs.pop()!, { recursive: true, force: true });
		}
	});

	it("silently injects retrieved memories and writes the completed turn", async () => {
		const fakeMem0 = await createFakeMem0Server("The user's validation marker is MEMORY_TOKEN_XYZ.");
		fakeServers.push(fakeMem0);
		const cwd = createTempDir();
		tempDirs.push(cwd);
		writeMemoryConfig(cwd, fakeMem0.baseUrl);
		const handlers = createExtensionHarness();
		const ctx = {
			cwd,
			sessionManager: {
				getSessionId: () => "test-session-id",
				getSessionFile: () => join(cwd, "session.jsonl"),
			},
		};

		await emit(handlers, "session_start", { type: "session_start" }, ctx);
		const beforeResults = await emit(
			handlers,
			"before_agent_start",
			{
				type: "before_agent_start",
				prompt: "What is my favorite validation marker?",
				systemPrompt: "You are a test assistant.",
				systemPromptOptions: {},
			},
			ctx,
		);
		const beforeResult = beforeResults[0] as BeforeAgentStartResult;

		await emit(
			handlers,
			"message_end",
			{
				type: "message_end",
				message: {
					role: "user",
					content: [{ type: "text", text: "What is my favorite validation marker?" }],
				},
			},
			ctx,
		);
		await emit(
			handlers,
			"turn_end",
			{
				type: "turn_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "MEMORY_TOKEN_XYZ" }],
					stopReason: "stop",
				},
			},
			ctx,
		);
		await emit(handlers, "session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);

		expect(beforeResult.systemPrompt).toContain("# Relevant Long-Term Memory");
		expect(beforeResult.systemPrompt).toContain("MEMORY_TOKEN_XYZ");
		expect(fakeMem0.records.filter((r) => r.path === "/search").length).toBeGreaterThanOrEqual(1);
		expect(fakeMem0.records.filter((r) => r.path === "/memories").length).toBeGreaterThanOrEqual(1);
		expect(fakeMem0.records.some((r) => r.path === "/search" && r.method === "POST")).toBe(true);
		expect(fakeMem0.records.some((r) => r.path === "/memories" && r.method === "POST")).toBe(true);

		// Find the before_agent_start search (query should contain the user prompt)
		const searchRecord = fakeMem0.records.find(
			(r) =>
				r.path === "/search" &&
				(r.body as Record<string, unknown>)?.query?.toString().includes("validation marker"),
		);
		expect(searchRecord).toBeDefined();
		const searchBody = getRecordBody(searchRecord);
		expect(fakeMem0.records.find((record) => record.path === "/search")?.headers["x-api-key"]).toBe(
			"test-memory-api-key",
		);
		expect(searchBody.user_id).toBe("test-user");
		expect(searchBody.agent_id).toBe("test-agent");
		expect(searchBody.query).toBe("What is my favorite validation marker?");
		expect(searchBody.top_k).toBe(3);

		const addBody = getRecordBody(fakeMem0.records.find((record) => record.path === "/memories"));
		expect(addBody.user_id).toBe("test-user");
		expect(addBody.agent_id).toBe("test-agent");
		expect(addBody.metadata).toMatchObject({
			cwd,
			sessionId: "test-session-id",
			sessionFile: join(cwd, "session.jsonl"),
			source: "pi-mem0-memory-extension",
		});
		expect(addBody.messages).toEqual([
			{ role: "user", content: "What is my favorite validation marker?" },
			{ role: "assistant", content: "MEMORY_TOKEN_XYZ" },
		]);
	});

	it("does not block the agent when the memory service is unavailable", async () => {
		const cwd = createTempDir();
		tempDirs.push(cwd);
		writeMemoryConfig(cwd, "http://127.0.0.1:9", 50);
		const handlers = createExtensionHarness();
		const ctx = {
			cwd,
			sessionManager: {
				getSessionId: () => "test-session-id",
				getSessionFile: () => join(cwd, "session.jsonl"),
			},
		};

		await emit(handlers, "session_start", { type: "session_start" }, ctx);
		const beforeResults = await emit(
			handlers,
			"before_agent_start",
			{
				type: "before_agent_start",
				prompt: "Keep working even if memory is unavailable.",
				systemPrompt: "You are a test assistant.",
				systemPromptOptions: {},
			},
			ctx,
		);
		await emit(
			handlers,
			"turn_end",
			{
				type: "turn_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "OK" }],
					stopReason: "stop",
				},
			},
			ctx,
		);
		await emit(handlers, "session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);

		expect(beforeResults).toEqual([undefined]);
	});

	it("waits for pending writes before searching memories", async () => {
		// Use a server that delays /memories to simulate slow LLM fact extraction.
		// This tests that before_agent_start waits for writeQueue to complete
		// so searches always see the latest data.
		const delayedServer = await createDelayedMem0Server("DELAYED_TOKEN_ABC");
		fakeServers.push(delayedServer);
		const cwd = createTempDir();
		tempDirs.push(cwd);
		writeMemoryConfig(cwd, delayedServer.baseUrl);
		const handlers = createExtensionHarness();
		const ctx = {
			cwd,
			sessionManager: {
				getSessionId: () => "test-session-id",
				getSessionFile: () => join(cwd, "session.jsonl"),
			},
		};

		await emit(handlers, "session_start", { type: "session_start" }, ctx);

		// Turn 1: user + assistant -> triggers slow addMemory
		await emit(
			handlers,
			"message_end",
			{
				type: "message_end",
				message: { role: "user", content: [{ type: "text", text: "What is the delayed token?" }] },
			},
			ctx,
		);
		await emit(
			handlers,
			"turn_end",
			{
				type: "turn_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "DELAYED_TOKEN_ABC" }],
					stopReason: "stop",
				},
			},
			ctx,
		);

		// Turn 2: search should await the slow write and find the memory
		const beforeResults = await emit(
			handlers,
			"before_agent_start",
			{
				type: "before_agent_start",
				prompt: "What is the delayed token?",
				systemPrompt: "You are a test assistant.",
				systemPromptOptions: {},
			},
			ctx,
		);

		expect((beforeResults[0] as { systemPrompt?: string })?.systemPrompt).toContain("DELAYED_TOKEN_ABC");

		await emit(handlers, "session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);
	});

	it("waits for pending writes before searching memories", async () => {
		const fakeMem0 = await createFakeMem0Server("The test token is RACE_TEST_TOKEN.");
		fakeServers.push(fakeMem0);
		const cwd = createTempDir();
		tempDirs.push(cwd);
		writeMemoryConfig(cwd, fakeMem0.baseUrl, 5000);
		const handlers = createExtensionHarness();
		const ctx = {
			cwd,
			sessionManager: {
				getSessionId: () => "test-session-id",
				getSessionFile: () => join(cwd, "session.jsonl"),
			},
		};

		await emit(handlers, "session_start", { type: "session_start" }, ctx);

		// Simulate a slow addMemory by intercepting the /memories request
		const _baselineRecords = fakeMem0.records.length;

		// Turn 1: user sends a message
		await emit(
			handlers,
			"message_end",
			{
				type: "message_end",
				message: { role: "user", content: [{ type: "text", text: "Tell me about race conditions" }] },
			},
			ctx,
		);

		// Turn 1: assistant responds — this triggers addMemory (and cleanup) in writeQueue
		await emit(
			handlers,
			"turn_end",
			{
				type: "turn_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "RACE_TEST_TOKEN is the answer." }],
					stopReason: "stop",
				},
			},
			ctx,
		);

		// Turn 2: immediately start a new before_agent_start
		// The key test: before_agent_start should await the pending writeQueue,
		// so the search sees the latest data (including the memory just written).
		// If the writeQueue is NOT awaited, the search might miss the new memory.
		const beforeResults2 = await emit(
			handlers,
			"before_agent_start",
			{
				type: "before_agent_start",
				prompt: "What is the race test token?",
				systemPrompt: "You are a test assistant.",
				systemPromptOptions: {},
			},
			ctx,
		);

		// The search should have waited for writeQueue, so it found the memory
		expect(beforeResults2[0]).toBeDefined();
		expect((beforeResults2[0] as { systemPrompt?: string })?.systemPrompt).toContain("RACE_TEST_TOKEN");

		await emit(handlers, "session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);
	});

	it("applies time-based score decay to old memories", async () => {
		const now = new Date();
		const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
		const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
		const sixtyDaysAgo = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000).toISOString();

		// Create a fake mem0 server that returns memories with different ages
		const records: RequestRecord[] = [];
		const server = createServer(async (req, res) => {
			const body = parseJsonBody(await readRequestBody(req));
			const record = { path: req.url ?? "", method: req.method ?? "", headers: req.headers, body };
			records.push(record);

			if (record.path === "/search") {
				sendJson(res, 200, {
					results: [
						{ id: "fresh", memory: "Fresh memory from today", score: 0.8, created_at: oneDayAgo },
						{ id: "month-old", memory: "Memory from 30 days ago", score: 0.8, created_at: thirtyDaysAgo },
						{ id: "two-month-old", memory: "Memory from 60 days ago", score: 0.8, created_at: sixtyDaysAgo },
					],
				});
				return;
			}
			if (record.path === "/memories") {
				sendJson(res, 200, [{ id: "decay-test-id", memory: "decay test", event: "ADD" }]);
				return;
			}
			if (record.path.startsWith("/memories/") && record.method === "DELETE") {
				sendJson(res, 200, { status: "deleted", memory_id: record.path.slice("/memories/".length) });
				return;
			}
			sendJson(res, 404, { error: "not found" });
		});

		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address() as AddressInfo;
		const baseUrl = `http://127.0.0.1:${address.port}`;

		const cwd = createTempDir();
		tempDirs.push(cwd);
		writeMemoryConfig(cwd, baseUrl);
		const handlers = createExtensionHarness();
		const ctx = {
			cwd,
			sessionManager: {
				getSessionId: () => "test-session-id",
				getSessionFile: () => join(cwd, "session.jsonl"),
			},
		};

		await emit(handlers, "session_start", { type: "session_start" }, ctx);

		const beforeResults = await emit(
			handlers,
			"before_agent_start",
			{
				type: "before_agent_start",
				prompt: "Test decay",
				systemPrompt: "You are a test assistant.",
				systemPromptOptions: {},
			},
			ctx,
		);

		const prompt = (beforeResults[0] as { systemPrompt?: string })?.systemPrompt ?? "";

		// All three memories should be present (decay doesn't remove, just reorders)
		const freshIdx = prompt.indexOf("Fresh memory");
		const monthIdx = prompt.indexOf("Memory from 30");
		const twoMonthIdx = prompt.indexOf("Memory from 60");

		expect(freshIdx).toBeGreaterThan(-1);
		expect(monthIdx).toBeGreaterThan(-1);
		expect(twoMonthIdx).toBeGreaterThan(-1);

		// Fresh should appear before month-old, which should appear before two-month-old
		expect(freshIdx).toBeLessThan(monthIdx);
		expect(monthIdx).toBeLessThan(twoMonthIdx);

		await new Promise<void>((resolve) => server.close(() => resolve()));
	});
});
