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
			sendJson(res, 200, { id: "fake-memory-id" });
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
		expect(fakeMem0.records.map((record) => record.path)).toEqual(["/search", "/memories"]);

		const searchBody = getRecordBody(fakeMem0.records.find((record) => record.path === "/search"));
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
});
