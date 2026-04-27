import { isAbsolute, relative, resolve } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { createAgentSession, SessionManager } from "@mariozechner/pi-coding-agent";
import type { AgentSession } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import { updateStepStatus } from "./long-task-runner.js";

// ── Types ──────────────────────────────────────────────────────────────────

type WorkerRole = "researcher" | "coder" | "tester" | "reviewer" | "docWriter";

export interface WorkerExecutionOptions {
	goal: string;
	worker: WorkerRole;
	context?: string;
	taskId?: string;
	stepId?: string;
	allowedScope?: string[];
}

export interface WorkerExecutionResult {
	output: string;
	artifacts: string[];
	error?: string;
}

// Injection point for testing
type SessionFactory = (options: {
	cwd: string;
	tools: string[];
	systemInstructions: string;
}) => Promise<{
	session: AgentSession;
	dispose: () => void;
}>;

let _sessionFactory: SessionFactory | undefined;

export function setSessionFactory(factory: SessionFactory | undefined): void {
	_sessionFactory = factory;
}

// ── Worker Instructions ────────────────────────────────────────────────────

export function buildWorkerSystemInstructions(role: WorkerRole, allowedScope?: string[]): string {
	const base = [
		`You are a ${role} worker agent executing a scoped task.`,
		"Work only on the task assigned to you. Do not do anything else.",
		"When finished, output your findings clearly and concisely.",
		"Do not ask follow-up questions. Produce your best answer and stop.",
	];

	const roleRules: Record<WorkerRole, string[]> = {
		researcher: [
			"ROLE: READ-ONLY RESEARCHER.",
			"Use read, grep, find, and ls to explore the codebase.",
			"Output: findings, relevant files, risks, and assumptions.",
			"Format your output with clear sections: ## Findings, ## Relevant Files, ## Risks, ## Assumptions.",
		],
		reviewer: [
			"ROLE: READ-ONLY REVIEWER.",
			"Use read, grep, find, and ls to inspect code and diffs.",
			"Review for: regressions, test coverage gaps, code quality issues, security concerns.",
			"Output: findings ordered by severity (critical, high, medium, low).",
			"Format your output with clear sections: ## Critical, ## High, ## Medium, ## Low.",
		],
		coder: [
			"ROLE: SCOPED CODER.",
			"You may use read, bash, edit, and write to implement changes.",
			allowedScope?.length
				? `ALLOWED SCOPE: You MUST NOT edit files outside: ${allowedScope.join(", ")}.`
				: "NO SCOPE SET: State which files you will modify before any write/edit.",
			"If a needed change is outside scope, report it rather than proceeding.",
			"After each edit, verify the change is correct.",
			"Output: list of changed files and implementation summary.",
			'End with a "Changed files:" section listing each modified file path.',
		],
		tester: [
			"ROLE: VALIDATION TESTER.",
			"You may use bash to run test commands. You may read test results and source files.",
			"Do NOT edit any files.",
			"Run the specified test commands and report results.",
			"Output: commands run, pass/fail status, and failure details if any.",
			"Format with ## Commands Run and ## Results sections.",
		],
		docWriter: [
			"ROLE: DOCUMENTATION WRITER.",
			"You may edit documentation files only (markdown, README, docs).",
			"Do NOT edit source code.",
			"If no documentation changes are needed, explain why.",
			"Output: changed doc file paths, or explanation of why no docs changes were needed.",
		],
	};

	return [...base, ...(roleRules[role] ?? [])].join("\n");
}

export function getToolsForRole(role: WorkerRole): string[] {
	switch (role) {
		case "researcher":
		case "reviewer":
			return ["read", "grep", "find", "ls"];
		case "coder":
			return ["read", "bash", "edit", "write"];
		case "tester":
			return ["read", "bash"];
		case "docWriter":
			return ["read", "edit", "write"];
	}
}

// ── Core Execution ─────────────────────────────────────────────────────────

export async function executeWorker(
	cwd: string,
	options: WorkerExecutionOptions,
): Promise<WorkerExecutionResult> {
	const tools = getToolsForRole(options.worker);
	const systemInstructions = buildWorkerSystemInstructions(options.worker, options.allowedScope);

	const userPrompt = [
		`## Goal`,
		options.goal,
		options.context ? `\n## Context\n${options.context}` : "",
		allowedScopeReminder(options),
	].filter((line) => line?.length > 0).join("\n");

	let session: AgentSession | undefined;
	let disposeSession: (() => void) | undefined;

	try {
		if (_sessionFactory) {
			const result = await _sessionFactory({ cwd, tools, systemInstructions });
			session = result.session;
			disposeSession = result.dispose;
		} else {
			const result = await createAgentSession({
				cwd,
				tools,
				sessionManager: SessionManager.inMemory(cwd),
			});
			session = result.session;
		}

		await session.prompt(`${systemInstructions}\n\n${userPrompt}`);

		const output = session.messages
			.filter((m) => m.role === "assistant")
			.map(getMessageText)
			.join("\n\n")
			.trim();

		const artifacts = extractReferences(output);
		const scopeError = validateWorkerScope(cwd, options, output);
		if (scopeError) {
			if (options.taskId && options.stepId) {
				updateStepStatus(cwd, options.taskId, options.stepId, "failed", scopeError);
			}
			return { output, artifacts, error: scopeError };
		}

		if (options.taskId && options.stepId) {
			try {
				updateStepStatus(cwd, options.taskId, options.stepId, "completed", output, artifacts);
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : String(error);
				return {
					output,
					artifacts,
					error: `Worker completed, but failed to persist result to task ${options.taskId} step ${options.stepId}: ${errorMessage}`,
				};
			}
		}

		return { output, artifacts };
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		if (options.taskId && options.stepId) {
			try {
				updateStepStatus(cwd, options.taskId, options.stepId, "failed", errorMessage);
			} catch {
				// ignore
			}
		}
		return { output: "", artifacts: [], error: errorMessage };
	} finally {
		try {
			disposeSession?.();
			session?.dispose();
		} catch {
			// ignore
		}
	}
}

// ── Helpers ────────────────────────────────────────────────────────────────

function getMessageText(msg: { role: string; content: unknown }): string {
	if (typeof msg.content === "string") {
		return msg.content;
	}
	if (Array.isArray(msg.content)) {
		return (msg.content as Array<{ type: string; text?: string }>)
			.filter((block) => block.type === "text" && block.text)
			.map((block) => block.text!)
			.join("\n");
	}
	return "";
}

function allowedScopeReminder(options: WorkerExecutionOptions): string {
	if (options.worker !== "coder" || !options.allowedScope?.length) {
		return "";
	}
	return `\n## Allowed Scope\nYou may only modify files within: ${options.allowedScope.join(", ")}.`;
}

export function extractReferences(output: string): string[] {
	const refs: string[] = [];
	const filePattern = /(?:^|\s)([./]?\w+(?:\/[-\w./]+)*\.\w+)/gm;
	let match: RegExpExecArray | null;
	while ((match = filePattern.exec(output)) !== null) {
		const path = match[1];
		if (path && !refs.includes(path) && !path.startsWith("http")) {
			refs.push(path);
		}
	}
	return refs.slice(0, 20);
}

export function isInScope(filePath: string, allowedScope: string[], cwd: string): boolean {
	if (!allowedScope || allowedScope.length === 0) return true;
	const resolved = resolve(cwd, filePath);
	return allowedScope.some((scopePath) => {
		const resolvedScope = resolve(cwd, scopePath);
		const pathFromScope = relative(resolvedScope, resolved);
		return pathFromScope === "" || (!pathFromScope.startsWith("..") && !isAbsolute(pathFromScope));
	});
}

export function extractChangedFiles(output: string): string[] {
	const match = output.match(/Changed files:\s*\n((?:\s*[-*]\s*.+\n?)*)/i);
	if (!match) return [];
	return match[1]
		.split("\n")
		.map((line) => line.replace(/^\s*[-*]\s*/, "").trim())
		.filter((line): line is string => line.length > 0);
}

function validateWorkerScope(cwd: string, options: WorkerExecutionOptions, output: string): string | undefined {
	if (options.worker !== "coder" || !options.allowedScope?.length) {
		return undefined;
	}
	const allowedScope = options.allowedScope;
	const changedFiles = extractChangedFiles(output);
	const outOfScopeFiles = changedFiles.filter((file) => !isInScope(file, allowedScope, cwd));
	if (outOfScopeFiles.length === 0) {
		return undefined;
	}
	return `Worker changed files outside allowedScope (${allowedScope.join(", ")}): ${outOfScopeFiles.join(", ")}`;
}

// ── Parallel Execution ───────────────────────────────────────────────────

interface ParallelWorkerJob {
	goal: string;
	worker: WorkerRole;
	context?: string;
	stepId?: string;
	allowedScope?: string[];
}

export async function executeMultipleWorkers(
	cwd: string,
	jobs: ParallelWorkerJob[],
	taskId?: string,
): Promise<{ results: WorkerExecutionResult[]; summary: string }> {
	if (jobs.length === 0) {
		return { results: [], summary: "No jobs to execute." };
	}

	const readOnlyRoles: WorkerRole[] = ["researcher", "reviewer"];
	const readOnlyJobs = jobs
		.map((job, index) => ({ job, index }))
		.filter(({ job }) => readOnlyRoles.includes(job.worker));
	const writeJobs = jobs
		.map((job, index) => ({ job, index }))
		.filter(({ job }) => !readOnlyRoles.includes(job.worker));

	const results: WorkerExecutionResult[] = new Array(jobs.length);

	// Execute read-only jobs in parallel
	if (readOnlyJobs.length > 0) {
		const parallelResults = await Promise.all(
			readOnlyJobs.map(({ job }) =>
				executeWorker(cwd, {
					goal: job.goal,
					worker: job.worker,
					context: job.context,
					taskId,
					stepId: job.stepId,
					allowedScope: job.allowedScope,
				}),
			),
		);
		for (let i = 0; i < parallelResults.length; i++) {
			results[readOnlyJobs[i]!.index] = parallelResults[i]!;
		}
	}

	// Execute write jobs sequentially
	for (const { job, index } of writeJobs) {
		const result = await executeWorker(cwd, {
			goal: job.goal,
			worker: job.worker,
			context: job.context,
			taskId,
			stepId: job.stepId,
			allowedScope: job.allowedScope,
		});
		results[index] = result;
	}

	const summaryLines = jobs.map((job, i) => {
		const r = results[i];
		if (!r) return `[${job.worker}] ${job.goal.slice(0, 50)}... -> no result`;
		if (r.error) return `[${job.worker}] ${job.goal.slice(0, 50)}... -> ERROR: ${r.error.slice(0, 80)}`;
		return `[${job.worker}] ${job.goal.slice(0, 50)}... -> ${r.output.slice(0, 100)}`;
	});

	return { results, summary: summaryLines.join("\n") };
}

// ── Tool Definition ────────────────────────────────────────────────────────

const WorkerExecuteParams = Type.Object({
	worker: StringEnum(["researcher", "coder", "tester", "reviewer", "docWriter"] as const, {
		description: "Worker role to execute as.",
	}),
	goal: Type.String({ description: "Goal for the worker step." }),
	context: Type.Optional(
		Type.String({ description: "Context: prior step outputs, relevant file paths, memories." }),
	),
	taskId: Type.Optional(Type.String({ description: "Task id to update step status on completion." })),
	stepId: Type.Optional(Type.String({ description: "Step id to update on completion." })),
	allowedScope: Type.Optional(
		Type.Array(Type.String(), { description: "Allowed file scope for coder worker." }),
	),
});

// ── Extension Factory ──────────────────────────────────────────────────────

export default function workerExecutorExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "worker_execute",
		label: "Worker Execute",
		description:
			"Execute a worker agent (researcher, coder, tester, reviewer, docWriter) for scoped task execution. Researcher and reviewer are read-only. Coder writes only in allowedScope.",
		promptSnippet: "Execute a scoped worker agent for delegated task execution",
		promptGuidelines: [
			"Use worker_execute to delegate scoped work to a specialized worker agent.",
			"Call researcher for codebase exploration, file scanning, and information gathering.",
			"Call reviewer for code review, diff analysis, and test coverage assessment.",
			"Call coder for scoped implementation within allowedScope.",
			"Call tester to run validation commands and report results.",
			"Always set taskId and stepId so results are persisted to the long task record.",
			"Provide focused context (relevant files, prior step outputs) rather than full conversation history.",
			"Wait for worker output before proceeding to the next step. Workers run synchronously.",
			"Researcher and reviewer are read-only. They cannot modify files.",
		],
		parameters: WorkerExecuteParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!params.goal?.trim()) {
				return {
					content: [{ type: "text", text: "worker_execute: goal is required." }],
					details: {},
					isError: true,
				};
			}

			const result = await executeWorker(ctx.cwd, {
				goal: params.goal,
				worker: params.worker as WorkerRole,
				context: params.context,
				taskId: params.taskId,
				stepId: params.stepId,
				allowedScope: params.allowedScope,
			});

			if (result.error) {
				return {
					content: [
						{
							type: "text",
							text: `Worker ${params.worker} failed: ${result.error}`,
						},
					],
					details: result,
					isError: true,
				};
			}

			const resultLines = [
				`Worker ${params.worker} completed.`,
				`\n## Output\n${result.output}`,
			];
			if (result.artifacts.length > 0) {
				resultLines.push(
					`\n## Artifacts\n${result.artifacts.map((a) => `- ${a}`).join("\n")}`,
				);
			}

			return {
				content: [{ type: "text", text: resultLines.join("\n") }],
				details: result,
			};
		},
	});

	pi.registerTool({
		name: "worker_execute_multi",
		label: "Worker Execute Multi",
		description:
			"Execute multiple worker agents. Read-only workers (researcher, reviewer) run in parallel. Coder, tester, and docWriter run sequentially.",
		promptSnippet: "Execute multiple worker agents, with read-only workers in parallel",
		promptGuidelines: [
			"Use worker_execute_multi when you need to run multiple read-only workers (researcher, reviewer) at the same time.",
			"Read-only workers always run in parallel. Coder, tester, and docWriter always run sequentially.",
			"Each job needs a goal and worker role. Optionally provide context and stepId.",
			"All results are returned together. Read the summary to understand what each worker produced.",
		],
		parameters: Type.Object({
			jobs: Type.Array(
				Type.Object({
					worker: StringEnum(["researcher", "coder", "tester", "reviewer", "docWriter"] as const, {
						description: "Worker role.",
					}),
					goal: Type.String({ description: "Goal for this worker." }),
					context: Type.Optional(Type.String({ description: "Optional context." })),
					stepId: Type.Optional(Type.String({ description: "Optional step id." })),
					allowedScope: Type.Optional(Type.Array(Type.String(), { description: "Optional allowed scope." })),
				}),
				{ description: "Array of worker jobs to execute." },
			),
			taskId: Type.Optional(Type.String({ description: "Task id for tracking results." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!params.jobs?.length) {
				return {
					content: [{ type: "text", text: "worker_execute_multi: at least one job is required." }],
					details: {},
					isError: true,
				};
			}

			const { results, summary } = await executeMultipleWorkers(
				ctx.cwd,
				params.jobs.map((j) => ({
					goal: j.goal,
					worker: j.worker as WorkerRole,
					context: j.context,
					stepId: j.stepId,
					allowedScope: j.allowedScope,
				})),
				params.taskId,
			);

			const errorCount = results.filter((r) => r.error).length;
			const header = `Executed ${results.length} worker(s). ${errorCount} error(s).`;
			const body = [
				`## Summary`,
				summary,
			];
			for (let i = 0; i < results.length; i++) {
				const r = results[i];
				if (r.error) {
					body.push(`\n## Worker ${i + 1} (ERROR)\n${r.error}`);
				} else {
					body.push(`\n## Worker ${i + 1}\n${r.output}`);
					if (r.artifacts.length > 0) {
						body.push(`\nArtifacts: ${r.artifacts.map((a) => `- ${a}`).join(", ")}`);
					}
				}
			}

			return {
				content: [{ type: "text", text: `${header}\n${body.join("\n")}` }],
				details: { results, summary },
				isError: errorCount > 0,
			};
		},
	});
}
