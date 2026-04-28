import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession } from "@mariozechner/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { addTaskStep, createLongTask, readTask } from "../../../../.pi/extensions/long-task-runner.js";
import workerExecutorExtension, {
	buildWorkerSystemInstructions,
	executeMultipleWorkers,
	executeWorker,
	extractChangedFiles,
	extractReferences,
	getToolsForRole,
	isInScope,
	resolveWorkerModel,
	setSessionFactory,
} from "../../../../.pi/extensions/worker-executor.js";

// ── Helpers ──────────────────────────────────────────────────────────────

type CommandHandler = (args: string, ctx: FakeCommandContext) => Promise<void>;
type ExtensionHandler = (event: unknown, ctx: unknown) => Promise<unknown> | unknown;
type ToolParams = {
	worker?: string;
	goal?: string;
	context?: string;
	taskId?: string;
	stepId?: string;
	allowedScope?: string[];
	jobs?: Array<{
		worker: string;
		goal: string;
		context?: string;
		stepId?: string;
		allowedScope?: string[];
	}>;
};

interface FakeToolResult {
	content: Array<{ type: string; text: string }>;
	details?: unknown;
	isError?: boolean;
}

interface FakeTool {
	name: string;
	execute: (
		toolCallId: string,
		params: ToolParams,
		signal: AbortSignal | undefined,
		onUpdate: undefined,
		ctx: { cwd: string },
	) => Promise<FakeToolResult>;
}

interface FakeCommandContext {
	cwd: string;
	hasUI: boolean;
	ui: {
		notifications: Array<{ message: string; type?: string }>;
		editorText: string;
		notify: (message: string, type?: "info" | "warning" | "error") => void;
		setEditorText: (text: string) => void;
	};
}

function createTempDir(): string {
	return join(tmpdir(), `pi-worker-executor-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

function createFakeMessage(role: string, text: string) {
	return { role, content: text };
}

function asAgentSession(session: {
	messages: Array<{ role: string; content: string }>;
	prompt: () => Promise<void>;
	dispose: () => void;
}): AgentSession {
	return session as unknown as AgentSession;
}

function createExtensionHarness(): {
	commands: Map<string, CommandHandler>;
	handlers: Map<string, ExtensionHandler[]>;
	tools: Map<string, FakeTool>;
} {
	const commands = new Map<string, CommandHandler>();
	const handlers = new Map<string, ExtensionHandler[]>();
	const tools = new Map<string, FakeTool>();
	workerExecutorExtension({
		on(eventName: string, handler: ExtensionHandler) {
			const existing = handlers.get(eventName) ?? [];
			existing.push(handler);
			handlers.set(eventName, existing);
		},
		registerTool(tool: FakeTool) {
			tools.set(tool.name, tool);
		},
		registerCommand(name: string, options: { handler: CommandHandler }) {
			commands.set(name, options.handler);
		},
	} as unknown as Parameters<typeof workerExecutorExtension>[0]);
	return { commands, handlers, tools };
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("worker executor", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		setSessionFactory(undefined);
		while (tempDirs.length > 0) {
			rmSync(tempDirs.pop()!, { recursive: true, force: true });
		}
	});

	it("registers the worker_execute tool", () => {
		const { tools } = createExtensionHarness();
		expect(tools.get("worker_execute")).toBeDefined();
	});

	// ── buildWorkerSystemInstructions ──────────────────────────────────

	it("builds researcher-specific system instructions", () => {
		const instructions = buildWorkerSystemInstructions("researcher");
		expect(instructions).toContain("ROLE: RESEARCHER");
		expect(instructions).toContain("including curl for web search");
		expect(instructions).toContain("## Findings");
		expect(instructions).toContain("## Risks");
	});

	it("builds reviewer-specific system instructions", () => {
		const instructions = buildWorkerSystemInstructions("reviewer");
		expect(instructions).toContain("ROLE: REVIEWER");
		expect(instructions).toContain("aesthetics");
		expect(instructions).toContain("## Critical");
		expect(instructions).toContain("## High");
	});

	it("builds coder-specific system instructions with scope", () => {
		const instructions = buildWorkerSystemInstructions("coder", ["src/", "test/"]);
		expect(instructions).toContain("SCOPED CODER");
		expect(instructions).toContain("src/, test/");
	});

	it("builds coder instructions warning about no scope", () => {
		const instructions = buildWorkerSystemInstructions("coder");
		expect(instructions).toContain("NO SCOPE SET");
	});

	it("builds tester-specific system instructions", () => {
		const instructions = buildWorkerSystemInstructions("tester");
		expect(instructions).toContain("VALIDATION TESTER");
		expect(instructions).toContain("edit, and write");
	});

	it("builds docWriter-specific system instructions", () => {
		const instructions = buildWorkerSystemInstructions("docWriter");
		expect(instructions).toContain("DOCUMENTATION WRITER");
		expect(instructions).toContain("Chinese documentation");
	});

	it("builds imageReviewer-specific system instructions", () => {
		const instructions = buildWorkerSystemInstructions("imageReviewer");
		expect(instructions).toContain("IMAGE REVIEWER");
		expect(instructions).toContain("multimodal");
		expect(instructions).toContain("pixel-level");
	});

	// ── getToolsForRole (all workers have full tool access) ────

	it("returns full tools for researcher", () => {
		const tools = getToolsForRole("researcher");
		expect(tools).toContain("bash");
		expect(tools).toContain("edit");
	});

	it("returns full tools for reviewer", () => {
		const tools = getToolsForRole("reviewer");
		expect(tools).toContain("bash");
	});

	it("returns full tools for coder", () => {
		const tools = getToolsForRole("coder");
		expect(tools).toContain("ls");
		expect(tools).toContain("grep");
	});

	it("returns full tools for tester", () => {
		const tools = getToolsForRole("tester");
		expect(tools).toContain("edit");
	});

	it("returns full tools for docWriter", () => {
		const tools = getToolsForRole("docWriter");
		expect(tools).toContain("bash");
	});

	// ── extractReferences ──────────────────────────────────────────────

	it("extracts file paths from worker output", () => {
		const output = "Found issues in src/core/sdk.ts and .pi/extensions/worker.ts.\nAlso check README.md.";
		const refs = extractReferences(output);
		expect(refs).toContain("src/core/sdk.ts");
		expect(refs).toContain(".pi/extensions/worker.ts");
		expect(refs).toContain("README.md");
	});

	it("deduplicates file paths", () => {
		const output = "Check src/main.ts and src/main.ts again.";
		const refs = extractReferences(output);
		expect(refs.filter((r) => r === "src/main.ts")).toHaveLength(1);
	});

	// ── extractChangedFiles ────────────────────────────────────────────

	it("extracts changed files from coder output", () => {
		const output = [
			"Some discussion text.",
			"Changed files:",
			"- src/core/sdk.ts",
			"- .pi/extensions/multi-agent-dispatcher.ts",
			"More text after.",
		].join("\n");
		const files = extractChangedFiles(output);
		expect(files).toEqual(["src/core/sdk.ts", ".pi/extensions/multi-agent-dispatcher.ts"]);
	});

	it("returns empty array when no Changed files section", () => {
		const files = extractChangedFiles("No changes made.");
		expect(files).toEqual([]);
	});

	// ── isInScope ──────────────────────────────────────────────────────

	it("validates file paths against allowed scope", () => {
		const cwd = "/Users/test/project";
		expect(isInScope("src/main.ts", ["src/"], cwd)).toBe(true);
		expect(isInScope("test/suite.ts", ["src/"], cwd)).toBe(false);
		expect(isInScope("src/core/sdk.ts", ["src/core/", "test/"], cwd)).toBe(true);
	});

	it("does not treat sibling path prefixes as in scope", () => {
		const cwd = "/Users/test/project";
		expect(isInScope("src2/main.ts", ["src/"], cwd)).toBe(false);
	});

	it("returns true when no scope is set", () => {
		expect(isInScope("any/file.ts", [], "/tmp")).toBe(true);
	});

	// ── executeWorker with factory injection ───────────────────────────

	it("executeWorker returns output from injected session", async () => {
		const cwd = createTempDir();
		tempDirs.push(cwd);

		let capturedInstructions = "";
		setSessionFactory(async (options) => {
			capturedInstructions = options.systemInstructions;
			const session = {
				messages: [
					createFakeMessage("user", "test"),
					createFakeMessage("assistant", "Research findings: found src/main.ts and test.ts"),
				],
				prompt: async () => {},
				dispose: () => {},
			};
			return {
				session: asAgentSession(session),
				dispose: () => {},
			};
		});

		const result = await executeWorker(cwd, {
			goal: "Find all TypeScript files",
			worker: "researcher",
			taskId: undefined,
			stepId: undefined,
		});

		expect(result.output).toContain("Research findings");
		expect(result.error).toBeUndefined();
		expect(capturedInstructions).toContain("ROLE: RESEARCHER");
	});

	it("executeWorker returns error on session failure", async () => {
		const cwd = createTempDir();
		tempDirs.push(cwd);

		setSessionFactory(async () => {
			throw new Error("Session creation failed");
		});

		const result = await executeWorker(cwd, {
			goal: "Find files",
			worker: "researcher",
		});

		expect(result.output).toBe("");
		expect(result.error).toContain("Session creation failed");
	});

	// ── worker_execute tool integration ────────────────────────────────

	it("worker_execute tool returns error for empty goal", async () => {
		const { tools } = createExtensionHarness();
		const tool = tools.get("worker_execute");
		expect(tool).toBeDefined();

		const result = await tool!.execute("call-1", { worker: "researcher", goal: "" }, undefined, undefined, {
			cwd: createTempDir(),
		});

		expect(result.isError).toBe(true);
		expect(result.content[0]!.text).toContain("goal is required");
	});

	it("worker_execute tool runs with factory and returns output", async () => {
		const cwd = createTempDir();
		tempDirs.push(cwd);

		setSessionFactory(async () => {
			const session = {
				messages: [createFakeMessage("assistant", "Found 3 files: a.ts, b.ts, c.ts")],
				prompt: async () => {},
				dispose: () => {},
			};
			return {
				session: asAgentSession(session),
				dispose: () => {},
			};
		});

		const { tools } = createExtensionHarness();
		const tool = tools.get("worker_execute");
		expect(tool).toBeDefined();

		const result = await tool!.execute(
			"call-1",
			{ worker: "researcher", goal: "Scan for TypeScript files" },
			undefined,
			undefined,
			{ cwd },
		);

		expect(result.isError).toBeFalsy();
		expect(result.content[0]!.text).toContain("Worker researcher completed");
		expect(result.content[0]!.text).toContain("Found 3 files");
	});

	it("executeWorker reports persistence failures instead of succeeding silently", async () => {
		const cwd = createTempDir();
		tempDirs.push(cwd);

		setSessionFactory(async () => ({
			session: asAgentSession({
				messages: [createFakeMessage("assistant", "Findings in src/main.ts")],
				prompt: async () => {},
				dispose: () => {},
			}),
			dispose: () => {},
		}));

		const result = await executeWorker(cwd, {
			goal: "Research files",
			worker: "researcher",
			taskId: "missing-task",
			stepId: "missing-step",
		});

		expect(result.error).toContain("failed to persist result");
	});

	it("executeWorker does not duplicate task artifacts when persisting step artifacts", async () => {
		const cwd = createTempDir();
		tempDirs.push(cwd);
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		const task = createLongTask(cwd, "Track worker output");
		addTaskStep(cwd, task.id, "Research context", { worker: "researcher" });
		const stepId = readTask(cwd, task.id).plan[0]!.id;

		setSessionFactory(async () => ({
			session: asAgentSession({
				messages: [createFakeMessage("assistant", "Findings in src/main.ts")],
				prompt: async () => {},
				dispose: () => {},
			}),
			dispose: () => {},
		}));

		const result = await executeWorker(cwd, {
			goal: "Research files",
			worker: "researcher",
			taskId: task.id,
			stepId,
		});

		expect(result.error).toBeUndefined();
		const updated = readTask(cwd, task.id);
		expect(updated.artifacts.filter((artifact) => artifact === "src/main.ts")).toHaveLength(1);
		expect(updated.plan[0]!.artifacts).toEqual(["src/main.ts"]);
	});

	it("executeWorker fails scoped coder output that reports out-of-scope changed files", async () => {
		const cwd = createTempDir();
		tempDirs.push(cwd);

		setSessionFactory(async () => ({
			session: asAgentSession({
				messages: [
					createFakeMessage(
						"assistant",
						["Implemented change.", "Changed files:", "- src/main.ts", "- src2/main.ts"].join("\n"),
					),
				],
				prompt: async () => {},
				dispose: () => {},
			}),
			dispose: () => {},
		}));

		const result = await executeWorker(cwd, {
			goal: "Implement scoped change",
			worker: "coder",
			allowedScope: ["src/"],
		});

		expect(result.error).toContain("outside allowedScope");
		expect(result.error).toContain("src2/main.ts");
	});

	// ── Phase 7: Parallel Workers ──────────────────────────────────────

	it("registers the worker_execute_multi tool", () => {
		const { tools } = createExtensionHarness();
		expect(tools.get("worker_execute_multi")).toBeDefined();
	});

	it("worker_execute_multi returns error for empty jobs", async () => {
		const { tools } = createExtensionHarness();
		const tool = tools.get("worker_execute_multi");
		expect(tool).toBeDefined();

		const result = await tool!.execute("call-1", { jobs: [] }, undefined, undefined, { cwd: createTempDir() });

		expect(result.isError).toBe(true);
		expect(result.content[0]!.text).toContain("at least one job");
	});

	it("executeMultipleWorkers runs read-only jobs in parallel", async () => {
		const cwd = createTempDir();
		tempDirs.push(cwd);

		const startTimes: number[] = [];
		setSessionFactory(async () => {
			startTimes.push(Date.now());
			// Small delay to detect parallelism
			await new Promise((r) => setTimeout(r, 50));
			return {
				session: asAgentSession({
					messages: [createFakeMessage("assistant", "Result")],
					prompt: async () => {},
					dispose: () => {},
				}),
				dispose: () => {},
			};
		});

		const jobs = [
			{ goal: "Research file A", worker: "researcher" as const },
			{ goal: "Review file B", worker: "reviewer" as const },
		];

		const { results } = await executeMultipleWorkers(cwd, jobs);

		expect(results).toHaveLength(2);
		expect(results.every((r) => !r.error)).toBe(true);
		// If parallel, startTimes should be close together (< 20ms apart)
		// If sequential, they'd be at least 50ms apart
		if (startTimes.length === 2) {
			const gap = Math.abs(startTimes[0]! - startTimes[1]!);
			expect(gap).toBeLessThan(30); // parallel = close together
		}
	});

	it("executeMultipleWorkers returns error results for failed workers", async () => {
		const cwd = createTempDir();
		tempDirs.push(cwd);

		let callCount = 0;
		setSessionFactory(async () => {
			callCount++;
			if (callCount === 2) throw new Error("Second worker failed");
			return {
				session: asAgentSession({
					messages: [createFakeMessage("assistant", "OK")],
					prompt: async () => {},
					dispose: () => {},
				}),
				dispose: () => {},
			};
		});

		const jobs = [
			{ goal: "Job 1", worker: "researcher" as const },
			{ goal: "Job 2", worker: "reviewer" as const },
		];

		const { results } = await executeMultipleWorkers(cwd, jobs);

		expect(results).toHaveLength(2);
		expect(results[0]!.error).toBeUndefined();
		expect(results[1]!.error).toContain("Second worker failed");
	});

	it("executeMultipleWorkers keeps mixed read/write results aligned to original jobs", async () => {
		const cwd = createTempDir();
		tempDirs.push(cwd);

		setSessionFactory(async (options) => ({
			session: asAgentSession({
				messages: [
					createFakeMessage(
						"assistant",
						`${options.systemInstructions.includes("SCOPED CODER") ? "coder" : "researcher"} result`,
					),
				],
				prompt: async () => {},
				dispose: () => {},
			}),
			dispose: () => {},
		}));

		const jobs = [
			{ goal: "Write change", worker: "coder" as const },
			{ goal: "Research context", worker: "researcher" as const },
		];

		const { results, summary } = await executeMultipleWorkers(cwd, jobs);

		expect(results[0]!.output).toBe("coder result");
		expect(results[1]!.output).toBe("researcher result");
		expect(summary).toContain("[coder] Write change");
		expect(summary).toContain("[researcher] Research context");
	});
});

// ── resolveWorkerModel ────────────────────────────────────────────────────

describe("resolveWorkerModel", () => {
	const fakeModel = { id: "test-model", provider: "test-provider", name: "Test Model" } as any;
	const fakeRegistry = {
		find: (provider: string, modelId: string) => {
			if (provider === "test-provider" && modelId === "test-model") return fakeModel;
			return undefined;
		},
	};

	it("returns undefined when no config file exists", () => {
		const tmpDir = join(tmpdir(), `pi-resolve-model-no-config-${Date.now()}`);
		try {
			const result = resolveWorkerModel(tmpDir, "researcher", fakeRegistry);
			expect(result).toBeUndefined();
		} finally {
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("returns undefined when worker has no modelPolicy", () => {
		const tmpDir = join(tmpdir(), `pi-resolve-model-no-policy-${Date.now()}`);
		mkdirSync(join(tmpDir, ".pi"), { recursive: true });
		try {
			// Config with no modelPolicy on workers
			writeFileSync(
				join(tmpDir, ".pi", "task-router.config.json"),
				JSON.stringify({
					workers: { researcher: { enabled: true } },
					modelPolicies: { coding: { provider: "test-provider", model: "test-model" } },
				}),
			);
			const result = resolveWorkerModel(tmpDir, "researcher", fakeRegistry);
			expect(result).toBeUndefined();
		} finally {
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("returns undefined when modelPolicy references a policy with null provider/model", () => {
		const tmpDir = join(tmpdir(), `pi-resolve-model-null-values-${Date.now()}`);
		mkdirSync(join(tmpDir, ".pi"), { recursive: true });
		try {
			writeFileSync(
				join(tmpDir, ".pi", "task-router.config.json"),
				JSON.stringify({
					workers: { researcher: { modelPolicy: "longContext" } },
					modelPolicies: { longContext: { provider: null, model: null } },
				}),
			);
			const result = resolveWorkerModel(tmpDir, "researcher", fakeRegistry);
			expect(result).toBeUndefined();
		} finally {
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("returns undefined when model is not found in registry", () => {
		const tmpDir = join(tmpdir(), `pi-resolve-model-not-found-${Date.now()}`);
		mkdirSync(join(tmpDir, ".pi"), { recursive: true });
		try {
			writeFileSync(
				join(tmpDir, ".pi", "task-router.config.json"),
				JSON.stringify({
					workers: { researcher: { modelPolicy: "coding" } },
					modelPolicies: { coding: { provider: "nonexistent", model: "nope" } },
				}),
			);
			const result = resolveWorkerModel(tmpDir, "researcher", fakeRegistry);
			expect(result).toBeUndefined();
		} finally {
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("resolves model from config and registry", () => {
		const tmpDir = join(tmpdir(), `pi-resolve-model-success-${Date.now()}`);
		mkdirSync(join(tmpDir, ".pi"), { recursive: true });
		try {
			writeFileSync(
				join(tmpDir, ".pi", "task-router.config.json"),
				JSON.stringify({
					workers: { researcher: { modelPolicy: "coding" } },
					modelPolicies: { coding: { provider: "test-provider", model: "test-model", thinkingLevel: "high" } },
				}),
			);
			const result = resolveWorkerModel(tmpDir, "researcher", fakeRegistry);
			expect(result).toBeDefined();
			expect(result!.model).toBe(fakeModel);
			expect(result!.thinkingLevel).toBe("high");
		} finally {
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("resolves model without thinkingLevel when not specified", () => {
		const tmpDir = join(tmpdir(), `pi-resolve-model-no-thinking-${Date.now()}`);
		mkdirSync(join(tmpDir, ".pi"), { recursive: true });
		try {
			writeFileSync(
				join(tmpDir, ".pi", "task-router.config.json"),
				JSON.stringify({
					workers: { tester: { modelPolicy: "cheap" } },
					modelPolicies: { cheap: { provider: "test-provider", model: "test-model" } },
				}),
			);
			const result = resolveWorkerModel(tmpDir, "tester", fakeRegistry);
			expect(result).toBeDefined();
			expect(result!.model).toBe(fakeModel);
			expect(result!.thinkingLevel).toBeUndefined();
		} finally {
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("ignores invalid thinkingLevel values", () => {
		const tmpDir = join(tmpdir(), `pi-resolve-model-bad-thinking-${Date.now()}`);
		mkdirSync(join(tmpDir, ".pi"), { recursive: true });
		try {
			writeFileSync(
				join(tmpDir, ".pi", "task-router.config.json"),
				JSON.stringify({
					workers: { coder: { modelPolicy: "coding" } },
					modelPolicies: { coding: { provider: "test-provider", model: "test-model", thinkingLevel: "ultra" } },
				}),
			);
			const result = resolveWorkerModel(tmpDir, "coder", fakeRegistry);
			expect(result).toBeDefined();
			expect(result!.thinkingLevel).toBeUndefined();
		} finally {
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});
});
