// Integration test: verify per-worker model resolution with the real config
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readConfig } from "../../../../.pi/extensions/long-task-runner.js";
import { resolveWorkerModel } from "../../../../.pi/extensions/worker-executor.js";

describe("Integration: per-worker model resolution", () => {
	const CWD = "/Users/shelterpl/Dev/pi-mono";

	it("reads the actual task-router.config.json", () => {
		const config = readConfig(CWD);
		expect(config.enabled).toBe(true);
		expect(config.modelPolicies).toBeDefined();
		expect(config.workers).toBeDefined();
	});

	it("each worker role has a modelPolicy configured", () => {
		const config = readConfig(CWD);
		const roles = ["researcher", "coder", "tester", "reviewer", "docWriter"] as const;
		for (const role of roles) {
			const workerConfig = config.workers?.[role];
			expect(workerConfig?.modelPolicy, `${role} should have a modelPolicy`).toBeDefined();
		}
	});

	it("each referenced modelPolicy has non-null provider and model", () => {
		const config = readConfig(CWD);
		const roles = ["researcher", "coder", "tester", "reviewer", "docWriter"] as const;
		for (const role of roles) {
			const policyName = config.workers?.[role]?.modelPolicy;
			expect(policyName, `${role} missing modelPolicy`).toBeDefined();
			const policy = config.modelPolicies?.[policyName!];
			expect(policy, `policy "${policyName}" not found in modelPolicies`).toBeDefined();
			if (policyName !== "default") {
				expect(policy!.provider, `policy "${policyName}" missing provider`).not.toBeNull();
				expect(policy!.model, `policy "${policyName}" missing model`).not.toBeNull();
			}
		}
	});

	it("resolves researcher to longContext policy model", () => {
		const config = readConfig(CWD);
		const policyName = config.workers?.researcher?.modelPolicy;
		expect(policyName).toBe("longContext");
		const policy = config.modelPolicies?.longContext;
		expect(policy?.provider).toBe("deepseek");
		expect(policy?.model).toBe("deepseek-v4-flash");
	});

	it("resolves tester to cheapBatch policy model", () => {
		const config = readConfig(CWD);
		const policyName = config.workers?.tester?.modelPolicy;
		expect(policyName).toBe("cheapBatch");
		const policy = config.modelPolicies?.cheapBatch;
		expect(policy?.provider).toBe("ollama-cloud");
		expect(policy?.model).toBe("qwen3-coder-next");
	});

	it("resolves coder and reviewer to deepseek models", () => {
		const config = readConfig(CWD);
		const codingPolicy = config.modelPolicies?.coding;
		expect(codingPolicy?.provider).toBe("deepseek");
		expect(codingPolicy?.model).toBe("deepseek-v4-pro");

		const reasoningPolicy = config.modelPolicies?.reasoning;
		expect(reasoningPolicy?.provider).toBe("deepseek");
		expect(reasoningPolicy?.model).toBe("deepseek-v4-pro");
	});

	// Test actual model registry resolution
	it("falls back gracefully when model is not found in registry", () => {
		const tmpDir = join(tmpdir(), `pi-resolve-integration-${Date.now()}`);
		mkdirSync(join(tmpDir, ".pi"), { recursive: true });
		try {
			writeFileSync(
				join(tmpDir, ".pi", "task-router.config.json"),
				JSON.stringify({
					workers: { researcher: { modelPolicy: "nonexistent" } },
					modelPolicies: { nonexistent: { provider: "fake", model: "nope" } },
				}),
			);
			const emptyRegistry = { find: () => undefined };
			const result = resolveWorkerModel(tmpDir, "researcher", emptyRegistry);
			expect(result).toBeUndefined();
		} finally {
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});
});
