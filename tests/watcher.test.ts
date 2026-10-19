/**
 * Unit tests for the run watcher (ADR-0014): the session-level owner of
 * async delegate runs. The watcher registers runs before the child spawns,
 * delivers settled results through an injected dep, supports per-run cancel
 * and abort-all, and fires onIdle only when the last run settles.
 *
 * The widget is a projection of this same owner. Every test drains its own
 * runs; no process/widget registry is shared between tests. Submission is
 * distinct from observed transcript insertion.
 *
 * Runs on Node's built-in test runner with type stripping; the pi package
 * imports are redirected to stubs via ../resolve-stub-hook.mjs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { createRunWatcher, type RunDelivery, type RunWatcherDeps } from "../src/run-lifecycle.ts";
import type { SingleResult } from "../src/delegate.ts";

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
function makeWatcher(overrides: Partial<RunWatcherDeps> = {}) {
	const deliveries: RunDelivery[] = [];
	let idleCalls = 0;
	let clock = 1_000;
	const watcher = createRunWatcher({
		deliver: (d) => { deliveries.push(d); },
		onIdle: () => { idleCalls++; },
		now: () => clock,
		...overrides,
	});

	interface ManualRun {
		accepted: { runId: number; agent: string; task: string; mode: "single" | "parallel" | "chain" };
		runId: number;
		killCalls(): number[];
		registerLater(): void;
		settle(result?: Partial<SingleResult>): void;
		reject(error: Error): void;
		started(): boolean;
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
		let rejectRun: ((error: Error) => void) | undefined;
		let lateRegisterKill: (() => void) | undefined;
		const accepted = watcher.start({
			runId,
			agent,
			task,
			mode,
			widgetKey: `${mode}:${runId}`,
			start: (opts) =>
				new Promise<SingleResult>((resolve, reject) => {
					settleRun = (result) => resolve(result);
					rejectRun = reject;
					lateRegisterKill = () => opts.registerKill(() => killCalls.push(1));
					if (!overrides.deferKill) opts.registerKill(() => killCalls.push(1)); // default: register immediately
				}),
		});
		const run: ManualRun = {
			accepted,
			runId,
			killCalls: () => killCalls,
			registerLater: () => lateRegisterKill!(),
			settle: (result: Partial<SingleResult> = {}) => settleRun?.(makeResult({ agent, ...result })),
			reject: (error) => rejectRun!(error),
			started: () => settleRun !== undefined,
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
			watcher.confirmDeliveries(new Set(deliveries.map((d) => d.deliveryId)));
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
	const snapshot = h.watcher.snapshot();
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
	assert.equal(h.watcher.snapshot().length, 2);
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

test("settle: retains the outcome/widget until transcript insertion is confirmed", async () => {
	const h = makeWatcher();
	const run = h.startManual();
	run.settle();
	await flush();
	assert.equal(h.watcher.entries()[0].state, "delivery-pending");
	assert.equal(h.watcher.snapshot()[0].state, "delivery-pending");
	h.watcher.confirmDeliveries(new Set([h.deliveries[0].deliveryId]));
	assert.equal(h.watcher.entries().length, 0);
	assert.equal(h.watcher.snapshot().length, 0);
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

// ── Root lifecycle regressions ─────────────────────────────────────────────

test("unexpected runner rejection after Accepted delivers a correlated failed Result", async () => {
	const h = makeWatcher();
	const run = h.startManual();
	run.reject(new Error("temporary prompt write failed"));
	await flush();
	assert.equal(h.deliveries.length, 1);
	assert.equal(h.deliveries[0].runId, run.accepted.runId);
	assert.equal(h.deliveries[0].result.completedNormally, false);
	assert.match(h.deliveries[0].result.errorMessage!, /prompt write failed/);
	assert.equal(h.watcher.entries()[0].state, "delivery-pending");
	await h.finishAll();
});

test("synchronous start throw settles through the same failed outcome path", async () => {
	const h = makeWatcher();
	const handle = h.watcher.start({ runId: 1, agent: "scout", task: "boot", mode: "single", widgetKey: "one", start: () => { throw new Error("sync boot failure"); } });
	const result = await handle.result;
	assert.match(result.errorMessage!, /sync boot failure/);
	assert.equal(h.deliveries.length, 1);
	assert.equal(h.watcher.entries()[0].state, "delivery-pending", "not a ghost running record");
});

test("one shared FIFO pool bounds starts and releases slots only when runner cleanup settles", async () => {
	const h = makeWatcher({ limits: () => ({ maxConcurrency: 1, maxQueuedRuns: 2 }) });
	const a = h.startManual({ runId: 1 });
	const b = h.startManual({ runId: 2, mode: "parallel" });
	const c = h.startManual({ runId: 3 });
	assert.deepEqual(h.watcher.entries().map((r) => r.state), ["running", "queued", "queued"]);
	h.watcher.cancel(a.runId);
	assert.equal(b.started(), false, "kill request is not process cleanup");
	a.settle();
	await flush();
	assert.equal(b.started(), true);
	assert.equal(c.started(), false);
	b.settle();
	await flush();
	assert.equal(c.started(), true);
	await h.finishAll();
});

test("parallel admission is atomic when the entire batch does not fit", async () => {
	const h = makeWatcher({ limits: () => ({ maxConcurrency: 1, maxQueuedRuns: 1 }) });
	let starts = 0;
	const inputs = [1, 2, 3].map((runId) => ({ runId, agent: "scout", task: "batch", mode: "parallel" as const, widgetKey: String(runId), start: async () => { starts++; return makeResult(); } }));
	assert.throws(() => h.watcher.startMany(inputs), /capacity exceeded/i);
	assert.equal(starts, 0);
	assert.equal(h.watcher.entries().length, 0);
});

test("a fitting batch is fully registered before any runner starts", async () => {
	const h = makeWatcher();
	const counts: number[] = [];
	const handles = h.watcher.startMany([1, 2].map((runId) => ({ runId, agent: "scout", task: "batch", mode: "parallel" as const, widgetKey: String(runId), start: async () => { counts.push(h.watcher.entries().length); return makeResult(); } })));
	await Promise.all(handles.map((r) => r.result));
	assert.deepEqual(counts, [2, 2]);
	assert.equal(h.deliveries.length, 2);
});

test("queued cancellation settles without ever launching that Worker", async () => {
	const h = makeWatcher({ limits: () => ({ maxConcurrency: 1, maxQueuedRuns: 1 }) });
	const a = h.startManual({ runId: 1 });
	const b = h.startManual({ runId: 2 });
	assert.equal(h.watcher.cancel(b.runId).ok, true);
	assert.equal(b.started(), false);
	assert.equal(h.deliveries.length, 1);
	assert.equal(h.deliveries[0].runId, 2);
	assert.equal(h.deliveries[0].cancelled, true);
	a.settle();
	await flush();
	assert.equal(b.started(), false);
	await h.finishAll();
});

test("abortAll clears queued work and retained outcomes without later delivery", async () => {
	const h = makeWatcher({ limits: () => ({ maxConcurrency: 1, maxQueuedRuns: 2 }) });
	const a = h.startManual({ runId: 1 });
	const b = h.startManual({ runId: 2 });
	h.watcher.abortAll();
	a.settle();
	await flush();
	assert.equal(b.started(), false);
	assert.equal(h.deliveries.length, 0);
	assert.equal(h.watcher.entries().length, 0);
	await h.finishAll();
});

test("submission failure is retained; explicit retry reuses identity and never reruns execution", async () => {
	let calls = 0;
	const attempts: RunDelivery[] = [];
	const h = makeWatcher({ deliver: (delivery) => { attempts.push(delivery); if (++calls === 1) throw new Error("sender unavailable"); } });
	const run = h.startManual();
	run.settle();
	await flush();
	assert.equal(h.watcher.entries()[0].state, "delivery-failed");
	assert.match(h.watcher.entries()[0].deliveryError!, /unavailable/);
	await flush();
	assert.equal(calls, 1, "no automatic retry loop");
	assert.equal(h.watcher.retryDelivery(run.runId).ok, true);
	assert.equal(calls, 2);
	assert.equal(attempts[0].deliveryId, attempts[1].deliveryId);
	assert.equal(attempts[0].result, attempts[1].result);
	assert.equal(h.watcher.entries()[0].state, "delivery-pending");
	h.watcher.confirmDeliveries(new Set([attempts[0].deliveryId]));
	assert.equal(h.watcher.entries().length, 0);
	assert.equal(h.watcher.retryDelivery(run.runId).ok, false);
});

test("a resolved sender is not an insertion receipt; unrelated receipts cannot clear it", async () => {
	const h = makeWatcher({ deliver: async () => {} });
	const run = h.startManual();
	run.settle();
	await flush();
	h.watcher.confirmDeliveries(new Set(["unrelated"]));
	assert.equal(h.watcher.entries()[0].state, "delivery-pending");
	h.watcher.abortAll();
	assert.equal(h.watcher.entries().length, 0);
});

test("observable async sender rejection is retained without an unhandled rejection or retry", async () => {
	let calls = 0;
	const h = makeWatcher({ deliver: async () => { calls++; throw new Error("sender rejected"); } });
	const run = h.startManual();
	run.settle();
	await flush();
	assert.equal(calls, 1);
	assert.equal(h.watcher.entries()[0].state, "delivery-failed");
	assert.match(h.watcher.entries()[0].deliveryError!, /rejected/);
});

test("throwing UI/idle callbacks cannot prevent failed Result submission", async () => {
	const h = makeWatcher({ onIdle: () => { throw new Error("idle UI failed"); }, onChange: () => { throw new Error("widget failed"); } });
	const run = h.startManual();
	run.reject(new Error("boot failed"));
	await flush();
	assert.equal(h.deliveries.length, 1);
	assert.match(h.deliveries[0].result.errorMessage!, /boot failed/);
});

test("repeated cancel issues its late kill handle at most once", async () => {
	const h = makeWatcher();
	const run = h.startManual({ deferKill: true });
	h.watcher.cancel(run.runId);
	h.watcher.cancel(run.runId);
	run.registerLater();
	h.watcher.cancel(run.runId);
	assert.equal(run.killCalls().length, 1);
	await h.finishAll();
});

test("lowering limits never kills or evicts accepted work", async () => {
	let cap = 2;
	let queued = 2;
	const h = makeWatcher({ limits: () => ({ maxConcurrency: cap, maxQueuedRuns: queued }) });
	const a = h.startManual({ runId: 1 });
	const b = h.startManual({ runId: 2 });
	const c = h.startManual({ runId: 3 });
	cap = 1;
	queued = 0;
	assert.throws(() => h.startManual({ runId: 4 }), /capacity exceeded/i);
	assert.equal(a.killCalls().length + b.killCalls().length, 0);
	a.settle();
	await flush();
	assert.equal(c.started(), false);
	b.settle();
	await flush();
	assert.equal(c.started(), true, "previously accepted queue entry survives zero queue limit");
	await h.finishAll();
});

test("blocking and chain runs use the same owner but never push duplicate Results", async () => {
	const h = makeWatcher();
	const handle = h.watcher.start({ runId: 1, agent: "worker", task: "chain step", mode: "chain", widgetKey: "chain", pushResult: false, start: async () => makeResult() });
	assert.equal((await handle.result).completedNormally, true);
	assert.equal(h.deliveries.length, 0);
	assert.equal(h.watcher.entries().length, 0);
});

test("a failed older delivery attempt cannot overwrite a newer pending attempt", async () => {
	let rejectOld!: (error: Error) => void;
	let attempts = 0;
	const h = makeWatcher({ deliver: () => {
		if (++attempts === 1) return new Promise<void>((_resolve, reject) => { rejectOld = reject; });
	} });
	const run = h.startManual();
	run.settle(); await flush();
	h.watcher.retryDelivery(run.runId);
	rejectOld(new Error("old send failed"));
	await flush();
	assert.equal(attempts, 2);
	assert.equal(h.watcher.entries()[0].state, "delivery-pending");
});
