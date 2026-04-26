import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import personalProfileExtension from "../../../../.pi/extensions/personal-profile.js";

type ExtensionHandler = (event: unknown, ctx: unknown) => Promise<unknown> | unknown;

interface BeforeAgentStartResult {
	systemPrompt?: string;
}

function createTempDir(): string {
	return join(tmpdir(), `pi-profile-extension-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

function createExtensionHarness(): Map<string, ExtensionHandler[]> {
	const handlers = new Map<string, ExtensionHandler[]>();
	personalProfileExtension({
		on(eventName: string, handler: ExtensionHandler) {
			const existing = handlers.get(eventName) ?? [];
			existing.push(handler);
			handlers.set(eventName, existing);
		},
	} as Parameters<typeof personalProfileExtension>[0]);
	return handlers;
}

async function emit(
	handlers: Map<string, ExtensionHandler[]>,
	eventName: string,
	event: unknown,
	ctx: unknown,
): Promise<unknown[]> {
	const results: unknown[] = [];
	for (const handler of handlers.get(eventName) ?? []) {
		results.push(await handler(event, ctx));
	}
	return results;
}

describe("personal profile extension", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		while (tempDirs.length > 0) {
			rmSync(tempDirs.pop()!, { recursive: true, force: true });
		}
	});

	it("injects stable project profile context into the system prompt", async () => {
		const cwd = createTempDir();
		tempDirs.push(cwd);
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "profile.md"), "Project preference: prefer local memory.", "utf-8");
		const handlers = createExtensionHarness();

		await emit(handlers, "session_start", { type: "session_start" }, { cwd });
		const results = await emit(
			handlers,
			"before_agent_start",
			{
				type: "before_agent_start",
				prompt: "hello",
				systemPrompt: "Base prompt.",
				systemPromptOptions: {},
			},
			{ cwd },
		);
		const result = results[0] as BeforeAgentStartResult;

		expect(result.systemPrompt).toContain("# Stable Personal Profile");
		expect(result.systemPrompt).toContain("Project preference: prefer local memory.");
	});
});
