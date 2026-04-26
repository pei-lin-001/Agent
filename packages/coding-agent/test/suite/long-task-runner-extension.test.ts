import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import longTaskRunnerExtension, {
	addTaskStep,
	buildResumePrompt,
	buildTaskRoutingSystemPrompt,
	createLongTask,
	getTaskStorageDir,
	readTask,
	updateStepStatus,
} from "../../../../.pi/extensions/long-task-runner.js";

type CommandHandler = (args: string, ctx: FakeCommandContext) => Promise<void>;
type ExtensionHandler = (event: unknown, ctx: unknown) => Promise<unknown> | unknown;
type LongTaskToolParams = {
	action: "create" | "list" | "show" | "add_step" | "set_task" | "set_step" | "add_artifact" | "resume";
	goal?: string;
	taskId?: string;
	title?: string;
	stepId?: string;
	status?: string;
	message?: string;
	worker?: string;
	modelPolicy?: string;
	artifact?: string;
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
});
