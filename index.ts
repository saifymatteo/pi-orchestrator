/**
 * pi-orchestrator — forces the main agent to delegate work to a subagent fleet.
 *
 * See CONTEXT.md (glossary) and docs/adr/ (decisions).
 *
 * Engagement (default ON, persistent toggle via /orchestrator):
 *   1. Tools outside the keep-list are removed from the active set
 *      (re-applied every turn to catch dynamically registered tools).
 *   2. A delegation policy is appended to the system prompt every turn.
 *   3. A hard gate blocks any non-keep-list tool call with guidance to delegate.
 *
 * Child mode (PI_ORCHESTRATOR_CHILD=1): the extension self-disables and only
 * installs the orphan watchdog, the ADR-0007 tool gate when the parent
 * set PI_ORCHESTRATOR_BLOCKED_TOOLS (gate-only child mode), and the
 * parent-prompt forwarding hook when the parent set
 * PI_ORCHESTRATOR_PARENT_PROMPT_FILE (config forwardParentPrompt).
 */

import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, type SettingItem, SettingsList } from "@earendil-works/pi-tui";
import { discoverAgents } from "./agents.ts";
import {
	discoverKeptTools,
	effectiveKeepTools,
	matchersForTool,
	toolIsKept,
	toolMatchesAnyMatcher,
	loadConfig,
	saveConfig,
	type DiscoveredTool,
	type OrchestratorConfig,
} from "./config.ts";
import * as fs from "node:fs";
import { clearFleetWidget, hasRunningTasks, idleFleetWidgetLines, killAllFleet, registerDelegateTool, type DelegateDeps } from "./delegate.ts";
import { buildPolicy } from "./policy.ts";
import { truncateToWidth } from "./width.ts";
import type { AgentConfig } from "./agents.ts";

// ── Child mode: orphan watchdog + ADR-0007 tool gate ───────────────────────────────

/**
 * Parse PI_ORCHESTRATOR_BLOCKED_TOOLS into a matcher list. Comma-separated,
 * same matcher syntax as keepTools (exact name, glob, ext:<id>); segments
 * are trimmed and empty ones dropped. Exact strings are preserved (matching
 * is case-insensitive downstream); dedupe is not required.
 */
export function parseBlockedToolsEnv(value: string): string[] {
	return value
		.split(",")
		.map((m) => m.trim())
		.filter((m) => m.length > 0);
}

/**
 * Child-side tool gate (ADR-0007): block tools matching
 * PI_ORCHESTRATOR_BLOCKED_TOOLS with a visible reason, so a subagent that
 * inherits global extensions still honors the orchestrator's tool policy.
 * Backstop complement to the parent-side --exclude-tools expansion (ADR-0008):
 * also enforces matchers whose tools the parent's registry could not see,
 * with a visible reason.
 * Fail-soft: with an absent/empty env var no handler is installed at all.
 */
export function installChildToolGate(pi: any): void {
	const matchers = parseBlockedToolsEnv(process.env.PI_ORCHESTRATOR_BLOCKED_TOOLS ?? "");
	if (matchers.length === 0) return;

	pi.on("tool_call", async (event: any) => {
		if (event.toolName === "delegate") return;
		const tool = pi.getAllTools().find((t: any) => t.name === event.toolName);
		const matched = toolMatchesAnyMatcher({ name: event.toolName, sourceInfo: tool?.sourceInfo }, matchers);
		if (!matched) return;
		return {
			block: true,
			reason:
				`Blocked by orchestrator policy: tool "${event.toolName}" matches blocked matcher "${matched}". ` +
				`It will not execute. Use the remaining tools to complete the task.`,
		};
	});
}

/**
 * Pure transformation: append the (already delta-stripped) parent prompt at
 * the END of the child's system prompt (after pi base, agent body,
 * project_context, skills, and cwd). Exported for unit tests
 * (tests/index.test.ts).
 */
export function withParentPrompt(systemPrompt: string | undefined, parentPrompt: string): string {
	// Empty-result guard: if delta-stripping removed everything (parent prompt
	// fully duplicated in the child), append nothing — returning the child's
	// prompt unchanged avoids a dangling trailing blank line and any
	// forwarding artifacts.
	if (!parentPrompt) return systemPrompt ?? "";
	return systemPrompt ? `${systemPrompt}\n\n${parentPrompt}` : parentPrompt;
}

/**
 * Delta-forwarding: strip segments of the parent's forwarded prompt that the
 * child ALREADY receives verbatim through its own system-prompt assembly.
 *
 * Why: the child runs in the same cwd with the same extension set, so pi's
 * normal assembly injects the identical <project_context> block (AGENTS.md
 * content) and the identical "Current working directory:" line into the
 * child's own prompt. Forwarding a second verbatim copy costs ~tokens with
 * zero informational value (measured on a captured session locally). Only
 * these two segments are stripped;
 * everything else in the forwarded prompt is the actual informational
 * payload and stays: the base-prompt body (NOT duplicated — the child
 * embeds its own tool list, so the bytes diverge), the Toolbelt notice and
 * the CodeGraph/extension guidance (both differ from the child's own
 * copies). The skills section is conditionally stripped — only when the
 * parent's entire slice appears verbatim in the child's prompt (see the
 * Segment 3 comment below).
 *
 * Safety guard: a segment is only removed when the child's own system prompt
 * (`childPrompt`, the pre-append event.systemPrompt) contains that exact
 * byte sequence. This covers the per-task `cwd` override case (delegate tool):
 * when the child runs in a DIFFERENT directory its project_context/cwd differ
 * from the parent's, the membership check fails, and nothing is stripped.
 * The check also makes the strip self-validating against future pi assembly
 * changes — worst case we under-strip (harmless), never over-strip.
 *
 * Determinism (cache-prefix stability): pure function of (childPrompt,
 * parentPrompt) — same inputs always produce the same output bytes. The join
 * point is normalized to exactly one blank line, matching the surrounding
 * prompt's paragraph separator.
 *
 * Exported for unit tests (tests/index.test.ts).
 */
export function stripDuplicatedParentSegments(childPrompt: string | undefined, parentPrompt: string): string {
	if (!childPrompt) return parentPrompt;
	let result = parentPrompt;

	/** Remove `segment` from `result` plus ONE following blank-line separator
	 *  (so the text before and after the removal stays single-blank-line
	 *  separated) — but only when the child's own prompt contains the segment
	 *  verbatim; otherwise leave it untouched. */
	const removeIfDuplicated = (segment: string): void => {
		if (!segment || !childPrompt.includes(segment)) return;
		const start = result.indexOf(segment);
		if (start === -1) return; // defensive; segment came from `result` itself
		const end = start + segment.length;
		const after = result.startsWith("\n\n", end) ? end + 2 : end;
		result = result.slice(0, start) + result.slice(after);
	};

	// Segment 1: the <project_context> block (first occurrence — pi injects
	// exactly one; a non-greedy match keeps the boundary tight).
	const ctx = /<project_context>[\s\S]*?<\/project_context>/.exec(result);
	if (ctx) removeIfDuplicated(ctx[0]);

	// Segment 2: the cwd line (start-of-line anchored, single line).
	const cwd = /^Current working directory: .*$/m.exec(result);
	if (cwd) removeIfDuplicated(cwd[0]);

	// Segment 3: the skills injection section ("## Agent skills" up to the
	// "---" separator). This one is frequently only PARTIALLY duplicated —
	// the parent's and child's skill lists can diverge — so unlike segments
	// 1 and 2 it is gated purely by the verbatim-membership check: it is
	// stripped only when the parent's ENTIRE slice is a contiguous verbatim
	// substring of the child's own prompt, i.e. every byte already exists in
	// the child's copy. A partial match (child has extra/different skills)
	// leaves the parent's section fully intact.
	const skillsStart = result.indexOf("## Agent skills");
	if (skillsStart !== -1) {
		const sepIdx = result.indexOf("\n---\n", skillsStart);
		const skills = sepIdx === -1 ? result.slice(skillsStart) : result.slice(skillsStart, sepIdx);
		removeIfDuplicated(skills);
	}

	return result;
}

/**
 * Child-side parent-prompt forwarding (config `forwardParentPrompt`): the
 * parent writes its pre-policy system prompt to a temp file and passes the
 * path via PI_ORCHESTRATOR_PARENT_PROMPT_FILE; this hook appends it at the
 * END of the child's system prompt (after project_context/skills/cwd) so the
 * stable shared prefix — pi base, agent body, context, skills, cwd — is
 * maximized for provider prompt-cache hits. Before appending, the copy is
 * delta-stripped (stripDuplicatedParentSegments): segments the child already
 * receives verbatim (project_context, cwd) are dropped. Deterministic — the
 * same (child prompt, parent prompt) pair always yields the same bytes, so
 * the cache prefix stays stable across spawns. Fail-soft: with the env var
 * unset nothing is installed; a failed file read is a silent pass-through so
 * the child works without the forwarding.
 */
export function installChildParentPrompt(pi: any): void {
	const promptFile = process.env.PI_ORCHESTRATOR_PARENT_PROMPT_FILE;
	if (!promptFile) return;

	pi.on("before_agent_start", async (event: any) => {
		let parentPrompt: string;
		try {
			parentPrompt = await fs.promises.readFile(promptFile, "utf-8");
		} catch {
			return undefined;
		}
		const finalPrompt = withParentPrompt(event.systemPrompt, stripDuplicatedParentSegments(event.systemPrompt, parentPrompt));
		return { systemPrompt: finalPrompt };
	});
}

function installChildWatchdog(): void {
	const parentPid = process.ppid;
	const die = (reason: string) => {
		try {
			process.stderr.write(`[pi-orchestrator] child exiting: ${reason}\n`);
		} catch {
			/* ignore */
		}
		// Hard exit: the print-mode child must never linger
		process.exit(2);
	};

	// Heartbeat: if the parent PID disappears, exit. (Parent death, even
	// SIGKILL, is caught within 5s. Children are spawned with all three
	// stdio pipes (RPC mode), so stdin never closes and cannot serve as a
	// liveness signal — detection is heartbeat-based.)
	const heartbeat = setInterval(() => {
		try {
			process.kill(parentPid, 0);
		} catch {
			die(`parent pid ${parentPid} no longer exists`);
		}
	}, 5000);
	heartbeat.unref?.();
}

// ── Parent mode ─────────────────────────────────────────────────────────────

/**
 * The orchestrator parent's pre-policy system prompt, captured each turn by
 * the before_agent_start hook. Forwarded to subagents (when
 * config.forwardParentPrompt is on) so installed extensions' promptGuidelines
 * (e.g. CodeGraph usage) reach the children too.
 */
let parentSystemPrompt: string | undefined;

/**
 * Deps for the delegate tool. Takes a live config getter (session_start
 * reassigns `config` from disk) so every dep reads the current values, never
 * a stale copy. Exported for unit tests (tests/index.test.ts).
 */
export function buildDelegateDeps(getConfig: () => OrchestratorConfig, onIdle: () => void): DelegateDeps {
	return {
		getAgents: () => discoverAgents(getConfig()),
		getDispatchDefaults: (ctx: any) => ({
			model: ctx?.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
			thinkingLevel: ctx?.thinkingLevel,
		}),
		getCwd: () => process.cwd(),
		getSignal: () => undefined,
		getMaxTurns: () => getConfig().maxTurns,
		getStallTimeoutMs: () => getConfig().stallTimeoutMs,
		// Global child-side block list (ADR-0007); unioned with per-agent
		// blockTools inside delegate.ts resolveBlockedTools.
		getChildBlockedTools: () => getConfig().childBlockedTools,
		// Child extension loading (ADR-0008): empty = inherit-all, non-empty =
		// --no-extensions + one -e per entry (derived inside delegate.ts).
		getChildExtensions: () => getConfig().childExtensions,
		// Forward the parent's captured pre-policy system prompt to subagents
		// (config forwardParentPrompt); parentSystemPrompt is captured per turn
		// by the before_agent_start hook below.
		getForwardParentPrompt: () => getConfig().forwardParentPrompt,
		getParentPrompt: () => parentSystemPrompt,
		onIdle,
	};
}

export default function (pi: any) {
	if (process.env.PI_ORCHESTRATOR_CHILD === "1") {
		installChildWatchdog();
		installChildToolGate(pi);
		installChildParentPrompt(pi);
		return;
	}

	let config: OrchestratorConfig = loadConfig();
	let engaged = config.enabled;
	let lastUi: any;
	// Non-builtin tools discovered at runtime (ADR-0004); refreshed on every
	// applyReduction() so late-registered tools are picked up.
	let discovered: DiscoveredTool[] = [];

	function updateIdleWidget(): void {
		if (!lastUi?.setWidget) return;
		// Clobber guard: never repaint the (idle) fleet widget while a subagent
		// is running. onIdle only fires when runningTasks is empty, so idle is
		// never wrongly suppressed — this only defuses stale/extra callers.
		if (hasRunningTasks()) return;
		try {
			if (engaged) {
				lastUi.setWidget("orchestrator-fleet", idleFleetWidgetLines(discoverAgents(config).map((a) => a.name)));
			} else {
				clearFleetWidget(lastUi);
			}
		} catch {
			/* not in TUI */
		}
	}

	function applyReduction(): void {
		try {
			const all: any[] = pi.getAllTools();
			discovered = discoverKeptTools(all, config.keepTools);
			if (engaged) {
				const effective = effectiveKeepTools(config.keepTools, discovered);
				const kept = all.filter((t) => toolIsKept(t, effective)).map((t) => t.name);
				pi.setActiveTools(Array.from(new Set([...kept, "delegate"])));
			} else {
				pi.setActiveTools(all.map((t) => t.name));
			}
		} catch (err) {
			// Can race during startup; re-applied on every before_agent_start.
			console.error("[pi-orchestrator] applyReduction failed:", err);
		}
	}

	function setEngaged(next: boolean, ctx?: any, opts?: { persist?: boolean; quiet?: boolean }): void {
		engaged = next;
		config.enabled = next;
		if (opts?.persist !== false) {
			try {
				saveConfig(config);
			} catch (err) {
				console.error("[pi-orchestrator] failed to save config:", err);
			}
		}
		applyReduction();
		updateIdleWidget();
		if (!opts?.quiet && ctx?.ui?.notify) {
			ctx.ui.notify(
				next
					? `Orchestrator ENGAGED · fleet: ${discoverAgents(config).map((a) => a.name).join(", ") || "(empty)"}`
					: "Orchestrator disengaged — full toolset restored (persisted to orchestrator.json)",
				next ? "info" : "warning",
			);
		}
	}

	// ── Session lifecycle ───────────────────────────────────────────────────

	pi.on("session_start", async (_event: any, ctx: any) => {
		config = loadConfig();
		parentSystemPrompt = undefined; // Defensive: don't forward a stale prompt across sessions
		engaged = config.enabled;
		if (ctx?.ui) lastUi = ctx.ui;

		if (engaged) {
			applyReduction();
			updateIdleWidget();
		} else if (ctx?.ui?.notify) {
			// Defuse the "why isn't it forcing?" surprise (ADR-0003)
			ctx.ui.notify("Orchestrator is DISENGAGED (orchestrator.json enabled:false). Run /orchestrator to engage.", "warning");
		}
	});

	pi.on("session_shutdown", async () => {
		// User requirement: never leave fleet agents running in the background.
		killAllFleet();
		try {
			if (lastUi) clearFleetWidget(lastUi);
		} catch {
			/* ignore */
		}
	});

	// ── Policy injection + tool-repair each turn ───────────────────────────

	pi.on("before_agent_start", async (event: any, ctx: any) => {
		if (!engaged) return;
		// Capture the parent's real (pre-policy) prompt each turn, before the
		// policy append below, for forwarding to subagents (forwardParentPrompt).
		parentSystemPrompt = event.systemPrompt;
		if (ctx?.ui) lastUi = ctx.ui;

		// Re-apply the reduction: catches tools registered after session_start
		// (e.g. by other extensions) and any re-enablement that happened.
		applyReduction();

		const agents: AgentConfig[] = discoverAgents(config);
		// Policy text must only advertise tools the gate actually allows: under
		// keep-list-only (non-empty keepTools) most discovered extensions
		// are not kept, so filter the discovered groups down to the kept tools.
		const effective = effectiveKeepTools(config.keepTools, discovered);
		const keptDiscovered = discovered
			.map((d) => ({
				...d,
				// source: d.extensionId makes deriveExtensionId return the same id
				// discoverKeptTools derived (d.names excludes shadow-skipped tools).
				names: d.names.filter((n) => toolIsKept({ name: n, sourceInfo: { source: d.extensionId } }, effective)),
			}))
			.filter((d) => d.names.length > 0);
		return { systemPrompt: `${event.systemPrompt}\n\n${buildPolicy(agents, config, keptDiscovered)}` };
	});

	// ── Hard gate (ADR-0001) ────────────────────────────────────────────────

	pi.on("tool_call", async (event: any) => {
		if (!engaged) return;
		if (event.toolName === "delegate") return;

		const tool = pi.getAllTools().find((t: any) => t.name === event.toolName);
		const effective = effectiveKeepTools(config.keepTools, discovered);
		const allowed = toolIsKept({ name: event.toolName, sourceInfo: tool?.sourceInfo }, effective);
		if (allowed) return;

		const fleetNames = discoverAgents(config).map((a) => a.name).join(", ");
		return {
			block: true,
			reason:
				`Blocked: you are an ORCHESTRATOR. "${event.toolName}" is not on your allow-list. ` +
				`Delegate this work instead: delegate({ agent: "...", task: "..." }). ` +
				`Available agents: ${fleetNames || "(none)"}. ` +
				`Task prompts must be self-contained (subagents cannot see this conversation).`,
		};
	});

	// ── The delegate tool ───────────────────────────────────────────────────

	registerDelegateTool(pi, buildDelegateDeps(() => config, () => updateIdleWidget()));

	// ── Commands ────────────────────────────────────────────────────────────

	pi.registerCommand("orchestrator", {
		description: "Toggle orchestrator mode (persisted to orchestrator.json)",
		handler: async (_args: string, ctx: any) => {
			if (ctx?.ui) lastUi = ctx.ui;
			setEngaged(!engaged, ctx);
		},
	});

	pi.registerCommand("orchestrator-tools", {
		description: "Edit the orchestrator keep-list (checkbox UI)",
		handler: async (_args: string, ctx: any) => {
			if (ctx?.ui) lastUi = ctx.ui;
			if (ctx?.mode !== "tui") {
				ctx?.ui?.notify("/orchestrator-tools requires TUI mode — edit ~/.pi/agent/orchestrator.json instead", "warning");
				return;
			}

			const allTools: any[] = pi.getAllTools();
			const effective = effectiveKeepTools(config.keepTools, discovered);
			const items: SettingItem[] = allTools.map((tool) => ({
				id: tool.name,
				label: tool.name,
				currentValue: matchersForTool(tool, effective).length > 0 ? "allowed" : "blocked",
				values: ["allowed", "blocked"],
			}));

			await ctx.ui.custom((tui: any, theme: any, _kb: any, done: any) => {
				const container = new Container();
				const MAX_NAMES = 6;
				const nameSummary = (names: string[]) =>
					names.length > MAX_NAMES
						? `${names.slice(0, MAX_NAMES).join(", ")} +${names.length - MAX_NAMES} more`
						: names.join(", ");
				const discoveredHeader = config.keepTools.length === 0
					? "discovered extensions (auto-kept — keepTools is empty)"
					: "discovered extensions (kept only if matched by keepTools)";
				container.addChild(
					new (class {
						render(width: number) {
							// Truncate PLAIN text to the rendered width BEFORE styling —
							// theme.fg() adds ANSI escapes that would break width
							// measurement and crash pi on lines wider than the terminal.
							const w = Number.isFinite(width) && width > 0 ? width : 80;
							const fit = (s: string) => truncateToWidth(s, w);
							return [
								theme.fg("accent", theme.bold(fit("Orchestrator keep-list"))),
								...config.keepTools.map((m) => theme.fg("dim", fit(`  · ${m}`))),
								...(discovered.length > 0 ? ["", theme.fg("accent", fit(discoveredHeader))] : []),
								...discovered.map((d) => theme.fg("dim", fit(`  - ext:${d.extensionId} (${nameSummary(d.names)})`))),
								"",
							];
						}
						invalidate() {}
					})(),
				);

				const settingsList = new SettingsList(
					items,
					Math.min(items.length + 2, 20),
					getSettingsListTheme(),
					(id: string, newValue: string) => {
						const tool = allTools.find((t) => t.name === id);
						if (!tool || id === "delegate") return; // delegate is always kept
						if (newValue === "allowed") {
							if (!toolIsKept(tool, config.keepTools)) config.keepTools.push(id);
						} else {
							// Remove every matcher that currently matches this tool
							config.keepTools = config.keepTools.filter((m) => !matchersForTool(tool, [m]).includes(m));
						}
						saveConfig(config);
						applyReduction();
					},
					() => done(undefined),
				);
				container.addChild(settingsList);

				return {
					render(width: number) {
						return container.render(width);
					},
					invalidate() {
						container.invalidate();
					},
					handleInput(data: string) {
						settingsList.handleInput?.(data);
						tui.requestRender();
					},
				};
			});
		},
	});
}
