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
	createPolicyTextCache,
	stripDuplicatedParentSegments,
	withParentPrompt,
} from "../src/index.ts";
import { DEFAULT_CONFIG, type DiscoveredTool, type OrchestratorConfig } from "../src/config.ts";
import { buildPolicy } from "../src/policy.ts";
import type { AgentConfig } from "../src/agents.ts";

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

test("buildDelegateDeps: getAsyncDefault reads the live config async key (ADR-0016)", () => {
	let config: OrchestratorConfig = { ...DEFAULT_CONFIG, async: true };
	const deps = buildDelegateDeps(() => config, () => {});
	assert.equal(deps.getAsyncDefault?.(), true);
	config = { ...config, async: false };
	assert.equal(deps.getAsyncDefault?.(), false);
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

// ── Delegate deps wiring: fleet widget state label (ADR-0003) ────────────

test("buildDelegateDeps: getOrchestratorMode maps enabled to engaged", () => {
	const config: OrchestratorConfig = { ...DEFAULT_CONFIG, enabled: true };
	const deps = buildDelegateDeps(() => config, () => {});
	assert.equal(deps.getOrchestratorMode(), "engaged");
});

test("buildDelegateDeps: getOrchestratorMode reads the live config, so /orchestrator relabels without a rebuild", () => {
	let config: OrchestratorConfig = { ...DEFAULT_CONFIG };
	const deps = buildDelegateDeps(() => config, () => {});
	assert.equal(deps.getOrchestratorMode(), "engaged");
	config = { ...config, enabled: false };
	assert.equal(deps.getOrchestratorMode(), "auto", "a disabled orchestrator must never be labelled engaged");
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

// ── Delta-forwarding (stripDuplicatedParentSegments) ───────────────────

// OS-neutral synthetic cwd values — these fixtures are prompt *text*; the
// stripper only compares the full "Current working directory: …" line
// verbatim, so any path works as long as both sides agree.
const FAKE_CWD = path.join(os.tmpdir(), "repo-x");
const FAKE_CWD_OTHER = path.join(os.tmpdir(), "repo-other");

const CHILD_WITH_DUPES =
	"base\n\n<project_context>\nAGENTS.md content\n</project_context>\n\n" +
	`Current working directory: ${FAKE_CWD}\n\nToolbelt: 4 tools`;

const PARENT_WITH_DUPES =
	"Available tools:\n- recall\n\n" +
	"<project_context>\nAGENTS.md content\n</project_context>\n\n" +
	`Current working directory: ${FAKE_CWD}\n\n` +
	"Toolbelt: 36 tools\n\nCodeGraph tools are available.";

const PARENT_STRIPPED =
	"Available tools:\n- recall\n\nToolbelt: 36 tools\n\nCodeGraph tools are available.";

test("stripDuplicatedParentSegments: removes verbatim-duplicated project_context + cwd, keeps the rest", () => {
	assert.equal(stripDuplicatedParentSegments(CHILD_WITH_DUPES, PARENT_WITH_DUPES), PARENT_STRIPPED);
});

test("stripDuplicatedParentSegments: deterministic — same inputs, same output bytes", () => {
	const once = stripDuplicatedParentSegments(CHILD_WITH_DUPES, PARENT_WITH_DUPES);
	for (let i = 0; i < 5; i++) {
		assert.equal(stripDuplicatedParentSegments(CHILD_WITH_DUPES, PARENT_WITH_DUPES), once);
	}
});

test("stripDuplicatedParentSegments: keeps segments NOT present in the child's prompt (per-task cwd override)", () => {
	const childOtherCwd =
		"base\n\n<project_context>\nOTHER repo AGENTS.md\n</project_context>\n\n" +
		`Current working directory: ${FAKE_CWD_OTHER}\n\nToolbelt: 4 tools`;
	// Neither the parent's project_context block nor its cwd line appears in
	// the child's prompt ⇒ both must survive untouched.
	assert.equal(stripDuplicatedParentSegments(childOtherCwd, PARENT_WITH_DUPES), PARENT_WITH_DUPES);
});

test("stripDuplicatedParentSegments: partially-duplicated segments (skills) are left intact", () => {
	// The child's skills section DIVERGES from the parent's (not a contiguous
	// verbatim substring) ⇒ the parent's whole section must survive.
	const parent = "## Agent skills\n\n### Issue tracker\n\nSee docs.\n\n---\n\nBase body";
	const child = "## Agent skills\n\n### Triage labels\n\nDifferent docs.\n\n---\n\nBase body";
	assert.equal(stripDuplicatedParentSegments(child, parent), parent);
});

test("stripDuplicatedParentSegments: verbatim-duplicated skills section is stripped", () => {
	// The parent's entire skills slice appears contiguously in the child's
	// (superset) skills section ⇒ every byte is already present ⇒ strip.
	const parentSkills = "## Agent skills\n\n### Issue tracker\n\nSee docs.";
	const parent = `${parentSkills}\n\n---\n\nBase body`;
	const child = `prefix\n\n${parentSkills}\n\n### Domain docs\n\nMore.\n\n---\n\nchild base`;
	assert.equal(stripDuplicatedParentSegments(child, parent), "\n---\n\nBase body");
});

test("stripDuplicatedParentSegments: undefined child prompt ⇒ parent prompt returned unchanged", () => {
	assert.equal(stripDuplicatedParentSegments(undefined, PARENT_WITH_DUPES), PARENT_WITH_DUPES);
});

test("withParentPrompt: fully-duplicated parent prompt strips to empty ⇒ nothing appended", () => {
	// Every segment of the parent prompt (project_context + cwd line) already
	// appears verbatim in the child's prompt ⇒ delta-stripping yields an empty
	// string ⇒ withParentPrompt must return the child prompt unchanged (no
	// trailing blank line, no forwarded artifacts).
	const shared = "<project_context>\nsame AGENTS.md\n</project_context>\n\nCurrent working directory: D:\\Git\\repo";
	const child = `base\n\n${shared}`;
	const stripped = stripDuplicatedParentSegments(child, shared);
	assert.equal(stripped, "");
	assert.equal(withParentPrompt(child, stripped), child);
});

test("stripDuplicatedParentSegments: parent prompt without duplicable segments is a no-op", () => {
	const parent = "extension guidance\n\nMore guidance";
	assert.equal(stripDuplicatedParentSegments(CHILD_WITH_DUPES, parent), parent);
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

test("installChildParentPrompt: duplicated project_context/cwd segments are delta-stripped before appending", async () => {
	const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-orchestrator-test-"));
	const promptFile = path.join(tmp, "parent.md");
	await fs.promises.writeFile(promptFile, PARENT_WITH_DUPES, "utf-8");
	process.env.PI_ORCHESTRATOR_PARENT_PROMPT_FILE = promptFile;
	try {
		const pi = capturePi();
		installChildParentPrompt(pi as any);
		const handler = pi.handlers["before_agent_start"]?.[0];
		assert.ok(handler, "forwarding handler should be installed");
		const result = await handler({ systemPrompt: CHILD_WITH_DUPES });
		assert.deepEqual(result, { systemPrompt: `${CHILD_WITH_DUPES}\n\n${PARENT_STRIPPED}` });
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

// ── Policy text cache (ADR-0013) ───────────────────────────────────────────

test("createPolicyTextCache: computed lazily once, reused verbatim across turns", () => {
	let calls = 0;
	const cache = createPolicyTextCache(() => {
		calls += 1;
		return `policy-v${calls}`;
	});
	assert.equal(cache.get(), "policy-v1");
	assert.equal(cache.get(), "policy-v1", "the same text must be re-appended next turn without recomputing");
	assert.equal(calls, 1);
});

test("createPolicyTextCache: invalidate at an episode boundary forces a recompute", () => {
	let calls = 0;
	const cache = createPolicyTextCache(() => `policy-v${++calls}`);
	assert.equal(cache.get(), "policy-v1");
	cache.invalidate(); // setEngaged / session_start
	assert.equal(cache.get(), "policy-v2", "re-engaging must regenerate the text (fresh fleet list)");
	assert.equal(calls, 2);
});

test("buildPolicy: deterministic for identical inputs (ADR-0013 cache premise)", () => {
	const agents: AgentConfig[] = [
		{ name: "scout", description: "read-only recon", systemPrompt: "", source: "builtin", filePath: "x.md" },
		{
			name: "worker",
			description: "general-purpose",
			tools: ["read", "bash"],
			systemPrompt: "worker prompt",
			source: "builtin",
			filePath: "y.md",
		},
	];
	const kept: DiscoveredTool[] = [{ extensionId: "ext:x", names: ["read"], partial: false }];
	assert.equal(buildPolicy(agents, DEFAULT_CONFIG, kept), buildPolicy(agents, DEFAULT_CONFIG, kept));
});

// ── AUTO toolset hands-off (clarified contract) ─────────────────────────────
//
// AUTO (enabled:false) NEVER touches the active tool set. Which built-in
// tools are active is pi's concern (its `defaultTools` setting — default
// read/bash/edit/write; powershell/grep/find/ls stay registered-but-inactive
// unless the user opts in), and extension tools belong to the extensions
// that registered them (plannotator phase-gates its two tools). An earlier
// fix force-enabled all registered builtins in AUTO; the user rejected that
// (powershell was never opted into), so the contract is: hands-off in AUTO,
// and the toggle-off restore (applyReduction's disengaged branch, reached
// only via /orchestrator) must also not force-enable optional builtins.

const ALL_REGISTERED = [
	"read", "bash", "powershell", "edit", "write", "grep", "find", "ls",
	"delegate", "advisor", "recall", "codegraph_explore", "fetch", "search", "transcribe",
	"plannotator_submit_plan", "plannotator_mark_done",
];

/** pi's launch-time active set with the defaultTools default. */
const LAUNCH_DEFAULT_ACTIVE = ALL_REGISTERED.filter(
	(n) => !["grep", "find", "ls", "powershell"].includes(n),
);

function toolsetPi() {
	const calls: string[][] = [];
	const handlers: Record<string, Array<(event: any, ctx: any) => any>> = {};
	const ALL = ALL_REGISTERED.map((n) => ({ name: n, sourceInfo: { path: `<builtin:${n}>` } }));
	let active: string[] = [...LAUNCH_DEFAULT_ACTIVE];
	const stub: any = {
		on(event: string, handler: (event: any, ctx: any) => any) {
			(handlers[event] ??= []).push(handler);
		},
		getAllTools: () => ALL.map((t) => ({ ...t })),
		getActiveTools: () => [...active],
		setActiveTools(names: string[]) {
			calls.push([...names]);
			active = [...names];
		},
		registerTool() {},
		registerCommand(name: string, def: any) {
			((handlers as any).command ??= {})[name] = def.handler;
		},
	};
	return { stub, handlers, calls };
}

/** Point getAgentDir() (stubbed) at a temp dir with the given enabled flag;
 *  restore the env afterwards so other tests are unaffected. */
async function withAgentDir(enabled: boolean, fn: () => Promise<void>): Promise<void> {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-orch-auto-norm-"));
	fs.writeFileSync(path.join(dir, "orchestrator.jsonc"), JSON.stringify({ enabled }));
	const prev = process.env.PI_ORCH_TEST_AGENT_DIR;
	process.env.PI_ORCH_TEST_AGENT_DIR = dir;
	delete process.env.PI_ORCHESTRATOR_CHILD;
	try {
		await fn();
	} finally {
		if (prev === undefined) delete process.env.PI_ORCH_TEST_AGENT_DIR;
		else process.env.PI_ORCH_TEST_AGENT_DIR = prev;
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

async function loadExtension(): Promise<any> {
	const mod = await import("../src/index.ts");
	return mod.default;
}

test("AUTO session_start leaves the active set untouched (pi's defaultTools governs)", async () => {
	const { stub, handlers, calls } = toolsetPi();
	assert.deepEqual(stub.getActiveTools(), LAUNCH_DEFAULT_ACTIVE, "precondition: pi launch defaults are reduced");
	await withAgentDir(false, async () => {
		(await loadExtension())(stub);
		assert.equal(handlers.session_start?.length, 1);
		await handlers.session_start[0]({}, {});
		assert.equal(calls.length, 0, "AUTO session_start must not touch the tool set");
		assert.deepEqual(stub.getActiveTools(), LAUNCH_DEFAULT_ACTIVE);
	});
});

test("AUTO before_agent_start stays hands-off even when tools were stripped", async () => {
	const { stub, handlers, calls } = toolsetPi();
	await withAgentDir(false, async () => {
		(await loadExtension())(stub);
		await handlers.session_start[0]({}, {});
		// Simulate plannotator's idle strip + a builtin gap from a resume replay:
		// AUTO must not revert either — whoever stripped them owns them.
		stub.setActiveTools(stub.getActiveTools().filter((n: string) => n !== "plannotator_submit_plan" && n !== "bash"));
		const beforeTurn = calls.length;
		const res = await handlers.before_agent_start[0]({ systemPrompt: "p" }, {});
		assert.equal(res, undefined, "AUTO must not append the delegation policy");
		assert.equal(calls.length, beforeTurn, "AUTO before_agent_start must not touch the tool set");
		await handlers.before_agent_start[0]({ systemPrompt: "p" }, {});
		assert.equal(calls.length, beforeTurn, "later disengaged turns stay hands-off too");
	});
});

test("toggle-off via /orchestrator restores extensions + core builtins, not optional builtins", async () => {
	const { stub, handlers, calls } = toolsetPi();
	await withAgentDir(true, async () => {
		(await loadExtension())(stub);
		await handlers.session_start[0]({}, {});
		assert.deepEqual(stub.getActiveTools(), ["delegate"], "precondition: engaged keep-list");
		calls.length = 0;
		// Toggle off — the same path /orchestrator uses.
		await (handlers as any).command.orchestrator("", {});
		assert.equal(calls.length, 1, "toggle-off restores the tool set exactly once");
		const restored = stub.getActiveTools();
		for (const name of ["read", "bash", "edit", "write", "delegate", "advisor", "plannotator_submit_plan"]) {
			assert.ok(restored.includes(name), `toggle-off must restore ${name}`);
		}
		for (const name of ["powershell", "grep", "find", "ls"]) {
			assert.ok(!restored.includes(name), `toggle-off must not force-enable optional builtin ${name}`);
		}
	});
});

test("ENGAGED session_start still reduces to the keep-list (unchanged)", async () => {
	const { stub, handlers, calls } = toolsetPi();
	await withAgentDir(true, async () => {
		(await loadExtension())(stub);
		await handlers.session_start[0]({}, {});
		assert.equal(calls.length, 1);
		// DEFAULT_CONFIG.keepTools is ["delegate"] → keep-list-only leaves delegate.
		assert.deepEqual(stub.getActiveTools(), ["delegate"]);
	});
});
