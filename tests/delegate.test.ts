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
import { collectTouchedFiles, fleetKey, formatTouchedFiles, isToolTurn, nextFleetRunId } from "../delegate.ts";
import { buildChildSpawnArgs, expandBlockedToolsToNames, stableSessionId } from "../delegate.ts";

/** Minimal RunningTask-shaped fixture (mode is the only other required field).
 *  toolTurns defaults to turns (1); tests that need a mismatch override it. */
function task(overrides = {}) {
	return {
		id: "task0",
		agent: "scout",
		task: "recon auth flow",
		mode: "single",
		turns: 1,
		toolTurns: 1,
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
				toolTurns: 7,
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
		[task({ agent: "scout" }), task({ agent: "longername", turns: 2, toolTurns: 2 })],
		["scout", "longername"],
	);
	assert.ok(lines[1].startsWith("  scout      · turn 1"));
	assert.ok(lines[2].startsWith("  longername · turn 2"));
});

test("agent names longer than 12 chars are truncated, never padded", () => {
	const lines = renderFleetLines([task({ agent: "averylongagentname", turns: 3, toolTurns: 3 })], ["averylongagentname"]);
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
	const lines = renderFleetLines(
		[task({ agent: "scout" }), task({ agent: "worker", turns: 2, toolTurns: 2 })],
		["scout", "worker"],
	);
	assert.equal(lines[0], "⏳ Fleet · single · 2 running");
});

// ── Fleet widget shows tool-bearing turns (matches TUI tool-call view) ─────

test("renderFleetLines displays toolTurns, not the raw turn count", () => {
	// 7 raw turns, 6 tool-bearing (final text-only wrap-up excluded) — the
	// widget must read turn 6 to match the TUI's tool-call count.
	const lines = renderFleetLines([task({ turns: 7, toolTurns: 6 })], ["scout"]);
	assert.match(lines[1], /· turn 6 ·/);
	assert.ok(!lines[1].includes("turn 7"));
});

// ── isToolTurn (turn_end counting helper) ───────────────────────────────

test("isToolTurn: assistant message with toolCall parts → true", () => {
	const msg = assistantMsg([toolCall("read", { file_path: "/a.ts" })]);
	assert.equal(isToolTurn(msg as any), true);
});

test("isToolTurn: text-only assistant message → false", () => {
	const msg = assistantMsg([{ type: "text", text: "all done" }]);
	assert.equal(isToolTurn(msg as any), false);
});

test("isToolTurn: empty/missing message → false", () => {
	assert.equal(isToolTurn(assistantMsg([]) as any), false);
	assert.equal(isToolTurn(undefined), false);
});

test("isToolTurn: non-empty toolResults → true even without toolCall parts", () => {
	const msg = assistantMsg([{ type: "text", text: "hmm" }]);
	assert.equal(isToolTurn(msg as any, [{ toolCallId: "t1" }]), true);
});

// ── Touched-files extraction (collectTouchedFiles / formatTouchedFiles) ────

function assistantMsg(content: any[]) {
	return { role: "assistant", content };
}

function toolCall(name: string, args: Record<string, unknown>) {
	return { type: "toolCall", name, arguments: args };
}

test("collectTouchedFiles: write + edit paths collected, read/bash ignored", () => {
	const messages = [
		assistantMsg([
			toolCall("read", { file_path: "/src/ignored.ts" }),
			toolCall("bash", { command: "touch /src/ignored2.ts" }),
		]),
		assistantMsg([toolCall("write", { file_path: "/src/a.ts", content: "x" })]),
		assistantMsg([toolCall("edit", { path: "/src/b.ts", oldText: "a", newText: "b" })]),
	];
	assert.deepEqual(collectTouchedFiles(messages as any), ["/src/a.ts", "/src/b.ts"]);
});

test("collectTouchedFiles: falls back from file_path to path", () => {
	const messages = [
		assistantMsg([toolCall("write", { path: "/via/path.ts" })]),
		assistantMsg([toolCall("edit", { file_path: "/via/file_path.ts" })]),
	];
	assert.deepEqual(collectTouchedFiles(messages as any), ["/via/path.ts", "/via/file_path.ts"]);
});

test("collectTouchedFiles: dedupes preserving first-seen order", () => {
	const messages = [
		assistantMsg([toolCall("write", { file_path: "/b.ts" }), toolCall("edit", { file_path: "/a.ts" })]),
		assistantMsg([toolCall("edit", { path: "/b.ts" })]),
	];
	assert.deepEqual(collectTouchedFiles(messages as any), ["/b.ts", "/a.ts"]);
});

test("collectTouchedFiles: skips non-string and empty paths, empty messages → []", () => {
	const messages = [
		assistantMsg([toolCall("write", { file_path: 42 }), toolCall("edit", { file_path: "" })]),
		assistantMsg([{ type: "text", text: "no tool calls here" }]),
	];
	assert.deepEqual(collectTouchedFiles(messages as any), []);
	assert.deepEqual(collectTouchedFiles([]), []);
});

test("formatTouchedFiles: caps at 10 with a … and N more suffix", () => {
	const files = Array.from({ length: 12 }, (_, i) => `/f${i}.ts`);
	const text = formatTouchedFiles(files);
	assert.ok(text.startsWith(`Files touched: ${files.slice(0, 10).join(", ")}`));
	assert.ok(text.endsWith(", … and 2 more"));
});

test("formatTouchedFiles: empty input returns empty string", () => {
	assert.equal(formatTouchedFiles([]), "");
});

// ── Child spawn args (ADR-0008) ─────────────────────────────────────────────

test("buildChildSpawnArgs: base RPC args are always present, in order", () => {
	assert.deepEqual(buildChildSpawnArgs({ extensions: [], excludeTools: [] }), [
		"--mode",
		"rpc",
		"--no-session",
	]);
});

test("buildChildSpawnArgs: model, thinking, and per-agent tools join the front", () => {
	assert.deepEqual(
		buildChildSpawnArgs({
			model: "openrouter/cheap",
			thinkingLevel: "high",
			tools: ["read", "grep"],
			extensions: [],
			excludeTools: [],
		}),
		["--mode", "rpc", "--no-session", "--model", "openrouter/cheap", "--thinking", "high", "--tools", "read,grep"],
	);
});

test("buildChildSpawnArgs: no model/thinking/tools omits their flags entirely", () => {
	const args = buildChildSpawnArgs({ extensions: [], excludeTools: [] });
	assert.ok(!args.includes("--model"));
	assert.ok(!args.includes("--thinking"));
	assert.ok(!args.includes("--tools"));
});

test("buildChildSpawnArgs: empty extensions ⇒ no extension flags (children inherit-all)", () => {
	const args = buildChildSpawnArgs({ extensions: [], excludeTools: [] });
	assert.ok(!args.includes("--no-extensions"));
	assert.ok(!args.includes("-e"));
});

test("buildChildSpawnArgs: non-empty extensions ⇒ --no-extensions plus one -e pair per entry", () => {
	const args = buildChildSpawnArgs({
		extensions: ["./my-ext.ts", "npm:@foo/bar"],
		excludeTools: [],
	});
	assert.deepEqual(args.slice(args.indexOf("--no-extensions")), [
		"--no-extensions",
		"-e",
		"./my-ext.ts",
		"-e",
		"npm:@foo/bar",
	]);
});

test("buildChildSpawnArgs: excludeTools becomes one comma-joined --exclude-tools flag (pi docs: comma-separated denylist)", () => {
	const args = buildChildSpawnArgs({ extensions: [], excludeTools: ["advisor", "history_cleanup"] });
	assert.deepEqual(args.slice(-2), ["--exclude-tools", "advisor,history_cleanup"]);
	assert.equal(args.filter((a) => a === "--exclude-tools").length, 1, "flag must not repeat");

	// Empty list → flag omitted entirely (the interception gate handles it).
	assert.ok(!buildChildSpawnArgs({ extensions: [], excludeTools: [] }).includes("--exclude-tools"));
});

// ── stable --session-id per (agent, model) ─────────────────────────────

/** pi's assertValidSessionId contract (verified in the pi binary):
 *  non-empty, only [A-Za-z0-9._-], starts and ends alphanumeric. */
const SESSION_ID_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

test("buildChildSpawnArgs: sessionId is emitted as the trailing --session-id pair", () => {
	const args = buildChildSpawnArgs({ extensions: [], excludeTools: [], sessionId: "abc123" });
	assert.deepEqual(args.slice(-2), ["--session-id", "abc123"]);
	assert.equal(args.indexOf("--session-id"), args.length - 2, "pair must be last (after --exclude-tools)");
});

test("buildChildSpawnArgs: sessionId omitted ⇒ no --session-id flag", () => {
	assert.ok(!buildChildSpawnArgs({ extensions: [], excludeTools: [] }).includes("--session-id"));
});

test("stableSessionId: deterministic across calls (same inputs → same output)", () => {
	assert.equal(stableSessionId("scout", "openrouter/cheap"), stableSessionId("scout", "openrouter/cheap"));
	assert.equal(stableSessionId("worker", undefined), stableSessionId("worker", undefined));
});

test("stableSessionId: differs per agent name and per model", () => {
	assert.notEqual(stableSessionId("scout", "openrouter/cheap"), stableSessionId("worker", "openrouter/cheap"));
	assert.notEqual(stableSessionId("scout", "openrouter/cheap"), stableSessionId("scout", "openrouter/premium"));
});

test("stableSessionId: output matches pi's assertValidSessionId format", () => {
	for (const id of [
		stableSessionId("scout", "openrouter/cheap"),
		stableSessionId("a-very_long.agent-name", undefined),
	]) {
		assert.match(id, SESSION_ID_RE);
		assert.equal(id.length, 32, "first 16 bytes of sha1 hex = 32 chars");
	}
});

// ── expandBlockedToolsToNames (ADR-0008) ──────────────────────────────────

const tool = (name: string, sourceInfo?: unknown) => ({ name, sourceInfo });
const nm = (pkg: string, rest: string) => ({ path: `C:/repo/node_modules/${pkg}/${rest}` });

test("expandBlockedToolsToNames: exact match (case-insensitive) resolves to the tool name", () => {
	const tools = [tool("advisor", nm("@l/advisor", "i.js")), tool("todo", undefined)];
	assert.deepEqual(expandBlockedToolsToNames(["advisor"], tools), ["advisor"]);
	assert.deepEqual(expandBlockedToolsToNames(["ADVISOR"], tools), ["advisor"]);
});

test("expandBlockedToolsToNames: glob matcher expands to every matching tool name", () => {
	const tools = [
		tool("hindsight_recall", nm("@luxusai/pi-hindsight", "i.js")),
		tool("hindsight_retain", nm("@luxusai/pi-hindsight", "i.js")),
		tool("todo", undefined),
	];
	assert.deepEqual(expandBlockedToolsToNames(["hindsight_*"], tools), ["hindsight_recall", "hindsight_retain"]);
});

test("expandBlockedToolsToNames: ext:<id> matcher resolves via sourceInfo", () => {
	const tools = [
		tool("hindsight_recall", nm("@luxusai/pi-hindsight", "i.js")),
		tool("other_tool", nm("plain-pkg", "i.js")),
	];
	assert.deepEqual(expandBlockedToolsToNames(["ext:@luxusai/pi-hindsight"], tools), ["hindsight_recall"]);
});

test("expandBlockedToolsToNames: dedupes names across overlapping matchers, first-seen order", () => {
	const tools = [
		tool("hindsight_recall", nm("@luxusai/pi-hindsight", "i.js")),
		tool("hindsight_retain", nm("@luxusai/pi-hindsight", "i.js")),
	];
	// recall matches both the glob and the ext: matcher — collected once.
	assert.deepEqual(expandBlockedToolsToNames(["hindsight_*", "ext:@luxusai/pi-hindsight"], tools), [
		"hindsight_recall",
		"hindsight_retain",
	]);
});

test("expandBlockedToolsToNames: duplicate tool entries do not duplicate names", () => {
	const tools = [tool("advisor", nm("x", "i.js")), tool("advisor", nm("x", "i.js"))];
	assert.deepEqual(expandBlockedToolsToNames(["advisor"], tools), ["advisor"]);
});

test("expandBlockedToolsToNames: matchers that expand to nothing are skipped silently", () => {
	const tools = [tool("todo", undefined)];
	assert.deepEqual(expandBlockedToolsToNames(["nope", "missing_*", "ext:@gone/pkg"], tools), []);
});

test("expandBlockedToolsToNames: empty matchers ⇒ []", () => {
	const tools = [tool("advisor", nm("x", "i.js")), tool("todo", undefined)];
	assert.deepEqual(expandBlockedToolsToNames([], tools), []);
});
