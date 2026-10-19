import { test } from "node:test";
import { getEventListeners } from "node:events";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runSingleAgent, type RunSingleAgentOptions } from "../src/delegate.ts";

const fixture = path.resolve("tests/fixtures/rpc-child.mjs");

function harness(t: { after: (fn: () => void) => void }, scenario: string, overrides: Partial<RunSingleAgentOptions> = {}) {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "worker-runner-test-"));
	t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
	const options: RunSingleAgentOptions = {
		defaultCwd: directory,
		dispatchDefaults: { model: "test/model", thinkingLevel: "low" },
		agents: [{ name: "worker", description: "test worker", source: "project", filePath: "worker.md", systemPrompt: "", tools: ["read"] }],
		agentName: "worker", task: "test task", maxTurns: 20, stallTimeoutMs: 2000,
		blockedTools: [], extensions: ["fixture-extension"], parentPrompt: undefined,
		getAllTools: () => [], cwd: undefined, step: undefined, signal: undefined, onUpdate: undefined,
		makeDetails: (results) => ({ mode: "single", results }),
		sessionOpts: { persist: true, parentSessionFile: path.join(directory, "parent.jsonl") },
		invocation: { command: process.execPath, argsPrefix: [fixture, scenario, directory] },
		...overrides,
	};
	const audit = () => JSON.parse(fs.readFileSync(path.join(directory, "audit.json"), "utf8"));
	const assertClean = () => {
		const data = audit();
		for (const p of [data.promptFile, data.parentFile].filter(Boolean)) {
			assert.equal(fs.existsSync(p), false, `removed temp file ${p}`);
			assert.equal(fs.existsSync(path.dirname(p)), false, "removed temp directory");
		}
		assert.throws(() => process.kill(data.pid, 0), "child is actually gone when the runner resolves");
		if (process.platform !== "win32" && data.closed) assert.equal(data.filesAtClose, true, "prompt files survive until real close");
	};
	return { options, directory, audit, assertClean };
}

test("real child: setup precedes prompt, spawn flags/env and progress survive until close and cleanup", { timeout: 8000 }, async (t) => {
	const progress: unknown[] = [];
	const updates: number[] = [];
	const h = harness(t, "success", {
		agents: [{ name: "worker", description: "test worker", source: "project", filePath: "worker.md", systemPrompt: "worker system", tools: ["read"] }],
		blockedTools: ["forbidden*"], parentPrompt: "parent system",
		onProgress: (value) => progress.push(value),
		onUpdate: (update) => updates.push(update.details!.results[0].exitCode),
	});
	const result = await runSingleAgent(h.options);
	assert.equal(result.completedNormally, true, JSON.stringify(result));
	assert.equal(result.sessionId, "linked");
	assert.equal(result.sessionFile, path.join(h.directory, "linked.jsonl"));
	assert.equal(result.messages.length, 1);
	assert.equal(result.usage.turns, 1);
	assert.equal(result.usage.toolTurns, 1);
	assert.deepEqual(progress.at(-1), { turns: 1, toolTurns: 1, contextTokens: 21, inputTokens: 11, outputTokens: 7 });
	assert.ok(updates.length > 0);
	assert.ok(updates.every((value) => value === -1));
	const a = h.audit();
	assert.deepEqual(a.commands.map((c: { type: string }) => c.type), ["get_state", "new_session", "get_state", "set_session_name", "prompt"]);
	assert.equal(a.commands[1].parentSession, h.options.sessionOpts.parentSessionFile);
	assert.equal(a.commands[3].name, "orch: worker — test task");
	assert.equal(a.commands[4].message, "Task: test task");
	assert.equal(a.child, "1");
	assert.equal(a.blocked, "forbidden*");
	assert.match(a.prompt, /worker system[\s\S]*forbidden\*/);
	assert.equal(a.parentPrompt, "parent system");
	for (const [flag, value] of [["--mode", "rpc"], ["--model", "test/model"], ["--thinking", "low"], ["--tools", "read"], ["--exclude-tools", "forbidden*"], ["-e", "fixture-extension"], ["--session-dir", h.directory]]) {
		assert.equal(a.args[a.args.indexOf(flag) + 1], value);
	}
	assert.ok(a.args.includes("--no-extensions"));
	assert.equal(a.args.includes("--no-session"), false);
	assert.equal(a.args.includes("--session-id"), false);
	h.assertClean();
});

test("real child: persistent setup replies do not settle the run before its prompt and output", { timeout: 8000 }, async (t) => {
	const progress: unknown[] = [];
	const h = harness(t, "success", { onProgress: (value) => progress.push(value) });
	const result = await runSingleAgent(h.options);
	assert.equal(result.completedNormally, true);
	assert.equal(result.sessionId, "linked");
	assert.equal(result.messages.length, 1);
	assert.deepEqual(h.audit().commands.map((c: { type: string }) => c.type), ["get_state", "new_session", "get_state", "set_session_name", "prompt"]);
	assert.deepEqual(progress.at(-1), { turns: 1, toolTurns: 1, contextTokens: 21, inputTokens: 11, outputTokens: 7 });
	h.assertClean();
});

for (const scenario of ["success", "malformed"]) {
	test(`real child: ephemeral ${scenario}, throwing observers cannot strand it`, { timeout: 8000 }, async (t) => {
		const h = harness(t, scenario, {
			sessionOpts: { persist: false },
			onProgress: () => { throw new Error("observer failure"); },
			onUpdate: () => { throw new Error("UI failure"); },
		});
		const result = await runSingleAgent(h.options);
		assert.equal(result.completedNormally, true);
		assert.equal(result.messages.length, 1);
		assert.deepEqual(h.audit().commands.map((c: { type: string }) => c.type), ["prompt"]);
		assert.ok(h.audit().args.includes("--no-session"));
		assert.match(h.audit().args[h.audit().args.indexOf("--session-id") + 1], /^[a-f0-9]{32}$/);
		h.assertClean();
	});
}

for (const scenario of ["early-exit", "rejected"]) {
	test(`real child: ${scenario} is a failure, not normal completion`, { timeout: 8000 }, async (t) => {
		const h = harness(t, scenario);
		const result = await runSingleAgent(h.options);
		assert.equal(result.completedNormally, false);
		assert.match(result.errorMessage!, scenario === "rejected" ? /RPC prompt rejected: fixture rejection/ : /closed before agent_settled/);
		if (scenario === "early-exit") { assert.equal(result.exitCode, 23); assert.match(result.stderr, /unexpected failure/); }
		h.assertClean();
	});
}

test("failed real spawn returns an attributable failure after close", { timeout: 8000 }, async (t) => {
	const h = harness(t, "success", { invocation: { command: path.join(os.tmpdir(), "nonexistent-runner-executable"), argsPrefix: [] } });
	const result = await runSingleAgent(h.options);
	assert.equal(result.completedNormally, false);
	assert.match(result.errorMessage!, /ENOENT/);
});

test("real child: cancellation preserves partial output and removes AbortSignal listener", { timeout: 8000 }, async (t) => {
	const controller = new AbortController();
	let kill: (() => void) | undefined;
	const h = harness(t, "cancel", {
		signal: controller.signal, registerKill: (fn) => { kill = fn; },
		onProgress: () => controller.abort(),
	});
	const result = await runSingleAgent(h.options);
	assert.equal(result.completedNormally, false);
	assert.equal(result.stopReason, "aborted");
	assert.equal(result.messages.length, 1);
	assert.equal(result.usage.output, 7);
	assert.equal(getEventListeners(controller.signal, "abort").length, 0);
	kill!(); kill!(); // Stale owner handles are safe after close.
	h.assertClean();
});

test("pre-aborted signal never launches a child", async (t) => {
	const controller = new AbortController(); controller.abort();
	const h = harness(t, "success", { signal: controller.signal });
	const result = await runSingleAgent(h.options);
	assert.equal(result.stopReason, "aborted");
	assert.equal(fs.existsSync(path.join(h.directory, "audit.json")), false);
});

test("cancellation during async prompt preparation cannot launch a child", async (t) => {
	const controller = new AbortController();
	const h = harness(t, "success", {
		signal: controller.signal,
		blockedTools: ["forbidden*"],
		getAllTools: () => { queueMicrotask(() => controller.abort()); return []; },
	});
	const result = await runSingleAgent(h.options);
	assert.equal(result.stopReason, "aborted");
	assert.equal(fs.existsSync(path.join(h.directory, "audit.json")), false);
});

test("registering a kill handle after owner cancellation cannot send a prompt", { timeout: 8000 }, async (t) => {
	const h = harness(t, "success", { registerKill: (kill) => { kill(); kill(); } });
	const result = await runSingleAgent(h.options);
	assert.equal(result.stopReason, "aborted");
	const auditFile = path.join(h.directory, "audit.json");
	if (fs.existsSync(auditFile)) assert.equal(h.audit().commands.length, 0);
});

test("real child: watchdog kills silent stdout and preserves partial output", { timeout: 8000 }, async (t) => {
	const h = harness(t, "stall", { stallTimeoutMs: 500 });
	const result = await runSingleAgent(h.options);
	assert.equal(result.stopReason, "stall-timeout");
	assert.equal(result.completedNormally, false);
	assert.equal(result.messages.length, 1);
	assert.match(result.errorMessage!, /Stall timeout/);
	h.assertClean();
});

test("real child: every stdout line, even malformed noise, resets watchdog", { timeout: 8000 }, async (t) => {
	const h = harness(t, "noise", { stallTimeoutMs: 500 });
	const result = await runSingleAgent(h.options);
	assert.equal(result.completedNormally, true);
	h.assertClean();
});

test("real child: stalled session setup flushes waiters and never sends prompt after close", { timeout: 8000 }, async (t) => {
	const h = harness(t, "setup-stall", { stallTimeoutMs: 500 });
	const result = await runSingleAgent(h.options);
	assert.equal(result.stopReason, "stall-timeout");
	assert.deepEqual(h.audit().commands.map((c: { type: string }) => c.type), ["get_state"]);
	h.assertClean();
});

test("real child: budget steers once, allows five grace turns, then kills with partial output", { timeout: 8000 }, async (t) => {
	const h = harness(t, "budget", { maxTurns: 1 });
	const result = await runSingleAgent(h.options);
	assert.equal(result.completedNormally, false);
	assert.equal(result.stopReason, "turn-budget-exhausted");
	assert.equal(result.usage.turns, 6);
	assert.equal(result.messages.length, 1);
	assert.equal(h.audit().commands.filter((c: { type: string }) => c.type === "steer").length, 1);
	assert.match(result.errorMessage!, /soft grace steered at turn 1, hard limit 6/);
	h.assertClean();
});

test("real child: idempotent cancellation escalates ignored SIGTERM after 3 seconds", { timeout: 8000, skip: process.platform === "win32" ? "Windows terminates SIGTERM immediately" : false }, async (t) => {
	let kill: (() => void) | undefined;
	let cancelledAt = 0;
	const h = harness(t, "ignore-term", {
		registerKill: (fn) => { kill = fn; },
		onProgress: () => { cancelledAt = Date.now(); kill!(); kill!(); },
	});
	const result = await runSingleAgent(h.options);
	assert.equal(result.stopReason, "aborted");
	assert.ok(Date.now() - cancelledAt >= 2900);
	assert.equal(h.audit().termCount, 1);
	h.assertClean();
});
