import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import longTaskRunnerExtension, {
	addTaskStep,
	buildProgressBar,
	buildResumePrompt,
	buildTaskRoutingSystemPrompt,
	createLongTask,
	getTaskStorageDir,
	readTask,
	updateStepStatus,
	updateTaskStatus,
} from "../../../../.pi/extensions/long-task-runner.js";

type CommandHandler = (args: string, ctx: FakeCommandContext) => Promise<void>;
type ExtensionHandler = (event: unknown, ctx: unknown) => Promise<unknown> | unknown;
type LongTaskToolParams = {
	action:
		| "create"
		| "list"
		| "show"
		| "add_step"
		| "set_task"
		| "set_step"
		| "add_artifact"
		| "resume"
		| "suggest_steps"
		| "add_suggested_steps";
	goal?: string;
	sourcePrompt?: string;
	taskId?: string;
	title?: string;
	stepId?: string;
	status?: string;
	message?: string;
	worker?: string;
	modelPolicy?: string;
	expectedOutput?: string;
	allowedScope?: string[];
	artifact?: string;
	stepArtifacts?: string[];
	notes?: string;
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
		params: LongTaskToolParams,
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
	return join(tmpdir(), `pi-long-task-extension-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

function createExtensionHarness(): {
	commands: Map<string, CommandHandler>;
	handlers: Map<string, ExtensionHandler[]>;
	tools: Map<string, FakeTool>;
} {
	const commands = new Map<string, CommandHandler>();
	const handlers = new Map<string, ExtensionHandler[]>();
	const tools = new Map<string, FakeTool>();
	longTaskRunnerExtension({
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
	} as unknown as Parameters<typeof longTaskRunnerExtension>[0]);
	return { commands, handlers, tools };
}

function createFakeContext(cwd: string): FakeCommandContext {
	const notifications: Array<{ message: string; type?: string }> = [];
	return {
		cwd,
		hasUI: true,
		ui: {
			notifications,
			editorText: "",
			notify(message, type) {
				notifications.push({ message, type });
			},
			setEditorText(text) {
				this.editorText = text;
			},
		},
	};
}

describe("long task runner extension", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		while (tempDirs.length > 0) {
			rmSync(tempDirs.pop()!, { recursive: true, force: true });
		}
	});

	it("creates and persists a long task record", () => {
		const cwd = createTempDir();
		tempDirs.push(cwd);
		const task = createLongTask(cwd, "Implement a durable personal task runner.");
		const storageDir = getTaskStorageDir(cwd);
		const taskPath = join(storageDir, `${task.id}.json`);

		expect(existsSync(taskPath)).toBe(true);
		expect(task.status).toBe("pending");
		expect(task.goal).toBe("Implement a durable personal task runner.");
		expect(readTask(cwd, task.id).id).toBe(task.id);
		expect(JSON.parse(readFileSync(taskPath, "utf-8")).mode).toBe("long-task");
	});

	it("updates steps and builds a resume prompt from durable state", () => {
		const cwd = createTempDir();
		tempDirs.push(cwd);
		const task = createLongTask(cwd, "Research, implement, and review task routing.");
		const withFirstStep = addTaskStep(cwd, task.id, "Research durable workflow patterns");
		const firstStepId = withFirstStep.plan[0]!.id;
		addTaskStep(cwd, task.id, "Implement local JSON persistence");

		const updated = updateStepStatus(cwd, task.id, firstStepId, "completed", "Research notes captured.");
		const prompt = buildResumePrompt(updated);

		expect(updated.plan[0]!.status).toBe("completed");
		expect(updated.plan[0]!.output).toBe("Research notes captured.");
		expect(prompt).toContain("继续长期任务");
		expect(prompt).toContain(firstStepId);
		expect(prompt).toContain("Implement local JSON persistence");
	});

	it("injects task routing guidance while preserving immediate mode as the default", () => {
		const cwd = createTempDir();
		tempDirs.push(cwd);
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "task-router.config.json"),
			JSON.stringify({
				enabled: true,
				defaultMode: "immediate",
				askWhenAmbiguous: true,
				routing: { autoEscalateKeywords: ["后台"] },
				workers: { researcher: { enabled: true, permission: "read-only", modelPolicy: "longContext" } },
			}),
			"utf-8",
		);

		const prompt = buildTaskRoutingSystemPrompt(cwd, "请后台持续推进这个复杂任务");

		expect(prompt).toContain("Default mode: immediate.");
		expect(prompt).toContain("Keep simple requests in immediate mode.");
		expect(prompt).toContain("Current request matched long-task keyword(s): 后台.");
		expect(prompt).toContain("researcher");
	});

	it("includes multi-agent classifier output in routing prompt when prompt triggers multi_agent_candidate", () => {
		const cwd = createTempDir();
		tempDirs.push(cwd);
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "task-router.config.json"),
			JSON.stringify({ enabled: true, defaultMode: "immediate" }),
			"utf-8",
		);

		const prompt = buildTaskRoutingSystemPrompt(cwd, "我们要做多 agent 协作编排，包含调研、编码、测试和 review");

		expect(prompt).toContain("Dispatch classifier mode: multi_agent_candidate");
		expect(prompt).toContain("Dispatch classifier reason:");
		expect(prompt).toContain("Dispatch classifier signals:");
		expect(prompt).toContain("multi_agent_keyword");
		expect(prompt).toContain("Dispatch recommended action: plan_multi_agent");
		expect(prompt).toContain("Dispatch should create task: true");
		expect(prompt).toContain("Dispatch should plan workers: true");
		expect(prompt).toContain("Recommendation usage:");
		expect(prompt).toContain("do not spawn workers yet");
		expect(prompt).toContain("Dispatch worker plan hints:");
		expect(prompt).toContain("- researcher:");
		expect(prompt).toContain("- coder:");
		expect(prompt).toContain("- tester:");
		expect(prompt).toContain("- reviewer:");
		expect(prompt).toContain(
			"Use the worker_execute tool to run researcher and reviewer workers. Coder, tester, and docWriter workers are available for later phases.",
		);
	});

	it("includes docWriter in worker plan when prompt mentions documentation", () => {
		const cwd = createTempDir();
		tempDirs.push(cwd);
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "task-router.config.json"),
			JSON.stringify({ enabled: true, defaultMode: "immediate" }),
			"utf-8",
		);

		const prompt = buildTaskRoutingSystemPrompt(
			cwd,
			"我们要做多 agent 协作编排，包含调研、编码、测试、review，并更新 README 文档",
		);

		expect(prompt).toContain("Dispatch worker plan hints:");
		expect(prompt).toContain("- docWriter:");
	});

	it("includes long_task classifier output in routing prompt when prompt triggers long-term work", () => {
		const cwd = createTempDir();
		tempDirs.push(cwd);
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "task-router.config.json"),
			JSON.stringify({ enabled: true, defaultMode: "immediate" }),
			"utf-8",
		);

		const prompt = buildTaskRoutingSystemPrompt(cwd, "帮我规划一个复杂功能，后续多轮推进");

		expect(prompt).toContain("Dispatch classifier mode: long_task");
		expect(prompt).toContain("Dispatch classifier reason:");
		expect(prompt).toContain("Dispatch classifier signals:");
		expect(prompt).toContain("long_task_keyword_cn");
		expect(prompt).toContain("Dispatch recommended action: use_long_task");
		expect(prompt).toContain("Dispatch should create task: true");
		expect(prompt).toContain("Dispatch should plan workers: false");
		expect(prompt).toContain("Recommendation usage:");
		expect(prompt).toContain("Dispatch worker plan hints: none");
	});

	it("includes immediate classifier output in routing prompt when prompt triggers immediate mode", () => {
		const cwd = createTempDir();
		tempDirs.push(cwd);
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "task-router.config.json"),
			JSON.stringify({ enabled: true, defaultMode: "immediate" }),
			"utf-8",
		);

		const prompt = buildTaskRoutingSystemPrompt(cwd, "帮我解释一下 mem0 是干什么的");

		expect(prompt).toContain("Dispatch classifier mode: immediate");
		expect(prompt).toContain("Dispatch classifier reason:");
		expect(prompt).toContain("Dispatch classifier signals:");
		expect(prompt).toContain("Dispatch recommended action: answer_directly");
		expect(prompt).toContain("Dispatch should create task: false");
		expect(prompt).toContain("Dispatch should plan workers: false");
		expect(prompt).toContain("Recommendation usage:");
		expect(prompt).toContain("Dispatch worker plan hints: none");
	});

	it("registers the /task command and loads resume text into the editor", async () => {
		const cwd = createTempDir();
		tempDirs.push(cwd);
		const { commands } = createExtensionHarness();
		const taskCommand = commands.get("task");
		expect(taskCommand).toBeDefined();
		const ctx = createFakeContext(cwd);

		await taskCommand!("create Build a resumable task runner.", ctx);
		const createdNotification = ctx.ui.notifications.at(-1)?.message ?? "";
		const taskId = createdNotification.match(/id: ([^\n]+)/)?.[1];
		expect(taskId).toBeDefined();

		await taskCommand!(`add-step ${taskId} Define task JSON schema`, ctx);
		await taskCommand!(`resume ${taskId}`, ctx);

		expect(ctx.ui.editorText).toContain("继续长期任务");
		expect(ctx.ui.editorText).toContain("Define task JSON schema");
	});

	it("registers a long_task tool for model-driven durable task tracking", async () => {
		const cwd = createTempDir();
		tempDirs.push(cwd);
		const { tools } = createExtensionHarness();
		const longTaskTool = tools.get("long_task");
		expect(longTaskTool).toBeDefined();

		const createResult = await longTaskTool!.execute(
			"tool-call-1",
			{ action: "create", goal: "Track a complex implementation across sessions." },
			undefined,
			undefined,
			{ cwd },
		);
		const taskId = createResult.content[0]!.text.match(/id: ([^\n]+)/)?.[1];
		expect(taskId).toBeDefined();

		const stepResult = await longTaskTool!.execute(
			"tool-call-2",
			{
				action: "add_step",
				taskId,
				title: "Define the recovery behavior",
				worker: "researcher",
				modelPolicy: "longContext",
			},
			undefined,
			undefined,
			{ cwd },
		);

		expect(stepResult.content[0]!.text).toContain("Added step");
		expect(readTask(cwd, taskId!).plan[0]!.title).toBe("Define the recovery behavior");
		expect(readTask(cwd, taskId!).plan[0]!.worker).toBe("researcher");
		expect(readTask(cwd, taskId!).plan[0]!.modelPolicy).toBe("longContext");
	});

	it("stores artifacts through the long_task tool", async () => {
		const cwd = createTempDir();
		tempDirs.push(cwd);
		const { tools } = createExtensionHarness();
		const longTaskTool = tools.get("long_task");
		expect(longTaskTool).toBeDefined();
		const createResult = await longTaskTool!.execute(
			"tool-call-1",
			{ action: "create", goal: "Track implementation artifacts." },
			undefined,
			undefined,
			{ cwd },
		);
		const taskId = createResult.content[0]!.text.match(/id: ([^\n]+)/)?.[1];
		expect(taskId).toBeDefined();

		await longTaskTool!.execute(
			"tool-call-2",
			{ action: "add_artifact", taskId, artifact: ".pi/long-task-agent.md" },
			undefined,
			undefined,
			{ cwd },
		);

		expect(readTask(cwd, taskId!).artifacts).toContain(".pi/long-task-agent.md");
	});

	it("routing prompt contains Dispatch step drafts for multi-agent prompts", () => {
		const cwd = createTempDir();
		tempDirs.push(cwd);
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "task-router.config.json"),
			JSON.stringify({ enabled: true, defaultMode: "immediate" }),
			"utf-8",
		);

		const prompt = buildTaskRoutingSystemPrompt(cwd, "我们要做多 agent 协作编排，包含调研、编码、测试和 review");

		expect(prompt).toContain("Dispatch step drafts:");
		expect(prompt).toContain("[researcher]");
		expect(prompt).toContain("[coder]");
		expect(prompt).toContain("[tester]");
		expect(prompt).toContain("[reviewer]");
		expect(prompt).toContain(
			"Step drafts are suggestions only; do not add them to long_task unless the user asks to track or continue the task",
		);
	});

	it("routing prompt contains Dispatch step drafts: none for immediate prompts", () => {
		const cwd = createTempDir();
		tempDirs.push(cwd);
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "task-router.config.json"),
			JSON.stringify({ enabled: true, defaultMode: "immediate" }),
			"utf-8",
		);

		const prompt = buildTaskRoutingSystemPrompt(cwd, "帮我解释一下 mem0 是干什么的");

		expect(prompt).toContain("Dispatch step drafts: none");
	});

	it("long_task suggest_steps returns drafts without creating a task", async () => {
		const cwd = createTempDir();
		tempDirs.push(cwd);
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "task-router.config.json"),
			JSON.stringify({ enabled: true, defaultMode: "immediate" }),
			"utf-8",
		);

		const { tools } = createExtensionHarness();
		const longTaskTool = tools.get("long_task");
		expect(longTaskTool).toBeDefined();

		const result = await longTaskTool!.execute(
			"tool-call-1",
			{ action: "suggest_steps", goal: "我们要做多 agent 协作编排，包含调研、编码、测试和 review" },
			undefined,
			undefined,
			{ cwd },
		);

		expect(result.isError).toBeFalsy();
		expect(result.content[0]!.text).toContain("Suggested steps:");
		expect(result.content[0]!.text).toContain("[researcher]");
		expect(result.content[0]!.text).toContain("[coder]");
		expect(result.content[0]!.text).toContain("[tester]");
		expect(result.content[0]!.text).toContain("[reviewer]");

		const tasksDir = join(cwd, ".pi", "tasks");
		expect(existsSync(tasksDir)).toBe(false);
	});

	it("long_task suggest_steps returns no drafts for non-multi-agent goals", async () => {
		const cwd = createTempDir();
		tempDirs.push(cwd);
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "task-router.config.json"),
			JSON.stringify({ enabled: true, defaultMode: "immediate" }),
			"utf-8",
		);

		const { tools } = createExtensionHarness();
		const longTaskTool = tools.get("long_task");
		expect(longTaskTool).toBeDefined();

		const result = await longTaskTool!.execute(
			"tool-call-1",
			{ action: "suggest_steps", goal: "帮我解释一下 mem0 是干什么的" },
			undefined,
			undefined,
			{ cwd },
		);

		expect(result.isError).toBeFalsy();
		expect(result.content[0]!.text).toContain("No multi-agent step drafts suggested");
	});

	it("long_task add_suggested_steps writes steps to an existing task", async () => {
		const cwd = createTempDir();
		tempDirs.push(cwd);
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "task-router.config.json"),
			JSON.stringify({ enabled: true, defaultMode: "immediate" }),
			"utf-8",
		);

		const { tools } = createExtensionHarness();
		const longTaskTool = tools.get("long_task");
		expect(longTaskTool).toBeDefined();

		const createResult = await longTaskTool!.execute(
			"tool-call-1",
			{ action: "create", goal: "我们要做多 agent 协作编排，包含调研、编码、测试和 review" },
			undefined,
			undefined,
			{ cwd },
		);
		const taskId = createResult.content[0]!.text.match(/id: ([^\n]+)/)?.[1];
		expect(taskId).toBeDefined();

		const addResult = await longTaskTool!.execute(
			"tool-call-2",
			{ action: "add_suggested_steps", taskId },
			undefined,
			undefined,
			{ cwd },
		);

		expect(addResult.isError).toBeFalsy();
		expect(addResult.content[0]!.text).toContain("Added 4 step(s) to task");
		expect(addResult.content[0]!.text).toContain("reused 0");

		const task = readTask(cwd, taskId!);
		expect(task.plan).toHaveLength(4);
		expect(task.plan[0]!.worker).toBe("researcher");
		expect(task.plan[0]!.expectedOutput).toBe("Concise findings, relevant files, risks, and assumptions.");
	});

	it("long_task add_suggested_steps reuses existing steps on second call", async () => {
		const cwd = createTempDir();
		tempDirs.push(cwd);
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "task-router.config.json"),
			JSON.stringify({ enabled: true, defaultMode: "immediate" }),
			"utf-8",
		);

		const { tools } = createExtensionHarness();
		const longTaskTool = tools.get("long_task");
		expect(longTaskTool).toBeDefined();

		const createResult = await longTaskTool!.execute(
			"tool-call-1",
			{ action: "create", goal: "我们要做多 agent 协作编排，包含调研、编码、测试和 review" },
			undefined,
			undefined,
			{ cwd },
		);
		const taskId = createResult.content[0]!.text.match(/id: ([^\n]+)/)?.[1];
		expect(taskId).toBeDefined();

		await longTaskTool!.execute("tool-call-2", { action: "add_suggested_steps", taskId }, undefined, undefined, {
			cwd,
		});

		const secondResult = await longTaskTool!.execute(
			"tool-call-3",
			{ action: "add_suggested_steps", taskId },
			undefined,
			undefined,
			{ cwd },
		);

		expect(secondResult.content[0]!.text).toContain("Added 0 step(s)");
		expect(secondResult.content[0]!.text).toContain("reused 4");

		const task = readTask(cwd, taskId!);
		expect(task.plan).toHaveLength(4);
	});

	it("suggest_steps uses sourcePrompt over goal, preserving multi-agent signals when goal is shortened", async () => {
		const cwd = createTempDir();
		tempDirs.push(cwd);
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "task-router.config.json"),
			JSON.stringify({ enabled: true, defaultMode: "immediate" }),
			"utf-8",
		);

		const { tools } = createExtensionHarness();
		const longTaskTool = tools.get("long_task");
		expect(longTaskTool).toBeDefined();

		const result = await longTaskTool!.execute(
			"tool-call-1",
			{
				action: "suggest_steps",
				goal: "Add regression test",
				sourcePrompt: "我们要做多 agent 协作编排，包含调研、编码、测试和 review",
			},
			undefined,
			undefined,
			{ cwd },
		);

		expect(result.isError).toBeFalsy();
		expect(result.content[0]!.text).toContain("[researcher]");
		expect(result.content[0]!.text).toContain("[coder]");
		expect(result.content[0]!.text).toContain("[tester]");
		expect(result.content[0]!.text).toContain("[reviewer]");
	});

	it("add_suggested_steps uses sourcePrompt when goal is shortened, preserving multi-agent signals", async () => {
		const cwd = createTempDir();
		tempDirs.push(cwd);
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "task-router.config.json"),
			JSON.stringify({ enabled: true, defaultMode: "immediate" }),
			"utf-8",
		);

		const { tools } = createExtensionHarness();
		const longTaskTool = tools.get("long_task");
		expect(longTaskTool).toBeDefined();

		const createResult = await longTaskTool!.execute(
			"tool-call-1",
			{ action: "create", goal: "Add regression test" },
			undefined,
			undefined,
			{ cwd },
		);
		const taskId = createResult.content[0]!.text.match(/id: ([^\n]+)/)?.[1];
		expect(taskId).toBeDefined();

		const addResult = await longTaskTool!.execute(
			"tool-call-2",
			{
				action: "add_suggested_steps",
				taskId,
				sourcePrompt: "我们要做多 agent 协作编排，包含调研、编码、测试和 review",
			},
			undefined,
			undefined,
			{ cwd },
		);

		expect(addResult.content[0]!.text).toContain("Added 4 step(s) to task");
		const task = readTask(cwd, taskId!);
		expect(task.plan).toHaveLength(4);
		expect(task.plan[0]!.worker).toBe("researcher");
	});

	it("add_suggested_steps falls back to task.originalPrompt when sourcePrompt is missing", async () => {
		const cwd = createTempDir();
		tempDirs.push(cwd);
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "task-router.config.json"),
			JSON.stringify({ enabled: true, defaultMode: "immediate" }),
			"utf-8",
		);

		const { tools } = createExtensionHarness();
		const longTaskTool = tools.get("long_task");
		expect(longTaskTool).toBeDefined();

		const createResult = await longTaskTool!.execute(
			"tool-call-1",
			{
				action: "create",
				goal: "Short summary",
				sourcePrompt: "我们要做多 agent 协作编排，包含调研、编码、测试和 review",
			},
			undefined,
			undefined,
			{ cwd },
		);
		const taskId = createResult.content[0]!.text.match(/id: ([^\n]+)/)?.[1];
		expect(taskId).toBeDefined();

		const task = readTask(cwd, taskId!);
		expect(task.originalPrompt).toBe("我们要做多 agent 协作编排，包含调研、编码、测试和 review");
		expect(task.goal).toBe("Short summary");

		const addResult = await longTaskTool!.execute(
			"tool-call-2",
			{ action: "add_suggested_steps", taskId },
			undefined,
			undefined,
			{ cwd },
		);

		expect(addResult.content[0]!.text).toContain("Added 4 step(s) to task");
	});

	it("routing prompt includes sourcePrompt guidance", () => {
		const cwd = createTempDir();
		tempDirs.push(cwd);
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "task-router.config.json"),
			JSON.stringify({ enabled: true, defaultMode: "immediate" }),
			"utf-8",
		);

		const prompt = buildTaskRoutingSystemPrompt(cwd, "我们要做多 agent 协作编排，包含调研、编码、测试和 review");

		expect(prompt).toContain("pass the original user request as sourcePrompt, not a shortened goal summary");
	});

	it("resume prompt displays worker and expectedOutput metadata when present", () => {
		const cwd = createTempDir();
		tempDirs.push(cwd);
		const task = createLongTask(
			cwd,
			"We need multi agent collaboration, covering research, coding, testing, and review",
		);
		const withFirstStep = addTaskStep(cwd, task.id, "Research context and constraints", {
			worker: "researcher",
			expectedOutput: "Concise findings, relevant files, risks, and assumptions.",
		});
		const stepId = withFirstStep.plan[0]!.id;
		updateStepStatus(cwd, task.id, stepId, "completed");

		addTaskStep(cwd, task.id, "Implement scoped changes", {
			worker: "coder",
			expectedOutput: "Changed files and implementation summary.",
		});

		const updated = readTask(cwd, task.id);
		const prompt = buildResumePrompt(updated);

		expect(prompt).toContain("worker: researcher");
		expect(prompt).toContain("expectedOutput: Concise findings, relevant files, risks, and assumptions.");
		expect(prompt).toContain("worker: coder");
		expect(prompt).toContain("expectedOutput: Changed files and implementation summary.");
	});

	it("resume prompt includes Lead Execution Protocol", () => {
		const cwd = createTempDir();
		tempDirs.push(cwd);
		const task = createLongTask(cwd, "Implement a durable task runner.");
		addTaskStep(cwd, task.id, "Research patterns", { worker: "researcher" });
		const updated = readTask(cwd, task.id);
		const prompt = buildResumePrompt(updated);

		expect(prompt).toContain("# Lead Execution Protocol");
		expect(prompt).toContain("Execute ONLY the current pending/running step");
		expect(prompt).toContain("Use the worker_execute tool to delegate work to researcher and reviewer workers");
		expect(prompt).toContain(
			"researcher: READ-ONLY. Use read, grep, find, ls. Output findings, relevant files, risks, assumptions.",
		);
		expect(prompt).toContain(
			"coder: SCOPED WRITE. Only edit files in allowedScope. If no allowedScope, declare files before editing.",
		);
		expect(prompt).toContain("tester: VALIDATION ONLY. Run test commands. Report pass/fail with error details.");
		expect(prompt).toContain(
			"reviewer: READ-ONLY. Review diffs and test coverage. Output findings ordered by severity.",
		);
		expect(prompt).toContain(
			"docWriter: DOCS ONLY. Edit documentation files, or explain why no docs changes are needed.",
		);
	});

	it("resume prompt includes current step details and do-not-replan instruction", () => {
		const cwd = createTempDir();
		tempDirs.push(cwd);
		const task = createLongTask(cwd, "Implement a durable task runner.");
		addTaskStep(cwd, task.id, "Research context and constraints", {
			worker: "researcher",
			expectedOutput: "Concise findings, relevant files, risks, and assumptions.",
			allowedScope: [".pi/extensions/", "packages/coding-agent/src/core/"],
		});
		const updated = readTask(cwd, task.id);
		const prompt = buildResumePrompt(updated);
		const currentStep = updated.plan[0]!;

		expect(prompt).toContain("# 当前步骤详情");
		expect(prompt).toContain(`当前步骤 ID：${currentStep.id}`);
		expect(prompt).toContain("Worker 角色：researcher");
		expect(prompt).toContain("预期输出：Concise findings, relevant files, risks, and assumptions.");
		expect(prompt).toContain("允许修改范围：.pi/extensions/, packages/coding-agent/src/core/");
		expect(prompt).toContain("## 重要：不要重新规划！");
		expect(prompt).toContain("你正在恢复之前规划好的任务。请直接继续执行当前步骤，不要重新分析或重新规划。");
		expect(prompt).toContain("只执行当前这一个步骤，完成后立即调用 long_task set_step 更新步骤状态。");
		expect(prompt).toContain("不要跳到后面的步骤，不要并行执行，不要创建子 agent。");
	});

	it("routing prompt always includes Tool Failure Recovery", () => {
		const cwd = createTempDir();
		tempDirs.push(cwd);
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "task-router.config.json"),
			JSON.stringify({ enabled: true, defaultMode: "immediate" }),
			"utf-8",
		);

		const prompt = buildTaskRoutingSystemPrompt(cwd, "帮我解释一下 mem0 是干什么的");

		expect(prompt).toContain("# Tool Call Failure Recovery");
		expect(prompt).toContain("Read the error message carefully");
		expect(prompt).toContain("Do NOT repeat the same failing call unchanged");
		expect(prompt).toContain("If the same tool fails twice consecutively");
		expect(prompt).toContain("For edit failures: read the target file");
		expect(prompt).toContain("For bash failures: verify command syntax");
		expect(prompt).toContain("call long_task set_step blocked and explain what failed");
	});

	it("routing prompt includes Lead Execution Protocol when active tasks exist", () => {
		const cwd = createTempDir();
		tempDirs.push(cwd);
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "task-router.config.json"),
			JSON.stringify({ enabled: true, defaultMode: "immediate" }),
			"utf-8",
		);

		createLongTask(cwd, "An ongoing multi-step task.");
		const prompt = buildTaskRoutingSystemPrompt(cwd, "继续推进");

		expect(prompt).toContain("# Lead Execution Protocol");
		expect(prompt).toContain("Execute ONLY the current pending/running step");
		expect(prompt).toContain("Use the worker_execute tool to delegate work to researcher and reviewer workers");
	});

	it("routing prompt does NOT include Lead Execution Protocol when no active tasks exist", () => {
		const cwd = createTempDir();
		tempDirs.push(cwd);
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "task-router.config.json"),
			JSON.stringify({ enabled: true, defaultMode: "immediate" }),
			"utf-8",
		);

		const prompt = buildTaskRoutingSystemPrompt(cwd, "帮我解释一下 mem0 是干什么的");

		expect(prompt).toContain("# Tool Call Failure Recovery");
		expect(prompt).not.toContain("# Lead Execution Protocol");
	});

	it("resume prompt includes allowedScope enforcement rules", () => {
		const cwd = createTempDir();
		tempDirs.push(cwd);
		const task = createLongTask(cwd, "Implement a scoped change.");
		addTaskStep(cwd, task.id, "Implement changes", {
			worker: "coder",
			allowedScope: ["packages/coding-agent/src/core/"],
		});
		const updated = readTask(cwd, task.id);
		const prompt = buildResumePrompt(updated);

		expect(prompt).toContain("If the current step has allowedScope, you MUST NOT edit files outside that scope.");
		expect(prompt).toContain(
			"If the current step has no allowedScope, you MUST state which files you will modify before editing.",
		);
		expect(prompt).toContain(
			"If you need to edit a file outside allowedScope, mark the step blocked and explain why.",
		);
	});

	it("set_step stores stepArtifacts and notes on a step", async () => {
		const cwd = createTempDir();
		tempDirs.push(cwd);
		const { tools } = createExtensionHarness();
		const longTaskTool = tools.get("long_task");
		expect(longTaskTool).toBeDefined();

		const createResult = await longTaskTool!.execute(
			"tool-call-1",
			{ action: "create", goal: "Track implementation with step artifacts." },
			undefined,
			undefined,
			{ cwd },
		);
		const taskId = createResult.content[0]!.text.match(/id: ([^\n]+)/)?.[1];
		expect(taskId).toBeDefined();

		await longTaskTool!.execute(
			"tool-call-2",
			{ action: "add_step", taskId, title: "Research context" },
			undefined,
			undefined,
			{ cwd },
		);

		const task = readTask(cwd, taskId!);
		const stepId = task.plan[0]!.id;

		await longTaskTool!.execute(
			"tool-call-3",
			{
				action: "set_step",
				taskId,
				stepId,
				status: "completed",
				message: "Research complete",
				stepArtifacts: [".pi/findings.md", ".pi/risks.md"],
				notes: "Key risk: SDK version mismatch",
			},
			undefined,
			undefined,
			{ cwd },
		);

		const updated = readTask(cwd, taskId!);
		const step = updated.plan[0]!;
		expect(step.status).toBe("completed");
		expect(step.output).toBe("Research complete");
		expect(step.artifacts).toEqual([".pi/findings.md", ".pi/risks.md"]);
		expect(step.notes).toBe("Key risk: SDK version mismatch");
	});

	it("step-level artifacts propagate to task-level artifact list", async () => {
		const cwd = createTempDir();
		tempDirs.push(cwd);
		const { tools } = createExtensionHarness();
		const longTaskTool = tools.get("long_task");
		expect(longTaskTool).toBeDefined();

		const createResult = await longTaskTool!.execute(
			"tool-call-1",
			{ action: "create", goal: "Track implementation." },
			undefined,
			undefined,
			{ cwd },
		);
		const taskId = createResult.content[0]!.text.match(/id: ([^\n]+)/)?.[1];
		expect(taskId).toBeDefined();

		await longTaskTool!.execute(
			"tool-call-2",
			{ action: "add_step", taskId, title: "Step 1" },
			undefined,
			undefined,
			{ cwd },
		);

		let task = readTask(cwd, taskId!);
		const step1Id = task.plan[0]!.id;

		await longTaskTool!.execute(
			"tool-call-3",
			{
				action: "set_step",
				taskId,
				stepId: step1Id,
				status: "completed",
				stepArtifacts: ["file-a.ts", "file-b.ts"],
			},
			undefined,
			undefined,
			{ cwd },
		);

		task = readTask(cwd, taskId!);
		expect(task.artifacts).toContain("file-a.ts");
		expect(task.artifacts).toContain("file-b.ts");
	});

	it("show output displays step artifacts and notes inline", async () => {
		const cwd = createTempDir();
		tempDirs.push(cwd);
		const { tools } = createExtensionHarness();
		const longTaskTool = tools.get("long_task");
		expect(longTaskTool).toBeDefined();

		const createResult = await longTaskTool!.execute(
			"tool-call-1",
			{ action: "create", goal: "Track with artifacts." },
			undefined,
			undefined,
			{ cwd },
		);
		const taskId = createResult.content[0]!.text.match(/id: ([^\n]+)/)?.[1];
		expect(taskId).toBeDefined();

		await longTaskTool!.execute(
			"tool-call-2",
			{ action: "add_step", taskId, title: "Research step" },
			undefined,
			undefined,
			{ cwd },
		);

		const task = readTask(cwd, taskId!);
		const stepId = task.plan[0]!.id;

		await longTaskTool!.execute(
			"tool-call-3",
			{
				action: "set_step",
				taskId,
				stepId,
				status: "completed",
				stepArtifacts: [".pi/findings.md"],
				notes: "Important observation",
			},
			undefined,
			undefined,
			{ cwd },
		);

		const showResult = await longTaskTool!.execute("tool-call-4", { action: "show", taskId }, undefined, undefined, {
			cwd,
		});

		expect(showResult.content[0]!.text).toContain("artifacts: .pi/findings.md");
		expect(showResult.content[0]!.text).toContain("notes: Important observation");
	});

	it("resume prompt includes step artifacts and notes", () => {
		const cwd = createTempDir();
		tempDirs.push(cwd);
		const task = createLongTask(cwd, "Track with step artifacts.");
		addTaskStep(cwd, task.id, "Research context", {
			worker: "researcher",
			expectedOutput: "Concise findings, relevant files, risks, and assumptions.",
		});
		const updated = readTask(cwd, task.id);
		const stepId = updated.plan[0]!.id;
		updateStepStatus(
			cwd,
			task.id,
			stepId,
			"completed",
			"Research done",
			[".pi/findings.md"],
			"Risk: version mismatch",
		);
		const task2 = readTask(cwd, task.id);
		addTaskStep(cwd, task2.id, "Implement changes", { worker: "coder" });
		const final = readTask(cwd, task.id);
		const prompt = buildResumePrompt(final);

		expect(prompt).toContain("artifacts: .pi/findings.md");
		expect(prompt).toContain("notes: Risk: version mismatch");
	});

	it("Lead Execution Protocol includes step artifact rules", () => {
		const cwd = createTempDir();
		tempDirs.push(cwd);
		const task = createLongTask(cwd, "Test artifact rules.");
		addTaskStep(cwd, task.id, "Research", { worker: "researcher" });
		const updated = readTask(cwd, task.id);
		const prompt = buildResumePrompt(updated);

		expect(prompt).toContain("## Step Artifact Rules");
		expect(prompt).toContain("When completing a step via long_task set_step, always include stepArtifacts:");
		expect(prompt).toContain("- researcher: file paths of findings docs, relevant source files, risk assessments");
		expect(prompt).toContain("- coder: list of changed files with a brief summary of what changed");
		expect(prompt).toContain("- tester: test command outputs, pass/fail status, failure details");
		expect(prompt).toContain("- reviewer: findings ordered by severity with file references");
		expect(prompt).toContain(
			"- docWriter: changed doc file paths, or explanation of why no docs changes were needed",
		);
		expect(prompt).toContain("Use the notes parameter to add freeform observations, warnings, or context.");
	});

	// ── Phase 8: Dashboard UX ──────────────────────────────────────────

	it("buildProgressBar produces correct bar for various ratios", () => {
		// buildProgressBar is imported at the top
		expect(buildProgressBar(0, 10, 10)).toBe("[░░░░░░░░░░]");
		expect(buildProgressBar(5, 10, 10)).toBe("[█████░░░░░]");
		expect(buildProgressBar(10, 10, 10)).toBe("[██████████]");
		expect(buildProgressBar(0, 0, 10)).toBe("[░░░░░░░░░░]");
		expect(buildProgressBar(1, 3, 6)).toBe("[██░░░░]");
	});

	it("formatTaskSummary in routing prompt includes progress info", () => {
		const cwd = createTempDir();
		tempDirs.push(cwd);
		const task = createLongTask(cwd, "Test summary formatting.");
		addTaskStep(cwd, task.id, "Research", { worker: "researcher" });
		addTaskStep(cwd, task.id, "Implement", { worker: "coder" });
		addTaskStep(cwd, task.id, "Test", { worker: "tester" });
		let updated = readTask(cwd, task.id);
		const step1Id = updated.plan[0]!.id;
		updateStepStatus(cwd, task.id, step1Id, "completed", "Done");
		updated = readTask(cwd, task.id);
		// Trigger routing prompt generation which uses formatTaskSummary
		const prompt = buildTaskRoutingSystemPrompt(cwd, "status check");
		expect(prompt).toContain("1/3");
	});

	it("/task list separates active from completed tasks", async () => {
		const cwd = createTempDir();
		tempDirs.push(cwd);
		const { commands } = createExtensionHarness();
		const ctx = createFakeContext(cwd);

		// Create an active task
		createLongTask(cwd, "Active task 1");
		// Create and complete a task - direct write to bypass async import issues
		// updateTaskStatus is now imported at the top
		const done = createLongTask(cwd, "Completed task");
		updateTaskStatus(cwd, done.id, "completed");

		await commands.get("task")!("list", ctx);
		const notification = ctx.ui.notifications.at(-1)?.message ?? "";
		expect(notification).toContain("Active");
	});
});
