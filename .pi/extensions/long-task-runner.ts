import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { StringEnum } from "@mariozechner/pi-ai";
import { Type } from "typebox";
import { buildAgentStepDrafts, recommendAgentDispatch } from "./multi-agent-dispatcher.js";

type TaskStatus = "pending" | "running" | "blocked" | "completed" | "failed" | "cancelled";
type StepStatus = "pending" | "running" | "completed" | "failed" | "skipped" | "blocked";

interface TaskRouterConfig {
	enabled?: boolean;
	defaultMode?: "immediate" | "long-task";
	askWhenAmbiguous?: boolean;
	longTaskStorageDir?: string;
	routing?: {
		autoEscalateKeywords?: string[];
		autoEscalateWhenMultiplePhases?: boolean;
		autoEscalateWhenManyFilesLikely?: boolean;
	};
	modelPolicies?: Record<string, { provider?: string | null; model?: string | null; thinkingLevel?: string | null }>;
	workers?: Record<string, { enabled?: boolean; permission?: string; modelPolicy?: string; allowParallel?: boolean }>;
}

interface AddTaskStepOptions {
	input?: string;
	worker?: string;
	modelPolicy?: string;
	expectedOutput?: string;
	allowedScope?: string[];
}

interface AddTaskStepResult {
	task: LongTaskRecord;
	step: LongTaskStep;
	reused: boolean;
}

export interface LongTaskStep {
	id: string;
	title: string;
	status: StepStatus;
	dependsOn: string[];
	worker?: string;
	modelPolicy?: string;
	input: string;
	output?: string;
	error?: string;
	expectedOutput?: string;
	allowedScope?: string[];
	startedAt?: string;
	completedAt?: string;
	artifacts?: string[];
	notes?: string;
}

export interface LongTaskRecord {
	id: string;
	title: string;
	status: TaskStatus;
	createdAt: string;
	updatedAt: string;
	mode: "long-task";
	goal: string;
	originalPrompt?: string;
	plan: LongTaskStep[];
	currentStepId?: string;
	artifacts: string[];
	memoryKeys: string[];
	trace: LongTaskTraceEntry[];
}

interface LongTaskTraceEntry {
	timestamp: string;
	event: string;
	message: string;
}

interface ParsedTaskCommand {
	action: string;
	args: string[];
}

const DEFAULT_STORAGE_DIR = ".pi/tasks";
const DEFAULT_CONFIG: Required<Pick<TaskRouterConfig, "enabled" | "defaultMode" | "askWhenAmbiguous">> = {
	enabled: true,
	defaultMode: "immediate",
	askWhenAmbiguous: true,
};
const VALID_TASK_STATUSES: TaskStatus[] = ["pending", "running", "blocked", "completed", "failed", "cancelled"];
const VALID_STEP_STATUSES: StepStatus[] = ["pending", "running", "completed", "failed", "skipped", "blocked"];
const LongTaskToolParams = Type.Object({
	action: StringEnum(["create", "list", "show", "add_step", "set_task", "set_step", "add_artifact", "resume", "suggest_steps", "add_suggested_steps"] as const, {
		description: "Long task action to perform.",
	}),
	goal: Type.Optional(Type.String({ description: "Goal for create, suggest_steps, or add_suggested_steps." })),
	sourcePrompt: Type.Optional(
		Type.String({
			description:
				"Original user prompt for create, suggest_steps, or add_suggested_steps. Use this to preserve multi-agent signals when the goal is a short summary.",
		}),
	),
	taskId: Type.Optional(
		Type.String({ description: "Task id for show, add_step, set_task, set_step, add_artifact, resume, or add_suggested_steps." }),
	),
	title: Type.Optional(Type.String({ description: "Step title for add_step." })),
	stepId: Type.Optional(Type.String({ description: "Step id for set_step." })),
	status: Type.Optional(Type.String({ description: "Task or step status." })),
	message: Type.Optional(Type.String({ description: "Optional output or error message for step updates." })),
	worker: Type.Optional(Type.String({ description: "Optional worker hint for add_step, such as researcher or reviewer." })),
	modelPolicy: Type.Optional(Type.String({ description: "Optional model policy hint for add_step." })),
	expectedOutput: Type.Optional(Type.String({ description: "Optional expected output description for add_step." })),
	allowedScope: Type.Optional(Type.Array(Type.String(), { description: "Optional allowed scope for add_step." })),
	artifact: Type.Optional(Type.String({ description: "Artifact path, URL, or note for add_artifact." })),
	stepArtifacts: Type.Optional(Type.Array(Type.String(), { description: "Step-level artifacts when calling set_step (file paths, URLs, or notes produced by the step)." })),
	notes: Type.Optional(Type.String({ description: "Optional freeform notes to attach to the step when calling set_step." })),
});

function nowIso(): string {
	return new Date().toISOString();
}

function slugifyTitle(title: string): string {
	const normalized = title
		.toLowerCase()
		.replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 48);
	return normalized || "task";
}

function createTaskId(title: string): string {
	return `${new Date().toISOString().slice(0, 10)}-${slugifyTitle(title)}-${randomUUID().slice(0, 8)}`;
}

function createStepId(index: number, title: string): string {
	return `step-${String(index + 1).padStart(2, "0")}-${slugifyTitle(title).slice(0, 32)}`;
}

function parseConfig(cwd: string): TaskRouterConfig {
	const configPath = join(cwd, ".pi", "task-router.config.json");
	if (!existsSync(configPath)) {
		return {};
	}
	try {
		return JSON.parse(readFileSync(configPath, "utf-8")) as TaskRouterConfig;
	} catch (error) {
		throw new Error(`Failed to parse task router config at ${configPath}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function readConfig(cwd: string): TaskRouterConfig {
	return { ...DEFAULT_CONFIG, ...parseConfig(cwd) };
}

function isEnabled(cwd: string): boolean {
	return readConfig(cwd).enabled !== false;
}

export function getTaskStorageDir(cwd: string): string {
	const config = readConfig(cwd);
	return join(cwd, config.longTaskStorageDir ?? DEFAULT_STORAGE_DIR);
}

function ensureStorageDir(cwd: string): string {
	const storageDir = getTaskStorageDir(cwd);
	mkdirSync(storageDir, { recursive: true });
	return storageDir;
}

function taskFilePath(cwd: string, taskId: string): string {
	if (taskId.includes("/") || taskId.includes("\\") || taskId !== basename(taskId)) {
		throw new Error(`Invalid task id: ${taskId}`);
	}
	return join(getTaskStorageDir(cwd), `${taskId}.json`);
}

function writeTask(cwd: string, task: LongTaskRecord): void {
	ensureStorageDir(cwd);
	writeFileSync(taskFilePath(cwd, task.id), `${JSON.stringify(task, null, 2)}\n`, "utf-8");
}

export function readTask(cwd: string, taskId: string): LongTaskRecord {
	const path = taskFilePath(cwd, taskId);
	if (!existsSync(path)) {
		throw new Error(`Task not found: ${taskId}`);
	}
	return JSON.parse(readFileSync(path, "utf-8")) as LongTaskRecord;
}

export function listTasks(cwd: string): LongTaskRecord[] {
	const storageDir = getTaskStorageDir(cwd);
	if (!existsSync(storageDir)) {
		return [];
	}
	return readdirSync(storageDir)
		.filter((entry) => entry.endsWith(".json"))
		.map((entry) => readTask(cwd, entry.slice(0, -".json".length)))
		.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function appendTrace(task: LongTaskRecord, event: string, message: string): void {
	task.trace.push({ timestamp: nowIso(), event, message });
	task.updatedAt = nowIso();
}

function firstSentence(text: string): string {
	const normalized = text.trim().replace(/\s+/g, " ");
	if (normalized.length <= 80) {
		return normalized;
	}
	return `${normalized.slice(0, 77)}...`;
}

export function createLongTask(cwd: string, goal: string, title?: string, originalPrompt?: string): LongTaskRecord {
	const cleanGoal = goal.trim();
	if (!cleanGoal) {
		throw new Error("Task goal is required");
	}
	const taskTitle = title?.trim() || firstSentence(cleanGoal);
	const timestamp = nowIso();
	const task: LongTaskRecord = {
		id: createTaskId(taskTitle),
		title: taskTitle,
		status: "pending",
		createdAt: timestamp,
		updatedAt: timestamp,
		mode: "long-task",
		goal: cleanGoal,
		originalPrompt: originalPrompt?.trim() || undefined,
		plan: [],
		artifacts: [],
		memoryKeys: [`task:${taskTitle}`],
		trace: [{ timestamp, event: "task_created", message: "Task record created" }],
	};
	writeTask(cwd, task);
	return task;
}

export function addTaskStep(cwd: string, taskId: string, title: string, options: AddTaskStepOptions = {}): LongTaskRecord {
	return addOrReuseTaskStep(cwd, taskId, title, options).task;
}

function addOrReuseTaskStep(cwd: string, taskId: string, title: string, options: AddTaskStepOptions = {}): AddTaskStepResult {
	const cleanTitle = title.trim();
	if (!cleanTitle) {
		throw new Error("Step title is required");
	}
	const task = readTask(cwd, taskId);
	const matchingStep = findMatchingTaskStep(task, [cleanTitle, options.input ?? "", options.worker ?? "", options.modelPolicy ?? ""].join(" "));
	if (matchingStep) {
		appendTrace(task, "step_reused", `Reused existing step ${matchingStep.id}`);
		writeTask(cwd, task);
		return { task, step: matchingStep, reused: true };
	}
	const step: LongTaskStep = {
		id: createStepId(task.plan.length, cleanTitle),
		title: cleanTitle,
		status: "pending",
		dependsOn: task.plan.length > 0 ? [task.plan[task.plan.length - 1]!.id] : [],
		input: options.input?.trim() || cleanTitle,
		worker: options.worker?.trim() || undefined,
		modelPolicy: options.modelPolicy?.trim() || undefined,
		expectedOutput: options.expectedOutput?.trim() || undefined,
		allowedScope: options.allowedScope?.length ? options.allowedScope : undefined,
	};
	task.plan.push(step);
	task.currentStepId = task.currentStepId ?? step.id;
	appendTrace(task, "step_added", `Added step ${step.id}`);
	writeTask(cwd, task);
	return { task, step, reused: false };
}

export function addTaskArtifact(cwd: string, taskId: string, artifact: string): LongTaskRecord {
	const cleanArtifact = artifact.trim();
	if (!cleanArtifact) {
		throw new Error("Artifact is required");
	}
	const task = readTask(cwd, taskId);
	task.artifacts.push(cleanArtifact);
	appendTrace(task, "artifact_added", `Added artifact ${cleanArtifact}`);
	writeTask(cwd, task);
	return task;
}

export function updateTaskStatus(cwd: string, taskId: string, status: TaskStatus): LongTaskRecord {
	if (!VALID_TASK_STATUSES.includes(status)) {
		throw new Error(`Invalid task status: ${status}`);
	}
	const task = readTask(cwd, taskId);
	task.status = status;
	appendTrace(task, "task_status_updated", `Task status changed to ${status}`);
	writeTask(cwd, task);
	return task;
}

export function updateStepStatus(
	cwd: string,
	taskId: string,
	stepId: string,
	status: StepStatus,
	message?: string,
	stepArtifacts?: string[],
	notes?: string,
): LongTaskRecord {
	if (!VALID_STEP_STATUSES.includes(status)) {
		throw new Error(`Invalid step status: ${status}`);
	}
	const task = readTask(cwd, taskId);
	const step = task.plan.find((candidate) => candidate.id === stepId);
	if (!step) {
		throw new Error(`Step not found: ${stepId}`);
	}
	step.status = status;
	if (status === "running") {
		step.startedAt = step.startedAt ?? nowIso();
	}
	if (status === "completed" || status === "failed" || status === "skipped" || status === "blocked") {
		step.completedAt = nowIso();
	}
	if (status === "completed" && message?.trim()) {
		step.output = message.trim();
	}
	if (status === "failed" && message?.trim()) {
		step.error = message.trim();
	}
	if (stepArtifacts?.length) {
		step.artifacts = stepArtifacts.filter((a): a is string => a?.trim().length > 0);
		for (const artifact of step.artifacts) {
			if (!task.artifacts.includes(artifact)) {
				task.artifacts.push(artifact);
			}
		}
	}
	if (notes?.trim()) {
		step.notes = notes.trim();
	}
	task.currentStepId = task.plan.find((candidate) => candidate.status === "pending" || candidate.status === "running")?.id;
	if (task.plan.length > 0 && task.plan.every((candidate) => candidate.status === "completed" || candidate.status === "skipped")) {
		task.status = "completed";
	}
	appendTrace(task, "step_status_updated", `Step ${step.id} changed to ${status}`);
	writeTask(cwd, task);
	return task;
}

function parseTaskCommand(args: string): ParsedTaskCommand {
	const parts = args.trim().split(/\s+/).filter(Boolean);
	return { action: parts[0] ?? "help", args: parts.slice(1) };
}

export function buildProgressBar(completed: number, total: number, width: number): string {
	if (total === 0) return `[${"░".repeat(width)}]`;
	const filled = Math.round((completed / total) * width);
	return `[${"█".repeat(filled)}${"░".repeat(width - filled)}]`;
}

function formatTaskSummary(task: LongTaskRecord): string {
	const nextStep = task.plan.find((step) => step.status === "pending" || step.status === "running");
	const runningStep = task.plan.find((step) => step.status === "running");
	const totalSteps = task.plan.length;
	const completedSteps = task.plan.filter((step) => step.status === "completed").length;
	const failedSteps = task.plan.filter((step) => step.status === "failed" || step.status === "blocked").length;
	const progressBar = totalSteps > 0 ? ` ${buildProgressBar(completedSteps, totalSteps, 10)}` : "";
	const workerStatuses = task.plan
		.filter((step) => step.worker && step.status !== "pending")
		.slice(0, 6)
		.map((step) => {
			const icon = step.status === "completed" ? "✓" : step.status === "running" ? "…" : step.status === "failed" ? "✗" : step.status === "skipped" ? "⏭" : "⊘";
			return `${icon}${step.worker}:${step.title.slice(0, 20)}`;
		});
	return [
		`${task.status === "running" ? "▶" : task.status === "completed" ? "✓" : task.status === "blocked" ? "⊘" : "○"} ${task.title}`,
		`id: ${task.id}`,
		`status: ${task.status}${progressBar}  ${completedSteps}/${totalSteps} steps`,
		failedSteps > 0 ? `⚠ ${failedSteps} step(s) failed or blocked` : undefined,
		runningStep ? `running: [${runningStep.worker ?? "?"}] ${runningStep.title}` : undefined,
		nextStep && !runningStep ? `next: [${nextStep.worker ?? "?"}] ${nextStep.title}` : undefined,
		workerStatuses.length > 0 ? workerStatuses.join(" | ") : undefined,
	].filter((line): line is string => !!line).join("\n");
}

function isActiveTask(task: LongTaskRecord): boolean {
	return task.status === "pending" || task.status === "running" || task.status === "blocked";
}

function taskSearchText(task: LongTaskRecord): string {
	return [
		task.title,
		task.goal,
		...task.plan.flatMap((step) => [step.id, step.title, step.input, step.output ?? ""]),
		...task.artifacts,
		...task.memoryKeys,
	].join(" ");
}

function stepSearchText(step: LongTaskStep): string {
	return [step.id, step.title, step.input, step.output ?? "", step.worker ?? "", step.modelPolicy ?? ""].join(" ");
}

const MATCH_STOP_WORDS = new Set([
	"and",
	"the",
	"for",
	"with",
	"into",
	"this",
	"that",
	"task",
	"step",
	"steps",
	"worker",
	"long",
	"term",
	"create",
	"created",
	"implement",
	"implementation",
	"layer",
	"mvp",
	"个人",
	"任务",
	"长期",
	"实现",
	"创建",
	"纳入",
	"第一版",
]);

function tokenizeForMatch(text: string): Set<string> {
	const tokens = new Set<string>();
	const normalized = text.toLowerCase().replace(/[_/.-]+/g, " ");
	for (const match of normalized.matchAll(/[a-z0-9]+|[\u4e00-\u9fa5]{2,}/g)) {
		const token = match[0];
		if (token.length < 2 || MATCH_STOP_WORDS.has(token)) {
			continue;
		}
		tokens.add(token);
		addTokenAliases(tokens, token);
	}
	addPhraseAliases(tokens, normalized);
	return tokens;
}

function addTokenAliases(tokens: Set<string>, token: string): void {
	const aliases: Record<string, string[]> = {
		dispatcher: ["dispatch", "dispatch-scope"],
		dispatch: ["dispatch-scope"],
		orchestration: ["orchestrate", "dispatch-scope"],
		orchestrator: ["orchestrate", "dispatch-scope"],
		routing: ["route", "dispatch-scope"],
		router: ["route", "dispatch-scope"],
		roles: ["role", "dispatch-scope"],
		role: ["dispatch-scope"],
		context: ["dispatch-scope"],
		result: ["dispatch-scope"],
		results: ["result", "dispatch-scope"],
		merging: ["merge", "dispatch-scope"],
		merge: ["dispatch-scope"],
		complexity: ["dispatch-scope"],
		classification: ["dispatch-scope"],
	};
	for (const alias of aliases[token] ?? []) {
		tokens.add(alias);
	}
}

function addPhraseAliases(tokens: Set<string>, normalized: string): void {
	const phraseAliases: Array<[RegExp, string[]]> = [
		[/multi\s+agent|多\s*agent|多智能体|多代理/, ["multi", "agent", "dispatch-scope"]],
		[/协作编排|编排层|调度层|调度/, ["orchestrate", "dispatch", "dispatch-scope"]],
		[/路由|分流/, ["route", "dispatch-scope"]],
		[/角色|职责/, ["role", "dispatch-scope"]],
		[/上下文/, ["context", "dispatch-scope"]],
		[/结果合并|合并/, ["merge", "result", "dispatch-scope"]],
		[/复杂度|分类/, ["complexity", "classification", "dispatch-scope"]],
	];
	for (const [pattern, aliases] of phraseAliases) {
		if (pattern.test(normalized)) {
			for (const alias of aliases) {
				tokens.add(alias);
			}
		}
	}
}

function findMatchingActiveTask(cwd: string, text: string): LongTaskRecord | undefined {
	const queryTokens = tokenizeForMatch(text);
	if (queryTokens.size === 0) {
		return undefined;
	}
	let bestMatch: { task: LongTaskRecord; overlap: number } | undefined;
	for (const task of listTasks(cwd).filter(isActiveTask)) {
		const taskTokens = tokenizeForMatch(taskSearchText(task));
		const overlap = [...queryTokens].filter((token) => taskTokens.has(token)).length;
		if (overlap >= 2 && (!bestMatch || overlap > bestMatch.overlap)) {
			bestMatch = { task, overlap };
		}
	}
	return bestMatch?.task;
}

function tokenOverlap(left: Set<string>, right: Set<string>): number {
	return [...left].filter((token) => right.has(token)).length;
}

function findMatchingTaskStep(task: LongTaskRecord, text: string): LongTaskStep | undefined {
	const queryTokens = tokenizeForMatch(text);
	if (queryTokens.size === 0) {
		return undefined;
	}
	const activeStep = task.plan.find((step) => step.id === task.currentStepId)
		?? task.plan.find((step) => step.status === "pending" || step.status === "running");
	let bestMatch: { step: LongTaskStep; overlap: number } | undefined;
	for (const step of task.plan) {
		const stepTokens = tokenizeForMatch(stepSearchText(step));
		const overlap = tokenOverlap(queryTokens, stepTokens);
		const isActiveStep = activeStep?.id === step.id;
		if ((isActiveStep && overlap >= 2) || overlap >= 3) {
			if (!bestMatch || overlap > bestMatch.overlap) {
				bestMatch = { step, overlap };
			}
		}
	}
	return bestMatch?.step;
}

function formatTaskDetails(task: LongTaskRecord): string {
	const steps = task.plan.length === 0
		? "No steps yet."
		: task.plan
			.map((step) => {
				const hints = [step.worker ? `worker:${step.worker}` : undefined, step.modelPolicy ? `model:${step.modelPolicy}` : undefined]
					.filter((hint): hint is string => !!hint)
					.join(" ");
				const statusIcons: Record<string, string> = { pending: "○", running: "▶", completed: "✓", failed: "✗", skipped: "⏭", blocked: "⊘" };
				const icon = statusIcons[step.status] ?? "?";
				const line = `  ${icon} ${step.id} [${step.status}] ${step.title}${hints ? ` (${hints})` : ""}`;
				const extras: string[] = [];
				if (step.expectedOutput) extras.push(`       expected: ${step.expectedOutput}`);
				if (step.artifacts?.length) extras.push(`       artifacts: ${step.artifacts.join(", ")}`);
				if (step.notes) extras.push(`       notes: ${step.notes}`);
				if (step.startedAt && step.completedAt) {
					const duration = new Date(step.completedAt).getTime() - new Date(step.startedAt).getTime();
					if (duration > 0) extras.push(`       took: ${Math.round(duration / 1000)}s`);
				}
				if (step.error) extras.push(`       error: ${step.error.slice(0, 200)}`);
				if (step.output) extras.push(`       output: ${step.output.slice(0, 200)}`);
				return extras.length > 0 ? `${line}\n${extras.join("\n")}` : line;
			})
			.join("\n");
	const artifacts = task.artifacts.length === 0 ? "No artifacts yet." : task.artifacts.map((artifact) => `- ${artifact}`).join("\n");
	return [
		`# ${task.title}`,
		`id: ${task.id}`,
		`status: ${task.status}`,
		"",
		"Goal:",
		task.goal,
		"",
		"Steps:",
		steps,
		"",
		"Artifacts:",
		artifacts,
	].join("\n");
}

export function buildResumePrompt(task: LongTaskRecord): string {
	const completedSteps = task.plan.filter((step) => step.status === "completed");
	const nextStep = task.plan.find((step) => step.status === "pending" || step.status === "running");
	const currentStep = task.plan.find((step) => step.id === task.currentStepId) ?? nextStep;

	function formatStepLine(step: LongTaskStep): string {
		const meta = [
			step.worker ? `worker: ${step.worker}` : undefined,
			step.expectedOutput ? `expectedOutput: ${step.expectedOutput}` : undefined,
			step.allowedScope?.length ? `allowedScope: ${step.allowedScope.join(", ")}` : undefined,
			step.artifacts?.length ? `artifacts: ${step.artifacts.join(", ")}` : undefined,
			step.notes ? `notes: ${step.notes}` : undefined,
		].filter((line): line is string => !!line);
		const primary = `- ${step.id}: ${step.title}`;
		return meta.length > 0 ? `${primary}\n  ${meta.join("\n  ")}` : primary;
	}

	function formatCurrentStep(step: LongTaskStep): string {
		return [
			`当前步骤 ID：${step.id}`,
			`标题：${step.title}`,
			step.worker ? `Worker 角色：${step.worker}` : undefined,
			step.expectedOutput ? `预期输出：${step.expectedOutput}` : undefined,
			step.allowedScope?.length ? `允许修改范围：${step.allowedScope.join(", ")}` : undefined,
			step.input ? `步骤输入：${step.input}` : undefined,
			step.artifacts?.length ? `步骤产物：${step.artifacts.join(", ")}` : undefined,
			step.notes ? `步骤笔记：${step.notes}` : undefined,
		].filter((line): line is string => !!line).join("\n");
	}

	return [
		`继续长期任务：${task.title}`,
		"",
		`任务 ID：${task.id}`,
		`当前状态：${task.status}`,
		"",
		"原始目标：",
		task.goal,
		"",
		completedSteps.length > 0
			? `已完成步骤：\n${completedSteps.map(formatStepLine).join("\n")}`
			: "已完成步骤：暂无",
		"",
		nextStep
			? `下一步：${formatStepLine(nextStep)}`
			: "下一步：请先根据目标补充计划步骤。",
		task.artifacts.length > 0 ? `\n相关产物：\n${task.artifacts.map((artifact) => `- ${artifact}`).join("\n")}` : "",
		currentStep
			? [
					"",
					"# 当前步骤详情",
					formatCurrentStep(currentStep),
					"",
					"## 重要：不要重新规划！",
					"你正在恢复之前规划好的任务。请直接继续执行当前步骤，不要重新分析或重新规划。",
					"只执行当前这一个步骤，完成后立即调用 long_task set_step 更新步骤状态。",
					"不要跳到后面的步骤，不要并行执行，不要创建子 agent。",
				].join("\n")
			: "",
		"",
		"请先简要复述当前进度，再继续推进下一步。",
		buildLeadExecutionProtocol(),
	].filter((line): line is string => !!line).join("\n");
}

export function buildLeadExecutionProtocol(): string {
	return [
		"",
		"# Lead Execution Protocol",
		"When you are the lead agent for a long task, follow these rules strictly:",
		"",
		"## Step Execution",
		"1. Before any action, use long_task show to read the current task state.",
		"2. Execute ONLY the current pending/running step. Do NOT jump ahead to later steps.",
		"3. Execute ONE step at a time. Do NOT batch or parallelize multiple steps.",
		"4. When a step is finished, immediately call long_task set_step with completed/failed/blocked.",
		"5. Do NOT skip steps. Mark them skipped explicitly if needed.",
		"6. Use the worker_execute tool to delegate work to researcher and reviewer workers. Do NOT spawn workers manually.",
		"",
		"## Worker Role Behavior",
		"Your behavior depends on the current step's worker role:",
		"- researcher: READ-ONLY. Use read, grep, find, ls. Output findings, relevant files, risks, assumptions.",
		"- coder: SCOPED WRITE. Only edit files in allowedScope. If no allowedScope, declare files before editing.",
		"- tester: VALIDATION ONLY. Run test commands. Report pass/fail with error details.",
		"- reviewer: READ-ONLY. Review diffs and test coverage. Output findings ordered by severity.",
		"- docWriter: DOCS ONLY. Edit documentation files, or explain why no docs changes are needed.",
		"",
		"## allowedScope Enforcement",
		"If the current step has allowedScope, you MUST NOT edit files outside that scope.",
		"If the current step has no allowedScope, you MUST state which files you will modify before editing.",
		"If you need to edit a file outside allowedScope, mark the step blocked and explain why.",
		"",
		"## Step Artifact Rules",
		"When completing a step via long_task set_step, always include stepArtifacts:",
		"- researcher: file paths of findings docs, relevant source files, risk assessments",
		"- coder: list of changed files with a brief summary of what changed",
		"- tester: test command outputs, pass/fail status, failure details",
		"- reviewer: findings ordered by severity with file references",
		"- docWriter: changed doc file paths, or explanation of why no docs changes were needed",
		"Use the notes parameter to add freeform observations, warnings, or context.",
		"Step artifacts are automatically added to the task artifact list.",
	].join("\n");
}

export function buildToolFailureRecoveryPrompt(): string {
	return [
		"",
		"# Tool Call Failure Recovery",
		"When a tool call returns an error:",
		"1. Read the error message carefully. Understand what went wrong before retrying.",
		"2. Construct a corrected call with minimal, correct parameters.",
		"3. Do NOT repeat the same failing call unchanged.",
		"4. If the same tool fails twice consecutively:",
		"   - For edit failures: read the target file, then retry with corrected parameters or use write instead.",
		"   - For bash failures: verify command syntax, try a simpler variant.",
		"   - If recovery is not possible, call long_task set_step blocked and explain what failed.",
	].join("\n");
}

export function buildTaskRoutingSystemPrompt(cwd: string, userPrompt: string): string | undefined {
	const config = readConfig(cwd);
	if (config.enabled === false) {
		return undefined;
	}
	const keywords = config.routing?.autoEscalateKeywords ?? [];
	const matchedKeywords = keywords.filter((keyword) => userPrompt.includes(keyword));
	const recommendation = recommendAgentDispatch(userPrompt);
	const stepDrafts = buildAgentStepDrafts(userPrompt);
	const workerLines = Object.entries(config.workers ?? {})
		.filter(([, worker]) => worker.enabled !== false)
		.map(([name, worker]) => `- ${name}: permission=${worker.permission ?? "unspecified"}, modelPolicy=${worker.modelPolicy ?? "default"}`);
	const modelPolicyLines = Object.entries(config.modelPolicies ?? {})
		.map(([name, policy]) => {
			const model = policy.provider && policy.model ? `${policy.provider}/${policy.model}` : "current/default model";
			return `- ${name}: ${model}${policy.thinkingLevel ? `, thinking=${policy.thinkingLevel}` : ""}`;
		});
	const activeTasks = listTasks(cwd).filter(isActiveTask);
	const activeTaskLines = activeTasks.slice(0, 8).map((task) => `- ${formatTaskSummary(task).replace(/\n/g, "\n  ")}`);
	const hasActiveTasks = activeTasks.length > 0;
	return [
		buildToolFailureRecoveryPrompt(),
		hasActiveTasks ? buildLeadExecutionProtocol() : undefined,
		"",
		"# Personal Task Routing",
		`Default mode: ${config.defaultMode ?? "immediate"}.`,
		"Keep simple requests in immediate mode. Do not create long-task records for direct questions, small edits, or one-off commands.",
		"Use the long_task tool only when work is complex, multi-step, interruptible, long-running, or explicitly asks for tracked/background progress.",
		"Before creating a new long task, check the active long tasks below. If one already covers the user's request, reuse it by showing, resuming, or updating that existing task instead of creating a duplicate.",
		"When an active task has a next pending/running step matching the user's request, continue that step and use the exact task id from the active task list.",
		"Create a new long task only when no active task matches the goal.",
		"When calling long_task suggest_steps or add_suggested_steps, pass the original user request as sourcePrompt, not a shortened goal summary. The classifier needs the original prompt to detect multi-agent signals.",
		config.askWhenAmbiguous !== false
			? "If a request is ambiguous and tracking would add overhead, ask the user before creating a long task."
			: "When ambiguous, use your best judgment without asking.",
		matchedKeywords.length > 0 ? `Current request matched long-task keyword(s): ${matchedKeywords.join(", ")}.` : undefined,
		`Dispatch classifier mode: ${recommendation.mode}.`,
		`Dispatch classifier reason: ${recommendation.reason}`,
		`Dispatch classifier signals: ${recommendation.signals.length > 0 ? recommendation.signals.join(", ") : "none"}`,
		`Dispatch recommended action: ${recommendation.action}`,
		`Dispatch should create task: ${recommendation.shouldCreateTask}`,
		`Dispatch should plan workers: ${recommendation.shouldPlanWorkers}`,
		recommendation.workerPlanHints.length > 0
			? [
					"Dispatch worker plan hints:",
					...recommendation.workerPlanHints.map((hint) => `- ${hint.role}: ${hint.reason}`),
				].join("\n")
			: "Dispatch worker plan hints: none",
		stepDrafts.length > 0
			? [
					"Dispatch step drafts:",
					...stepDrafts.map((draft) => `- [${draft.worker}] ${draft.title} -> ${draft.expectedOutput}`),
				].join("\n")
			: "Dispatch step drafts: none",
		"Recommendation usage:",
		"- answer_directly: answer without long_task unless the user explicitly asks to track it.",
		"- use_long_task: use or create a long_task, reusing an active matching task first.",
		"- plan_multi_agent: keep the lead agent in control; create or reuse a long_task and plan worker roles, but do not spawn workers yet.",
		"Worker plan hints are planning guidance. Use the worker_execute tool to run researcher and reviewer workers. Coder, tester, and docWriter workers are available for later phases.",
		"Step drafts are suggestions only; do not add them to long_task unless the user asks to track or continue the task.",
		activeTaskLines.length > 0 ? `Active long tasks:\n${activeTaskLines.join("\n")}` : "Active long tasks: none.",
		workerLines.length > 0 ? `Available worker hints:\n${workerLines.join("\n")}` : undefined,
		modelPolicyLines.length > 0 ? `Available model policy hints:\n${modelPolicyLines.join("\n")}` : undefined,
	].filter((line): line is string => !!line).join("\n");
}

function notify(ctx: ExtensionCommandContext, message: string, type: "info" | "warning" | "error" = "info"): void {
	if (ctx.hasUI) {
		ctx.ui.notify(message, type);
	}
}

function helpText(): string {
	return [
		"Usage:",
		"/task create <goal>",
		"/task list",
		"/task show <taskId>",
		"/task add-step <taskId> <title>",
		"/task add-artifact <taskId> <artifact>",
		"/task set-task <taskId> <pending|running|blocked|completed|failed|cancelled>",
		"/task set-step <taskId> <stepId> <pending|running|completed|failed|skipped|blocked> [message]",
		"/task resume <taskId>",
	].join("\n");
}

function requireString(value: string | undefined, label: string): string {
	if (!value?.trim()) {
		throw new Error(`${label} is required`);
	}
	return value.trim();
}

function executeLongTaskAction(
	cwd: string,
	params: {
		action: "create" | "list" | "show" | "add_step" | "set_task" | "set_step" | "add_artifact" | "resume" | "suggest_steps" | "add_suggested_steps";
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
	},
): { text: string; details: unknown } {
	if (!isEnabled(cwd)) {
		throw new Error("Long-task runner is disabled by .pi/task-router.config.json");
	}
	if (params.action === "suggest_steps") {
		const prompt = (params.sourcePrompt ?? params.goal ?? "").trim();
		const drafts = buildAgentStepDrafts(prompt);
		if (drafts.length === 0) {
			return { text: "No multi-agent step drafts suggested for this goal.", details: { drafts: [] } };
		}
		const lines = [
			"Suggested steps:",
			...drafts.map(
				(draft) =>
					`- [${draft.worker}] ${draft.title}\n  reason: ${draft.reason}\n  expectedOutput: ${draft.expectedOutput}`,
			),
		];
		return { text: lines.join("\n"), details: { drafts } };
	}
	if (params.action === "add_suggested_steps") {
		const task = readTask(cwd, requireString(params.taskId, "taskId"));
		const prompt = (params.sourcePrompt ?? task.originalPrompt ?? params.goal ?? task.goal).trim();
		const drafts = buildAgentStepDrafts(prompt);
		const results: Array<{ draft: typeof drafts[number]; stepId: string; reused: boolean }> = [];
		for (const draft of drafts) {
			const result = addOrReuseTaskStep(cwd, task.id, draft.title, {
				input: draft.reason,
				worker: draft.worker,
				expectedOutput: draft.expectedOutput,
			});
			results.push({ draft, stepId: result.step.id, reused: result.reused });
		}
		const addedCount = results.filter((r) => !r.reused).length;
		const reusedCount = results.filter((r) => r.reused).length;
		const parts = [`Added ${addedCount} step(s) to task, reused ${reusedCount} existing step(s).`, formatTaskSummary(readTask(cwd, task.id))];
		return { text: parts.join("\n"), details: { results } };
	}
	if (params.action === "create") {
		const goal = requireString(params.goal, "goal");
		const matchingTask = findMatchingActiveTask(cwd, [goal, params.title ?? ""].join(" "));
		if (matchingTask) {
			return {
				text: `Reused existing long task instead of creating a duplicate\n${formatTaskSummary(matchingTask)}`,
				details: { reused: true, task: matchingTask },
			};
		}
		const task = createLongTask(cwd, goal, undefined, params.sourcePrompt);
		return { text: `Created long task\n${formatTaskSummary(task)}`, details: task };
	}
	if (params.action === "list") {
		const tasks = listTasks(cwd);
		return {
			text: tasks.length === 0 ? "No long tasks found." : tasks.map(formatTaskSummary).join("\n\n"),
			details: { tasks },
		};
	}
	if (params.action === "show") {
		const task = readTask(cwd, requireString(params.taskId, "taskId"));
		return { text: formatTaskDetails(task), details: task };
	}
	if (params.action === "add_step") {
		const result = addOrReuseTaskStep(cwd, requireString(params.taskId, "taskId"), requireString(params.title, "title"), {
			worker: params.worker,
			modelPolicy: params.modelPolicy,
			expectedOutput: params.expectedOutput,
			allowedScope: params.allowedScope,
		});
		if (result.reused) {
			return {
				text: `Reused existing step instead of adding a duplicate\n${result.step.id}: ${result.step.title}\n${formatTaskSummary(result.task)}`,
				details: { reused: true, task: result.task, step: result.step },
			};
		}
		return { text: `Added step\n${formatTaskSummary(result.task)}`, details: result.task };
	}
	if (params.action === "set_task") {
		const task = updateTaskStatus(
			cwd,
			requireString(params.taskId, "taskId"),
			requireString(params.status, "status") as TaskStatus,
		);
		return { text: `Updated task\n${formatTaskSummary(task)}`, details: task };
	}
	if (params.action === "set_step") {
		const task = updateStepStatus(
			cwd,
			requireString(params.taskId, "taskId"),
			requireString(params.stepId, "stepId"),
			requireString(params.status, "status") as StepStatus,
			params.message,
			params.stepArtifacts,
			params.notes,
		);
		return { text: `Updated step\n${formatTaskSummary(task)}`, details: task };
	}
	if (params.action === "add_artifact") {
		const task = addTaskArtifact(cwd, requireString(params.taskId, "taskId"), requireString(params.artifact, "artifact"));
		return { text: `Added artifact\n${formatTaskSummary(task)}`, details: task };
	}
	const task = readTask(cwd, requireString(params.taskId, "taskId"));
	return { text: buildResumePrompt(task), details: { task, resumePrompt: buildResumePrompt(task) } };
}

async function handleTaskCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
	const parsed = parseTaskCommand(args);
	try {
		if (!isEnabled(ctx.cwd)) {
			throw new Error("Long-task runner is disabled by .pi/task-router.config.json");
		}
		if (parsed.action === "create") {
			const goal = parsed.args.join(" ");
			const matchingTask = findMatchingActiveTask(ctx.cwd, goal);
			if (matchingTask) {
				notify(ctx, `Reused existing long task instead of creating a duplicate\n${formatTaskSummary(matchingTask)}`);
				return;
			}
			const task = createLongTask(ctx.cwd, goal);
			notify(ctx, `Created long task\n${formatTaskSummary(task)}`);
			return;
		}
		if (parsed.action === "list") {
			const tasks = listTasks(ctx.cwd);
			if (tasks.length === 0) {
				notify(ctx, "No long tasks found.");
				return;
			}
			const active = tasks.filter(isActiveTask);
			const done = tasks.filter((t) => !isActiveTask(t));
			const parts: string[] = [];
			if (active.length > 0) {
				parts.push(`Active (${active.length}):\n${active.map(formatTaskSummary).join("\n\n")}`);
			}
			if (done.length > 0) {
				const recent = done.slice(0, 5);
				parts.push(`Recently completed (showing ${recent.length} of ${done.length}):\n${recent.map(formatTaskSummary).join("\n\n")}`);
			}
			notify(ctx, parts.join("\n\n"));
			return;
		}
		if (parsed.action === "show") {
			const taskId = parsed.args[0];
			if (!taskId) throw new Error("Task id is required");
			notify(ctx, formatTaskDetails(readTask(ctx.cwd, taskId)));
			return;
		}
		if (parsed.action === "add-step") {
			const [taskId, ...titleParts] = parsed.args;
			if (!taskId) throw new Error("Task id is required");
			const result = addOrReuseTaskStep(ctx.cwd, taskId, titleParts.join(" "));
			notify(
				ctx,
				result.reused
					? `Reused existing step instead of adding a duplicate\n${result.step.id}: ${result.step.title}\n${formatTaskSummary(result.task)}`
					: `Added step\n${formatTaskSummary(result.task)}`,
			);
			return;
		}
		if (parsed.action === "add-artifact") {
			const [taskId, ...artifactParts] = parsed.args;
			if (!taskId) throw new Error("Task id is required");
			const task = addTaskArtifact(ctx.cwd, taskId, artifactParts.join(" "));
			notify(ctx, `Added artifact\n${formatTaskSummary(task)}`);
			return;
		}
		if (parsed.action === "set-task") {
			const [taskId, status] = parsed.args;
			if (!taskId) throw new Error("Task id is required");
			if (!status) throw new Error("Task status is required");
			const task = updateTaskStatus(ctx.cwd, taskId, status as TaskStatus);
			notify(ctx, `Updated task\n${formatTaskSummary(task)}`);
			return;
		}
		if (parsed.action === "set-step") {
			const [taskId, stepId, status, ...messageParts] = parsed.args;
			if (!taskId) throw new Error("Task id is required");
			if (!stepId) throw new Error("Step id is required");
			if (!status) throw new Error("Step status is required");
			const task = updateStepStatus(ctx.cwd, taskId, stepId, status as StepStatus, messageParts.join(" ") || undefined);
			notify(ctx, `Updated step\n${formatTaskSummary(task)}`);
			return;
		}
		if (parsed.action === "resume") {
			const taskId = parsed.args[0];
			if (!taskId) throw new Error("Task id is required");
			const prompt = buildResumePrompt(readTask(ctx.cwd, taskId));
			if (ctx.hasUI) {
				ctx.ui.setEditorText(prompt);
				notify(ctx, `Loaded resume prompt for ${taskId}`);
			}
			return;
		}
		notify(ctx, helpText(), "info");
	} catch (error) {
		notify(ctx, error instanceof Error ? error.message : String(error), "error");
	}
}

export default function longTaskRunnerExtension(pi: ExtensionAPI) {
	pi.on("before_agent_start", async (event, ctx) => {
		const routingPrompt = buildTaskRoutingSystemPrompt(ctx.cwd, event.prompt);
		if (!routingPrompt) {
			return undefined;
		}
		return {
			systemPrompt: `${event.systemPrompt}${routingPrompt}`,
		};
	});

	pi.registerTool({
		name: "long_task",
		label: "Long Task",
		description: "Create, inspect, update, and resume durable local long-task records.",
		promptSnippet: "Track complex, multi-step, interruptible work as durable local task records",
		promptGuidelines: [
			"Use long_task only for complex, multi-step, long-running, interruptible, or explicitly requested tracked work.",
			"Do not use long_task for simple questions, small one-off edits, or quick command execution.",
			"Before create or add_step, inspect active task state and reuse an existing matching task or step instead of duplicating it.",
			"Use long_task with action create before tracking a new long-running task, then add_step and set_step as progress is made.",
			"Use long_task add_artifact to attach important files, URLs, notes, or outputs to the task record.",
			"Use long_task suggest_steps to preview step drafts for a goal without writing anything. Always pass the original user request as sourcePrompt, not a shortened goal summary.",
			"Use long_task add_suggested_steps to persist suggested step drafts into a task, reusing existing steps when they match. Always pass the original user request as sourcePrompt, not a shortened goal summary.",
		],
		parameters: LongTaskToolParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				const result = executeLongTaskAction(ctx.cwd, params);
				return {
					content: [{ type: "text", text: result.text }],
					details: result.details,
				};
			} catch (error) {
				return {
					content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
					details: { error: error instanceof Error ? error.message : String(error) },
					isError: true,
				};
			}
		},
	});

	pi.registerCommand("task", {
		description: "Create, inspect, update, and resume durable long tasks",
		getArgumentCompletions: (prefix) => {
			const actions = ["create", "list", "show", "add-step", "add-artifact", "set-task", "set-step", "resume"];
			const filtered = actions.filter((action) => action.startsWith(prefix));
			return filtered.length > 0 ? filtered.map((action) => ({ value: action, label: action })) : null;
		},
		handler: handleTaskCommand,
	});
}
