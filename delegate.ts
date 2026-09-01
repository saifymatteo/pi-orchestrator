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

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const COLLAPSED_ITEM_COUNT = 10;
const PER_TASK_OUTPUT_CAP = 50 * 1024;
/** Turn budget default (ADR-0006); overridden by orchestrator.json `maxTurns`
 *  (via deps.getMaxTurns) or per-agent frontmatter `maxTurns`. */
const DEFAULT_MAX_TURNS = 50;
/** Hard-kill grace margin past the soft-grace budget (ADR-0006). */
const TURN_BUDGET_GRACE = 5;
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
export function renderFleetLines(tasks: RunningTask[], agentNames: string[]): string[] {
	if (tasks.length === 0) {
		return idleFleetWidgetLines(agentNames);
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
			`  ${name} · turn ${task.turns} · ctx ${formatTokens(task.contextTokens)}` +
				` · ↑${formatTokens(task.inputTokens)} ↓${formatTokens(task.outputTokens)} · "${summary}"`,
		);
	}
	return lines;
}

function updateFleetWidget(
	ctx: { ui: { setWidget(id: string, lines: string[] | undefined, opts?: unknown): void } },
	agentNames: string[],
): void {
	if (!ctx.ui?.setWidget) return;
	ctx.ui.setWidget("orchestrator-fleet", renderFleetLines([...runningTasks.values()], agentNames));
}

export function clearFleetWidget(ui: { setWidget(id: string, lines: string[] | undefined, opts?: unknown): void }): void {
	try {
		ui.setWidget("orchestrator-fleet", undefined);
	} catch {
		/* not in TUI */
	}
}

export function idleFleetWidgetLines(agentNames: string[]): string[] {
	return [`orchestrator: engaged · fleet: ${agentNames.join(", ") || "(empty)"}`];
}

// ── Live child-process registry (for session_shutdown reaping) ──────────────

const liveProcs = new Set<ChildProcess>();

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
}

interface SingleResult {
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
}

export interface SubagentDetails {
	mode: "single" | "parallel" | "chain";
	results: SingleResult[];
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
function isFailedResult(result: SingleResult): boolean {
	return (
		!result.completedNormally ||
		result.stopReason === "error" ||
		result.stopReason === "aborted" ||
		result.stopReason === "turn-budget-exhausted" ||
		result.stopReason === "stall-timeout"
	);
}

function getResultOutput(result: SingleResult): string {
	// Budget-exhausted and stall-killed runs report the reason AND everything
	// captured so far.
	if (result.stopReason === "turn-budget-exhausted" || result.stopReason === "stall-timeout") {
		const partial = getFinalOutput(result.messages);
		const reason = result.errorMessage || "Run was killed";
		return partial ? `${reason}\n\nPartial output:\n${partial}` : reason;
	}
	if (isFailedResult(result)) {
		return result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
	}
	return getFinalOutput(result.messages) || "(no output)";
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

// ── Running one subagent ────────────────────────────────────────────────────

type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

interface DispatchDefaults {
	model?: string;
	thinkingLevel?: ThinkingLevel;
}

async function runSingleAgent(
	defaultCwd: string,
	agentKey: string,
	dispatchDefaults: DispatchDefaults,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	maxTurns: number,
	stallTimeoutMs: number,
	cwd: string | undefined,
	step: number | undefined,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => SubagentDetails,
	/** Dispatch mode for the fleet widget line (single/parallel/chain). */
	fleetMode: RunningTask["mode"],
	onFleetChange: () => void,
): Promise<SingleResult> {
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
			stderr: `Unknown agent: "${agentName}". Available agents: ${available}.`,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			step,
		};
	}

	const args: string[] = ["--mode", "rpc", "--no-session"];
	const inheritsDispatchConfig = !agent.model;
	const model = agent.model ?? dispatchDefaults.model;
	if (model) args.push("--model", model);
	if (inheritsDispatchConfig && dispatchDefaults.thinkingLevel) {
		args.push("--thinking", dispatchDefaults.thinkingLevel);
	}
	if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));

	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;

	const currentResult: SingleResult = {
		agent: agentName,
		agentSource: agent.source,
		task,
		exitCode: 0,
		completedNormally: false,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		model,
		step,
	};

	const fleetTask: RunningTask = {
		id: agentKey,
		agent: agentName,
		task,
		mode: fleetMode,
		turns: 0,
		contextTokens: 0,
		inputTokens: 0,
		outputTokens: 0,
	};

	const emitUpdate = () => {
		if (onUpdate) {
			onUpdate({
				content: [{ type: "text", text: getFinalOutput(currentResult.messages) || "(running...)" }],
				details: makeDetails([currentResult]),
			});
		}
	};

	try {
		if (agent.systemPrompt.trim()) {
			const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
			tmpPromptDir = tmp.dir;
			tmpPromptPath = tmp.filePath;
			args.push("--append-system-prompt", tmpPromptPath);
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

		const exitCode = await new Promise<number>((resolve) => {
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
				env: { ...process.env, PI_ORCHESTRATOR_CHILD: "1" },
			});
			liveProcs.add(proc);
			// Swallow EPIPE: the child may die before/while we write a command.
			proc.stdin?.on("error", () => {});
			// Track for the fleet widget
			fleetTask.turns = 0;
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
				resolve(code ?? 0);
			});

			proc.on("error", () => {
				cleanup();
				resolve(1);
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

			// Kick off the task. Sending via stdin is why stdin is a pipe; a
			// rejected prompt is failed via the "init" response above.
			sendRpc(proc, { id: "init", type: "prompt", message: `Task: ${task}` });
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
	}
}

// ── Tool schema ─────────────────────────────────────────────────────────────

const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task to delegate to the agent" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const DelegateParams = Type.Object({
	agent: Type.Optional(Type.String({ description: "Agent name (single mode)" })),
	task: Type.Optional(Type.String({ description: "Task to delegate (single mode)" })),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Parallel mode: array of {agent, task}. Max 8." })),
	chain: Type.Optional(
		Type.Array(
			Type.Object({
				agent: Type.String({ description: "Agent name for this step" }),
				task: Type.String({ description: "Task; {previous} inserts the prior step's output" }),
				cwd: Type.Optional(Type.String({ description: "Working directory" })),
			}),
			{ description: "Chain mode: sequential steps; {previous} in task inserts prior output" },
		),
	),
	cwd: Type.Optional(Type.String({ description: "Working directory (single mode)" })),
});

// ── Registration ────────────────────────────────────────────────────────────

export interface DelegateDeps {
	getAgents: () => AgentConfig[];
	getDispatchDefaults: (ctx: any) => DispatchDefaults;
	getCwd: () => string;
	getSignal: () => AbortSignal | undefined;
	onIdle: () => void;
	/** Default turn budget from orchestrator.json `maxTurns` (ADR-0006);
	 *  per-agent frontmatter `maxTurns` overrides this. Falls back to 50. */
	getMaxTurns?: () => number;
	/** Stall timeout in ms from orchestrator.json `stallTimeoutMs` (ADR-0006).
	 *  Falls back to 10 minutes. */
	getStallTimeoutMs?: () => number;
}

export function registerDelegateTool(pi: any, deps: DelegateDeps): void {
	pi.registerTool({
		name: "delegate",
		label: "Delegate",
		description:
			"Delegate work to a fleet subagent with an isolated context and full tools. " +
			"Modes: single ({agent, task}), parallel ({tasks: [{agent, task}]}, max 8), " +
			"chain ({chain: [{agent, task}]}, sequential, {previous} placeholder inserts the prior step's output). " +
			"This is your only way to read, write, edit, search, or run commands.",
		parameters: DelegateParams,

		async execute(_toolCallId: string, params: any, signal: AbortSignal | undefined, onUpdate: any, ctx: any) {
			const agents = deps.getAgents();
			const dispatchDefaults = deps.getDispatchDefaults(ctx);
			const defaultMaxTurns = deps.getMaxTurns?.() ?? DEFAULT_MAX_TURNS;
			const stallTimeoutMs = deps.getStallTimeoutMs?.() ?? DEFAULT_STALL_TIMEOUT_MS;
			// Per-agent frontmatter `maxTurns` overrides the config default (ADR-0006).
			const resolveMaxTurns = (agentName: string): number =>
				agents.find((a) => a.name === agentName)?.maxTurns ?? defaultMaxTurns;
			const makeDetails =
				(mode: "single" | "parallel" | "chain") =>
				(results: SingleResult[]): SubagentDetails => ({ mode, results });

			const fleetChanged = () => updateFleetWidget(ctx, agents.map((a) => a.name));
			// Unique per invocation: concurrent delegate calls must not collide on
			// runningTasks keys, or the fleet header undercounts running agents.
			const runId = nextFleetRunId();

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
							text: `Invalid parameters: provide exactly one of {agent+task}, {tasks[]}, {chain[]}.\nAvailable agents: ${available}`,
						},
					],
					details: makeDetails("single")([]),
				};
			}

			try {
				if (params.chain && params.chain.length > 0) {
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

						const result = await runSingleAgent(
							deps.getCwd(),
							fleetKey(runId, "chain", i),
							dispatchDefaults,
							agents,
							step.agent,
							taskWithContext,
							resolveMaxTurns(step.agent),
							stallTimeoutMs,
							step.cwd,
							i + 1,
							signal ?? deps.getSignal(),
							chainUpdate,
							makeDetails("chain"),
							"chain",
							fleetChanged,
						);
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
					return {
						content: [{ type: "text", text: getFinalOutput(results[results.length - 1].messages) || "(no output)" }],
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
							usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
						};
					}

					const emitParallelUpdate = () => {
						if (onUpdate) {
							const running = allResults.filter((r) => r.exitCode === -1).length;
							const done = allResults.filter((r) => r.exitCode !== -1).length;
							onUpdate({
								content: [{ type: "text", text: `Parallel: ${done}/${allResults.length} done, ${running} running...` }],
								details: makeDetails("parallel")([...allResults]),
							});
						}
					};

					const results = await mapWithConcurrencyLimit(
						params.tasks as { agent: string; task: string; cwd?: string }[],
						MAX_CONCURRENCY,
						async (t, index) => {
							const result = await runSingleAgent(
								deps.getCwd(),
								fleetKey(runId, "parallel", index),
								dispatchDefaults,
								agents,
								t.agent,
								t.task,
								resolveMaxTurns(t.agent),
								stallTimeoutMs,
								t.cwd,
								undefined,
								signal ?? deps.getSignal(),
								(partial) => {
									if (partial.details?.results[0]) {
										allResults[index] = partial.details.results[0];
										emitParallelUpdate();
									}
								},
								makeDetails("parallel"),
								"parallel",
								fleetChanged,
							);
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
						return `### [${r.agent}] ${status}\n\n${output}`;
					});
					return {
						content: [
							{ type: "text", text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n---\n\n")}` },
						],
						details: makeDetails("parallel")(results),
					};
				}

				if (params.agent && params.task) {
					const result = await runSingleAgent(
						deps.getCwd(),
						fleetKey(runId, "single"),
						dispatchDefaults,
						agents,
						params.agent,
						params.task,
						resolveMaxTurns(params.agent),
						stallTimeoutMs,
						params.cwd,
						undefined,
						signal ?? deps.getSignal(),
						onUpdate,
						makeDetails("single"),
						"single",
						fleetChanged,
					);
					if (isFailedResult(result)) {
						return {
							content: [{ type: "text", text: `Agent ${result.stopReason || "failed"}: ${getResultOutput(result)}` }],
							details: makeDetails("single")([result]),
							isError: true,
						};
					}
					return {
						content: [{ type: "text", text: getFinalOutput(result.messages) || "(no output)" }],
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
				const isRunning = isPartial === true || context?.isPartial === true || r.exitCode === -1;
				const isError = !isRunning && isFailedResult(r);
				const icon = isRunning
					? theme.fg("warning", "⏳")
					: isError
						? theme.fg("error", "✗")
						: theme.fg("success", "✓");
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

			const successCount = details.results.filter((r) => !isFailedResult(r) && r.exitCode !== -1).length;
			const total = details.results.length;
			const icon = successCount === total ? theme.fg("success", "✓") : theme.fg("warning", "◐");

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
					const rIcon = r.exitCode === -1 ? theme.fg("warning", "⏳") : isFailedResult(r) ? theme.fg("error", "✗") : theme.fg("success", "✓");
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
				const rIcon =
					r.exitCode === -1
						? theme.fg("warning", "⏳")
						: isFailedResult(r)
							? theme.fg("error", "✗")
							: theme.fg("success", "✓");
				const displayItems = getDisplayItems(r.messages);
				text += `\n\n${theme.fg("muted", r.step ? `─── Step ${r.step}: ` : "─── ")}${theme.fg("accent", r.agent)} ${rIcon}`;
				if (displayItems.length === 0) text += `\n${theme.fg("muted", r.exitCode === -1 ? "(running...)" : "(no output)")}`;
				else text += `\n${renderDisplayItems(displayItems, 5)}`;
			}
			const usageStr = formatUsageStats(aggregateUsage(details.results));
			if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
			text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
			return new Text(text, 0, 0);
		},
	});
}
