/**
 * Unit tests for the child tool gate's env parsing (ADR-0007):
 * parseBlockedToolsEnv in index.ts. Runs on Node's built-in test runner with
 * type stripping; the pi package imports are redirected to stubs via
 * ../resolve-stub-hook.mjs (see ../register-stubs.mjs).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
	buildDelegateDeps,
	installChildParentPrompt,
	installChildToolGate,
	parseBlockedToolsEnv,
	withParentPrompt,
} from "../index.ts";
import { DEFAULT_CONFIG, type OrchestratorConfig } from "../config.ts";

test("parseBlockedToolsEnv: empty string → no matchers (gate not installed)", () => {
	assert.deepEqual(parseBlockedToolsEnv(""), []);
});

test("parseBlockedToolsEnv: whitespace-only segments are dropped", () => {
	assert.deepEqual(parseBlockedToolsEnv("   "), []);
	assert.deepEqual(parseBlockedToolsEnv(" , , "), []);
});

test("parseBlockedToolsEnv: segments are trimmed", () => {
	assert.deepEqual(parseBlockedToolsEnv(" bash , hindsight_* ,ext:@l/p "), ["bash", "hindsight_*", "ext:@l/p"]);
});

test("parseBlockedToolsEnv: empty segments between commas are dropped", () => {
	assert.deepEqual(parseBlockedToolsEnv("a,,b,,,"), ["a", "b"]);
});

test("parseBlockedToolsEnv: exact strings preserved (case kept, matching is downstream)", () => {
	assert.deepEqual(parseBlockedToolsEnv("Bash,HINDSIGHT_*"), ["Bash", "HINDSIGHT_*"]);
});

test("parseBlockedToolsEnv: dedupe is not required — duplicates pass through", () => {
	assert.deepEqual(parseBlockedToolsEnv("bash,bash"), ["bash", "bash"]);
});

test("parseBlockedToolsEnv: glob and ext matchers survive intact", () => {
	assert.deepEqual(parseBlockedToolsEnv("hindsight_*,ext:@luxusai/pi-hindsight,advis?r"), [
		"hindsight_*",
		"ext:@luxusai/pi-hindsight",
		"advis?r",
	]);
});

// ── Delegate deps wiring: childBlockedTools transport (ADR-0007) ───────────

/** Capture-only pi stub: records event handlers, exposes no tools. */
function capturePi() {
	const handlers: Record<string, Array<(event: any) => any>> = {};
	return {
		handlers,
		on(event: string, handler: (event: any) => any) {
			(handlers[event] ??= []).push(handler);
		},
		getAllTools: () => [],
	};
}

test("buildDelegateDeps: getChildBlockedTools returns the config value", () => {
	const config: OrchestratorConfig = { ...DEFAULT_CONFIG, childBlockedTools: ["bash", "hindsight_*"] };
	const deps = buildDelegateDeps(() => config, () => {});
	assert.deepEqual(deps.getChildBlockedTools?.(), ["bash", "hindsight_*"]);
});

test("buildDelegateDeps: getChildBlockedTools reads the live config (session_start reload), not a stale copy", () => {
	let config: OrchestratorConfig = { ...DEFAULT_CONFIG, childBlockedTools: [] };
	const deps = buildDelegateDeps(() => config, () => {});
	assert.deepEqual(deps.getChildBlockedTools?.(), []);
	config = { ...config, childBlockedTools: ["ext:@luxusai/pi-hindsight"] };
	assert.deepEqual(deps.getChildBlockedTools?.(), ["ext:@luxusai/pi-hindsight"]);
});

test("buildDelegateDeps: other config-backed deps also read the live config", () => {
	let config: OrchestratorConfig = { ...DEFAULT_CONFIG, maxTurns: 10 };
	const deps = buildDelegateDeps(() => config, () => {});
	assert.equal(deps.getMaxTurns?.(), 10);
	config = { ...config, maxTurns: 99 };
	assert.equal(deps.getMaxTurns?.(), 99);
});

// ── Delegate deps wiring: child extension transport (ADR-0008) ─────────────

test("buildDelegateDeps: getChildExtensions returns the config value", () => {
	const config: OrchestratorConfig = { ...DEFAULT_CONFIG, childExtensions: ["npm:@foo/bar"] };
	const deps = buildDelegateDeps(() => config, () => {});
	assert.deepEqual(deps.getChildExtensions?.(), ["npm:@foo/bar"]);
});

test("buildDelegateDeps: getChildExtensions reads the live config (session_start reload), not a stale copy", () => {
	let config: OrchestratorConfig = { ...DEFAULT_CONFIG };
	const deps = buildDelegateDeps(() => config, () => {});
	assert.deepEqual(deps.getChildExtensions?.(), []);
	config = { ...config, childExtensions: ["./my-ext.ts"] };
	assert.deepEqual(deps.getChildExtensions?.(), ["./my-ext.ts"]);
});

// ── Delegate deps wiring: parent prompt forwarding (forwardParentPrompt) ──

test("buildDelegateDeps: getForwardParentPrompt returns the config value", () => {
	const config: OrchestratorConfig = { ...DEFAULT_CONFIG, forwardParentPrompt: false };
	const deps = buildDelegateDeps(() => config, () => {});
	assert.equal(deps.getForwardParentPrompt?.(), false);
});

test("buildDelegateDeps: getForwardParentPrompt reads the live config (session_start reload), not a stale copy", () => {
	let config: OrchestratorConfig = { ...DEFAULT_CONFIG, forwardParentPrompt: true };
	const deps = buildDelegateDeps(() => config, () => {});
	assert.equal(deps.getForwardParentPrompt?.(), true);
	config = { ...config, forwardParentPrompt: false };
	assert.equal(deps.getForwardParentPrompt?.(), false);
});

test("buildDelegateDeps: getParentPrompt returns undefined by default (no capture yet)", () => {
	const deps = buildDelegateDeps(() => DEFAULT_CONFIG, () => {});
	assert.equal(deps.getParentPrompt?.(), undefined);
});

// ── Child tool gate (ADR-0007) ─────────────────────────────────────────────

test("installChildToolGate: matching tool_call returns block with the matcher in the reason", async () => {
	process.env.PI_ORCHESTRATOR_BLOCKED_TOOLS = "hindsight_*";
	try {
		const pi = capturePi();
		installChildToolGate(pi as any);
		const handler = pi.handlers["tool_call"]?.[0];
		assert.ok(handler, "gate handler should be installed");
		const result = await handler({ toolName: "hindsight_recall" });
		assert.equal(result?.block, true);
		assert.match(result.reason, /hindsight_\*/);
	} finally {
		delete process.env.PI_ORCHESTRATOR_BLOCKED_TOOLS;
	}
});

test("installChildToolGate: delegate tool is exempt even when explicitly blocked", async () => {
	process.env.PI_ORCHESTRATOR_BLOCKED_TOOLS = "delegate";
	try {
		const pi = capturePi();
		installChildToolGate(pi as any);
		const handler = pi.handlers["tool_call"]?.[0];
		assert.ok(handler, "gate handler should be installed");
		assert.equal(await handler({ toolName: "delegate" }), undefined);
	} finally {
		delete process.env.PI_ORCHESTRATOR_BLOCKED_TOOLS;
	}
});

test("installChildToolGate: non-matching tool passes through", async () => {
	process.env.PI_ORCHESTRATOR_BLOCKED_TOOLS = "bash";
	try {
		const pi = capturePi();
		installChildToolGate(pi as any);
		const handler = pi.handlers["tool_call"]?.[0];
		assert.ok(handler, "gate handler should be installed");
		assert.equal(await handler({ toolName: "grep" }), undefined);
	} finally {
		delete process.env.PI_ORCHESTRATOR_BLOCKED_TOOLS;
	}
});

test("installChildToolGate: absent/empty env installs no handler", () => {
	delete process.env.PI_ORCHESTRATOR_BLOCKED_TOOLS;
	const pi = capturePi();
	installChildToolGate(pi as any);
	assert.equal(pi.handlers["tool_call"], undefined);
});

// ── Child parent-prompt forwarding (forwardParentPrompt) ───────────────

test("withParentPrompt: appends the parent prompt with a blank-line separator", () => {
	assert.equal(withParentPrompt("base prompt", "parent rules"), "base prompt\n\nparent rules");
});

test("withParentPrompt: falsy systemPrompt ⇒ parent prompt becomes the whole prompt", () => {
	assert.equal(withParentPrompt(undefined, "parent rules"), "parent rules");
	assert.equal(withParentPrompt("", "parent rules"), "parent rules");
});

test("installChildParentPrompt: unset env installs no handler", () => {
	delete process.env.PI_ORCHESTRATOR_PARENT_PROMPT_FILE;
	const pi = capturePi();
	installChildParentPrompt(pi as any);
	assert.equal(pi.handlers["before_agent_start"], undefined);
});

test("installChildParentPrompt: set env appends the file contents at the END of the system prompt", async () => {
	const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-orchestrator-test-"));
	const promptFile = path.join(tmp, "parent.md");
	await fs.promises.writeFile(promptFile, "parent rules", "utf-8");
	process.env.PI_ORCHESTRATOR_PARENT_PROMPT_FILE = promptFile;
	try {
		const pi = capturePi();
		installChildParentPrompt(pi as any);
		const handler = pi.handlers["before_agent_start"]?.[0];
		assert.ok(handler, "forwarding handler should be installed");
		const result = await handler({ systemPrompt: "base\nproject_context\nskills\ncwd" });
		assert.deepEqual(result, { systemPrompt: "base\nproject_context\nskills\ncwd\n\nparent rules" });
	} finally {
		delete process.env.PI_ORCHESTRATOR_PARENT_PROMPT_FILE;
		await fs.promises.rm(tmp, { recursive: true, force: true });
	}
});

test("installChildParentPrompt: unreadable file is a pass-through (undefined)", async () => {
	process.env.PI_ORCHESTRATOR_PARENT_PROMPT_FILE = path.join(os.tmpdir(), "pi-orchestrator-does-not-exist-xyz.md");
	try {
		const pi = capturePi();
		installChildParentPrompt(pi as any);
		const handler = pi.handlers["before_agent_start"]?.[0];
		assert.ok(handler, "forwarding handler should be installed");
		assert.equal(await handler({ systemPrompt: "base" }), undefined);
	} finally {
		delete process.env.PI_ORCHESTRATOR_PARENT_PROMPT_FILE;
	}
});
