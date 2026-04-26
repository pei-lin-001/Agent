import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

interface ProfileConfig {
	maxProfileChars: number;
}

const DEFAULT_CONFIG: ProfileConfig = {
	maxProfileChars: 16_000,
};

function readOptionalFile(path: string): string {
	if (!existsSync(path)) {
		return "";
	}
	return readFileSync(path, "utf-8").trim();
}

function readProfileConfig(cwd: string): ProfileConfig {
	const globalConfigPath = join(homedir(), ".pi", "agent", "profile.config.json");
	const projectConfigPath = join(cwd, ".pi", "profile.config.json");
	const config = { ...DEFAULT_CONFIG };

	for (const configPath of [globalConfigPath, projectConfigPath]) {
		if (!existsSync(configPath)) {
			continue;
		}
		try {
			Object.assign(config, JSON.parse(readFileSync(configPath, "utf-8")) as Partial<ProfileConfig>);
		} catch {
			continue;
		}
	}

	return config;
}

function truncateText(text: string, maxChars: number): string {
	if (text.length <= maxChars) {
		return text;
	}
	return `${text.slice(0, maxChars)}\n[truncated]`;
}

function formatProfileSection(parts: string[], maxProfileChars: number): string {
	const body = parts
		.map((part) => part.trim())
		.filter(Boolean)
		.join("\n\n---\n\n");

	if (!body) {
		return "";
	}

	return `\n\n# Stable Personal Profile\n\nThis profile contains stable preferences, identity, operating principles, and long-term goals for the personal assistant. Treat it as higher-level user context. Use it when relevant, but do not mention this profile unless the user asks.\n\n${truncateText(body, maxProfileChars)}`;
}

export default function personalProfileExtension(pi: ExtensionAPI) {
	let profileSection = "";

	pi.on("session_start", async (_event, ctx) => {
		const config = readProfileConfig(ctx.cwd);
		const globalProfile = readOptionalFile(join(homedir(), ".pi", "agent", "profile.md"));
		const projectProfile = readOptionalFile(join(ctx.cwd, ".pi", "profile.md"));
		const projectStatus = readOptionalFile(join(ctx.cwd, ".pi", "project-status.md"));
		const localProfile = readOptionalFile(join(ctx.cwd, ".pi", "profile.local.md"));
		const localStatus = readOptionalFile(join(ctx.cwd, ".pi", "project-status.local.md"));
		profileSection = formatProfileSection(
			[globalProfile, projectProfile, projectStatus, localProfile, localStatus].filter(Boolean),
			config.maxProfileChars,
		);
	});

	pi.on("before_agent_start", async (event) => {
		if (!profileSection) {
			return undefined;
		}
		return {
			systemPrompt: `${event.systemPrompt}${profileSection}`,
		};
	});
}
