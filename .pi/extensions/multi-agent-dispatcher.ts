import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export type AgentDispatchMode = "immediate" | "long_task" | "multi_agent_candidate";

export type AgentDispatchAction = "answer_directly" | "use_long_task" | "plan_multi_agent";

export interface AgentDispatchDecision {
	mode: AgentDispatchMode;
	reason: string;
	signals: string[];
}

export interface AgentDispatchRecommendation extends AgentDispatchDecision {
	action: AgentDispatchAction;
	shouldCreateTask: boolean;
	shouldPlanWorkers: boolean;
}

const MULTI_AGENT_PATTERNS: Array<{ pattern: RegExp; signal: string }> = [
	{ pattern: /多\s*agent|多智能体|multi\s*agent|协作编排|collaborative\s+orchestration/i, signal: "multi_agent_keyword" },
	{ pattern: /(调研|研究|research).+(编码|实现|code|coding).+(测试|test)/i, signal: "multi_role_span" },
	{ pattern: /(编码|实现|code).+(测试|test).+(审查|review)/i, signal: "multi_role_span" },
	{ pattern: /(research|investigate).+(implement|code).+(test|review)/i, signal: "multi_role_span" },
	{ pattern: /调研.{0,6}编码.{0,6}测试.{0,6}(review|审查)/i, signal: "multi_role_span" },
	{ pattern: /(设计|design).+(实现|implement).+(验证|verify)/i, signal: "multi_role_span" },
];

const LONG_TASK_PATTERNS: Array<{ pattern: RegExp; signal: string }> = [
	{ pattern: /长期任务|长期开发|持续推进|分阶段|多轮推进|后续跟踪|长期推进/i, signal: "long_task_keyword_cn" },
	{ pattern: /long\s*task|ongoing|multi[\s-]*phase|iterative|track\s+this|keep\s+tracking/i, signal: "long_task_keyword_en" },
	{ pattern: /跨\s*session|跨会话|resumable|pick\s+up\s+later/i, signal: "cross_session" },
	{ pattern: /放进长期|纳入长期|作为长期|存为任务/i, signal: "explicit_long_task_cn" },
	{ pattern: /(帮我|请).+(规划|plan)\s.*(后续|多轮|分步)/i, signal: "planned_multistep" },
];

const IMMEDIATE_OVERRIDE_PATTERNS: Array<{ pattern: RegExp; signal: string }> = [
	{ pattern: /^(解释|说明|什么是|what\s+is|explain|describe|帮我解释|帮我说明)/i, signal: "simple_question" },
	{ pattern: /(typo|拼写|改一个|fix\s+a?\s*typo)/i, signal: "trivial_edit" },
	{ pattern: /^(列出|list|show\s+me|查一下|查看)/i, signal: "simple_lookup" },
];

const MIN_LONG_TASK_LENGTH = 20;

function collectSignals(prompt: string): { multiAgent: string[]; longTask: string[]; immediate: string[] } {
	const multiAgent: string[] = [];
	const longTask: string[] = [];
	const immediate: string[] = [];

	for (const { pattern, signal } of MULTI_AGENT_PATTERNS) {
		if (pattern.test(prompt)) {
			multiAgent.push(signal);
		}
	}

	for (const { pattern, signal } of LONG_TASK_PATTERNS) {
		if (pattern.test(prompt)) {
			longTask.push(signal);
		}
	}

	for (const { pattern, signal } of IMMEDIATE_OVERRIDE_PATTERNS) {
		if (pattern.test(prompt)) {
			immediate.push(signal);
		}
	}

	return { multiAgent, longTask, immediate };
}

export function classifyAgentRequest(prompt: string): AgentDispatchDecision {
	const { multiAgent, longTask, immediate } = collectSignals(prompt);

	if (multiAgent.length > 0) {
		return {
			mode: "multi_agent_candidate",
			reason: "Detected multi-agent signals: multiple roles or explicit multi-agent keywords.",
			signals: multiAgent,
		};
	}

	if (longTask.length > 0) {
		return {
			mode: "long_task",
			reason: "Detected long-term task signals: explicit long-task keywords, cross-session need, or planned multi-step work.",
			signals: longTask,
		};
	}

	if (immediate.length > 0 && prompt.length < MIN_LONG_TASK_LENGTH * 4) {
		return {
			mode: "immediate",
			reason: "Detected simple question or trivial edit signal with no long-term indicators.",
			signals: immediate,
		};
	}

	return {
		mode: "immediate",
		reason: "No long-term or multi-agent signals detected; defaulting to immediate mode.",
		signals: [],
	};
}

const MODE_ACTION_MAP: Record<AgentDispatchMode, { action: AgentDispatchAction; shouldCreateTask: boolean; shouldPlanWorkers: boolean }> = {
	immediate: { action: "answer_directly", shouldCreateTask: false, shouldPlanWorkers: false },
	long_task: { action: "use_long_task", shouldCreateTask: true, shouldPlanWorkers: false },
	multi_agent_candidate: { action: "plan_multi_agent", shouldCreateTask: true, shouldPlanWorkers: true },
};

export function recommendAgentDispatch(prompt: string): AgentDispatchRecommendation {
	const decision = classifyAgentRequest(prompt);
	const mapped = MODE_ACTION_MAP[decision.mode];
	return {
		...decision,
		action: mapped.action,
		shouldCreateTask: mapped.shouldCreateTask,
		shouldPlanWorkers: mapped.shouldPlanWorkers,
	};
}

export default function multiAgentDispatcherExtension(_pi: ExtensionAPI) {
	// This file lives under .pi/extensions, so Pi auto-discovers it as an extension.
	// The dispatcher is currently a pure helper module; the default factory keeps
	// auto-discovery valid without registering tools, commands, or handlers yet.
}
