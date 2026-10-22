/** One live-session owner for admission, execution, cancellation and retained Results. */
import { randomUUID } from "node:crypto";
import type { SingleResult } from "./delegate.ts";

export type RunMode = "single" | "parallel" | "chain";
export type RunState = "queued" | "running" | "delivery-pending" | "delivery-failed";
export interface RunProgress {
	turns: number;
	toolTurns: number;
	contextTokens: number;
	inputTokens: number;
	outputTokens: number;
}
export interface RunningTask extends RunProgress {
	id: string;
	agent: string;
	task: string;
	mode: RunMode;
	state?: RunState;
}
export interface AcceptedRun {
	runId: number;
	agent: string;
	task: string;
	mode: RunMode;
	state: RunState;
}
export interface RunHandle extends AcceptedRun {
	/** Both wait modes settle through this promise; failures are values, never rejections. */
	result: Promise<SingleResult>;
}
export interface RunDelivery {
	runId: number;
	deliveryId: string;
	agent: string;
	task: string;
	mode: RunMode;
	result: SingleResult;
	cancelled: boolean;
}
export interface RunWatcherDeps {
	deliver(delivery: RunDelivery): void | Promise<void>;
	canDeliver?(): boolean;
	onIdle(): void;
	now(): number;
	onChange?(): void;
	limits?(): { maxConcurrency: number; maxQueuedRuns: number };
}
export interface RunWatcherStartInput {
	runId: number;
	agent: string;
	task: string;
	mode: RunMode;
	widgetKey: string;
	/** Blocking runs return through the handle rather than also pushing a Result. */
	pushResult?: boolean;
	start(opts: {
		signal: AbortSignal;
		registerKill(kill: () => void): void;
		onProgress(progress: RunProgress): void;
	}): Promise<SingleResult>;
}
export interface RunLease {
	result: Promise<RunDelivery[]>;
	commit(): void;
	release(): void;
}
export interface RunWatcher {
	claim(ids: number[], owner: string): RunLease;
	flush(): void;
	/** Offers are retained until a positive branch receipt; finalized missing drafts may be offered again. */
	offer(): RunDelivery[];
	finishBoundary(): void;
	start(input: RunWatcherStartInput): RunHandle;
	/** Reserve the entire batch before any member's start function is called. */
	startMany(inputs: RunWatcherStartInput[]): RunHandle[];
	entries(): Array<AcceptedRun & { elapsedMs: number; deliveryError?: string }>;
	snapshot(): RunningTask[];
	cancel(runId: number): { ok: true } | { ok: false; error: string };
	abortAll(): void;
	confirmDeliveries(deliveryIds: ReadonlySet<string>): void;
	retryDelivery(runId: number): { ok: true } | { ok: false; error: string };
}

const emptyProgress = (): RunProgress => ({ turns: 0, toolTurns: 0, contextTokens: 0, inputTokens: 0, outputTokens: 0 });

function failedResult(input: RunWatcherStartInput, error: unknown): SingleResult {
	const message = error instanceof Error ? error.message : String(error);
	return {
		agent: input.agent, agentSource: "unknown", task: input.task,
		exitCode: 1, completedNormally: false, messages: [], stderr: message,
		stopReason: "error", errorMessage: message,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0, toolTurns: 0 },
	};
}

export function createRunWatcher(deps: RunWatcherDeps): RunWatcher {
	interface Record {
		input: RunWatcherStartInput;
		state: RunState;
		acceptedAt: number;
		controller: AbortController;
		kill?: () => void;
		killIssued: boolean;
		cancelled: boolean;
		aborted: boolean;
		started: boolean;
		settled: boolean;
		progress: RunProgress;
		deliveryId: string;
		deliveryError?: string;
		deliveryAttempt: number;
		outcome?: SingleResult;
		claim?: object;
		submitted?: boolean;
		offered?: boolean;
		resolve(result: SingleResult): void;
		result: Promise<SingleResult>;
	}
	const records = new Map<number, Record>();
	const queue: number[] = [];
	let active = 0;
	let draining = false;
	let aborting = false;
	let busy = false;

	function limits() {
		const value = deps.limits?.();
		return {
			maxConcurrency: Number.isSafeInteger(value?.maxConcurrency) && value!.maxConcurrency > 0 ? value!.maxConcurrency : 4,
			maxQueuedRuns: Number.isSafeInteger(value?.maxQueuedRuns) && value!.maxQueuedRuns >= 0 ? value!.maxQueuedRuns : 32,
		};
	}
	function publish() {
		// UI callbacks never own settlement or prevent a Result submission.
		try { deps.onChange?.(); } catch { /* unavailable UI */ }
		const hasWork = active > 0 || [...records.values()].some((r) => r.state === "queued");
		if (busy && !hasWork) {
			busy = false;
			try { deps.onIdle(); } catch { /* idle UI is not outcome delivery */ }
		}
	}
	function kill(record: Record) {
		if (!record.kill || record.killIssued) return;
		record.killIssued = true;
		try { record.kill(); } catch { /* runner still settles through its promise */ }
	}
	function delivery(record: Record): RunDelivery {
		return {
			runId: record.input.runId, deliveryId: record.deliveryId,
			agent: record.input.agent, task: record.input.task, mode: record.input.mode,
			result: record.outcome!, cancelled: record.cancelled,
		};
	}
	function eligible(record: Record) {
		return !record.aborted && !!record.outcome && !record.claim && !record.submitted && !record.offered;
	}
	function flush() {
		try { if (deps.canDeliver && !deps.canDeliver()) return; }
		catch { return; /* unavailable host context: retain outcomes */ }
		for (const record of records.values()) if (eligible(record)) submit(record);
	}
	function submit(record: Record) {
		if (record.aborted || !record.outcome || record.claim) return;
		record.submitted = true;
		record.state = "delivery-pending";
		record.deliveryError = undefined;
		const attempt = ++record.deliveryAttempt;
		const failed = (error: unknown) => {
			if (records.get(record.input.runId) !== record || record.aborted || attempt !== record.deliveryAttempt) return;
			record.state = "delivery-failed";
			record.deliveryError = error instanceof Error ? error.message : String(error);
			publish();
		};
		try {
			const returned = deps.deliver(delivery(record));
			// Real pi returns void. An injected/alternate sender may expose errors,
			// but a resolved promise still is NOT transcript confirmation.
			if (returned) Promise.resolve(returned).catch(failed);
		} catch (error) { failed(error); }
	}
	function finish(record: Record, result: SingleResult) {
		if (record.settled) return;
		record.settled = true;
		if (record.started) active--;
		if (record.cancelled || record.aborted) result = {
			...result, completedNormally: false, stopReason: "aborted",
			errorMessage: record.cancelled ? "Cancelled by orchestrator." : "Parent session aborted.",
		};
		record.outcome = result;
		if (record.aborted || record.input.pushResult === false) records.delete(record.input.runId);
		else {
			record.state = "delivery-pending";
			flush();
		}
		record.resolve(result);
		drain();
		publish();
	}
	function drain() {
		if (draining || aborting) return;
		draining = true;
		try {
			while (active < limits().maxConcurrency && queue.length) {
				const record = records.get(queue.shift()!);
				if (!record || record.settled || record.aborted) continue;
				record.started = true;
				record.state = "running";
				active++;
				try {
					const promise = record.input.start({
						signal: record.controller.signal,
						registerKill: (handle) => {
							if (record.kill) return;
							record.kill = handle;
							if (record.cancelled || record.aborted) kill(record);
						},
						onProgress: (progress) => {
							if (record.settled) return;
							record.progress = { ...progress };
							publish();
						},
					});
					Promise.resolve(promise).then(
						(result) => finish(record, result),
						(error) => finish(record, failedResult(record.input, error)),
					);
				} catch (error) { finish(record, failedResult(record.input, error)); }
			}
		} finally { draining = false; }
		publish();
	}
	function startMany(inputs: RunWatcherStartInput[]): RunHandle[] {
		// Apply current limits to existing FIFO work before considering new work.
		drain();
		const { maxConcurrency, maxQueuedRuns } = limits();
		const queued = [...records.values()].filter((r) => r.state === "queued").length;
		const available = Math.max(0, maxConcurrency - active) + Math.max(0, maxQueuedRuns - queued);
		if (inputs.length > available) throw new Error(
			`Fleet capacity exceeded: ${inputs.length} requested, ${available} available (${maxConcurrency} running slots, ${maxQueuedRuns} queue limit). No tasks in this batch were accepted.`,
		);
		const ids = new Set<number>();
		for (const input of inputs) {
			if (records.has(input.runId) || ids.has(input.runId)) throw new Error(`Duplicate run id ${input.runId}.`);
			ids.add(input.runId);
		}
		const handles = inputs.map((input) => {
			let resolve!: (result: SingleResult) => void;
			const result = new Promise<SingleResult>((done) => { resolve = done; });
			const record: Record = {
				input, acceptedAt: deps.now(), controller: new AbortController(),
				state: "queued", started: false, settled: false, cancelled: false, aborted: false,
				killIssued: false, progress: emptyProgress(), deliveryId: randomUUID(), deliveryAttempt: 0, resolve, result,
			};
			records.set(input.runId, record);
			queue.push(input.runId);
			return { runId: input.runId, agent: input.agent, task: input.task, mode: input.mode, state: record.state, result };
		});
		if (inputs.length) busy = true;
		drain();
		for (const handle of handles) handle.state = records.get(handle.runId)?.state ?? "running";
		return handles;
	}
	return {
		flush,
		offer() {
			const drafts: RunDelivery[] = [];
			for (const record of records.values()) if (eligible(record)) {
				record.offered = true;
				drafts.push(delivery(record));
			}
			return drafts;
		},
		finishBoundary() {
			for (const record of records.values()) record.offered = false;
		},
		claim(ids, owner) {
			if (typeof owner !== "string" || !owner.trim() || !Array.isArray(ids) || !ids.length ||
				Array.from(ids).some((id) => !Number.isSafeInteger(id) || id < 1) || new Set(ids).size !== ids.length) {
				throw new Error("Agent claim requires an owner and distinct positive run ids.");
			}
			const batch = ids.map((id) => {
				const record = records.get(id);
				if (!record || record.aborted) throw new Error(`Agent run ${id} is missing or already consumed.`);
				if (record.input.pushResult === false) throw new Error(`Agent run ${id} belongs to a blocking dispatch.`);
				if (record.claim) throw new Error(`Agent run ${id} is already claimed.`);
				if (record.submitted || record.offered) throw new Error(`Agent run ${id} is already submitted; queued delivery cannot be withdrawn.`);
				return record;
			});
			const token = {};
			for (const record of batch) record.claim = token;
			let closed = false;
			const close = (consume: boolean) => {
				if (closed) return;
				if (consume && batch.some((record) => !record.settled && !record.aborted)) {
					return; // Premature cleanup must not throw or consume unfinished work.
				}
				closed = true;
				for (const record of batch) {
					if (records.get(record.input.runId) !== record || record.aborted || record.claim !== token) continue;
					record.claim = undefined;
					if (consume) records.delete(record.input.runId);
				}
				flush();
				publish();
			};
			return {
				result: Promise.all(batch.map(async (record) => {
					await record.result;
					return delivery(record);
				})),
				commit: () => close(true), release: () => close(false),
			};
		},
		start: (input) => startMany([input])[0],
		startMany,
		entries: () => [...records.values()].filter((r) => !r.aborted).map((r) => ({
			runId: r.input.runId, agent: r.input.agent, task: r.input.task, mode: r.input.mode,
			state: r.state, elapsedMs: Math.max(0, deps.now() - r.acceptedAt), deliveryError: r.deliveryError,
		})),
		snapshot: () => [...records.values()].filter((r) => !r.aborted).map((r) => ({
			id: r.input.widgetKey, agent: r.input.agent, task: r.input.task, mode: r.input.mode,
			state: r.state, ...r.progress,
		})),
		cancel(runId) {
			const record = records.get(runId);
			if (!record || record.settled) return { ok: false, error: `No live run with id ${runId}. Finished runs cannot be cancelled; use {action: "status"} to list runs.` };
			record.cancelled = true;
			record.controller.abort();
			kill(record);
			if (!record.started) {
				const index = queue.indexOf(runId);
				if (index >= 0) queue.splice(index, 1);
				finish(record, failedResult(record.input, "Cancelled before launch."));
			}
			publish();
			return { ok: true };
		},
		abortAll() {
			aborting = true;
			const current = [...records.values()];
			// Mark every entry first: cancellation callbacks cannot deliver a sibling.
			for (const record of current) record.aborted = true;
			queue.length = 0;
			try {
				for (const record of current) {
					if (record.settled) { records.delete(record.input.runId); continue; }
					record.controller.abort();
					kill(record);
					if (!record.started) finish(record, failedResult(record.input, "Session aborted before launch."));
				}
			} finally { aborting = false; }
			publish();
		},
		confirmDeliveries(ids) {
			for (const [id, record] of records) {
				if (record.settled && ids.has(record.deliveryId)) records.delete(id);
			}
			publish();
		},
		retryDelivery(runId) {
			const record = records.get(runId);
			if (!record?.settled || record.aborted) return { ok: false, error: `No retained Result for run ${runId}.` };
			if (record.claim || record.offered) return { ok: false, error: `Run ${runId} is owned by a shared wait or boundary delivery.` };
			submit(record);
			publish();
			return { ok: true };
		},
	};
}
