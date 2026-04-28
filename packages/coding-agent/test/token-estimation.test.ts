import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import { estimateTokens } from "../src/core/compaction/index.js";

function userMessage(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: Date.now() };
}

function assistantTextMessage(text: string): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		usage: {
			input: 100,
			output: 50,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 150,
			cost: { input: 0.001, output: 0.001, cacheRead: 0, cacheWrite: 0, total: 0.002 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
	};
}

function toolResultMessage(text: string): AgentMessage {
	return {
		role: "toolResult",
		content: [{ type: "text", text }],
		toolCallId: "call_1",
		toolName: "bash",
		isError: false,
		timestamp: Date.now(),
	};
}

function bashExecutionMessage(command: string, output: string): AgentMessage {
	return {
		role: "bashExecution",
		command,
		output,
		exitCode: 0,
		cancelled: false,
		truncated: false,
		timestamp: Date.now(),
	};
}

function compactionSummaryMessage(summary: string): AgentMessage {
	return {
		role: "compactionSummary",
		summary,
		tokensBefore: 1000,
		timestamp: Date.now(),
	};
}

describe("estimateTokens", () => {
	describe("English text", () => {
		it("estimates tokens for plain English text", () => {
			const msg = userMessage("The quick brown fox jumps over the lazy dog.");
			const tokens = estimateTokens(msg);
			// chars/4 would give ~10, actual tiktoken is ~11
			// estimateStringTokens should be in a reasonable range
			expect(tokens).toBeGreaterThan(5);
			expect(tokens).toBeLessThan(20);
		});

		it("estimates tokens for English user message with array content", () => {
			const msg: AgentMessage = {
				role: "user",
				content: [
					{ type: "text", text: "Hello world" },
					{ type: "text", text: "This is a test" },
				],
				timestamp: Date.now(),
			};
			const tokens = estimateTokens(msg);
			expect(tokens).toBeGreaterThan(3);
			expect(tokens).toBeLessThan(15);
		});
	});

	describe("CJK text", () => {
		it("estimates significantly more tokens for Chinese text than chars/4 would", () => {
			const chineseText =
				"用户要求改进记忆系统，使其能够自动更新、去重和清理。这是一个关于长期记忆管理的重要改进方向。";
			const msg = userMessage(chineseText);
			const tokens = estimateTokens(msg);
			// chars/4 for this ~56 char string would give ~14
			// actual tiktoken is ~44+ tokens
			// estimateStringTokens should be 30+ (much closer to actual)
			expect(tokens).toBeGreaterThan(25);
		});

		it("estimates more tokens for Japanese text", () => {
			const japaneseText = "ユーザーはメモリシステムの改善を要求しています。自動更新と重複排除が必要です。";
			const msg = userMessage(japaneseText);
			const tokens = estimateTokens(msg);
			expect(tokens).toBeGreaterThan(10);
		});

		it("estimates more tokens for Korean text", () => {
			const koreanText = "사용자가 메모리 시스템 개선을 요청했습니다. 자동 업데이트와 중복 제거가 필요합니다.";
			const msg = userMessage(koreanText);
			const tokens = estimateTokens(msg);
			expect(tokens).toBeGreaterThan(15);
		});
	});

	describe("mixed content", () => {
		it("estimates tokens for mixed Chinese-English text", () => {
			const mixed = "这是一个关于 memory 系统的改进。Token counting 现在更准确了。";
			const msg = userMessage(mixed);
			const tokens = estimateTokens(msg);
			expect(tokens).toBeGreaterThan(15);
		});

		it("estimates tokens for code with Chinese comments", () => {
			const code = `// 清理过期的记忆条目
function cleanupStale(query: string) {
  const results = await search(query);
  return results.filter(r => r.score > 0.6);
}`;
			const msg = userMessage(code);
			const tokens = estimateTokens(msg);
			expect(tokens).toBeGreaterThan(10);
		});
	});

	describe("message types", () => {
		it("estimates tokens for assistant messages", () => {
			const msg = assistantTextMessage("这是中文回复，包含了一些代码和说明。");
			const tokens = estimateTokens(msg);
			expect(tokens).toBeGreaterThan(10);
		});

		it("estimates tokens for tool result messages", () => {
			const msg = toolResultMessage("执行结果：成功清理了 5 条过期的记忆。");
			const tokens = estimateTokens(msg);
			expect(tokens).toBeGreaterThan(8);
		});

		it("estimates tokens for bash execution messages", () => {
			const msg = bashExecutionMessage("curl http://localhost:8000/health", "状态：正常\n服务运行中");
			const tokens = estimateTokens(msg);
			expect(tokens).toBeGreaterThan(5);
		});

		it("estimates tokens for compaction summary messages", () => {
			const msg = compactionSummaryMessage("对话摘要：用户讨论了记忆系统的改进，包括自动清理和时间衰减功能。");
			const tokens = estimateTokens(msg);
			expect(tokens).toBeGreaterThan(15);
		});
	});

	describe("edge cases", () => {
		it("returns at least 1 token for non-empty messages", () => {
			const msg = userMessage("a");
			expect(estimateTokens(msg)).toBeGreaterThanOrEqual(1);
		});

		it("handles empty strings", () => {
			const msg = userMessage("");
			expect(estimateTokens(msg)).toBeGreaterThanOrEqual(1);
		});

		it("handles emoji (surrogate pairs)", () => {
			const msg = userMessage("Great work! 🎉🚀 Let's continue.");
			const tokens = estimateTokens(msg);
			expect(tokens).toBeGreaterThan(5);
		});

		it("counts image blocks as 1200 tokens each", () => {
			const msgWithImages: AgentMessage = {
				role: "toolResult",
				content: [
					{ type: "text", text: "Here is the screenshot" },
					{ type: "image" as const, data: "iVBORw0KGgo=", mimeType: "image/png" },
				],
				toolCallId: "call_1",
				toolName: "bash",
				isError: false,
				timestamp: Date.now(),
			};
			const tokens = estimateTokens(msgWithImages);
			// Text part + 1 image (1200 tokens)
			expect(tokens).toBeGreaterThan(1200);
		});
	});
});
