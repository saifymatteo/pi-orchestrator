import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createFleetPanel, renderFleetPanel } from "../src/fleet-panel.ts";
import type { RunningTask } from "../src/run-lifecycle.ts";

const CHANNEL = "pi-atelier:sidebar-panels";

function bus() {
	const emitter = new EventEmitter();
	const registrations: any[] = [];
	const removals: any[] = [];
	emitter.on(CHANNEL, (event) => {
		if (!event || typeof event !== "object") return;
		if (event.type === "register" && event.panel) registrations.push(event);
		if (event.type === "unregister") removals.push(event);
	});
	return {
		registrations, removals,
		emit: (data: unknown) => emitter.emit(CHANNEL, data),
		listeners: () => emitter.listenerCount(CHANNEL),
		events: {
			on(channel: string, handler: (data: unknown) => void) {
				emitter.on(channel, handler);
				return () => { emitter.off(channel, handler); };
			},
			emit(channel: string, data: unknown) { emitter.emit(channel, data); },
		},
	};
}

function task(overrides: Partial<RunningTask> = {}): RunningTask {
	return { id: "single:1", agent: "worker", task: "SECRET PROMPT", mode: "single", state: "running", turns: 4, toolTurns: 3, contextTokens: 12300, inputTokens: 4200, outputTokens: 800, ...overrides };
}

test("sidebar layout: compact idle status and bullet roster are left-aligned text rows", () => {
	const panel = renderFleetPanel([], ["scout", "worker"], "auto");
	assert.deepEqual(panel.rows, [
		{ text: "AUTO · idle", role: "muted" },
		{ text: "• scout", role: "primary" },
		{ text: "• worker", role: "primary" },
	]);
	assert.equal("keyValues" in panel, false, "blank-label values would right-align the roster again");
	assert.deepEqual(renderFleetPanel([], [], "engaged").rows, [
		{ text: "ENGAGED · idle", role: "muted" }, { text: "(empty fleet)", role: "muted" },
	]);
});

test("sidebar layout: running details stay compact, use tool turns, and never contain prompts", () => {
	const panel = renderFleetPanel([task()], ["worker"], "engaged");
	assert.deepEqual(panel.rows.slice(2), [
		{ text: "worker · turn 3", role: "primary" },
		{ text: "ctx 12k · ↑4.2k ↓800", role: "muted" },
	]);
	assert.ok(!JSON.stringify(panel).includes("SECRET PROMPT"));
	assert.ok(!JSON.stringify(panel).includes("turn 4"));
});

test("sidebar layout: active dispatch and counts are exactly two separate header rows", () => {
	const retained = renderFleetPanel([task({ state: "delivery-pending" })], ["worker"], "auto");
	assert.deepEqual(retained.rows.slice(0, 2), [
		{ text: "⏳ Fleet · single", role: "accent" }, { text: "0 running · 1 delivery pending", role: "caution" },
	]);
	assert.deepEqual(renderFleetPanel([task({ mode: "parallel" }), task({ mode: "parallel", state: "queued" })], [], "engaged").rows.slice(0, 2), [
		{ text: "⏳ Fleet · parallel", role: "accent" }, { text: "1 running · 1 queued", role: "working" },
	]);
	assert.equal(renderFleetPanel([task({ mode: "chain" })], [], "auto").rows[0].text, "⏳ Fleet · chain");
	assert.equal(renderFleetPanel([task({ mode: "chain" }), task()], [], "auto").rows[0].text, "⏳ Fleet · mixed");
});

test("sidebar layout: queue and delivery state remain distinct from execution", () => {
	const panel = renderFleetPanel([
		task({ state: "queued", agent: "scout" }),
		task({ state: "delivery-pending", agent: "worker" }),
		task({ state: "delivery-failed", agent: "reviewer" }),
	], [], "auto");
	assert.deepEqual(panel.rows.slice(2), [
		{ text: "scout · queued", role: "muted" },
		{ text: "worker · result pending", role: "caution" },
		{ text: "reviewer · delivery failed", role: "error" },
	]);
	assert.equal(panel.rows[1].role, "error", "failed delivery remains prominent in the counts too");
	assert.ok(!JSON.stringify(panel).includes("ctx"));
	assert.ok(!JSON.stringify(panel).includes("SECRET PROMPT"));
});

test("sidebar layout: large fleets are bounded without splitting a Worker's details", () => {
	const panel = renderFleetPanel(Array.from({ length: 40 }, (_, i) => task({ id: `single:${i}` })), [], "auto");
	assert.ok(panel.rows.length <= 24);
	assert.match(panel.rows.at(-1)!.text, /^More: \d+ runs$/);
	assert.equal(panel.rows.at(-1)!.role, "dim");
	for (let i = 0; i < panel.rows.length; i++) {
		if (panel.rows[i].text.startsWith("worker ·")) assert.match(panel.rows[i + 1].text, /^ctx /);
	}
	const idle = renderFleetPanel([], Array.from({ length: 40 }, (_, i) => `agent-${i}`), "auto");
	assert.equal(idle.rows.length, 24);
	assert.equal(idle.rows.at(-1)!.text, "More: 18 agents");
});

test("fleet panel: structured text is sanitized and bounded while preserving color roles", () => {
	const b = bus();
	const content = { rows: [
		{ text: "\u001b[31mFleet\u001b[0m\n\t\u0000", role: "accent" as const },
		{ text: "🚀".repeat(200), role: "muted" as const },
		{ text: "plain" },
	] };
	const panel = createFleetPanel(b.events, () => content);
	panel.start();
	assert.deepEqual(b.registrations[0].panel.rows, [
		{ text: "Fleet   ", role: "accent" }, { text: "🚀".repeat(160), role: "muted" }, { text: "plain" },
	]);
	assert.equal(b.registrations[0].panel.keyValues, undefined, "Atelier must use its left-aligned text-row path");
	panel.dispose();
});

test("fleet panel: compact renderer publishes without a competing key/value representation", () => {
	const b = bus();
	const content = renderFleetPanel([], ["scout", "worker"], "auto");
	const panel = createFleetPanel(b.events, () => content);
	panel.start();
	assert.deepEqual(b.registrations[0].panel.rows, content.rows);
	assert.equal("keyValues" in b.registrations[0].panel, false);
	panel.dispose();
});

test("fleet panel: publishes v1 registration and answers later Atelier discovery with fresh state", () => {
	const b = bus();
	let lines = ["Orchestrator: ENGAGED · Fleet: scout"];
	const panel = createFleetPanel(b.events, () => ({ rows: lines }));
	panel.update();
	assert.equal(b.registrations.length, 0, "no publication before session startup");
	panel.start();
	assert.deepEqual(b.registrations[0], {
		version: 1, type: "register", source: "pi-orchestrator", revision: 1,
		panel: { id: "orchestrator:fleet", title: "Orchestrator Fleet", rows: lines },
	});
	lines = ["Fleet · single · 1 running", "worker · turn 3"];
	b.emit({ version: 1, type: "discover", requestId: "atelier-1" });
	assert.equal(b.registrations.length, 2);
	assert.equal(b.registrations[1].requestId, "atelier-1");
	assert.equal(b.registrations[1].revision, 2);
	assert.deepEqual(b.registrations[1].panel.rows, lines);
	panel.dispose();
});

test("fleet panel: updates an existing consumer, unregisters, and restarts without leaking listeners or revisions", () => {
	const b = bus();
	const panel = createFleetPanel(b.events, () => ({ rows: ["idle"] }));
	panel.start();
	panel.update();
	assert.equal(b.listeners(), 2);
	assert.equal(b.registrations.length, 2);
	panel.dispose();
	panel.dispose();
	panel.update();
	b.emit({ version: 1, type: "discover", requestId: "after-shutdown" });
	assert.equal(b.listeners(), 1);
	assert.equal(b.registrations.length, 2);
	assert.deepEqual(b.removals, [{ version: 1, type: "unregister", source: "pi-orchestrator", revision: 3, id: "orchestrator:fleet" }]);
	panel.start();
	assert.equal(b.registrations.at(-1).revision, 4);
	panel.start(); // Defensive repeated startup also retires the old publisher.
	assert.equal(b.listeners(), 2);
	assert.equal(b.registrations.at(-1).revision, 6);
	panel.dispose();
});

test("fleet panel: malformed/foreign discovery is ignored without a response loop", () => {
	const b = bus();
	const panel = createFleetPanel(b.events, () => ({ rows: ["idle"] }));
	panel.start();
	for (const data of [null, [], "discover", {}, { version: 2, type: "discover", requestId: "x" },
		{ version: 1, type: "register", requestId: "x" }, ...[undefined, 1, "", " ", "x".repeat(257), "x\n", "\u001b", "\ud800", "\udc00"].map((requestId) => ({ version: 1, type: "discover", requestId }))]) {
		b.emit(data);
	}
	assert.equal(b.registrations.length, 1);
	b.emit({ version: 1, type: "discover", requestId: "valid-🚀" });
	assert.equal(b.registrations.length, 2);
	panel.dispose();
});

test("fleet panel: bounds rows/text to Atelier limits and strips terminal controls", () => {
	const b = bus();
	let lines = ["\u001b[31mred\u001b[0m\n\t\u0000", "🚀".repeat(200), ...Array.from({ length: 30 }, (_, i) => `task ${i}`)];
	const panel = createFleetPanel(b.events, () => ({ rows: lines }));
	panel.start();
	const rows = b.registrations[0].panel.rows;
	assert.equal(rows.length, 24);
	assert.equal(rows[0], "red   ");
	assert.equal(rows[1], "🚀".repeat(160));
	assert.equal(rows.at(-1), "… 9 more");
	assert.ok(rows.every((row: string) => Array.from(row).length <= 160));
	lines = Array.from({ length: 24 }, (_, i) => `${i}`);
	panel.update();
	assert.deepEqual(b.registrations.at(-1).panel.rows, lines, "exact limit needs no overflow row");
	panel.dispose();
});

test("fleet panel: absent Atelier/event bus and throwing optional observers are harmless", () => {
	const absent = createFleetPanel(undefined, () => { throw new Error("must not read"); });
	assert.doesNotThrow(() => { absent.start(); absent.update(); absent.dispose(); });
	const b = bus(); // No Atelier consumer, only a passive recorder.
	const brokenRead = createFleetPanel(b.events, () => { throw new Error("render failed"); });
	assert.doesNotThrow(() => { brokenRead.start(); brokenRead.update(); brokenRead.dispose(); });
	assert.equal(b.listeners(), 1);
	const emissions: any[] = [];
	const throwingConsumer = createFleetPanel({
		on() { return () => { throw new Error("unsubscribe failed"); }; },
		emit(_channel, data) { emissions.push(data); throw new Error("consumer failed"); },
	}, () => ({ rows: ["idle"] }));
	assert.doesNotThrow(() => { throwingConsumer.start(); throwingConsumer.update(); throwingConsumer.dispose(); });
	assert.deepEqual(emissions.map((event) => event.type), ["register", "register", "unregister"]);
	const brokenBus = createFleetPanel({
		on() { throw new Error("bus unavailable"); },
		emit() { throw new Error("listener failed"); },
	}, () => ({ rows: ["idle"] }));
	assert.doesNotThrow(() => { brokenBus.start(); brokenBus.update(); brokenBus.dispose(); });
});
