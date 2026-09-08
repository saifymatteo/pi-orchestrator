/**
 * Unit tests for createRpcWaiters (delegate.ts) — the id-matched RPC response
 * waiters used by sub-session setup (ADR-0011).
 *
 * The regression these exist for: the helper that sent `get_state` /
 * `new_session` used to be declared inside the run's exit-promise executor and
 * called THAT executor's `resolve` instead of its own. The first response ended
 * the whole run (exitCode = the response object, result "(no output)", child
 * orphaned). Extraction made the capture structurally impossible — the factory
 * receives exactly one callable (`send`) and no resolver — and the sentinel
 * test below pins that contract from the outside.
 *
 * Runs on Node's built-in test runner with type stripping; pi package imports
 * are redirected to stubs via ../resolve-stub-hook.mjs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { createRpcWaiters } from "../delegate.ts";

const response = (id: string, extra: Record<string, unknown> = {}) => ({
	type: "response",
	id,
	success: true,
	...extra,
});

test("command sends the command with its id attached (rpc.md: one JSON object per line)", () => {
	const sent: Record<string, unknown>[] = [];
	const waiters = createRpcWaiters((obj) => sent.push(obj), 1000);
	waiters.command({ type: "new_session", parentSession: "parent.jsonl" }, "sess-link");
	assert.deepEqual(sent, [{ id: "sess-link", type: "new_session", parentSession: "parent.jsonl" }]);
});

test("command resolves with the response that carries the same id", async () => {
	const waiters = createRpcWaiters(() => {}, 1000);
	const pending = waiters.command({ type: "get_state" }, "sess-before");
	assert.equal(waiters.pending(), 1);
	const matched = waiters.deliver(response("sess-before", { data: { sessionFile: "s.jsonl" } }));
	assert.equal(matched, true);
	assert.equal(waiters.pending(), 0);
	const resp = await pending;
	assert.equal(resp?.success, true);
	assert.equal(resp?.data?.sessionFile, "s.jsonl");
});

test("deliver ignores responses nobody awaited (unknown id, missing id, nullish event)", () => {
	const waiters = createRpcWaiters(() => {}, 1000);
	assert.equal(waiters.deliver(response("nobody-home")), false);
	assert.equal(waiters.deliver({ type: "response" }), false);
	assert.equal(waiters.deliver(undefined), false);
	assert.equal(waiters.deliver(null), false);
});

test("a response for one id leaves other waiters pending", async () => {
	const waiters = createRpcWaiters(() => {}, 1000);
	const a = waiters.command({ type: "get_state" }, "sess-before");
	const b = waiters.command({ type: "new_session" }, "sess-link");

	assert.equal(waiters.deliver(response("sess-before")), true);
	assert.equal((await a)?.id, "sess-before", "the answered waiter gets its own response");
	assert.equal(waiters.pending(), 1, "sess-link must still be waiting");

	waiters.flush();
	assert.equal(await b, null);
});

test("regression (ADR-0011): settling a waiter never settles the run's exit promise", async () => {
	const sent: Record<string, unknown>[] = [];
	let exitSettled = false;
	let waiters: ReturnType<typeof createRpcWaiters> | undefined;

	// Same nesting shape that used to break: the run's exit resolver is in
	// lexical scope while the RPC helpers are created and used. It must stay
	// untouched until the child actually exits.
	const exitPromise = new Promise<number>((resolveExit) => {
		waiters = createRpcWaiters((obj) => sent.push(obj), 1000);
		void waiters.command({ type: "get_state" }, "sess-before");
		void waiters.command({ type: "new_session", parentSession: "parent.jsonl" }, "sess-link");
		// The response that used to be passed to resolveExit() instead.
		waiters.deliver(response("sess-before", { data: { sessionId: "s1", sessionFile: "s.jsonl" } }));
		// (resolveExit referenced here only to prove the capture is reachable.)
		void resolveExit;
	});
	void exitPromise.then(() => {
		exitSettled = true;
	});

	await new Promise((r) => setTimeout(r, 20));
	assert.equal(exitSettled, false, "an RPC response must not end the run");
	assert.equal(waiters?.pending(), 1, "only the answered waiter settles");

	waiters?.flush(); // e.g. proc.on("close")
	await new Promise((r) => setTimeout(r, 20));
	assert.equal(exitSettled, false, "unblocking waiters must not end the run either");
	assert.equal(sent.length, 2);
});

test("flush unblocks every pending waiter with null and is safe to repeat", async () => {
	const waiters = createRpcWaiters(() => {}, 1000);
	const a = waiters.command({ type: "get_state" }, "sess-before");
	const b = waiters.command({ type: "new_session" }, "sess-link");
	waiters.flush();
	assert.equal(waiters.pending(), 0);
	assert.equal(await a, null);
	assert.equal(await b, null);
	waiters.flush(); // no throw on an empty registry
	assert.equal(waiters.deliver(response("sess-before")), false, "flushed waiters do not resurrect");
});

test("command resolves null on timeout instead of rejecting (setup is best-effort)", async () => {
	const waiters = createRpcWaiters(() => {}, 25);
	// The waiter's own timer is unref'd (it must never hold pi open), so keep
	// the event loop alive with a ref'd timer while we wait for it.
	const keepAlive = setTimeout(() => {}, 500);
	const p = waiters.command({ type: "get_state" }, "sess-before");
	assert.equal(waiters.pending(), 1);
	assert.equal(await p, null);
	assert.equal(waiters.pending(), 0);
	assert.equal(waiters.deliver(response("sess-before")), false, "a late response after the timeout is inert");
	clearTimeout(keepAlive);
});

test("deliver only matches string ids (numeric lookalikes are noise)", async () => {
	const waiters = createRpcWaiters(() => {}, 1000);
	const p = waiters.command({ type: "get_state" }, "42");
	assert.equal(waiters.deliver({ id: 42 }), false);
	waiters.flush();
	assert.equal(await p, null);
});
