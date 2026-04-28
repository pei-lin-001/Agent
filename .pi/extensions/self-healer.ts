/**
 * self-healer.ts — 自主错误检测 → 分类 → 修复任务生成 → mem0 记录闭环
 *
 * 监听 worker_execute 工具执行结果，在 worker 失败时自动：
 *   1. 分类错误类型（permission / config / data / model / unknown）
 *   2. 对可自动修复的问题创建修复任务
 *   3. 在下一轮对话中注入修复上下文
 *   4. 将经验记录到长期记忆
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
	createLongTask,
	addTaskStep,
	updateStepStatus,
	readConfig,
} from "./long-task-runner.js";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ── 类型 ──────────────────────────────────────────────────────────

type ErrorClass = "permission/tool" | "config/param" | "data/quality" | "model/auth" | "unknown";

interface FailureRecord {
	timestamp: string;
	taskId: string;
	stepId: string;
	workerRole: string;
	errorText: string;
	classification: ErrorClass;
	autoRepairTaskId?: string;
}

// ── 内存状态（仅会话内有效） ──────────────────────────────────────

const pendingFailures: FailureRecord[] = [];
const repairTaskIds = new Set<string>();
let leadAgentNotified = false;

// ── 分类规则（关键词匹配，无需 LLM） ────────────────────────────

const CLASSIFICATION_RULES: [RegExp[], ErrorClass, boolean][] = [
	// permission/tool — worker 缺少必要工具
	[
		[/no bash/i, /read.only/i, /cannot search/i, /不能搜索/i, /没有.*bash/i, /无.*工具/i],
		"permission/tool",
		true, // 可自动修复（改 getToolsForRole 配置）
	],
	// config/param — API 调用参数配置问题
	[
		[/max.tokens/i, /empty content/i, /SSSS+/i, /PAD/i, /timeout/i, /timed.?out/i, /token.*不足/i, /token.*不够/i],
		"config/param",
		true, // 可自动修复（改 task-router.config.json）
	],
	// model/auth — 模型不可用或认证失败
	[
		[/NOT FOUND IN REGISTRY/i, /model.*not.*found/i, /401/i, /unauthorized/i, /auth.*fail/i, /认证.*失败/i],
		"model/auth",
		false, // 不可自动修复（需手动配置认证）
	],
	// data/quality — 输出质量问题
	[
		[/fabricate/i, /编造/i, /来自模型知识/i, /not real/i, /没有来源/i, /无.*URL/i, /未.*验证/i],
		"data/quality",
		false, // 不可自动修复（需人工判断）
	],
];

/** 分类一个错误字符串 */
function classifyError(errorText: string): { classification: ErrorClass; autoRepairable: boolean } {
	for (const [patterns, classification, autoRepairable] of CLASSIFICATION_RULES) {
		if (patterns.some((p) => p.test(errorText))) {
			return { classification, autoRepairable };
		}
	}
	return { classification: "unknown", autoRepairable: false };
}

// ── 修复任务生成 ─────────────────────────────────────────────────

function makeRepairTaskTitle(record: FailureRecord): string {
	const role = record.workerRole || "worker";
	switch (record.classification) {
		case "permission/tool":
			return `Auto-repair: ${role} lack tools — fix getToolsForRole()`;
		case "config/param":
			return `Auto-repair: fix API params for ${role}`;
		case "model/auth":
			return `Manual-fix: auth/model issue for ${role}`;
		case "data/quality":
			return `Quality-fix: re-run ${role} with better instructions`;
		default:
			return `Investigate: ${role} failure — ${record.errorText.slice(0, 60)}`;
	}
}

function makeRepairGoal(record: FailureRecord): string {
	switch (record.classification) {
		case "permission/tool":
			return `Fix the worker tool set so all workers have full tool access. In .pi/extensions/worker-executor.ts, modify getToolsForRole() to return all tools for every role: ["read", "bash", "edit", "write", "ls", "grep", "find"]. The goal is captured in project memory — search mem0 for "worker tool permission" before implementing.`;
		case "config/param":
			return `Fix API configuration issue detected for ${record.workerRole} worker. The error was: "${record.errorText.slice(0, 200)}". Check .pi/task-router.config.json for modelPolicies and adjust max_tokens, model selection, or other parameters. If kimi-2.6 is involved, ensure max_tokens >= 8000.`;
		case "model/auth":
			return `Model/auth issue for ${record.workerRole}: "${record.errorText.slice(0, 200)}". Check .pi/task-router.config.json modelPolicies to ensure only providers with configured auth are used. Currently configured auth: ollama-cloud, deepseek. Remove policies referencing providers without auth (like google, anthropic).`;
		case "data/quality":
			return `The ${record.workerRole} worker returned data that may not be from real sources. Original error: "${record.errorText.slice(0, 200)}". Re-run the researcher with bash+curl to search for real data online, citing actual URLs.`;
		default:
			return `Investigate worker failure: ${record.workerRole} returned error "${record.errorText.slice(0, 300)}". Determine root cause and fix.`;
	}
}

function suggestedScope(record: FailureRecord): string[] {
	switch (record.classification) {
		case "permission/tool":
			return [".pi/extensions/worker-executor.ts"];
		case "config/param":
			return [".pi/task-router.config.json"];
		case "model/auth":
			return [".pi/task-router.config.json"];
		case "data/quality":
			return [];
		default:
			return [];
	}
}

async function createRepairTask(
	cwd: string,
	record: FailureRecord,
): Promise<string | undefined> {
	try {
		const title = makeRepairTaskTitle(record);
		const task = await createLongTask(cwd, title);
		const step = await addTaskStep(cwd, task.id, {
			worker: "coder",
			modelPolicy: "coding",
			input: makeRepairGoal(record),
			allowedScope: suggestedScope(record),
			expectedOutput: "修复后的文件变更说明",
		});
		repairTaskIds.add(task.id);
		record.autoRepairTaskId = task.id;
		return task.id;
	} catch (error) {
		console.error("[self-healer] Failed to create repair task:", error);
		return undefined;
	}
}

// ── mem0 记录（直接 HTTP，不依赖 mem0-memory 扩展） ──────────────

async function recordLesson(record: FailureRecord, cwd: string, sessionId: string, sessionFile: string): Promise<void> {
	if (record.classification === "unknown") return;

	const body = JSON.stringify({
		user_id: "pei-lin",
		agent_id: "personal-agent",
		messages: [
			{ role: "user", content: `Worker ${record.workerRole} 执行失败时发现系统性问题` },
			{ role: "assistant", content: `[self-healer ${record.timestamp}] 分类: ${record.classification}. Worker: ${record.workerRole}. 错误: ${record.errorText.slice(0, 300)}. 自动修复任务: ${record.autoRepairTaskId ?? "未创建"}.` },
		],
		metadata: { cwd, sessionId, sessionFile, source: "pi-self-healer", errorClass: record.classification, workerRole: record.workerRole },
	});

	try {
		// 获取 mem0 admin API key
		let apiKey = "test-key";
		try {
			apiKey = execSync(
				'security find-generic-password -a "$USER" -s "mem0-admin-api-key" -w',
				{ timeout: 3000 },
			).toString().trim();
		} catch {
			// Keychain 不可用时用默认 key
		}

		await fetch("http://127.0.0.1:8000/memories", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"x-api-key": apiKey,
			},
			body,
			signal: AbortSignal.timeout(5000),
		});
	} catch {
		// mem0 写入失败静默处理
	}
}

// ── 构建注入的上下文 ─────────────────────────────────────────────

function buildHealingContext(): string {
	if (pendingFailures.length === 0 && repairTaskIds.size === 0) return "";

	const lines: string[] = [];

	if (pendingFailures.length > 0) {
		lines.push("");
		lines.push("## Self-Healer: Detected Issues");
		lines.push("");
		lines.push("The following worker failures were detected in the previous turn. Review and decide whether to execute the auto-generated repair tasks:");
		lines.push("");
		for (const record of pendingFailures.slice(-5)) {
			// 最多展示最近 5 条
			lines.push(
				`- **${record.workerRole}** [${record.classification}] ${record.errorText.slice(0, 120)}`,
			);
			if (record.autoRepairTaskId) {
				lines.push(`  → Auto-repair task created: \`${record.autoRepairTaskId}\``);
				lines.push(
					`  → Run: \`long_task resume ${record.autoRepairTaskId}\` to execute the coder worker`,
				);
			}
		}
		lines.push("");
		lines.push(
			"For permission/tool and config/param issues, the repair tasks are safe to auto-execute.",
		);
		lines.push(
			"For model/auth and data/quality issues, review the task goal before executing.",
		);
		lines.push("");
	}

	if (repairTaskIds.size > 0) {
		lines.push("Active repair tasks pending execution:");
		for (const id of repairTaskIds) {
			lines.push(`- \`${id}\``);
		}
	}

	return lines.join("\n");
}

// ── 扩展工厂 ─────────────────────────────────────────────────────

export default function selfHealerExtension(pi: ExtensionAPI) {
	/**
	 * 1. tool_execution_end — 检测 worker 失败，分类并创建修复任务
	 */
	pi.on("tool_execution_end", async (event, ctx) => {
		// 只处理 worker_execute 和 worker_execute_multi
		if (event.toolName !== "worker_execute" && event.toolName !== "worker_execute_multi") {
			return;
		}
		if (!event.isError) return;

		const errorText = extractErrorText(event);
		if (!errorText) return;

		const { classification, autoRepairable } = classifyError(errorText);

		// 从 worker_execute 的 input 提取元信息
		const input = event.input as Record<string, unknown> | undefined;
		const workerRole = String(input?.worker ?? input?.jobs?.[0]?.worker ?? "unknown");
		const taskId = String(input?.taskId ?? "");
		const stepId = String(input?.stepId ?? "");

		const record: FailureRecord = {
			timestamp: new Date().toISOString(),
			taskId,
			stepId,
			workerRole,
			errorText,
			classification,
		};

		// 标记步骤为 blocked（如果已有 taskId/stepId）
		if (taskId && stepId) {
			try {
				await updateStepStatus(
					ctx.cwd,
					taskId,
					stepId,
					"blocked",
					`[self-healer] Classified as ${classification}. ${autoRepairable ? "Auto-repair task created." : "Manual fix required."}`,
				);
			} catch {
				// 状态更新失败不阻塞检测
			}
		}

		// 创建修复任务
		if (autoRepairable) {
			await createRepairTask(ctx.cwd, record);
		}

		pendingFailures.push(record);
		leadAgentNotified = false;
	});

	/**
	 * 2. tool_result — 在返回内容中嵌入修复提示
	 */
	pi.on("tool_result", async (event, _ctx) => {
		if (event.toolName !== "worker_execute" && event.toolName !== "worker_execute_multi") {
			return;
		}
		if (!event.isError) return;
		if (pendingFailures.length === 0) return;

		const latest = pendingFailures[pendingFailures.length - 1];
		if (!latest) return;

		const suffix =
			latest.autoRepairTaskId
				? `\n\n⚠ [self-healer] 自动创建修复任务 \`${latest.autoRepairTaskId}\`（分类: ${latest.classification}）`
				: `\n\n⚠ [self-healer] 检测到 ${latest.classification} 类型错误，需手动处理`;

		event.content = [
			...(Array.isArray(event.content) ? event.content : [{ type: "text" as const, text: String(event.content) }]),
			{ type: "text" as const, text: suffix },
		];
	});

	/**
	 * 3. turn_end — 记录经验到 mem0，清空本轮待处理
	 */
	pi.on("turn_end", async (_event, ctx) => {
		if (pendingFailures.length === 0) return;

		const sessionId = ctx.sessionManager.getSessionId?.() ?? "unknown";
		const sessionFile = ctx.sessionManager.getSessionFile?.() ?? "unknown";

		for (const record of pendingFailures) {
			await recordLesson(record, ctx.cwd, sessionId, sessionFile);
		}

		// 清空已处理的（保留 repairTaskIds 以便跟踪修复任务）
		pendingFailures.length = 0;
		leadAgentNotified = false;
	});

	/**
	 * 4. before_agent_start — 注入修复上下文
	 */
	pi.on("before_agent_start", async (event, _ctx) => {
		if (leadAgentNotified) return;
		const context = buildHealingContext();
		if (!context) return;

		event.systemPrompt = (event.systemPrompt ?? "") + "\n" + context;
		leadAgentNotified = true;
	});
}

// ── 辅助函数 ─────────────────────────────────────────────────────

function extractErrorText(event: {
	result?: unknown;
	details?: unknown;
}): string {
	// 从多种可能的结构中提取错误文字
	const sources = [
		// event.result 可能是 { error: "..." } 或 { isError: true, details: { error: "..." } }
		(event.result as Record<string, unknown>)?.error,
		(event.result as Record<string, unknown>)?.details,
		(event.details as Record<string, unknown>)?.error,
		(event.details as Record<string, unknown>)?.results,
	];

	for (const src of sources) {
		if (!src) continue;
		const text = typeof src === "string" ? src : JSON.stringify(src);
		if (text && text.length > 5) return text;
	}

	return "";
}
