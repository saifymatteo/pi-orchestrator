/**
 * Unit tests for the run watcher (ADR-0014): the session-level owner of
 * async delegate runs. The watcher registers runs before the child spawns,
 * delivers settled results through an injected dep, supports per-run cancel
 * and abort-all, and fires onIdle only when the last run settles.
 *
 * runningTasks is module-global (it feeds the fleet widget), so every test
 * finishes with finishAll() to drain its runs. Delivery happens on a
 * microtask after settle, so assertions follow `await flush()`.
 *
 * Runs on Node's built-in test runner with type stripping; the pi package
 * imports are redirected to stubs via ../resolve-stub-hook.mjs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { createRunWatcher, fleetKey, fleetTasksSnapshot, type RunDelivery, type SingleResult } from "../src/delegate.ts";

function makeResult(overrides: Partial<SingleResult> = {}): SingleResult {
	return {
		agent: "scout",
		agentSource: "builtin",
		task: "recon auth flow",
		exitCode: 0,
		completedNormally: true,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0, toolTurns: 0 },
		...overrides,
	};
}

/** One microtask-queue drain (delivery fires in the watcher's .then). */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Harness: watcher with recorded deliveries, a controllable clock, and
 *  manually-settled runners whose kill handles the test controls. */
function makeWatcher() {
	const deliveries: RunDelivery[] = [];
	let idleCalls = 0;
	let clock = 1_000;
	const watcher = createRunWatcher({
		deliver: (d) => deliveries.push(d),
		onIdle: () => idleCalls++,
		now: () => clock,
	});

	interface ManualRun {
		accepted: { runId: number; agent: string; task: string; mode: "single" | "parallel" };
		runId: number;
		killCalls(): number[];
		registerLater(): void;
		settle(result?: Partial<SingleResult>): void;
	}

	const runs: ManualRun[] = [];
	function startManual(
		overrides: { agent?: string; task?: string; mode?: "single" | "parallel"; runId?: number; deferKill?: boolean } = {},
	): ManualRun {
		const agent = overrides.agent ?? "scout";
		const task = overrides.task ?? "recon auth flow";
		const mode = overrides.mode ?? "single";
		const runId = overrides.runId ?? 100 + runs.length;
		const killCalls: number[] = [];
		let settleRun: ((result: SingleResult) => void) | undefined;
		let lateRegisterKill: (() => void) | undefined;
		const accepted = watcher.start({
			runId,
			agent,
			task,
			mode,
			widgetKey: fleetKey(runId, mode),
			start: (opts) =>
				new Promise<SingleResult>((resolve) => {
					settleRun = (result) => resolve(result);
					lateRegisterKill = () => opts.registerKill(() => killCalls.push(1));
					if (!overrides.deferKill) opts.registerKill(() => killCalls.push(1)); // default: register immediately
				}),
		});
		const run: ManualRun = {
			accepted,
			runId,
			killCalls: () => killCalls,
			registerLater: () => lateRegisterKill!(),
			settle: (result: Partial<SingleResult> = {}) => settleRun!(makeResult({ agent, ...result })),
		};
		runs.push(run);
		return run;
	}

	return {
		watcher,
		deliveries,
		idleCalls: () => idleCalls,
		tick(ms: number) {
			clock += ms;
		},
		startManual,
		/** Drain every started run (double settle is a no-op on a resolved promise). */
		async finishAll() {
			for (const run of runs) run.settle();
			await flush();
		},
	};
}

// ── Registration (before the child even spawns) ─────────────────────────────

test("watcher.start: run is registered immediately — status lists it, widget placeholder exists", async () => {
	const h = makeWatcher();
	const { accepted } = h.startManual();
	assert.equal(accepted.runId, 100);
	assert.equal(accepted.agent, "scout");

	const entries = h.watcher.entries();
	assert.equal(entries.length, 1);
	assert.equal(entries[0].runId, 100);
	assert.equal(entries[0].mode, "single");

	// Widget placeholder: the run shows in the fleet before the child's first event.
	const snapshot = fleetTasksSnapshot();
	assert.equal(snapshot.length, 1);
	assert.equal(snapshot[0].agent, "scout");
	assert.equal(snapshot[0].turns, 0);
	await h.finishAll();
});

test("watcher: elapsedMs comes from the injected clock", async () => {
	const h = makeWatcher();
	h.startManual();
	h.tick(90_000);
	assert.equal(h.watcher.entries()[0].elapsedMs, 90_000);
	await h.finishAll();
});

test("watcher: concurrent runs each get their own entry and widget line", async () => {
	const h = makeWatcher();
	h.startManual({ runId: 1, agent: "scout" });
	h.startManual({ runId: 2, agent: "worker", mode: "parallel" });
	assert.equal(h.watcher.entries().length, 2);
	assert.equal(fleetTasksSnapshot().length, 2);
	await h.finishAll();
});

// ── Settle → delivery ───────────────────────────────────────────────────────

test("settle: delivers the result once, with run id and cancelled=false", async () => {
	const h = makeWatcher();
	const run = h.startManual();
	assert.equal(h.deliveries.length, 0);
	run.settle();
	await flush();

	assert.equal(h.deliveries.length, 1);
	assert.equal(h.deliveries[0].runId, run.runId);
	assert.equal(h.deliveries[0].cancelled, false);
	assert.equal(h.deliveries[0].result.completedNormally, true);
	assert.equal(h.deliveries[0].mode, "single");
	await h.finishAll();
});

test("settle: removes the entry and the widget placeholder", async () => {
	const h = makeWatcher();
	const run = h.startManual();
	run.settle();
	await flush();
	assert.equal(h.watcher.entries().length, 0);
	assert.equal(fleetTasksSnapshot().length, 0);
	await h.finishAll();
});

test("settle of the LAST run fires onIdle exactly once; earlier settles do not", async () => {
	const h = makeWatcher();
	const a = h.startManual({ runId: 1, agent: "scout" });
	const b = h.startManual({ runId: 2, agent: "worker" });
	a.settle();
	await flush();
	assert.equal(h.idleCalls(), 0, "fleet still has one live run");
	b.settle();
	await flush();
	assert.equal(h.idleCalls(), 1);
	await h.finishAll();
});

test("failed result still delivers (never leaves the orchestrator waiting)", async () => {
	const h = makeWatcher();
	const run = h.startManual();
	run.settle({ completedNormally: false, stopReason: "turn-budget-exhausted", errorMessage: "killed" });
	await flush();
	assert.equal(h.deliveries.length, 1);
	assert.equal(h.deliveries[0].result.stopReason, "turn-budget-exhausted");
	await h.finishAll();
});

// ── Cancel ──────────────────────────────────────────────────────────────────

test("cancel: unknown id returns an informative error, kills nothing", async () => {
	const h = makeWatcher();
	const out = h.watcher.cancel(999);
	assert.equal(out.ok, false);
	if (!out.ok) assert.match(out.error, /no live run/i);
	await h.finishAll();
});

test("cancel: live run is killed and its settle delivers with cancelled=true", async () => {
	const h = makeWatcher();
	const run = h.startManual();
	const out = h.watcher.cancel(run.runId);
	assert.equal(out.ok, true);
	assert.equal(run.killCalls().length, 1, "cancel must issue the kill");

	run.settle({ completedNormally: false });
	await flush();
	assert.equal(h.deliveries.length, 1);
	assert.equal(h.deliveries[0].cancelled, true);
	assert.equal(h.deliveries[0].runId, run.runId);
	await h.finishAll();
});

test("cancel: kill handle registered AFTER cancel still fires (pre-spawn race)", async () => {
	const h = makeWatcher();
	const run = h.startManual({ deferKill: true });
	h.watcher.cancel(run.runId);
	run.registerLater();
	assert.equal(run.killCalls().length, 1, "handle registered after cancel must fire immediately");
	run.settle({ completedNormally: false });
	await flush();
	assert.equal(h.deliveries.length, 1);
	assert.equal(h.deliveries[0].cancelled, true);
	await h.finishAll();
});

// ── AbortAll (ESC: full stop, no deliveries) ────────────────────────────────

test("abortAll: kills every live run and settles deliver NOTHING (user aborted)", async () => {
	const h = makeWatcher();
	const a = h.startManual({ runId: 1, agent: "scout" });
	const b = h.startManual({ runId: 2, agent: "worker" });
	h.watcher.abortAll();
	assert.equal(a.killCalls().length, 1);
	assert.equal(b.killCalls().length, 1);
	a.settle();
	b.settle();
	await flush();
	assert.equal(h.deliveries.length, 0, "aborted runs must not push results into an aborted conversation");
	assert.equal(h.watcher.entries().length, 0);
	assert.equal(h.idleCalls(), 1, "idle fires once the aborted fleet is fully down");
	await h.finishAll();
});

test("abortAll with no live runs is a no-op", async () => {
	const h = makeWatcher();
	h.watcher.abortAll();
	await flush();
	assert.equal(h.idleCalls(), 0);
	await h.finishAll();
});
