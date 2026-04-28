#!/usr/bin/env node
/**
 * CLI entry point for the refactored coding agent.
 * Uses main.ts with AgentSession and new mode modules.
 *
 * Test with: npx tsx src/cli-new.ts [args...]
 */
import { appendFileSync } from "node:fs";
import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";
import { APP_NAME, getAgentDir } from "./config.js";
import { main } from "./main.js";

process.title = APP_NAME;
process.env.PI_CODING_AGENT = "true";
process.emitWarning = (() => {}) as typeof process.emitWarning;

// Crash log — write uncaught exceptions and unhandled rejections to disk
// so the external rescue system can diagnose failures after the process dies.
const CRASH_LOG_PATH = `${getAgentDir()}/${APP_NAME}-crash.log`;

process.on("uncaughtException", (error: Error) => {
	try {
		appendFileSync(CRASH_LOG_PATH, `[${new Date().toISOString()}] UNCAUGHT: ${error.stack || error.message}\n`);
	} catch {
		// If we can't write the crash log, there's nothing more we can do.
	}
	process.exit(1);
});

process.on("unhandledRejection", (reason: unknown) => {
	try {
		appendFileSync(CRASH_LOG_PATH, `[${new Date().toISOString()}] REJECTION: ${String(reason)}\n`);
	} catch {
		// Log what we can but don't exit — let the existing behavior continue.
	}
});

setGlobalDispatcher(new EnvHttpProxyAgent());

main(process.argv.slice(2));
