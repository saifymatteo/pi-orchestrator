/**
 * Unit tests for the fleet widget line builder (renderFleetLines in
 * delegate.ts): grouped header (mode + running count), per-agent lines with
 * turn/context/token stats and truncated task summary, mixed-mode header,
 * name alignment, and the idle fallback line.
 *
 * Runs on Node's built-in test runner with type stripping; the pi package
 * imports are redirected to stubs via ../resolve-stub-hook.mjs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { idleFleetWidgetLines, renderFleetLines } from "../delegate.ts";
import { fleetKey, nextFleetRunId } from "../delegate.ts";

/** Minimal RunningTask-shaped fixture (mode is the only new required field). */
function task(overrides = {}) {
	return {
		id: "task0",
		agent: "scout",
		task: "recon auth flow",
		mode: "single",
		turns: 1,
		contextTokens: 0,
		inputTokens: 0,
		outputTokens: 0,
		...overrides,
	};
}

test("idle fallback: no running tasks shows engaged line with fleet names", () => {
	assert.deepEqual(renderFleetLines([], ["scout", "worker"]), [
		"orchestrator: engaged · fleet: scout, worker",
	]);
});

test("idle fallback: empty fleet shows (empty)", () => {
	assert.deepEqual(renderFleetLines([], []), ["orchestrator: engaged · fleet: (empty)"]);
});

test("idleFleetWidgetLines matches the idle fallback of renderFleetLines", () => {
	assert.deepEqual(idleFleetWidgetLines(["scout"]), ["orchestrator: engaged · fleet: scout"]);
});

test("grouped header with shared mode and running count (even for 1 task)", () => {
	const lines = renderFleetLines([task({ agent: "scout", mode: "single" })], ["scout"]);
	assert.equal(lines.length, 2);
	assert.equal(lines[0], "⏳ Fleet · single · 1 running");
	assert.match(lines[1], /^  scout · turn 1 · ctx 0 · ↑0 ↓0 · "recon auth flow"$/);
});

test("per-agent line keeps token formatting and quoted task summary", () => {
	const lines = renderFleetLines(
		[
			task({
				agent: "worker",
				task: "implement guardrail",
				mode: "parallel",
				turns: 7,
				contextTokens: 45200,
				inputTokens: 3000,
				outputTokens: 12000,
			}),
			task({
				agent: "worker",
				task: "fix config parse",
				mode: "parallel",
				turns: 1,
				contextTokens: 2100,
				inputTokens: 900,
				outputTokens: 120,
			}),
		],
		["worker"],
	);
	assert.equal(lines[0], "⏳ Fleet · parallel · 2 running");
	assert.equal(lines[1], '  worker · turn 7 · ctx 45k · ↑3.0k ↓12k · "implement guardrail"');
	assert.equal(lines[2], '  worker · turn 1 · ctx 2.1k · ↑900 ↓120 · "fix config parse"');
});

test("mixed header when concurrent runs have different modes", () => {
	const lines = renderFleetLines(
		[task({ agent: "scout", mode: "single" }), task({ agent: "worker", mode: "parallel" })],
		["scout", "worker"],
	);
	assert.equal(lines[0], "⏳ Fleet · mixed · 2 running");
});

test("chain mode is shown in the header", () => {
	const lines = renderFleetLines([task({ agent: "planner", mode: "chain" })], ["planner"]);
	assert.equal(lines[0], "⏳ Fleet · chain · 1 running");
});

test("task summary is truncated to 40 chars including the ellipsis", () => {
	const long = "a".repeat(100);
	const lines = renderFleetLines([task({ task: long })], ["scout"]);
	const summary = lines[1].split('· "')[1].replace(/"$/, "");
	assert.equal(summary.length, 40);
	assert.ok(summary.endsWith("…"));
	assert.ok(summary.startsWith("a"));
});

test("task summary at exactly 40 chars is not truncated", () => {
	const exact = "b".repeat(40);
	const lines = renderFleetLines([task({ task: exact })], ["scout"]);
	assert.ok(lines[1].endsWith(`"${exact}"`));
	assert.ok(!lines[1].includes("…"));
});

test("agent names are padded to the longest current name for alignment", () => {
	const lines = renderFleetLines(
		[task({ agent: "scout" }), task({ agent: "longername", turns: 2 })],
		["scout", "longername"],
	);
	assert.ok(lines[1].startsWith("  scout      · turn 1"));
	assert.ok(lines[2].startsWith("  longername · turn 2"));
});

test("agent names longer than 12 chars are truncated, never padded", () => {
	const lines = renderFleetLines([task({ agent: "averylongagentname", turns: 3 })], ["averylongagentname"]);
	assert.ok(lines[1].startsWith("  averylongage · turn 3"));
	assert.equal(lines[1].indexOf("averylongagentname"), -1);
});

// ── renderResult: single-mode running/success/failure icons ────────────────
// Captures the tool definition pi would register, then drives renderResult
// directly with a passthrough theme (fg/bold return the text unchanged).

import { registerDelegateTool } from "../delegate.ts";

const delegateTool: any = (() => {
	let captured: any;
	registerDelegateTool(
		{ registerTool: (t: any) => (captured = t) } as any,
		{
			getAgents: () => [],
			getDispatchDefaults: () => ({}),
			getCwd: () => process.cwd(),
			getSignal: () => undefined,
			onIdle: () => {},
		},
	);
	return captured;
})();

const passthroughTheme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };

function singleResult(overrides: Record<string, unknown> = {}) {
	return {
		agent: "worker",
		agentSource: "builtin",
		task: "do a thing",
		exitCode: 0,
		completedNormally: false,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		...overrides,
	};
}

function renderSingleCollapsed(result: any, options: Record<string, unknown> = {}, context: any = undefined): string {
	const out = delegateTool.renderResult(
		{ content: [], details: { mode: "single", results: [result] } },
		{ expanded: false, ...options },
		passthroughTheme,
		context,
	);
	return out.text;
}

test("renderResult single mid-run (isPartial): warning ⏳ icon, no error ✗, no red [stopReason]", () => {
	const text = renderSingleCollapsed(singleResult({ stopReason: "toolUse" }), { isPartial: true });
	assert.ok(text.includes("⏳"), `expected running icon, got: ${text}`);
	assert.ok(!text.includes("✗"), `unexpected error icon: ${text}`);
	assert.ok(!text.includes("✓"), `unexpected success icon: ${text}`);
	assert.ok(!text.includes("[toolUse]"), `mid-run stopReason must not render as error tag: ${text}`);
	assert.match(text, /\(running\.\.\.\)/);
});

test("renderResult single mid-run via context.isPartial fallback also renders ⏳", () => {
	const text = renderSingleCollapsed(singleResult({ stopReason: "toolUse" }), {}, { isPartial: true });
	assert.ok(text.includes("⏳"), `expected running icon, got: ${text}`);
	assert.ok(!text.includes("✗"), `unexpected error icon: ${text}`);
});

test("renderResult single success (settled): green ✓", () => {
	const text = renderSingleCollapsed(singleResult({ completedNormally: true, messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }] }));
	assert.ok(text.includes("✓"), `expected success icon, got: ${text}`);
	assert.ok(!text.includes("✗") && !text.includes("⏳"), `unexpected icons: ${text}`);
});

test("renderResult single genuine failure (error stopReason, not partial): red ✗ with [stopReason] tag", () => {
	const text = renderSingleCollapsed(
		singleResult({ completedNormally: false, stopReason: "error", errorMessage: "boom" }),
	);
	assert.ok(text.includes("✗"), `expected error icon, got: ${text}`);
	assert.ok(text.includes("[error]"), `expected stopReason tag: ${text}`);
	assert.ok(text.includes("Error: boom"), `expected error message: ${text}`);
	assert.ok(!text.includes("⏳") && !text.includes("✓"), `unexpected icons: ${text}`);
});

// ── Unique fleet keys (concurrent delegate invocations) ────────────────────

test("nextFleetRunId successive calls differ", () => {
	const a = nextFleetRunId();
	const b = nextFleetRunId();
	assert.notEqual(a, b);
	assert.ok(b > a);
});

test("fleetKey is distinct for two simulated concurrent invocations of every mode", () => {
	// Two delegate calls at the same "time": same mode/index, different run ids.
	for (const [modeA, modeB] of [
		["single", "single"],
		["parallel", "parallel"],
		["chain", "chain"],
	] as const) {
		const runA = nextFleetRunId();
		const runB = nextFleetRunId();
		assert.notEqual(fleetKey(runA, modeA, 0), fleetKey(runB, modeB, 0), `mode ${modeA} collides`);
	}
});

test("renderFleetLines with two single-mode tasks shows 2 running", () => {
	const lines = renderFleetLines([task({ agent: "scout" }), task({ agent: "worker", turns: 2 })], ["scout", "worker"]);
	assert.equal(lines[0], "⏳ Fleet · single · 2 running");
});

