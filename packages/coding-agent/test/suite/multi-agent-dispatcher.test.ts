import { describe, expect, it } from "vitest";
import multiAgentDispatcherExtension, {
	type AgentDispatchDecision,
	classifyAgentRequest,
} from "../../../../.pi/extensions/multi-agent-dispatcher.js";

describe("classifyAgentRequest", () => {
	function expectMode(prompt: string, expectedMode: AgentDispatchDecision["mode"]) {
		const result = classifyAgentRequest(prompt);
		expect(result.mode).toBe(expectedMode);
		return result;
	}

	it("classifies simple explanation as immediate", () => {
		const result = expectMode("帮我解释一下 mem0 是干什么的", "immediate");
		expect(result.signals).toContain("simple_question");
	});

	it("classifies single typo fix as immediate", () => {
		const result = expectMode("修改这个文件里的一个 typo", "immediate");
		expect(result.signals).toContain("trivial_edit");
	});

	it("classifies explicit long-task request as long_task", () => {
		const result = expectMode("这个项目我要长期开发，帮我放进长期任务", "long_task");
		expect(result.signals.length).toBeGreaterThan(0);
	});

	it("classifies multi-agent collaborative request as multi_agent_candidate", () => {
		const result = expectMode("我们要做多 agent 协作编排，包含调研、编码、测试和 review", "multi_agent_candidate");
		expect(result.signals).toContain("multi_agent_keyword");
	});

	it("classifies planned multi-round work as long_task", () => {
		const result = expectMode("帮我规划一个复杂功能，后续多轮推进", "long_task");
		expect(result.signals.length).toBeGreaterThan(0);
	});

	it("defaults to immediate for unremarkable prompts", () => {
		const result = classifyAgentRequest("show me the current git status");
		expect(result.mode).toBe("immediate");
	});

	it("defaults to immediate for short prompts with no signals", () => {
		const result = classifyAgentRequest("hello");
		expect(result.mode).toBe("immediate");
		expect(result.signals).toEqual([]);
	});

	it("detects English multi-agent keyword", () => {
		const result = expectMode("Let's set up multi agent orchestration for this project", "multi_agent_candidate");
		expect(result.signals).toContain("multi_agent_keyword");
	});

	it("detects multi-role span without keyword", () => {
		const result = expectMode("research the API, then implement the client, then test it", "multi_agent_candidate");
		expect(result.signals).toContain("multi_role_span");
	});

	it("detects cross-session signal as long_task", () => {
		const result = expectMode("This needs to be resumable across sessions", "long_task");
		expect(result.signals).toContain("cross_session");
	});

	it("detects Chinese cross-session signal as long_task", () => {
		const result = expectMode("这件事需要跨 session 来做", "long_task");
		expect(result.signals).toContain("cross_session");
	});

	it("detects iterative keyword as long_task", () => {
		const result = expectMode("Let's do this iteratively over time", "long_task");
		expect(result.signals).toContain("long_task_keyword_en");
	});

	it("multi-agent signal takes priority over long-task signal", () => {
		const result = expectMode("这是一个长期多 agent 协作任务", "multi_agent_candidate");
		expect(result.signals).toContain("multi_agent_keyword");
	});

	it("reason is always a non-empty string", () => {
		const cases = [
			"帮我解释一下 mem0 是干什么的",
			"修改这个文件里的一个 typo",
			"这个项目我要长期开发，帮我放进长期任务",
			"我们要做多 agent 协作编排，包含调研、编码、测试和 review",
			"hello",
		];
		for (const prompt of cases) {
			const result = classifyAgentRequest(prompt);
			expect(result.reason.length).toBeGreaterThan(0);
		}
	});

	it("signals array is never null", () => {
		const result = classifyAgentRequest("anything");
		expect(Array.isArray(result.signals)).toBe(true);
	});

	it("exports a default extension factory for automatic .pi/extensions discovery", () => {
		expect(typeof multiAgentDispatcherExtension).toBe("function");
		expect(() =>
			multiAgentDispatcherExtension({} as Parameters<typeof multiAgentDispatcherExtension>[0]),
		).not.toThrow();
	});
});
