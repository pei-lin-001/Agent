/**
 * feedback-loop.ts — LLM 驱动的自主进化
 *
 * 不做关键词匹配。每轮结束后由 LLM 自主分析对话上下文，提取：
 *   1. 用户是否表达了不满？
 *   2. 根本原因是什么？
 *   3. 正确做法是什么？
 *   4. 何时应触发这个纠正？（泛化条件）
 *
 * 然后存入 mem0 作为结构化记忆，下一轮开始时由 LLM 判断当前任务
 * 是否匹配历史纠正，自动注入提醒。
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	createLongTask,
	addTaskStep,
} from "./long-task-runner.js";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ── 配置 ─────────────────────────────────────────────────────────

/** 用于分析的小模型（默认 deepseek-v4-flash，便宜又快） */
const ANALYZER_MODEL = process.env.FEEDBACK_ANALYZER_MODEL ?? "deepseek-v4-flash";

/** 最近多少轮对话送进 LLM 分析 */
const CONTEXT_WINDOW = 10;

/** 同类型纠正多少次后升级为系统性修复 */
const ESCALATION_THRESHOLD = 3;

// ── 类型 ─────────────────────────────────────────────────────────

interface TurnMemory {
	role: "user" | "assistant";
	content: string;
	timestamp: string;
	hasToolCalls?: boolean;
}

interface CorrectionAnalysis {
	hasCorrection: boolean;
	issueType: string;           // 自由文本，不限预定义类型
	rootCause: string;           // 根本原因
	correctBehavior: string;     // 正确做法
	triggerCondition: string;    // 什么时候触发这个纠正（泛化条件）
	severity: "low" | "medium" | "high";
	confidence: number;          // 0-1
}

interface StoredCorrection {
	id: string;
	timestamp: string;
	analysis: CorrectionAnalysis;
	occurrenceCount: number;
	escalated: boolean;
}

// ── 内存状态 ─────────────────────────────────────────────────────

const conversationBuffer: TurnMemory[] = [];
const activeCorrections: StoredCorrection[] = [];
let contextInjected = false;

// ── 核心：LLM 分析 ───────────────────────────────────────────────

async function analyzeConversationHistory(
	history: TurnMemory[],
): Promise<CorrectionAnalysis | null> {
	if (history.length < 2) return null;

	// 构建分析提示词
	const transcript = history
		.map((t) => `[${t.role === "user" ? "用户" : "助手"} ${t.timestamp.slice(11, 19)}] ${t.content.slice(0, 800)}`)
		.join("\n\n");

	const systemPrompt = [
		"分析这段对话。判断用户是否对助手的工作表达了不满、纠正或批评。",
		"如果用户没有任何不满，返回 null。如果有不满，提取以下信息并以 JSON 返回：",
		"",
		"```json",
		"{",
		'  "hasCorrection": true,',
		'  "issueType": "一句话概括问题类型（如：数据编造、图表丑陋、工具不足、理解偏差、缺少内容、配置错误等）",',
		'  "rootCause": "根本原因分析（如：researcher没有bash工具无法联网、max_tokens太小导致空输出、matplotlib默认配色粗糙等）",',
		'  "correctBehavior": "正确做法总结（如：所有research任务必须先用curl搜索真实数据并标注来源URL、kimi-2.6多模态调用需要max_tokens>=8000、matplotlib用Arial Unicode MS字体+低饱和配色等）",',
		'  "triggerCondition": "泛化触发条件（何时应自动提醒这个纠正？如：当任务涉及联网搜索且worker是researcher时、当调用kimi-2.6处理图像时、当生成matplotlib图表时）",',
		'  "severity": "low|medium|high",',
		'  "confidence": 0.95',
		"}",
		"```",
		"",
		"如果没有不满，返回: {\"hasCorrection\": false}",
		"只返回 JSON，不要其他文字。",
	].join("\n");

	try {
		const apiKey = getOllamaKey();
		const payload = JSON.stringify({
			model: ANALYZER_MODEL,
			messages: [
				{ role: "system", content: systemPrompt },
				{ role: "user", content: transcript },
			],
			max_tokens: 600,
			temperature: 0,
		}).encode();

		const resp = await fetch("https://ollama.com/v1/chat/completions", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"Authorization": `Bearer ${apiKey}`,
			},
			body: payload,
			signal: AbortSignal.timeout(15000),
		});

		if (!resp.ok) return null;
		const data = (await resp.json()) as {
			choices?: Array<{ message?: { content?: string } }>;
		};
		const raw = data.choices?.[0]?.message?.content?.trim() ?? "";

		// 提取 JSON
		const jsonMatch = raw.match(/\{[\s\S]*\}/);
		if (!jsonMatch) return null;

		const parsed = JSON.parse(jsonMatch[0]) as CorrectionAnalysis | { hasCorrection: false };
		if (!("hasCorrection" in parsed) || !parsed.hasCorrection) return null;
		return parsed as CorrectionAnalysis;
	} catch {
		return null;
	}
}

/** 判断当前任务是否应该触发历史纠正 */
async function evaluateRelevance(
	currentTask: string,
	corrections: StoredCorrection[],
): Promise<StoredCorrection[]> {
	if (corrections.length === 0 || !currentTask) return [];

	const correctionList = corrections
		.map((c, i) => `${i + 1}. 问题: "${c.analysis.issueType}", 触发条件: "${c.analysis.triggerCondition}", 正确做法: "${c.analysis.correctBehavior}"`)
		.join("\n");

	const systemPrompt = [
		"你有一个历史纠正列表。判断当前任务是否匹配任何历史纠正的触发条件。",
		"返回匹配的纠正编号列表（JSON数组），如 [1, 3]。没有匹配返回 []。",
		"触发条件匹配应宽松——只要任务上下文和纠正的触发条件有交集就匹配。",
		"只返回 JSON 数组，不要其他文字。",
	].join("\n");

	try {
		const apiKey = getOllamaKey();
		const payload = JSON.stringify({
			model: ANALYZER_MODEL,
			messages: [
				{ role: "system", content: systemPrompt },
				{
					role: "user",
					content: `当前任务: ${currentTask.slice(0, 500)}\n\n历史纠正:\n${correctionList}`,
				},
			],
			max_tokens: 100,
			temperature: 0,
		}).encode();

		const resp = await fetch("https://ollama.com/v1/chat/completions", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"Authorization": `Bearer ${apiKey}`,
			},
			body: payload,
			signal: AbortSignal.timeout(10000),
		});

		if (!resp.ok) return [];
		const data = (await resp.json()) as {
			choices?: Array<{ message?: { content?: string } }>;
		};
		const raw = data.choices?.[0]?.message?.content?.trim() ?? "[]";

		const arrMatch = raw.match(/\[[\s\S]*\]/);
		if (!arrMatch) return [];

		const indices = JSON.parse(arrMatch[0]) as number[];
		return indices.map((i) => corrections[i - 1]).filter(Boolean);
	} catch {
		return [];
	}
}

// ── mem0 记录 ─────────────────────────────────────────────────────

async function recordToMemory(correction: StoredCorrection): Promise<void> {
	const body = JSON.stringify({
		user_id: "pei-lin",
		agent_id: "personal-agent",
		messages: [
			{
				role: "user",
				content: `系统在对话中自主发现了一个需要纠正的模式: ${correction.analysis.issueType}`,
			},
			{
				role: "assistant",
				content: `[feedback-loop] 问题: ${correction.analysis.issueType}. 根因: ${correction.analysis.rootCause}. 正确做法: ${correction.analysis.correctBehavior}. 触发条件: ${correction.analysis.triggerCondition}. 严重性: ${correction.analysis.severity}. 出现次数: ${correction.occurrenceCount}.`,
			},
		],
		metadata: {
			source: "pi-feedback-loop-v2",
			issueType: correction.analysis.issueType,
			severity: correction.analysis.severity,
			occurrenceCount: correction.occurrenceCount,
		},
	});

	try {
		let apiKey = "test-key";
		try {
			apiKey = execSync(
				'security find-generic-password -a "$USER" -s "mem0-admin-api-key" -w',
				{ timeout: 3000 },
			).toString().trim();
		} catch { /* fallback */ }

		await fetch("http://127.0.0.1:8000/memories", {
			method: "POST",
			headers: { "Content-Type": "application/json", "x-api-key": apiKey },
			body,
			signal: AbortSignal.timeout(5000),
		});
	} catch { /* 静默 */ }
}

// ── 升级为修复任务 ───────────────────────────────────────────────

async function escalateToRepair(
	cwd: string,
	correction: StoredCorrection,
): Promise<void> {
	const title = `LLM-discovered fix: ${correction.analysis.issueType} (${correction.occurrenceCount}×)`;
	const goal = [
		`反馈循环自主检测到以下问题模式，已重复 ${correction.occurrenceCount} 次:`,
		`- 问题: ${correction.analysis.issueType}`,
		`- 根因: ${correction.analysis.rootCause}`,
		`- 正确做法: ${correction.analysis.correctBehavior}`,
		`- 触发条件: ${correction.analysis.triggerCondition}`,
		``,
		`请实施永久性修复。根据项目记忆和 feedback-loop 历史，修改相关代码或配置。`,
	].join("\n");

	try {
		const task = await createLongTask(cwd, title);
		await addTaskStep(cwd, task.id, {
			worker: "coder",
			modelPolicy: "coding",
			input: goal,
			expectedOutput: "修复后的文件列表和变更说明",
		});
		correction.escalated = true;
	} catch { /* 静默 */ }
}

// ── 工具函数 ─────────────────────────────────────────────────────

function getOllamaKey(): string {
	try {
		const authPath = join(homedir(), ".pi", "agent", "auth.json");
		const authRaw = readFileSync(authPath, "utf-8");
		const auth = JSON.parse(authRaw) as Record<string, { key?: string }>;
		return auth["ollama-cloud"]?.key ?? "";
	} catch {
		return "";
	}
}

function buildInjectionContext(relevant: StoredCorrection[]): string {
	if (relevant.length === 0) return "";

	const lines: string[] = [];
	lines.push("");
	lines.push("## Learned Corrections (feedback-loop)");
	lines.push("");
	lines.push("The following corrections were learned from past conversations. Apply them:");
	lines.push("");

	for (const c of relevant.slice(0, 5)) {
		const count = c.occurrenceCount > 1 ? ` (${c.occurrenceCount}×)` : "";
		lines.push(`- **${c.analysis.issueType}**${count}: ${c.analysis.correctBehavior}`);
	}

	lines.push("");
	return lines.join("\n");
}

// ── 扩展 ─────────────────────────────────────────────────────────

export default function feedbackLoopExtension(pi: ExtensionAPI) {
	/**
	 * 记录每一轮对话
	 */
	pi.on("turn_end", async (event, ctx) => {
		// 记录用户消息
		const userMsg = event.message;
		if (userMsg && "content" in userMsg) {
			const content = typeof userMsg.content === "string"
				? userMsg.content
				: Array.isArray(userMsg.content)
					? userMsg.content
						.filter((b): b is { type: "text"; text: string } => b.type === "text")
						.map((b) => b.text).join(" ")
					: "";
			if (content.length >= 10) {
				conversationBuffer.push({
					role: "user",
					content,
					timestamp: new Date().toISOString(),
				});
			}
		}

		// 记录助手行动摘要
		const toolNames = (event as unknown as { toolResults?: Array<{ name?: string }> })
			.toolResults
			?.map((t) => t.name)
			.filter(Boolean) ?? [];
		const summary = toolNames.length > 0
			? `[调用了工具: ${toolNames.join(", ")}]`
			: "";

		conversationBuffer.push({
			role: "assistant",
			content: summary,
			timestamp: new Date().toISOString(),
			hasToolCalls: toolNames.length > 0,
		});

		// 保持窗口大小
		while (conversationBuffer.length > CONTEXT_WINDOW * 2) {
			conversationBuffer.shift();
		}

		// LLM 分析（限速：最多每2轮分析一次）
		if (conversationBuffer.filter((t) => t.role === "user").length % 2 === 0) {
			const analysis = await analyzeConversationHistory(conversationBuffer);
			if (!analysis || analysis.confidence < 0.5) return;

			// 检查是否已有类似纠正
			const existing = activeCorrections.find(
				(c) =>
					c.analysis.issueType === analysis.issueType &&
					c.analysis.rootCause === analysis.rootCause,
			);

			if (existing) {
				existing.occurrenceCount++;
				existing.timestamp = new Date().toISOString();
				// 升级
				if (
					existing.occurrenceCount >= ESCALATION_THRESHOLD &&
					!existing.escalated &&
					analysis.severity !== "low"
				) {
					await escalateToRepair(ctx.cwd, existing);
				}
			} else {
				const stored: StoredCorrection = {
					id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
					timestamp: new Date().toISOString(),
					analysis,
					occurrenceCount: 1,
					escalated: false,
				};
				activeCorrections.push(stored);
				if (activeCorrections.length > 50) activeCorrections.shift();
				await recordToMemory(stored);
			}

			contextInjected = false;
		}
	});

	/**
	 * 注入相关纠正
	 */
	pi.on("before_agent_start", async (event, _ctx) => {
		if (contextInjected || activeCorrections.length === 0) return;

		// 获取当前用户输入作为任务上下文
		const userTurns = conversationBuffer
			.filter((t) => t.role === "user")
			.slice(-3);
		const currentTask = userTurns.map((t) => t.content).join(" ");

		if (!currentTask) return;

		const relevant = await evaluateRelevance(currentTask, activeCorrections);
		const context = buildInjectionContext(relevant);
		if (!context) return;

		event.systemPrompt = (event.systemPrompt ?? "") + "\n" + context;
		contextInjected = true;
	});
}
