/**
 * The `delegate` tool — the orchestrator's only path to real work.
 *
 * Spawns child `pi` processes (--mode rpc --no-session) with isolated
 * contexts and the FULL toolset. Children carry PI_ORCHESTRATOR_CHILD=1 so
 * the extension self-disables inside them (flat orchestration, ADR-0002).
 *
 * RPC mode (pi's RPC documentation, `pi --mode rpc`): commands are JSON
 * lines written to the child's
 * stdin (one `prompt` command kicks off the task; `steer` delivers the
 * turn-budget grace message), events stream back as JSON lines on stdout.
 * stdin MUST be a held-open pipe ("pipe"): unlike json -p print mode,
 * RPC mode reads commands from stdin and does NOT wait for EOF, so there
 * is no deadlock — and holding it open is required to send the prompt.
 * Success is STATE-based (agent_settled), not exit-code-based: RPC mode
 * never exits on its own, so the orchestrator kills the child after
 * settle (exit code is informational only).
 *
 * Orphan safety (user requirement: no background agents after pi dies):
 *   - Children get a held-open stdin pipe (see above); a runaway child is
 *     reaped by the turn budget (hard kill at maxTurns + 5), the stall
 *     watchdog (hard kill after stallTimeoutMs of silence, ADR-0006),
 *     or shutdown.
 *   - Child-side watchdog (installed in index.ts) polls the parent PID and
 *     exits the child when the parent disappears (catches SIGKILL within 5s).
 *   - Normal paths: abort signal (Esc) and session_shutdown kill children.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { AgentConfig } from "./agents.ts";
import { toolMatchesAnyMatcher } from "./config.ts";

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const COLLAPSED_ITEM_COUNT = 10;
const PER_TASK_OUTPUT_CAP = 50 * 1024;
/** Turn budget default (ADR-0006); overridden by orchestrator.json `maxTurns`
 *  (via deps.getMaxTurns) or per-agent frontmatter `maxTurns`. */
const DEFAULT_MAX_TURNS = 50;
/** Hard-kill grace margin past the soft-grace budget (ADR-0006). */
const TURN_BUDGET_GRACE = 5;

/** Max wait for one RPC command response during sub-session setup (ADR-0011).
 *  get_state/new_session answered in <1s in probes; setup is best-effort and
 *  must never delay a healthy spawn by more than this. */
const RPC_SETUP_TIMEOUT_MS = 10_000;

/** Stall watchdog default (ADR-0006): orchestrator.json `stallTimeoutMs`
 *  (via deps.getStallTimeoutMs) overrides this. */
const DEFAULT_STALL_TIMEOUT_MS = 600_000;
/** How often the stall watchdog checks for silence. */
const STALL_CHECK_INTERVAL_MS = 15_000;

// ── Fleet widget state (live subagent progress) ─────────────────────────────

interface RunningTask {
	id: string;
	agent: string;
	task: string;
	/** Dispatch mode of the delegate call that spawned this task. */
	mode: "single" | "parallel" | "chain";
	turns: number;
	/** Tool-bearing turns only (matches the TUI's tool-call view); raw turns stay in `turns` for the budget. */
	toolTurns: number;
	contextTokens: number;
	inputTokens: number;
	outputTokens: number;
}

const runningTasks = new Map<string, RunningTask>();

/** True while at least one subagent process is running (fleet-widget guard). */
export function hasRunningTasks(): boolean {
	return runningTasks.size > 0;
}

/** Monotonic sequence distinguishing concurrent delegate invocations. */
let fleetRunSeq = 0;

/** Next unique per-invocation run id (incremented on every delegate call). */
export function nextFleetRunId(): number {
	return ++fleetRunSeq;
}

/** Unique runningTasks key for a delegate invocation (mode + run id). */
export function fleetKey(runId: number, mode: "single" | "parallel" | "chain", index?: number): string {
	if (mode === "single") return `single:${runId}`;
	return mode === "parallel" ? `task${runId}:${index}` : `chain${runId}:${index}`;
}

/** Current live-task snapshot (fleet widget data source; tests + status UI). */
export function fleetTasksSnapshot(): RunningTask[] {
	return Array.from(runningTasks.values());
}

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

/** Longest agent name shown in a fleet widget line before hard truncation. */
const MAX_AGENT_NAME_WIDTH = 12;
/** Task summary cap in a fleet widget line (ellipsis included). */
const MAX_TASK_SUMMARY_CHARS = 40;

function truncateWithEllipsis(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * Pure line builder for the fleet widget: grouped header (dispatch mode +
 * running count) with one indented line per running task, or the idle
 * fallback line when nothing runs.
 */
export function renderFleetLines(tasks: RunningTask[], agentNames: string[], orchestratorMode: OrchestratorMode): string[] {
	if (tasks.length === 0) {
		return idleFleetWidgetLines(agentNames, orchestratorMode);
	}
	const modes = new Set(tasks.map((t) => t.mode));
	const mode = modes.size === 1 ? tasks[0].mode : "mixed";
	const lines: string[] = [`⏳ Fleet · ${mode} · ${tasks.length} running`];
	// Pad to the longest current name (capped) for column alignment; names past
	// the cap are truncated so the columns can never blow past it either.
	const nameWidth = Math.min(MAX_AGENT_NAME_WIDTH, Math.max(...tasks.map((t) => t.agent.length)));
	for (const task of tasks) {
		const name =
			task.agent.length > MAX_AGENT_NAME_WIDTH
				? task.agent.slice(0, MAX_AGENT_NAME_WIDTH)
				: task.agent.padEnd(nameWidth);
		const summary = truncateWithEllipsis(task.task, MAX_TASK_SUMMARY_CHARS);
		lines.push(
			`  ${name} · turn ${task.toolTurns} · ctx ${formatTokens(task.contextTokens)}` +
				` · ↑${formatTokens(task.inputTokens)} ↓${formatTokens(task.outputTokens)} · "${summary}"`,
		);
	}
	return lines;
}

function updateFleetWidget(
	ctx: { ui: { setWidget(id: string, lines: string[] | undefined, opts?: unknown): void } },
	agentNames: string[],
	orchestratorMode: OrchestratorMode,
): void {
	if (!ctx.ui?.setWidget) return;
	ctx.ui.setWidget("orchestrator-fleet", renderFleetLines([...runningTasks.values()], agentNames, orchestratorMode));
}

export function clearFleetWidget(ui: { setWidget(id: string, lines: string[] | undefined, opts?: unknown): void }): void {
	try {
		ui.setWidget("orchestrator-fleet", undefined);
	} catch {
		/* not in TUI */
	}
}

/**
 * Orchestrator state as shown in the fleet widget (ADR-0003). The label must
 * never claim more than the gate actually does: `engaged` only when forcing is
 * on (allow-list + policy active), `auto` when it is not — a disengaged
 * orchestrator still answers `delegate`, the model just keeps its full toolset
 * and delegates by choice. Before this, the idle line claimed `engaged` in both
 * states, which read as a broken gate.
 */
export type OrchestratorMode = "engaged" | "auto";

export function idleFleetWidgetLines(agentNames: string[], orchestratorMode: OrchestratorMode): string[] {
	return [`orchestrator: ${orchestratorMode} · fleet: ${agentNames.join(", ") || "(empty)"}`];
}

// ── Live child-process registry (for session_shutdown reaping) ──────────────

const liveProcs = new Set<ChildProcess>();

/**
 * The watcher of the registered extension instance (undefined in print mode
 * and tests). Session teardown marks runs aborted BEFORE killing so their
 * settle paths skip result delivery — no sendMessage during teardown.
 */
let activeWatcher: ReturnType<typeof createRunWatcher> | undefined;

/** Mark every live run aborted (delivery suppressed) and kill the fleet.
 *  Idempotent; overlaps with killAllFleet are safe. */
export function abortActiveRuns(): void {
	activeWatcher?.abortAll();
}

/** Kill every live subagent process. Called on session_shutdown and abort. */
export function killAllFleet(): void {
	for (const proc of liveProcs) {
		try {
			proc.kill("SIGTERM");
			// Unconditional escalation — proc.killed reflects a kill()
			// CALL, not process death, so gating on it never fires.
			setTimeout(() => {
				try {
					proc.kill("SIGKILL");
				} catch {
					/* already gone */
				}
			}, 3000);
		} catch {
			/* already gone */
		}
	}
	liveProcs.clear();
}

const NL = String.fromCharCode(10);

// ── Run watcher (ADR-0014): async child lifecycle outlives the tool call ────

/** A settled async run pushed into the parent conversation. */
export interface RunDelivery {
	runId: number;
	agent: string;
	task: string;
	mode: "single" | "parallel";
	result: SingleResult;
	/** True when the orchestrator cancelled this run ({action: "cancel"}). */
	cancelled: boolean;
}

export interface RunWatcherDeps {
	/** Push a settled run into the parent conversation (pi.sendMessage). */
	deliver(delivery: RunDelivery): void;
	/** Fired when the last live run settles (fleet idle again). */
	onIdle(): void;
	/** Injectable clock (tests). */
	now(): number;
}

export interface AcceptedRun {
	runId: number;
	agent: string;
	task: string;
	mode: "single" | "parallel";
}

export interface RunWatcherEntry {
	runId: number;
	agent: string;
	task: string;
	mode: "single" | "parallel";
	elapsedMs: number;
}

export interface RunWatcherStartInput {
	runId: number;
	agent: string;
	task: string;
	mode: "single" | "parallel";
	/** runningTasks key (fleetKey) — the watcher owns this entry's lifecycle:
	 *  a placeholder is visible to the widget before the child's first event
	 *  and is removed on settle (idempotently — runSingleAgent also deletes it
	 *  on close). */
	widgetKey: string;
	/** Starts the child. registerKill receives the child kill handle (SIGTERM
	 *  + SIGKILL escalation) the moment the process exists; for a run already
	 *  cancelled or aborted at that point, the watcher kills immediately —
	 *  a cancel racing a slow spawn cannot orphan the child. */
	start(opts: { registerKill(kill: () => void): void }): Promise<SingleResult>;
}

export interface RunWatcher {
	start(input: RunWatcherStartInput): AcceptedRun;
	/** Live runs for the status action, oldest first. */
	entries(): Array<AcceptedRun & { elapsedMs: number }>;
	/** Kill one live run. Its settle still delivers (marked cancelled) so the
	 *  orchestrator learns the run ended and what it produced until then. */
	cancel(runId: number): { ok: true } | { ok: false; error: string };
	/** ESC semantics: kill everything live and deliver NOTHING when runs
	 *  settle — an aborted conversation must not be resumed by a delivery. */
	abortAll(): void;
}

export function createRunWatcher(deps: RunWatcherDeps): RunWatcher {
	interface LiveEntry {
		runId: number;
		agent: string;
		task: string;
		mode: "single" | "parallel";
		widgetKey: string;
		startedAt: number;
		/** Kill handle, set by the runner once the child process exists. */
		kill?: () => void;
		cancelled: boolean;
		aborted: boolean;
	}

	const live = new Map<number, LiveEntry>();

	const safeKill = (entry: LiveEntry) => {
		try {
			entry.kill?.();
		} catch {
			/* already gone */
		}
	};

	/** Remove the run from both registries; onIdle when the fleet is empty. */
	const settle = (entry: LiveEntry) => {
		if (!live.has(entry.runId)) return; // idempotent (kill + natural settle race)
		live.delete(entry.runId);
		runningTasks.delete(entry.widgetKey);
		if (live.size === 0 && runningTasks.size === 0) deps.onIdle();
	};

	return {
		start(input: RunWatcherStartInput): AcceptedRun {
			const entry: LiveEntry = {
				runId: input.runId,
				agent: input.agent,
				task: input.task,
				mode: input.mode,
				widgetKey: input.widgetKey,
				startedAt: deps.now(),
				kill: undefined,
				cancelled: false,
				aborted: false,
			};
			live.set(entry.runId, entry);
			// Widget placeholder: the run is visible (turn 0) before the spawn's
			// first event overwrites the same key; hasRunningTasks() stays true
			// across the dispatch→spawn gap, so idle never fires spuriously.
			runningTasks.set(entry.widgetKey, {
				id: entry.widgetKey,
				agent: entry.agent,
				task: entry.task,
				mode: entry.mode,
				turns: 0,
				toolTurns: 0,
				contextTokens: 0,
				inputTokens: 0,
				outputTokens: 0,
			});
			input.start({ registerKill }).then(
				(result) => {
					const wasAborted = entry.aborted;
					const wasCancelled = entry.cancelled;
					settle(entry);
					if (wasAborted) return; // aborted conversation: no delivery
					deps.deliver({ runId: entry.runId, mode: entry.mode, agent: entry.agent, task: entry.task, result, cancelled: wasCancelled });
				},
				() => settle(entry), // rejected run (aborted child): settle silently
			);

			/** Late kill registration: if cancel/abort already happened, kill now. */
			function registerKill(kill: () => void): void {
				if (entry.kill) return;
				entry.kill = kill;
				if (entry.cancelled || entry.aborted) safeKill(entry);
			}

			return { runId: entry.runId, agent: entry.agent, task: entry.task, mode: entry.mode };
		},

		entries() {
			return Array.from(live.values())
				.sort((a, b) => a.runId - b.runId)
				.map((e) => ({ runId: e.runId, agent: e.agent, task: e.task, mode: e.mode, elapsedMs: Math.max(0, deps.now() - e.startedAt) }));
		},

		cancel(runId: number): { ok: true } | { ok: false; error: string } {
			const entry = live.get(runId);
			if (!entry) {
				return {
					ok: false,
					error: `No live run with id ${runId}. Use {action: "status"} to list live runs; finished runs cannot be cancelled.`,
				};
			}
			entry.cancelled = true;
			safeKill(entry);
			return { ok: true };
		},

		abortAll() {
			for (const entry of live.values()) {
				entry.aborted = true;
				safeKill(entry);
			}
		},
	};
}

/** One RPC response line from a child (rpc.md): `{ id, type: "response",
 *  success, data?, error? }`. Loose by design — pi owns the payload shape. */
export interface RpcResponse {
	id?: string;
	type?: string;
	success?: boolean;
	error?: string;
	data?: any;
	[key: string]: unknown;
}

/**
 * Id-matched RPC response waiters for one child process (ADR-0011).
 *
 * Extracted out of `runSingleAgent` on purpose. The sub-session helper used to
 * be declared *inside* the run's exit-promise executor, whose `resolve` was in
 * lexical scope; the helper called that `resolve` instead of its own, so the
 * first `get_state` response ended the entire run — `exitCode` became the
 * response object, the result collapsed to "(no output)", and the child was
 * never killed. Here there is no outer resolver to capture: a waiter can only
 * ever settle its own promise.
 */
export interface RpcWaiters {
	/** Send `cmd` with `id` attached and wait for the response carrying that id.
	 *  Resolves `null` on timeout or `flush()` — never rejects (setup is
	 *  best-effort and must not fail the run). */
	command(cmd: Record<string, unknown>, id: string): Promise<RpcResponse | null>;
	/** Route one incoming response: settles the waiter registered for
	 *  `event.id`, if any. Returns whether it matched, so callers keep their own
	 *  handling of the same line. Unknown ids are ignored (return false). */
	deliver(event: { id?: string } | null | undefined): boolean;
	/** Unblock every pending waiter with `null` (child gone / run aborted). */
	flush(): void;
	/** Outstanding waiters (tests, diagnostics). */
	pending(): number;
}

export function createRpcWaiters(
	send: (obj: Record<string, unknown>) => void,
	timeoutMs: number,
): RpcWaiters {
	const waiters = new Map<string, (resp: RpcResponse | null) => void>();

	const settle = (id: string, resp: RpcResponse | null): boolean => {
		const waiter = waiters.get(id);
		if (!waiter) return false;
		waiters.delete(id);
		waiter(resp);
		return true;
	};

	return {
		command(cmd: Record<string, unknown>, id: string): Promise<RpcResponse | null> {
			return new Promise<RpcResponse | null>((resolveCmd) => {
				const timer = setTimeout(() => settle(id, null), timeoutMs);
				timer.unref?.();
				waiters.set(id, (resp) => {
					clearTimeout(timer);
					resolveCmd(resp);
				});
				send({ id, ...cmd });
			});
		},
		deliver(event: { id?: string } | null | undefined): boolean {
			if (!event || typeof event.id !== "string") return false;
			if (/^\d+$/.test(event.id)) return false;
			return settle(event.id, event as RpcResponse);
		},
		flush(): void {
			for (const id of Array.from(waiters.keys())) settle(id, null);
		},
		pending(): number {
			return waiters.size;
		},
	};
}


/**
 * Send an RPC command to the child's stdin (JSON + newline, per rpc.md).
 * EPIPE-safe: the child may have died or closed stdin between checks.
 */
function sendRpc(proc: ChildProcess, obj: Record<string, unknown>): void {
	try {
		proc.stdin?.write(`${JSON.stringify(obj)}\n`);
	} catch {
		/* child gone / stream destroyed — nothing to send to */
	}
}

/**
 * Strict JSONL reader per rpc.md's framing rules: split on `\n` ONLY, strip a
 * trailing `\r`, flush any trailing bytes on stream end. StringDecoder keeps
 * multi-byte UTF-8 characters split across chunks intact. Deliberately NOT
 * Node readline, which also splits on U+2028/U+2029 — valid inside JSON
 * strings — and would corrupt the protocol.
 */
function attachJsonlReader(stream: NodeJS.ReadableStream, onLine: (line: string) => void): void {
	const decoder = new StringDecoder("utf8");
	let buffer = "";

	stream.on("data", (chunk: Buffer | string) => {
		buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
		while (true) {
			const newlineIndex = buffer.indexOf("\n");
			if (newlineIndex === -1) break;
			let line = buffer.slice(0, newlineIndex);
			buffer = buffer.slice(newlineIndex + 1);
			if (line.endsWith("\r")) line = line.slice(0, -1);
			onLine(line);
		}
	});

	stream.on("end", () => {
		buffer += decoder.end();
		if (buffer.length > 0) {
			onLine(buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer);
		}
	});
}

// ── Display helpers (adapted from pi's subagent example) ────────────────────

function formatUsageStats(
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		contextTokens?: number;
		turns?: number;
	},
	model?: string,
): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens && usage.contextTokens > 0) parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	if (model) parts.push(model);
	return parts.join(" ");
}

function formatToolCall(
	toolName: string,
	args: Record<string, unknown>,
	themeFg: (color: any, text: string) => string,
): string {
	const shortenPath = (p: string) => {
		const home = os.homedir();
		return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
	};

	switch (toolName) {
		case "bash": {
			const command = (args.command as string) || "...";
			const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
			return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
		}
		case "read": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			let text = themeFg("accent", filePath);
			if (offset !== undefined || limit !== undefined) {
				const startLine = offset ?? 1;
				const endLine = limit !== undefined ? startLine + limit - 1 : "";
				text += themeFg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
			}
			return themeFg("muted", "read ") + text;
		}
		case "write": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const content = (args.content || "") as string;
			const lines = content.split("\n").length;
			let text = themeFg("muted", "write ") + themeFg("accent", filePath);
			if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
			return text;
		}
		case "edit": {
			const rawPath = (args.file_path || args.path || "...") as string;
			return themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath));
		}
		case "ls": {
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "ls ") + themeFg("accent", shortenPath(rawPath));
		}
		case "find": {
			const pattern = (args.pattern || "*") as string;
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "find ") + themeFg("accent", pattern) + themeFg("dim", ` in ${shortenPath(rawPath)}`);
		}
		case "grep": {
			const pattern = (args.pattern || "") as string;
			const rawPath = (args.path || ".") as string;
			return (
				themeFg("muted", "grep ") +
				themeFg("accent", `/${pattern}/`) +
				themeFg("dim", ` in ${shortenPath(rawPath)}`)
			);
		}
		default: {
			const argsStr = JSON.stringify(args);
			const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
			return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
		}
	}
}

interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
	/** Tool-bearing turns (widget display); `turns` stays raw for the budget. */
	toolTurns: number;
}

export interface SingleResult {
	agent: string;
	/** "project" = discovered from the project tree (project agents win on collision). */
	agentSource: "user" | "builtin" | "project" | "unknown";
	task: string;
	/** Informational only: RPC children are SIGTERMed intentionally after settle. */
	exitCode: number;
	/** False until the child reached agent_settled (state-based success). */
	completedNormally: boolean;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	step?: number;
	/** Persistent sub-session (ADR-0011): the child's pi session file and id,
	 *  captured via RPC get_state before the task prompt. Undefined when
	 *  persistence is off or the child died before session setup completed. */
	sessionFile?: string;
	sessionId?: string;
}

export interface SubagentDetails {
	mode: "single" | "parallel" | "chain" | "accepted";
	results: SingleResult[];
	/** Async run bookkeeping (ADR-0014): deliveries echo the acceptance's run id. */
	runId?: number;
	cancelled?: boolean;
}

/**
 * True when a turn carried tool activity: non-empty `toolResults` (turn_end
 * carries them, pi extensions.md) or toolCall parts in the assistant message
 * (same detection getDisplayItems uses). The fleet widget counts only
 * tool-bearing turns so it matches the TUI's tool-call view; the turn budget
 * keeps counting raw turns (ADR-0006).
 */
export function isToolTurn(message: Message | undefined, toolResults?: readonly unknown[]): boolean {
	if (toolResults && toolResults.length > 0) return true;
	if (!message || message.role !== "assistant") return false;
	return message.content.some((part) => part.type === "toolCall");
}

function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") return part.text;
			}
		}
	}
	return "";
}

/**
 * Failure is state-based, never exit-code-based: RPC children are killed
 * (SIGTERM) right after agent_settled, so their exit code is not meaningful.
 */
/** Stop reasons that mean the run ended badly (as opposed to transiently, e.g.
 *  the child's mid-run `"toolUse"`). */
const FAILURE_STOP_REASONS = new Set(["error", "aborted", "turn-budget-exhausted", "stall-timeout"]);

type FailureSignals = Pick<SingleResult, "completedNormally" | "stopReason">;

function isFailedResult(result: FailureSignals): boolean {
	return !result.completedNormally || (!!result.stopReason && FAILURE_STOP_REASONS.has(result.stopReason));
}

/**
 * A failure signal that is final even while the run is still in flight: an
 * explicit failure stop reason, or an error message. An unsettled result with
 * neither is not a failure — it is a task that is still working.
 */
function isDefinitiveFailure(result: SingleResult): boolean {
	return (!!result.stopReason && FAILURE_STOP_REASONS.has(result.stopReason)) || !!result.errorMessage;
}

// ── Run/task display status (fleet widget + tool block icons) ───────────────

/**
 * Display state of one task. `running` is the not-yet-settled state, encoded by
 * the `exitCode: -1` sentinel that both parallel placeholders and live partial
 * emissions carry (see `emitUpdate`) — a real child exit code is never -1.
 *
 * `callIsPartial` is the renderer-side backstop: while pi renders an in-flight
 * tool call, an unsettled task with no definitive failure signal is running.
 * Without either signal an unsettled result reads as failure — correct for a
 * finished run, and the bug that painted running subagents red ✗ in parallel
 * and chain mode.
 */
export type TaskStatus = "running" | "failed" | "success";

export function taskStatus(result: SingleResult, callIsPartial = false): TaskStatus {
	if (result.exitCode === -1) return "running";
	if (isDefinitiveFailure(result)) return "failed";
	if (callIsPartial && !result.completedNormally) return "running";
	return isFailedResult(result) ? "failed" : "success";
}

/**
 * Header state for a multi-task run: `running` while any task is unsettled,
 * `success` when a finished run has no failures, `failed` only once finished
 * with at least one failure. A running fleet must never read as failure.
 */
export function runStatus(
	results: readonly SingleResult[],
	callIsPartial = false,
): { status: TaskStatus; successCount: number } {
	const statuses = results.map((r) => taskStatus(r, callIsPartial));
	const successCount = statuses.filter((s) => s === "success").length;
	if (statuses.some((s) => s === "running")) return { status: "running", successCount };
	return { status: successCount === results.length ? "success" : "failed", successCount };
}

/**
 * In-flight progress line for a parallel run. Counts through `taskStatus` so a
 * live partial counts as running: the inline version compared against
 * `exitCode === -1` on results whose sentinel had already been overwritten by
 * the first partial emission, so two working subagents read as
 * "0/2 done, 0 running" — neither done nor running.
 */
export function parallelProgress(results: readonly SingleResult[]): string {
	const running = results.filter((r) => taskStatus(r) === "running").length;
	return `Parallel: ${results.length - running}/${results.length} done, ${running} running...`;
}

/** Single source of truth pairing a status with its theme color and glyph. */
const STATUS_GLYPH: Record<TaskStatus, [color: string, glyph: string]> = {
	running: ["warning", "⏳"],
	failed: ["error", "✗"],
	success: ["success", "✓"],
};

function statusIcon(theme: { fg(color: any, text: string): string }, status: TaskStatus): string {
	const [color, glyph] = STATUS_GLYPH[status];
	return theme.fg(color, glyph);
}

function getResultOutput(result: SingleResult): string {
	// Budget-exhausted and stall-killed runs report the reason AND everything
	// captured so far.
	let output: string;
	if (result.stopReason === "turn-budget-exhausted" || result.stopReason === "stall-timeout") {
		const partial = getFinalOutput(result.messages);
		const reason = result.errorMessage || "Run was killed";
		output = partial ? `${reason}\n\nPartial output:\n${partial}` : reason;
	} else if (isFailedResult(result)) {
		output = result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
	} else {
		output = getFinalOutput(result.messages) || "(no output)";
	}
	return withSessionNote(result, output);
}

/**
 * Pointer to the child's persistent pi session (ADR-0011), appended to every
 * returned result text — the parent can reference it (`delegate({action:
 * "sessions"})` lists them all) or hand the path to another subagent (e.g. a
 * reviewer resuming what a worker actually did). Omitted for ephemeral runs.
 */
function withSessionNote(result: SingleResult, text: string): string {
	return result.sessionFile ? `${text}\n\nSubagent session: ${result.sessionFile}` : text;
}

function truncateParallelOutput(output: string): string {
	const byteLength = Buffer.byteLength(output, "utf8");
	if (byteLength <= PER_TASK_OUTPUT_CAP) return output;

	let truncated = output.slice(0, PER_TASK_OUTPUT_CAP);
	while (Buffer.byteLength(truncated, "utf8") > PER_TASK_OUTPUT_CAP) {
		truncated = truncated.slice(0, -1);
	}
	return `${truncated}\n\n[Output truncated: ${byteLength - Buffer.byteLength(truncated, "utf8")} bytes omitted.]`;
}

type DisplayItem = { type: "text"; text: string } | { type: "toolCall"; name: string; args: Record<string, any> };

function getDisplayItems(messages: Message[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") items.push({ type: "text", text: part.text });
				else if (part.type === "toolCall") items.push({ type: "toolCall", name: part.name, args: part.arguments });
			}
		}
	}
	return items;
}

/**
 * File paths a subagent wrote or edited, from assistant toolCall parts of the
 * write/edit builtins (same file_path/path arg shapes formatToolCall handles).
 * Skips non-string/empty values; dedupes preserving first-seen order.
 */
export function collectTouchedFiles(messages: Message[]): string[] {
	const files: string[] = [];
	const seen = new Set<string>();
	for (const msg of messages) {
		if (msg.role !== "assistant") continue;
		for (const part of msg.content) {
			if (part.type !== "toolCall" || (part.name !== "write" && part.name !== "edit")) continue;
			const args = part.arguments as Record<string, unknown> | undefined;
			const raw = (args?.file_path || args?.path) as string | undefined;
			if (typeof raw !== "string" || raw === "" || seen.has(raw)) continue;
			seen.add(raw);
			files.push(raw);
		}
	}
	return files;
}

/** One-line "Files touched: ..." summary; capped at `cap` paths (default 10). */
export function formatTouchedFiles(files: string[], cap = 10): string {
	if (files.length === 0) return "";
	const shown = files.slice(0, cap);
	let text = `Files touched: ${shown.join(", ")}`;
	if (files.length > cap) text += `, … and ${files.length - cap} more`;
	return text;
}

async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}

async function writePromptToTempFile(agentName: string, prompt: string): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-orchestrator-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	});
	return { dir: tmpDir, filePath };
}

// ── Resolving the pi executable (Windows-safe) ──────────────────────────────

let piInvocation: { command: string; argsPrefix: string[] } | undefined;

const pathExt = process.platform === "win32" ? (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";") : [""];

function resolvePiInvocation(): { command: string; argsPrefix: string[] } {
	if (piInvocation) return piInvocation;

	// Prefer spawning our own JS entry script with the current runtime
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	const looksLikeBinary = /\.(exe|cmd|bat|ps1)$/i.test(currentScript ?? "");
	if (currentScript && !isBunVirtualScript && !looksLikeBinary && fs.existsSync(currentScript)) {
		piInvocation = { command: process.execPath, argsPrefix: [currentScript] };
		return piInvocation;
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		// pi runs as a compiled binary; spawn ourselves directly
		piInvocation = { command: process.execPath, argsPrefix: [] };
		return piInvocation;
	}

	// Generic runtime without a usable script path → search PATH for pi
	const isWin = process.platform === "win32";
	const pathExt = isWin ? (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";") : [""];
	const dirs = (process.env.PATH || "").split(isWin ? ";" : ":").filter(Boolean);
	for (const dir of dirs) {
		for (const ext of pathExt) {
			const candidate = path.join(dir, `pi${ext.toLowerCase()}`);
			try {
				fs.accessSync(candidate, fs.constants.X_OK);
				if (/\.(cmd|bat)$/i.test(candidate)) {
					// Node refuses to spawn .cmd without a shell; route through cmd.exe
					piInvocation = { command: path.join(process.env.SystemRoot || "C:\\Windows", "System32", "cmd.exe"), argsPrefix: ["/d", "/s", "/c", candidate] };
				} else {
					piInvocation = { command: candidate, argsPrefix: [] };
				}
				return piInvocation;
			} catch {
				/* keep looking */
			}
		}
	}

	piInvocation = { command: "pi", argsPrefix: [] };
	return piInvocation;
}

// ── Child spawn policy (ADR-0008) ───────────────────────────────────────────

/**
 * Expand blocked matchers to concrete tool names against the parent's tool
 * registry (ADR-0008): every matcher — exact, glob, or ext:<id> — is resolved
 * via toolMatchesAnyMatcher (same case-insensitive semantics as the ADR-0007
 * gate), and each matching tool's name is collected once, in first-seen order.
 * The names feed pi's `--exclude-tools` comma list, which takes concrete names
 * only. Matchers that expand to nothing are skipped silently — the interception
 * gate (ADR-0007) still enforces them child-side.
 */
export function expandBlockedToolsToNames(
	matchers: string[],
	tools: Array<{ name: string; sourceInfo?: unknown }>,
): string[] {
	const names: string[] = [];
	const seen = new Set<string>();
	for (const tool of tools) {
		if (!toolMatchesAnyMatcher(tool, matchers)) continue;
		if (seen.has(tool.name)) continue;
		seen.add(tool.name);
		names.push(tool.name);
	}
	return names;
}

/**
 * Pure builder for the child pi process arguments (RPC mode). Spawn-time flags
 * only — the caller appends `--append-system-prompt` after the prompt temp file
 * is written. Flag semantics per pi's usage docs: `--exclude-tools` is a
 * comma-separated denylist (single occurrence, concrete names only);
 * `--no-extensions` disables extension discovery and `-e` re-adds specific
 * extension sources (repeatable). Extension loading is derived from the
 * `extensions` list: non-empty ⇒ `--no-extensions` plus one `-e` per entry
 * (selective loading), empty ⇒ no extension flags at all (children inherit
 * every discovered extension, ADR-0005/0008).
 */
export function buildChildSpawnArgs(opts: {
	model?: string;
	/** Deterministic session id (stableSessionId) forwarded via pi's
	 *  `--session-id`; ONLY used for ephemeral children (persistSessions off,
	 *  where the in-memory SessionManager id stabilizes the prompt_cache_key).
	 *  Persistent sub-sessions get a unique id per run — a shared id across
	 *  concurrent same-agent spawns would point two writers at one file. */
	sessionId?: string;
	/** Only set when the child inherits dispatch config (agent frontmatter has
	 *  no model — same rule as before this extraction). */
	thinkingLevel?: ThinkingLevel;
	tools?: string[];
	/** Extension sources (orchestrator.json `childExtensions`) loaded via pi's
	 *  repeatable `-e` flag; non-empty also implies `--no-extensions`. */
	extensions: string[];
	/** Concrete tool names unregistered at spawn via `--exclude-tools`
	 *  (ADR-0008) — already expanded from matchers via expandBlockedToolsToNames. */
	excludeTools: string[];
	/** Persistent sub-session (ADR-0011): omit `--no-session` so the child's
	 *  transcript survives; pi creates the file lazily on first message. */
	persistSessions?: boolean;
	/** Directory for the persistent session (the parent's session dir, so
	 *  sub-sessions of a session live in one place). Omitted → pi's default
	 *  per-cwd sessions dir. */
	sessionDir?: string;
}): string[] {
	const args: string[] = ["--mode", "rpc"];
	if (opts.model) args.push("--model", opts.model);
	if (opts.thinkingLevel) args.push("--thinking", opts.thinkingLevel);
	if (opts.tools && opts.tools.length > 0) args.push("--tools", opts.tools.join(","));
	if (opts.extensions.length > 0) {
		args.push("--no-extensions");
		for (const ext of opts.extensions) args.push("-e", ext);
	}
	if (opts.excludeTools.length > 0) args.push("--exclude-tools", opts.excludeTools.join(","));
	if (opts.persistSessions) {
		if (opts.sessionDir) args.push("--session-dir", opts.sessionDir);
	} else {
		args.push("--no-session");
		if (opts.sessionId) args.push("--session-id", opts.sessionId);
	}
	return args;
}

/**
 * Deterministic session id per (agent, model): stabilizes the OpenAI-compat
 * `prompt_cache_key` / session-affinity routing key across child spawns — pi
 * derives prompt_cache_key from the session id, so without this each spawn
 * lands on a random shard. Anthropic-native caching is content-prefix based
 * and unaffected. Format conforms to pi's assertValidSessionId
 * (/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/ — hex slug satisfies it).
 */
export function stableSessionId(agentName: string, model: string | undefined): string {
	return createHash("sha1")
		.update(`orchestrator:${agentName}:${model ?? "default"}`)
		.digest("hex")
		.slice(0, 32);
}

// ── Sub-session discovery (ADR-0011) ─────────────────────────────────────

export interface SessionHeader {
	id?: string;
	timestamp?: string;
	cwd?: string;
	parentSession?: string;
}

/**
 * Parse a session file's first line (the `session` header, session-format
 * v3). Returns null for anything that is not a parseable session header.
 */
export function parseSessionHeader(line: string): SessionHeader | null {
	try {
		const parsed = JSON.parse(line);
		if (parsed && typeof parsed === "object" && parsed.type === "session") return parsed as SessionHeader;
	} catch {
		/* not JSON */
	}
	return null;
}

/**
 * Read just the first line of a session file without loading the whole file
 * (child sessions can grow large). Returns null on any read/parse failure.
 */
export function readSessionHeader(filePath: string): SessionHeader | null {
	let fd: number | undefined;
	try {
		fd = fs.openSync(filePath, "r");
		const buffer = Buffer.alloc(4096);
		const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
		const firstLine = buffer.toString("utf8", 0, bytesRead).split("\n")[0];
		return parseSessionHeader(firstLine);
	} catch {
		return null;
	} finally {
		if (fd !== undefined)
			try {
				fs.closeSync(fd);
			} catch {
				/* ignore */
			}
	}
}

export interface SubSessionInfo {
	id?: string;
	timestamp?: string;
	file: string;
}

/**
 * Find the sub-sessions of a parent session: every session file in `dir`
 * whose header records `parentSession === parentSessionFile` (the link pi
 * writes when the parent sends RPC `new_session {parentSession}` — session
 * format v3). State-based like everything here: derived from disk, so it
 * survives parent restarts and covers runs from previous parent sessions
 * too. Sorted newest-first; files that vanish mid-scan are skipped.
 */
export function scanSubSessions(dir: string, parentSessionFile: string): SubSessionInfo[] {
	let names: string[];
	try {
		names = fs.readdirSync(dir);
	} catch {
		return [];
	}
	const found: SubSessionInfo[] = [];
	for (const name of names) {
		if (!name.endsWith(".jsonl")) continue;
		const filePath = path.join(dir, name);
		const header = readSessionHeader(filePath);
		if (header?.parentSession === parentSessionFile) {
			found.push({ id: header.id, timestamp: header.timestamp, file: filePath });
		}
	}
	return found.sort((a, b) => (b.timestamp ?? "").localeCompare(a.timestamp ?? ""));
}

// ── Running one subagent ────────────────────────────────────────────────────

type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

interface DispatchDefaults {
	model?: string;
	thinkingLevel?: ThinkingLevel;
}

/**
 * One subagent run (ADR-0014): the whole child lifecycle for a single task.
 * Options object — the runner is injectable (DelegateDeps.runAgent) so tests
 * can drive dispatch without spawning real pi processes.
 */
export interface RunSingleAgentOptions {
	defaultCwd: string;
	/** runningTasks key (fleetKey) for the fleet widget. */
	agentKey: string;
	dispatchDefaults: DispatchDefaults;
	agents: AgentConfig[];
	agentName: string;
	task: string;
	maxTurns: number;
	stallTimeoutMs: number;
	blockedTools: string[];
	extensions: string[];
	/** Parent's pre-policy system prompt to append (config
	 *  `forwardParentPrompt`); undefined disables the append. */
	parentPrompt: string | undefined;
	/** Parent-side tool list for expanding blockedTools to concrete names at
	 *  spawn time (tools may register after registration — resolved fresh per
	 *  spawn). */
	getAllTools: () => Array<{ name: string; sourceInfo?: unknown }>;
	cwd: string | undefined;
	step: number | undefined;
	/** Blocking-path abort signal (the tool call's). Async runs pass undefined —
	 *  their lifecycle is owned by the run watcher via registerKill. */
	signal: AbortSignal | undefined;
	onUpdate: OnUpdateCallback | undefined;
	makeDetails: (results: SingleResult[]) => SubagentDetails;
	/** Dispatch mode for the fleet widget line (single/parallel/chain). */
	fleetMode: RunningTask["mode"];
	onFleetChange: () => void;
	/** Sub-session policy (ADR-0011): whether the child keeps a persistent pi
	 *  session and which parent session file to link it to. */
	sessionOpts: { persist: boolean; parentSessionFile?: string | undefined };
	/** Called with the child kill handle (SIGTERM + SIGKILL escalation) the
	 *  moment the process exists — the run watcher's cancel/abort path. */
	registerKill?: (kill: () => void) => void;
}

export type RunAgent = (options: RunSingleAgentOptions) => Promise<SingleResult>;

async function runSingleAgent(opts: RunSingleAgentOptions): Promise<SingleResult> {
	const {
		defaultCwd,
		agentKey,
		dispatchDefaults,
		agents,
		agentName,
		task,
		maxTurns,
		stallTimeoutMs,
		blockedTools,
		extensions,
		parentPrompt,
		getAllTools,
		cwd,
		step,
		signal,
		onUpdate,
		makeDetails,
		fleetMode,
		onFleetChange,
		sessionOpts,
		registerKill,
	} = opts;
	const agent = agents.find((a) => a.name === agentName);

	if (!agent) {
		const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
		return {
			agent: agentName,
			agentSource: "unknown",
			task,
			exitCode: 1,
			completedNormally: false,
			messages: [],
			stderr: `Unknown agent: "${agentName}". Available agents: ${available}. Call delegate({action: "list"}) for fleet details.`,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0, toolTurns: 0 },
			step,
		};
	}

	const inheritsDispatchConfig = !agent.model;
	const model = agent.model ?? dispatchDefaults.model;
	// ADR-0011: persistent sub-sessions are file-per-run — a deterministic id
	// shared across concurrent same-agent spawns would point two writers at
	// one JSONL, so the stable cache-shard id is only used for ephemeral runs.
	const persistSessions = sessionOpts.persist;
	const sessionDir = sessionOpts.parentSessionFile ? path.dirname(sessionOpts.parentSessionFile) : undefined;
	const args = buildChildSpawnArgs({
		model,
		sessionId: persistSessions ? undefined : stableSessionId(agent.name, model),
		thinkingLevel: inheritsDispatchConfig ? dispatchDefaults.thinkingLevel : undefined,
		tools: agent.tools,
		extensions,
		// Always-on unregistration (ADR-0008): every matcher — exact, glob, ext:<id>
		// — is expanded against the parent's tool registry and removed at spawn;
		// the interception gate (PI_ORCHESTRATOR_BLOCKED_TOOLS env) stays as backstop
		// for tools a divergent child loads that the parent cannot see.
		excludeTools: expandBlockedToolsToNames(blockedTools, getAllTools()),
		persistSessions,
		sessionDir,
	});

	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;
	let tmpParentPromptDir: string | null = null;
	let parentPromptFilePath: string | undefined;

	const currentResult: SingleResult = {
		agent: agentName,
		agentSource: agent.source,
		task,
		exitCode: 0,
		completedNormally: false,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0, toolTurns: 0 },
		model,
		step,
	};

	const fleetTask: RunningTask = {
		id: agentKey,
		agent: agentName,
		task,
		mode: fleetMode,
		turns: 0,
		toolTurns: 0,
		contextTokens: 0,
		inputTokens: 0,
		outputTokens: 0,
	};

	const emitUpdate = () => {
		if (onUpdate) {
			onUpdate({
				content: [{ type: "text", text: getFinalOutput(currentResult.messages) || "(running...)" }],
				// Publish the shared "running" sentinel instead of the initial
				// exitCode 0: an unsettled result with a real-looking exit code is
				// what made running tasks render red ✗ in parallel/chain, and made the
				// parallel progress line count them as neither done nor running.
				// Spread, because `currentResult` keeps being mutated until settle.
				details: makeDetails([{ ...currentResult, exitCode: -1 }]),
			});
		}
	};

	try {
		// System prompt + tool-policy hint (ADR-0007): the child must know
		// blocked tools fail before it tries them. An empty prompt with no
		// blocked tools writes nothing (empty-trim guard).
		const sysPrompt =
			agent.systemPrompt +
			(blockedTools.length
				? `\n\n# Tool policy\nThese tools are blocked by orchestrator policy and will fail if called: ${blockedTools.join(", ")}. Accomplish the task with the remaining tools.`
				: "");
		if (sysPrompt.trim()) {
			const tmp = await writePromptToTempFile(agent.name, sysPrompt);
			tmpPromptDir = tmp.dir;
			tmpPromptPath = tmp.filePath;
			args.push("--append-system-prompt", tmpPromptPath);
		}

		// Parent prompt forwarding (config `forwardParentPrompt`): written to
		// its own temp file and passed to the child via
		// PI_ORCHESTRATOR_PARENT_PROMPT_FILE; the CHILD-side before_agent_start
		// hook (installChildParentPrompt in index.ts) appends it at the END of
		// the system prompt — after project_context/skills/cwd — so the stable
		// shared prefix (base prompt, context, skills, cwd) is maximized for
		// provider prompt-cache hits. The child-side hook also delta-strips
		// segments the child already receives verbatim (project_context, cwd)
		// from the forwarded copy — see stripDuplicatedParentSegments.
		if (parentPrompt?.trim()) {
			const tmp = await writePromptToTempFile(`${agent.name}-parent`, parentPrompt);
			tmpParentPromptDir = tmp.dir;
			parentPromptFilePath = tmp.filePath;
		}

		let wasAborted = false;
		let settled = false;
		let budgetWarned = false;

		// Stall watchdog (ADR-0006): a child stalled mid-turn emits no events,
		// so the turn budget never fires. Any stdout line resets lastEventAt;
		// silence past stallTimeoutMs is hard-killed like budget exhaustion.
		let watchdogActive = true;
		let lastEventAt = Date.now();
		let stallTimer: NodeJS.Timeout | undefined;
		const stopStallWatchdog = () => {
			if (watchdogActive) {
				watchdogActive = false;
				if (stallTimer) clearInterval(stallTimer);
			}
		};

		const exitCode = await new Promise<number>((resolveExit) => {
			const invocation = resolvePiInvocation();
			const proc = spawn(invocation.command, [...invocation.argsPrefix, ...args], {
				cwd: cwd ?? defaultCwd,
				shell: false,
				windowsHide: true,
				// stdin MUST be a held-open pipe: RPC mode reads JSON commands
				// from stdin (the prompt is sent below) and does NOT wait for
				// EOF, so unlike json -p print mode there is no deadlock.
				// Orphan detection is heartbeat-based (see installChildWatchdog).
				stdio: ["pipe", "pipe", "pipe"],
				env: {
					...process.env,
					PI_ORCHESTRATOR_CHILD: "1",
					PI_ORCHESTRATOR_BLOCKED_TOOLS: blockedTools.join(","),
					// Only set when parent-prompt forwarding produced a file
					// (config forwardParentPrompt; see installChildParentPrompt
					// in index.ts).
					...(parentPromptFilePath ? { PI_ORCHESTRATOR_PARENT_PROMPT_FILE: parentPromptFilePath } : {}),
				},
			});
			liveProcs.add(proc);
			// Swallow EPIPE: the child may die before/while we write a command.
			proc.stdin?.on("error", () => {});
			// Track for the fleet widget
			fleetTask.turns = 0;
			fleetTask.toolTurns = 0;
			runningTasks.set(agentKey, fleetTask);
			onFleetChange();

			/** SIGTERM the child, escalating to SIGKILL after 5s. */
			const killChild = () => {
				try {
					proc.kill("SIGTERM");
				} catch {
					/* already gone */
				}
				// Escalate unconditionally: proc.killed only reflects a
				// successful kill() CALL, not process death, so gating on it
				// was dead code — a child trapping/ignoring SIGTERM would
				// linger forever. Killing an already-exited child is a
				// silent no-op (or caught below).
				const t = setTimeout(() => {
					try {
						proc.kill("SIGKILL");
					} catch {
						/* already gone */
					}
				}, 5000);
				t.unref();
			};
			// Run-watcher hook (ADR-0014): the watcher's cancel/abort path kills
			// through this handle; a cancel racing a slow spawn is caught here.
			registerKill?.(killChild);

			// Interval body references killChild, so the timer starts inside
			// the executor. Cleared by stopStallWatchdog() on every terminal
			// path (settle, budget kill, stall kill, abort, close/error).
			stallTimer = setInterval(() => {
				if (!watchdogActive || settled || wasAborted) return;
				if (Date.now() - lastEventAt <= stallTimeoutMs) return;
				stopStallWatchdog();
				currentResult.stopReason = "stall-timeout";
				currentResult.errorMessage =
					`Stall timeout: no output for ${Math.round(stallTimeoutMs / 1000)}s ` +
					`(killed after ${currentResult.usage.turns} turns). Captured output up to this point is preserved.`;
				currentResult.completedNormally = false;
				killChild();
			}, STALL_CHECK_INTERVAL_MS);
			stallTimer.unref?.();

			// Awaited RPC commands (sub-session setup): id-matched waiters, fed
			// from processLine and unblocked en masse by close/error.
			const rpcWaiters = createRpcWaiters((obj) => sendRpc(proc, obj), RPC_SETUP_TIMEOUT_MS);

			const processLine = (line: string) => {
				// Every stdout line counts as activity — response lines, message
				// deltas, tool events, even unparseable noise (ADR-0006).
				lastEventAt = Date.now();
				if (!line.trim()) return;
				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}

				// Command responses (rpc.md): the prompt was rejected before
				// acceptance → fail the run. Failures AFTER acceptance arrive
				// through the normal event stream instead.
				if (event.type === "response") {
					// Awaited session-setup commands (get_state / new_session)
					// settle their waiter here; unknown ids are ignored.
					rpcWaiters.deliver(event);
					if (event.id === "init" && event.success === false) {
						stopStallWatchdog();
						currentResult.stopReason = "error";
						currentResult.errorMessage = `RPC prompt rejected: ${event.error || "unknown error"}`;
						killChild();
					}
					return;
				}

				// Headless fail-closed (ADR-0005): dialog methods (select/
				// confirm/input/editor) block until answered — with no user
				// watching they would hang the child forever. Cancel them.
				// Fire-and-forget methods (notify, setWidget, ...) need no reply.
				if (event.type === "extension_ui_request" && event.id) {
					if (event.method === "select" || event.method === "confirm" || event.method === "input" || event.method === "editor") {
						sendRpc(proc, { type: "extension_ui_response", id: event.id, cancelled: true });
					}
					return;
				}

				if (event.type === "message_end" && event.message) {
					const msg = event.message as Message;
					// Collect every conversation message (assistant / user /
					// toolResult). RPC mode has no tool_result_end event.
					currentResult.messages.push(msg);

					if (msg.role === "assistant") {
						const usage = msg.usage;
						if (usage) {
							currentResult.usage.input += usage.input || 0;
							currentResult.usage.output += usage.output || 0;
							currentResult.usage.cacheRead += usage.cacheRead || 0;
							currentResult.usage.cacheWrite += usage.cacheWrite || 0;
							currentResult.usage.cost += usage.cost?.total || 0;
							currentResult.usage.contextTokens = usage.totalTokens || 0;
							fleetTask.contextTokens = currentResult.usage.contextTokens;
							fleetTask.inputTokens = currentResult.usage.input;
							fleetTask.outputTokens = currentResult.usage.output;
						}
						if (!currentResult.model && msg.model) currentResult.model = msg.model;
						// Terminal reasons set by the stall/budget killers must
						// win over buffered stdout events arriving after the kill
						// (first killer wins; a trailing message_end must not
						// overwrite "stall-timeout"/"turn-budget-exhausted").
						if (
							msg.stopReason &&
							currentResult.stopReason !== "turn-budget-exhausted" &&
							currentResult.stopReason !== "stall-timeout"
						) {
							currentResult.stopReason = msg.stopReason;
						}
						if (msg.errorMessage) currentResult.errorMessage = msg.errorMessage;
					}
					emitUpdate();
					onFleetChange();
				}

				// One assistant turn = one turn_end with an assistant message.
				if (event.type === "turn_end" && event.message?.role === "assistant" && !settled) {
					currentResult.usage.turns++;
					fleetTask.turns = currentResult.usage.turns;
					if (isToolTurn(event.message as Message, event.toolResults)) {
						currentResult.usage.toolTurns++;
						fleetTask.toolTurns = currentResult.usage.toolTurns;
					}

					// Two-stage turn budget (ADR-0006): soft grace at the
					// budget (once), hard kill after the grace margin.
					if (currentResult.usage.turns === maxTurns && !budgetWarned) {
						budgetWarned = true;
						// Tolerate rejection (e.g. agent not streaming anymore).
						sendRpc(proc, {
							type: "steer",
							message: "You are near your turn budget. Wrap up now and deliver your final answer.",
						});
					}
					if (currentResult.usage.turns >= maxTurns + TURN_BUDGET_GRACE) {
						stopStallWatchdog();
						// First killer wins: buffered turn_end lines after a
						// stall kill must not relabel the run as budget-exhausted.
						// (The stall side is already guarded: budget kill calls
						// stopStallWatchdog() first, so the stall timer no-ops.)
						if (currentResult.stopReason !== "stall-timeout") {
							currentResult.stopReason = "turn-budget-exhausted";
							currentResult.errorMessage =
								`Turn budget exhausted: hard-killed at turn ${currentResult.usage.turns} ` +
								`(soft grace steered at turn ${maxTurns}, hard limit ${maxTurns + TURN_BUDGET_GRACE}). ` +
								`Captured output up to this turn is preserved.`;
							currentResult.completedNormally = false;
						}
						killChild();
					}
					onFleetChange();
				}

				// RPC mode never exits on its own: settled means done. Success
				// is state-based (this event), not exit-code-based. Kill the
				// child — the exit code is informational only.
				if (event.type === "agent_settled" && !settled) {
					settled = true;
					stopStallWatchdog();
					if (currentResult.stopReason !== "turn-budget-exhausted" && currentResult.stopReason !== "stall-timeout") {
						currentResult.completedNormally = true;
					}
					killChild();
					onFleetChange();
				}
			};

			attachJsonlReader(proc.stdout!, processLine);

			proc.stderr.on("data", (data) => {
				currentResult.stderr += data.toString();
			});

			const cleanup = () => {
				stopStallWatchdog();
				liveProcs.delete(proc);
				runningTasks.delete(agentKey);
				onFleetChange();
			};

			proc.on("close", (code) => {
				cleanup();
				// Unblock any session-setup waiters — the child is gone, so their
				// responses will never arrive. flush() with null skips the link.
				rpcWaiters.flush();
				resolveExit(code ?? 0);
			});

			proc.on("error", (err: unknown) => {
				// A spawn/stdio error must not collapse into a silent "(no output)":
				// record the reason so the failure is attributable (the ENOENT case
				// used to be indistinguishable from a child that simply said nothing).
				const detail = (err as Error)?.message ?? String(err);
				const code = (err as { code?: string })?.code;
				if (!currentResult.errorMessage) {
					currentResult.errorMessage = `pi child process error${code ? ` (${code})` : ""}: ${detail}`;
				}
				currentResult.stderr += currentResult.stderr ? NL + detail : detail;
				cleanup();
				rpcWaiters.flush();
				resolveExit(1);
			});

			if (signal) {
				const killProc = () => {
					wasAborted = true;
					stopStallWatchdog();
					proc.kill("SIGTERM");
					// Unconditional escalation — see killChild above for why a
					// proc.killed gate would be dead code.
					const t = setTimeout(() => {
						try {
							proc.kill("SIGKILL");
						} catch {
							/* already gone */
						}
					}, 5000);
					t.unref();
				};
				if (signal.aborted) killProc();
				else signal.addEventListener("abort", killProc, { once: true });
			}

			// Sub-session setup (ADR-0011), best-effort and strictly ordered
			// before the prompt: pi materializes the session file lazily on the
			// first message, so issuing `new_session {parentSession}` here links
			// the session the prompt lands in (parentSession lands in the v3
			// header) and the abandoned startup session never touches disk.
			// Failures/timeouts/cancellations skip the link; they never fail the
			// run. No awaits in the executor itself — the sync executor must not
			// become an async one.
			const setupSubSession = async (): Promise<void> => {
				try {
					const before = await rpcWaiters.command({ type: "get_state" }, "sess-before");
					if (before?.data?.sessionFile) {
						currentResult.sessionId = before.data.sessionId;
						currentResult.sessionFile = before.data.sessionFile;
					}
					if (sessionOpts.parentSessionFile) {
						const resp = await rpcWaiters.command(
							{ type: "new_session", parentSession: sessionOpts.parentSessionFile },
							"sess-link",
						);
						if (resp?.success && resp.data?.cancelled === false) {
							const after = await rpcWaiters.command({ type: "get_state" }, "sess-after");
							if (after?.data?.sessionFile) {
								currentResult.sessionId = after.data.sessionId;
								currentResult.sessionFile = after.data.sessionFile;
							}
						}
					}
					sendRpc(proc, {
						type: "set_session_name",
						name: `orch: ${agent.name} — ${truncateWithEllipsis(task.replace(/\s+/g, " "), MAX_TASK_SUMMARY_CHARS)}`,
					});
				} catch {
					/* best-effort: a dead child or malformed response just skips the link */
				}
			};

			const sessionSetup = persistSessions ? setupSubSession() : Promise.resolve();
			sessionSetup.finally(() => {
				// Kick off the task once the session is linked. Sending via stdin
				// is why stdin is a pipe; a rejected prompt is failed via the
				// "init" response above.
				if (!wasAborted) sendRpc(proc, { id: "init", type: "prompt", message: `Task: ${task}` });
			});
		});

		currentResult.exitCode = exitCode;
		if (wasAborted) throw new Error("Subagent was aborted");
		return currentResult;
	} finally {
		if (tmpPromptPath)
			try {
				fs.unlinkSync(tmpPromptPath);
			} catch {
				/* ignore */
			}
		if (tmpPromptDir)
			try {
				fs.rmdirSync(tmpPromptDir);
			} catch {
				/* ignore */
			}
		if (parentPromptFilePath)
			try {
				fs.unlinkSync(parentPromptFilePath);
			} catch {
				/* ignore */
			}
		if (tmpParentPromptDir)
			try {
				fs.rmdirSync(tmpParentPromptDir);
			} catch {
				/* ignore */
			}
	}
}

// ── Tool schema ─────────────────────────────────────────────────────────────

/**
 * Agent-name schema shared by single mode, tasks[], and chain[]. When the
 * fleet is non-empty, the names are published as a JSON-Schema `enum` so the
 * model picks from real names instead of inventing plausible ones (the
 * every-first-turn mangle: free-form string + prose roles ⇒ hallucinated
 * agent names). Empty fleet falls back to free-form, and the enum reflects
 * the fleet at registration time — the always-fresh truth lives in the
 * `list` action and the unknown-agent error.
 */
export function agentNameParam(description: string, fleetNames: string[]) {
	return Type.String({
		description: fleetNames.length > 0 ? `${description} Valid names: ${fleetNames.join(", ")}.` : description,
		...(fleetNames.length > 0 ? { enum: fleetNames } : {}),
	});
}

/**
 * Parameter schema for one fleet state. Rebuilt per registration so the
 * `enum` on every agent-name field lists the agents discovered at extension
 * load (builtin + user + project for the session cwd).
 */
export function buildDelegateParams(fleetNames: string[]) {
	return Type.Object({
		action: Type.Optional(
			Type.String({
				enum: ["list", "sessions", "status", "cancel"],
				description:
					"Discovery/control actions: {action: 'list'} returns the current fleet; {action: 'sessions'} lists this session's persistent subagent sub-sessions; {action: 'status'} lists live runs; {action: 'cancel', runId} kills one run. Use these instead of polling.",
			}),
		),
		runId: Type.Optional(Type.Number({ description: "Run id (required for the cancel action)" })),
		async: Type.Optional(
			Type.Boolean({
				description:
					"Async dispatch (default true): the call returns an acceptance immediately and the settled result is delivered into the conversation automatically. Pass false to block until the final result (quick lookups). Chain mode is always blocking.",
			}),
		),
		agent: Type.Optional(agentNameParam("Agent name (single mode)", fleetNames)),
		task: Type.Optional(Type.String({ description: "Task to delegate (single mode)" })),
		tasks: Type.Optional(
			Type.Array(
				Type.Object({
					agent: agentNameParam("Name of the agent to invoke", fleetNames),
					task: Type.String({ description: "Task to delegate to the agent" }),
					cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
				}),
				{ description: "Parallel mode: array of {agent, task}. Max 8." },
			),
		),
		chain: Type.Optional(
			Type.Array(
				Type.Object({
					agent: agentNameParam("Agent name for this step", fleetNames),
					task: Type.String({ description: "Task; {previous} inserts the prior step's output" }),
					cwd: Type.Optional(Type.String({ description: "Working directory" })),
				}),
				{ description: "Chain mode: sequential steps; {previous} in task inserts prior output" },
			),
		),
		cwd: Type.Optional(Type.String({ description: "Working directory (single mode)" })),
	});
}

// ── Registration ──────────────────────────────────────────────────────────

/** Custom-message type for async run deliveries (ADR-0014). */
const RUN_RESULT_MESSAGE_TYPE = "orchestrator-run-result";

/**
 * Append the touched-files line (derived from the run's own messages) to
 * returned/delivered text — \n\n-joined, omitted entirely when nothing touched.
 */
function withTouchedFiles(text: string, messages: Message[]): string {
	const files = formatTouchedFiles(collectTouchedFiles(messages));
	return files ? `${text}\n\n${files}` : text;
}

/** Human/model-facing elapsed formatting for the status action. */
function formatElapsed(ms: number): string {
	const s = Math.floor(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
	const h = Math.floor(m / 60);
	return `${h}h${String(m % 60).padStart(2, "0")}m`;
}

/** Status line for one delivered run (async result push, ADR-0014). */
function deliveryText(delivery: RunDelivery): string {
	const r = delivery.result;
	const failed = isFailedResult(r);
	const header = delivery.cancelled
		? `✗ Run ${delivery.runId} — ${delivery.agent} — cancelled`
		: failed
			? `✗ Run ${delivery.runId} — ${delivery.agent} — failed${r.stopReason ? ` (${r.stopReason})` : ""}`
			: `✓ Run ${delivery.runId} — ${delivery.agent} — completed`;
	const body = delivery.cancelled
		? `Cancelled by orchestrator.\n\n${getResultOutput(r)}`
		: failed
			? `Agent ${r.stopReason || "failed"}: ${getResultOutput(r)}`
			: getFinalOutput(r.messages) || "(no output)";
	return `${header}\n\n${withTouchedFiles(withSessionNote(r, body), r.messages)}`;
}

export interface DelegateDeps {
	getAgents: () => AgentConfig[];
	getDispatchDefaults: (ctx: any) => DispatchDefaults;
	getCwd: () => string;
	getSignal: () => AbortSignal | undefined;
	/** Async result deliveries auto-resume the orchestrator when idle (ADR-0014).
	 *  Required - without it a settled run's push is silently dropped. */
	onIdle: () => void;
	/** The child runner. Defaults to the real runSingleAgent; tests inject a
	 *  fake here to drive dispatch without spawning pi processes. */
	runAgent?: RunAgent;
	/** Current orchestrator state for the fleet widget label (ADR-0003):
	 *  `engaged` while the gate forces delegation, `auto` when it does not.
	 *  Required — a defaulted label would put the widget back to guessing, and
	 *  a guessed label is exactly the lie this reports. */
	getOrchestratorMode: () => OrchestratorMode;
	/** Default turn budget from orchestrator.json `maxTurns` (ADR-0006);
	 *  per-agent frontmatter `maxTurns` overrides this. Falls back to 50. */
	getMaxTurns?: () => number;
	/** Stall timeout in ms from orchestrator.json `stallTimeoutMs` (ADR-0006).
	 *  Falls back to 10 minutes. */
	getStallTimeoutMs?: () => number;
	/** Tool matchers blocked in every subagent (ADR-0007), from orchestrator.json
	 *  `childBlockedTools`. Falls back to none (gate not installed child-side). */
	getChildBlockedTools?: () => string[];
	/** Extension sources (orchestrator.json `childExtensions`) loaded in every
	 *  child via pi's repeatable `-e` flag; non-empty also spawns children with
	 *  `--no-extensions` (ADR-0008). Falls back to inherit-all. */
	getChildExtensions?: () => string[];
	/** Whether to append the parent's system prompt to every subagent's
	 *  system prompt (orchestrator.json `forwardParentPrompt`). Falls back
	 *  to false (no forwarding). */
	getForwardParentPrompt?: () => boolean;
	/** The parent's pre-policy system prompt, captured per turn by the
	 *  before_agent_start hook. Undefined until captured (or in child mode). */
	getParentPrompt?: () => string | undefined;
	/** Persistent sub-sessions (orchestrator.json `childSessions`, ADR-0011).
	 *  Falls back to true (sessions on). */
	getChildSessions?: () => boolean;
	/** The parent's own session file (ctx.sessionManager.getSessionFile()) —
	 *  recorded in each child's header via RPC `new_session {parentSession}`
	 *  and used to place child sessions in the parent's session dir.
	 *  Undefined when the parent runs ephemeral (--no-session). */
	getParentSessionFile?: (ctx: any) => string | undefined;
}

/**
 * One-line entry for the `list` action's fleet report.
 */
function formatAgentListing(a: AgentConfig): string {
	const attrs = [
		a.source,
		a.tools ? `tools: ${a.tools.join(", ")}` : "full tools",
		a.model ? `model: ${a.model}` : undefined,
		a.maxTurns ? `maxTurns: ${a.maxTurns}` : undefined,
	].filter(Boolean);
	return `- **${a.name}** (${attrs.join(", ")}): ${a.description}`;
}

export function registerDelegateTool(pi: any, deps: DelegateDeps): void {
	// The fleet enum lives in the schema, not just the prose: the model
	// generates against the tool schema, so listing real names there is what
	// stops the first-call hallucinated-agent mangle (prose policy text alone
	// lost that fight in practice — see the saifymatteo first-turn failures).
	// It reflects the fleet at registration time; the `list` action below is
	// the always-fresh truth.
	const fleetNames = deps.getAgents().map((a) => a.name);
	const runAgentCall: RunAgent = deps.runAgent ?? runSingleAgent;

	// Run watcher (ADR-0014): owns async run lifecycle outliving tool calls.
	// Settled results are pushed into the conversation (auto-resume when idle,
	// followUp queue when mid-turn) — the orchestrator never polls.
	const watcher = createRunWatcher({
		deliver: (delivery) => {
			try {
				pi.sendMessage?.(
					{
						customType: RUN_RESULT_MESSAGE_TYPE,
						content: [{ type: "text", text: deliveryText(delivery) }],
						display: true,
						details: {
							mode: "single",
							results: [delivery.result],
							runId: delivery.runId,
							cancelled: delivery.cancelled,
						} satisfies SubagentDetails,
					},
					{ triggerTurn: true, deliverAs: "followUp" },
				);
			} catch {
				/* delivery surface unavailable — the ADR-0011 sub-session transcript survives */
			}
		},
		onIdle: () => deps.onIdle(),
		now: () => Date.now(),
	});

	activeWatcher = watcher;

	// Transcript rendering for delivered run results: a compact push view —
	// status icon, run id, agent, task, first output line; expands to the
	// full delivered text (same content the model sees).
	pi.registerMessageRenderer?.(RUN_RESULT_MESSAGE_TYPE, (message: any, options: any, theme: any) => {
		const details = message?.details as SubagentDetails | undefined;
		const r = details?.results?.[0];
		const fullText = Array.isArray(message?.content) && message.content[0]?.type === "text" ? message.content[0].text : "(run result)";
		if (!r) return new Text(fullText, 0, 0);
		const icon = taskStatus(r, false) === "failed" ? "✗" : "✓";
		const head = `${icon} Run ${details.runId ?? "?"} — ${r.agent}`;
		if (options?.expanded === true) return new Text(`${theme.fg("toolTitle", theme.bold(head))}\n${fullText}`, 0, 0);
		const bodyLines = fullText.split("\n").map((l: string) => l.trim()).filter(Boolean);
		const first = bodyLines.find((l: string) => !l.startsWith("✓") && !l.startsWith("✗")) ?? "";
		return new Text(`${theme.fg("toolTitle", theme.bold(head))} ${theme.fg("muted", r.task)}\n${theme.fg("muted", first.slice(0, 160))}`, 0, 0);
	});

	// ESC kill for async children (ADR-0014): pi exposes no abort event, but an
	// aborted turn's final assistant message carries stopReason "aborted". ESC
	// while the orchestrator streams therefore kills the whole fleet (blocking
	// children via their tool-call signal, async children via the watcher);
	// ESC while fully idle is a pi-level no-op and cannot be observed.
	pi.on?.("agent_end", (event: any) => {
		const messages: any[] = event?.messages ?? [];
		const last = messages[messages.length - 1];
		if (last?.role === "assistant" && last?.stopReason === "aborted") watcher.abortAll();
	});

	pi.registerTool({
		name: "delegate",
		label: "Delegate",
		description:
			"Delegate work to a fleet subagent with an isolated context and full tools. " +
			"Dispatch is ASYNC BY DEFAULT: the call returns an acceptance (run id) immediately and each settled result is delivered into this conversation automatically — never poll. " +
			"Modes: single ({agent, task}), parallel ({tasks: [{agent, task}]}, max 8), " +
			"chain ({chain: [{agent, task}]}, sequential and blocking, {previous} placeholder inserts the prior step's output), " +
			"blocking escape hatch ({async: false} waits for the final result — quick lookups), " +
			"discovery/control ({action: 'list'} fleet; {action: 'sessions'} sub-sessions; {action: 'status'} live runs; {action: 'cancel', runId} kill one). " +
			"Agent names must be exact fleet names — never invent one; when unsure, list first. " +
			"Each dispatch returns a Subagent session path — the subagent's persistent pi transcript — that you can pass to another subagent for a deeper look. " +
			"This is your only way to read, write, edit, search, or run commands.",
		parameters: buildDelegateParams(fleetNames),

		async execute(_toolCallId: string, params: any, signal: AbortSignal | undefined, onUpdate: any, ctx: any) {
			const agents = deps.getAgents();

			// Discovery action (zero-cost): report the live fleet — recomputed per
			// call, so it reflects agents added after registration (the schema
			// enum cannot). Cheap enough to call on every first-turn uncertainty.
			if (params?.action === "list") {
				const listing = agents.map(formatAgentListing).join("\n") || "(fleet is empty — no agents discovered)";
				return {
					content: [
						{
							type: "text",
							text: `Fleet (agents available via delegate):\n${listing}`,
						},
					],
					details: { mode: "single", results: [] },
				};
			}

			// Sub-session listing (ADR-0011): every persistent child session
			// linked to THIS parent session, derived from disk (header
			// parentSession) — so it survives restarts/resumes and needs no
			// in-memory bookkeeping. The parent can hand a sub-session file to
			// another subagent (e.g. "review what the worker actually did:
			// <file>") instead of trusting the compressed summary.
			if (params?.action === "sessions") {
				const parentSessionFile = deps.getParentSessionFile?.(ctx);
				if (!parentSessionFile) {
					return {
						content: [
							{
								type: "text",
								text: "Sub-session listing unavailable: the parent session is ephemeral (no session file).",
							},
						],
						details: { mode: "single", results: [] },
					};
				}
				const subs = scanSubSessions(path.dirname(parentSessionFile), parentSessionFile);
				const listing =
					subs.map((s) => `- ${s.timestamp ?? "(unknown time)"}  ${s.id ?? "(no id)"}\n  ${s.file}`).join("\n") ||
					"(no sub-sessions recorded yet — they appear after a subagent's first message)";
				return {
					content: [
						{
							type: "text",
							text: `Sub-sessions of this session (persistent subagent transcripts):\n${listing}`,
						},
					],
					details: { mode: "single", results: [] },
				};
			}
			// ── Async run control (ADR-0014) ─────────────────────────────
			// status: list live runs (id, agent, task, elapsed) — how the
			// orchestrator re-finds in-flight work after compaction or a long
			// conversation. cancel: surgical single-run kill.
			if (params?.action === "status") {
				const entries = watcher.entries();
				const listing =
					entries
						.map(
							(e) =>
								`- run ${e.runId} · ${e.agent} · "${truncateWithEllipsis(e.task.replace(/\s+/g, " "), MAX_TASK_SUMMARY_CHARS)}" · ${formatElapsed(e.elapsedMs)}`,
						)
						.join("\n") || "";
				return {
					content: [
						{
							type: "text",
							text: entries.length
								? `Live runs (${entries.length}):\n${listing}\n\nResults are delivered automatically as runs settle — no polling. {action: "cancel", runId} stops one; {action: "sessions"} lists finished transcripts.`
								: "(no live runs — dispatch with {agent, task}; results are delivered automatically as runs settle. {action: \"sessions\"} lists finished subagent transcripts.)",
						},
					],
					details: { mode: "single", results: [] },
				};
			}
			if (params?.action === "cancel") {
				if (typeof params.runId !== "number" || !Number.isInteger(params.runId)) {
					return {
						content: [
							{
								type: "text",
								text: 'Cancel requires the run id: {action: "cancel", runId: <number>}. Use {action: "status"} to list live runs.',
							},
						],
						details: { mode: "single", results: [] },
						isError: true,
					};
				}
				const out = watcher.cancel(params.runId);
				if (!out.ok) {
					return {
						content: [{ type: "text", text: `Cancel failed: ${out.error}` }],
						details: { mode: "single", results: [] },
						isError: true,
					};
				}
				return {
					content: [
						{
							type: "text",
							text: `Run ${params.runId} cancelled: kill signal sent. Its final state is delivered automatically when the child exits.`,
						},
					],
					details: { mode: "single", results: [] },
				};
			}

			const dispatchDefaults = deps.getDispatchDefaults(ctx);
			const defaultMaxTurns = deps.getMaxTurns?.() ?? DEFAULT_MAX_TURNS;
			const stallTimeoutMs = deps.getStallTimeoutMs?.() ?? DEFAULT_STALL_TIMEOUT_MS;
			// Per-agent frontmatter `maxTurns` overrides the config default (ADR-0006).
			const resolveMaxTurns = (agentName: string): number =>
				agents.find((a) => a.name === agentName)?.maxTurns ?? defaultMaxTurns;
			// Blocked tools (ADR-0007): additive union of the global config policy
			// floor (deps.getChildBlockedTools) and per-agent frontmatter
			// `blockTools` — per-agent matchers can only extend the block list,
			// never re-grant a globally blocked tool.
			const resolveBlockedTools = (agentName: string): string[] => {
				const a = agents.find((x) => x.name === agentName);
				return [...new Set([...(deps.getChildBlockedTools?.() ?? []), ...(a?.blockTools ?? [])])];
			};
			// Child extension loading (ADR-0008): read live per invocation; no
			// per-agent override — extension loading is a fleet-wide concern, not
			// an agent-frontmatter one. Non-empty ⇒ --no-extensions + -e entries.
			const extensions = deps.getChildExtensions?.() ?? [];
			// Parent prompt forwarding: only when enabled in config; undefined when
			// off or not yet captured (child mode / first turn) — nothing appended.
			const parentPrompt = deps.getForwardParentPrompt?.() ? deps.getParentPrompt?.() : undefined;
			const makeDetails =
				(mode: "single" | "parallel" | "chain") =>
				(results: SingleResult[]): SubagentDetails => ({ mode, results });

			const fleetChanged = () => updateFleetWidget(ctx, agents.map((a) => a.name), deps.getOrchestratorMode());
			// Unique per invocation: concurrent delegate calls must not collide on
			// runningTasks keys, or the fleet header undercounts running agents.
			// Async dispatches assign per-task ids inside startAsyncRun instead.

			// ── Async dispatch (ADR-0014) ────────────────────────────────
			// One accepted run per task; the watcher owns the lifecycle outliving
			// this tool call and pushes the settled result into the conversation.
			const startAsyncRun = (
				agentName: string,
				taskText: string,
				mode: "single" | "parallel",
				index: number | undefined,
				taskCwd: string | undefined,
			): AcceptedRun => {
				const asyncRunId = nextFleetRunId();
				return watcher.start({
					runId: asyncRunId,
					agent: agentName,
					task: taskText,
					mode,
					widgetKey: fleetKey(asyncRunId, mode, index),
					start: ({ registerKill }) =>
						runAgentCall({
							defaultCwd: deps.getCwd(),
							agentKey: fleetKey(asyncRunId, mode, index),
							dispatchDefaults,
							agents,
							agentName,
							task: taskText,
							maxTurns: resolveMaxTurns(agentName),
							stallTimeoutMs,
							blockedTools: resolveBlockedTools(agentName),
							extensions,
							parentPrompt,
							getAllTools: () => pi.getAllTools(),
							cwd: taskCwd,
							step: undefined,
							// No tool-call signal: the run outlives this call; the
							// watcher's kill handle owns the child (ADR-0014).
							signal: undefined,
							onUpdate: undefined,
							makeDetails: makeDetails(mode),
							fleetMode: mode,
							onFleetChange: fleetChanged,
							// Sub-session policy (ADR-0011)
							sessionOpts: { persist: deps.getChildSessions?.() ?? true, parentSessionFile: deps.getParentSessionFile?.(ctx) },
							registerKill,
						}),
				});
			};

			// Acceptance result: run ids + the no-poll instruction. Results
			// arrive as pushed messages — the orchestrator must not wait.
			const acceptedResult = (runs: AcceptedRun[]) => ({
				content: [
					{
						type: "text",
						text:
							`Accepted ${runs.length === 1 ? `run ${runs[0].runId} — ${runs[0].agent}` : `${runs.length} runs`}:\n` +
							runs.map((r) => `- run ${r.runId} — ${r.agent}: "${truncateWithEllipsis(r.task.replace(/\s+/g, " "), MAX_TASK_SUMMARY_CHARS)}"`).join("\n") +
							"\n\nResults are delivered automatically as each subagent settles — do not poll and do not keep this turn alive waiting. Dispatch more work, respond to the user, or end your turn. " +
							'{action: "status"} lists live runs; {action: "cancel", runId} stops one; {action: "sessions"} lists finished transcripts.',
					},
				],
				details: { mode: "accepted", results: [] } satisfies SubagentDetails,
			});

			// Unknown-agent validation for the async path: a synchronous error at
			// dispatch — never an acceptance, so the orchestrator never waits for
			// a result that cannot come (ADR-0014 failure split).
			const unknownAsyncAgents = (names: string[]): string[] => [...new Set(names)].filter((n) => !agents.some((a) => a.name === n));

			const hasChain = (params.chain?.length ?? 0) > 0;
			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const hasSingle = Boolean(params.agent && params.task);
			const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);

			if (modeCount !== 1) {
				const available = agents.map((a) => a.name).join(", ") || "none";
				return {
					content: [
						{
							type: "text",
							text: `Invalid parameters: provide exactly one of {agent+task}, {tasks[]}, {chain[]} — or {action: "list"} to see the fleet.\nAvailable agents: ${available}`,
						},
					],
					details: makeDetails("single")([]),
				};
			}

			try {
				if (params.chain && params.chain.length > 0) {
					if (params.async === true) {
						return {
							content: [
								{
									type: "text",
									text: 'Chain dispatch is always blocking: {previous} substitution needs each prior result in-process. Drop async (or pass async: false) and the chain runs to completion in this call.',
								},
							],
							details: makeDetails("chain")([]),
							isError: true,
						};
					}
					const runId = nextFleetRunId();
					const results: SingleResult[] = [];
					let previousOutput = "";

					for (let i = 0; i < params.chain.length; i++) {
						const step = params.chain[i];
						const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);

						const chainUpdate: OnUpdateCallback | undefined = onUpdate
							? (partial) => {
									const currentResult = partial.details?.results[0];
									if (currentResult) {
										const allResults = [...results, currentResult];
										onUpdate({
											content: partial.content,
											details: makeDetails("chain")(allResults),
										});
									}
								}
							: undefined;

						const result = await runAgentCall({
							defaultCwd: deps.getCwd(),
							agentKey: fleetKey(runId, "chain", i),
							dispatchDefaults,
							agents,
							agentName: step.agent,
							task: taskWithContext,
							maxTurns: resolveMaxTurns(step.agent),
							stallTimeoutMs,
							blockedTools: resolveBlockedTools(step.agent),
							extensions,
							parentPrompt,
							getAllTools: () => pi.getAllTools(),
							cwd: step.cwd,
							step: i + 1,
							signal: signal ?? deps.getSignal(),
							onUpdate: chainUpdate,
							makeDetails: makeDetails("chain"),
							fleetMode: "chain",
							onFleetChange: fleetChanged,
							// Sub-session policy (ADR-0011)
							sessionOpts: { persist: deps.getChildSessions?.() ?? true, parentSessionFile: deps.getParentSessionFile?.(ctx) },
						});
						results.push(result);

						if (isFailedResult(result)) {
							return {
								content: [{ type: "text", text: `Chain stopped at step ${i + 1} (${step.agent}): ${getResultOutput(result)}` }],
								details: makeDetails("chain")(results),
								isError: true,
							};
						}
						previousOutput = getFinalOutput(result.messages);
					}
					const lastResult = results[results.length - 1];
					return {
						content: [
							{
								type: "text",
								text: withTouchedFiles(withSessionNote(lastResult, getFinalOutput(lastResult.messages) || "(no output)"), lastResult.messages),
							},
						],
						details: makeDetails("chain")(results),
					};
				}

				if (params.tasks && params.tasks.length > 0) {
					if (params.tasks.length > MAX_PARALLEL_TASKS) {
						return {
							content: [{ type: "text", text: `Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.` }],
							details: makeDetails("parallel")([]),
						};
					}

					if (params.async !== false) {
						const unknown = unknownAsyncAgents((params.tasks as { agent: string }[]).map((t) => t.agent));
						if (unknown.length > 0) {
							const available = agents.map((a) => a.name).join(", ") || "none";
							return {
								content: [{ type: "text", text: `Unknown agent(s): ${unknown.join(", ")}. Available: ${available}` }],
								details: makeDetails("parallel")([]),
								isError: true,
							};
						}
						return acceptedResult(
							(params.tasks as { agent: string; task: string; cwd?: string }[]).map((t, index) => startAsyncRun(t.agent, t.task, "parallel", index, t.cwd)),
						);
					}

					const runId = nextFleetRunId();
					const allResults: SingleResult[] = new Array(params.tasks.length);
					for (let i = 0; i < params.tasks.length; i++) {
						allResults[i] = {
							agent: params.tasks[i].agent,
							agentSource: "unknown",
							task: params.tasks[i].task,
							exitCode: -1,
							completedNormally: false,
							messages: [],
							stderr: "",
							usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0, toolTurns: 0 },
						};
					}

					const emitParallelUpdate = () => {
						if (onUpdate) {
							onUpdate({
								content: [{ type: "text", text: parallelProgress(allResults) }],
								details: makeDetails("parallel")([...allResults]),
							});
						}
					};

					const results = await mapWithConcurrencyLimit(
						params.tasks as { agent: string; task: string; cwd?: string }[],
						MAX_CONCURRENCY,
						async (t, index) => {
							const result = await runAgentCall({
								defaultCwd: deps.getCwd(),
								agentKey: fleetKey(runId, "parallel", index),
								dispatchDefaults,
								agents,
								agentName: t.agent,
								task: t.task,
								maxTurns: resolveMaxTurns(t.agent),
								stallTimeoutMs,
								blockedTools: resolveBlockedTools(t.agent),
								extensions,
								parentPrompt,
								getAllTools: () => pi.getAllTools(),
								cwd: t.cwd,
								step: undefined,
								signal: signal ?? deps.getSignal(),
								onUpdate: (partial) => {
									if (partial.details?.results[0]) {
										allResults[index] = partial.details.results[0];
										emitParallelUpdate();
									}
								},
								makeDetails: makeDetails("parallel"),
								fleetMode: "parallel",
								onFleetChange: fleetChanged,
								// Sub-session policy (ADR-0011)
								sessionOpts: { persist: deps.getChildSessions?.() ?? true, parentSessionFile: deps.getParentSessionFile?.(ctx) },
							});
							allResults[index] = result;
							emitParallelUpdate();
							return result;
						},
					);

					const successCount = results.filter((r) => !isFailedResult(r)).length;
					const summaries = results.map((r) => {
						const output = truncateParallelOutput(getResultOutput(r));
						const status = isFailedResult(r)
							? `failed${r.stopReason && r.stopReason !== "end" ? ` (${r.stopReason})` : ""}`
							: "completed";
						return withTouchedFiles(`### [${r.agent}] ${status}\n\n${output}`, r.messages);
					});
					return {
						content: [
							{ type: "text", text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n---\n\n")}` },
						],
						details: makeDetails("parallel")(results),
					};
				}

				if (params.agent && params.task) {
					if (params.async !== false) {
						const unknown = unknownAsyncAgents([params.agent]);
						if (unknown.length > 0) {
							const available = agents.map((a) => a.name).join(", ") || "none";
							return {
								content: [{ type: "text", text: `Unknown agent "${params.agent}". Available: ${available}` }],
								details: makeDetails("single")([]),
								isError: true,
							};
						}
						return acceptedResult([startAsyncRun(params.agent, params.task, "single", undefined, params.cwd)]);
					}

					const runId = nextFleetRunId();
					const result = await runAgentCall({
						defaultCwd: deps.getCwd(),
						agentKey: fleetKey(runId, "single"),
						dispatchDefaults,
						agents,
						agentName: params.agent,
						task: params.task,
						maxTurns: resolveMaxTurns(params.agent),
						stallTimeoutMs,
						blockedTools: resolveBlockedTools(params.agent),
						extensions,
						parentPrompt,
						getAllTools: () => pi.getAllTools(),
						cwd: params.cwd,
						step: undefined,
						signal: signal ?? deps.getSignal(),
						onUpdate,
						makeDetails: makeDetails("single"),
						fleetMode: "single",
						onFleetChange: fleetChanged,
						// Sub-session policy (ADR-0011)
						sessionOpts: { persist: deps.getChildSessions?.() ?? true, parentSessionFile: deps.getParentSessionFile?.(ctx) },
					});
					if (isFailedResult(result)) {
						return {
							content: [
								{
									type: "text",
									text: withTouchedFiles(
										`Agent ${result.stopReason || "failed"}: ${getResultOutput(result)}`,
										result.messages,
									),
								},
							],
							details: makeDetails("single")([result]),
							isError: true,
						};
					}
					return {
						content: [
							{
								type: "text",
								text: withTouchedFiles(withSessionNote(result, getFinalOutput(result.messages) || "(no output)"), result.messages),
							},
						],
						details: makeDetails("single")([result]),
					};
				}

				const available = agents.map((a) => a.name).join(", ") || "none";
				return {
					content: [{ type: "text", text: `Invalid parameters. Available agents: ${available}` }],
					details: makeDetails("single")([]),
				};
			} finally {
				if (runningTasks.size === 0) deps.onIdle();
			}
		},

		renderCall(args: any, theme: any, _context: any) {
			if (args.chain && args.chain.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("delegate ")) +
					theme.fg("accent", `chain (${args.chain.length} steps)`);
				for (let i = 0; i < Math.min(args.chain.length, 3); i++) {
					const step = args.chain[i];
					const cleanTask = step.task.replace(/\{previous\}/g, "").trim();
					const preview = cleanTask.length > 40 ? `${cleanTask.slice(0, 40)}...` : cleanTask;
					text +=
						"\n  " +
						theme.fg("muted", `${i + 1}.`) +
						" " +
						theme.fg("accent", step.agent) +
						theme.fg("dim", ` ${preview}`);
				}
				if (args.chain.length > 3) text += `\n  ${theme.fg("muted", `... +${args.chain.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			if (args.tasks && args.tasks.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("delegate ")) +
					theme.fg("accent", `parallel (${args.tasks.length} tasks)`);
				for (const t of args.tasks.slice(0, 3)) {
					const preview = t.task.length > 40 ? `${t.task.slice(0, 40)}...` : t.task;
					text += `\n  ${theme.fg("accent", t.agent)}${theme.fg("dim", ` ${preview}`)}`;
				}
				if (args.tasks.length > 3) text += `\n  ${theme.fg("muted", `... +${args.tasks.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			const agentName = args.agent || "...";
			const preview = args.task ? (args.task.length > 60 ? `${args.task.slice(0, 60)}...` : args.task) : "...";
			const text =
				theme.fg("toolTitle", theme.bold("delegate ")) +
				theme.fg("accent", agentName) +
				`\n  ${theme.fg("dim", preview)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result: any, { expanded, isPartial }: any, theme: any, context: any) {
			const details = result.details as SubagentDetails | undefined;
			if (!details || details.results.length === 0) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}

			const mdTheme = getMarkdownTheme();

			const renderDisplayItems = (items: DisplayItem[], limit?: number) => {
				const toShow = limit ? items.slice(-limit) : items;
				const skipped = limit && items.length > limit ? items.length - limit : 0;
				let text = "";
				if (skipped > 0) text += theme.fg("muted", `... ${skipped} earlier items\n`);
				for (const item of toShow) {
					if (item.type === "text") {
						const preview = expanded ? item.text : item.text.split("\n").slice(0, 3).join("\n");
						text += `${theme.fg("toolOutput", preview)}\n`;
					} else {
						text += `${theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme))}\n`;
					}
				}
				return text.trimEnd();
			};

			const aggregateUsage = (results: SingleResult[]) => {
				const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
				for (const r of results) {
					total.input += r.usage.input;
					total.output += r.usage.output;
					total.cacheRead += r.usage.cacheRead;
					total.cacheWrite += r.usage.cacheWrite;
					total.cost += r.usage.cost;
					total.turns += r.usage.turns;
				}
				return total;
			};

			if (details.mode === "single" && details.results.length === 1) {
				const r = details.results[0];
				// Mid-run, pi re-invokes renderResult with isPartial=true and the child's
				// stopReason is transiently "toolUse" — render as running, not failed.
				const status = taskStatus(r, isPartial === true || context?.isPartial === true);
				const isRunning = status === "running";
				const isError = status === "failed";
				const icon = statusIcon(theme, status);
				const displayItems = getDisplayItems(r.messages);
				const finalOutput = getFinalOutput(r.messages);

				if (expanded) {
					const container = new Container();
					let header = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
					if (isError && r.stopReason) header += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
					container.addChild(new Text(header, 0, 0));
					if (isError && r.errorMessage)
						container.addChild(new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
					container.addChild(new Text(theme.fg("dim", r.task), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
					if (displayItems.length === 0 && !finalOutput) {
						container.addChild(new Text(theme.fg("muted", isRunning ? "(running...)" : "(no output)"), 0, 0));
					} else {
						for (const item of displayItems) {
							if (item.type === "toolCall") {
								container.addChild(
									new Text(theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)), 0, 0),
								);
							}
						}
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}
					}
					const usageStr = formatUsageStats(r.usage, r.model);
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
					}
					return container;
				}

				let text = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
				if (isError && r.stopReason) text += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
				if (isError && r.errorMessage) text += `\n${theme.fg("error", `Error: ${r.errorMessage}`)}`;
				else if (displayItems.length === 0)
					text += `\n${theme.fg("muted", isRunning ? "(running...)" : "(no output)")}`;
				else {
					text += `\n${renderDisplayItems(displayItems, COLLAPSED_ITEM_COUNT)}`;
					if (displayItems.length > COLLAPSED_ITEM_COUNT) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				}
				const usageStr = formatUsageStats(r.usage, r.model);
				if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
				return new Text(text, 0, 0);
			}

			const callIsPartial = isPartial === true || context?.isPartial === true;
			const { status: runState, successCount } = runStatus(details.results, callIsPartial);
			const total = details.results.length;
			// Yellow while any task runs, green when a finished run fully succeeded,
			// red only once it is finished with a failure.
			const icon = runState === "running" ? theme.fg("warning", "◐") : statusIcon(theme, runState);

			if (expanded) {
				const container = new Container();
				container.addChild(
					new Text(
						`${icon} ${theme.fg("toolTitle", theme.bold(details.mode + " "))}${theme.fg("accent", `${successCount}/${total}`)}`,
						0,
						0,
					),
				);
				for (const r of details.results) {
					const rIcon = statusIcon(theme, taskStatus(r, callIsPartial));
					const displayItems = getDisplayItems(r.messages);
					const finalOutput = getFinalOutput(r.messages);

					container.addChild(new Spacer(1));
					container.addChild(
						new Text(
							`${theme.fg("muted", r.step ? `─── Step ${r.step}: ` : "─── ") + theme.fg("accent", r.agent)} ${rIcon}`,
							0,
							0,
						),
					);
					container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));

					for (const item of displayItems) {
						if (item.type === "toolCall") {
							container.addChild(
								new Text(theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)), 0, 0),
							);
						}
					}
					if (finalOutput) {
						container.addChild(new Spacer(1));
						container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
					}
					const taskUsage = formatUsageStats(r.usage, r.model);
					if (taskUsage) container.addChild(new Text(theme.fg("dim", taskUsage), 0, 0));
				}
				const usageStr = formatUsageStats(aggregateUsage(details.results));
				if (usageStr) {
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
				}
				return container;
			}

			let text = `${icon} ${theme.fg("toolTitle", theme.bold(details.mode + " "))}${theme.fg("accent", `${successCount}/${total}`)}`;
			for (const r of details.results) {
				const taskSt = taskStatus(r, callIsPartial);
				const rIcon = statusIcon(theme, taskSt);
				const displayItems = getDisplayItems(r.messages);
				text += `\n\n${theme.fg("muted", r.step ? `─── Step ${r.step}: ` : "─── ")}${theme.fg("accent", r.agent)} ${rIcon}`;
				if (displayItems.length === 0) text += `\n${theme.fg("muted", taskSt === "running" ? "(running...)" : "(no output)")}`;
				else text += `\n${renderDisplayItems(displayItems, 5)}`;
			}
			const usageStr = formatUsageStats(aggregateUsage(details.results));
			if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
			text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
			return new Text(text, 0, 0);
		},
	});
}
