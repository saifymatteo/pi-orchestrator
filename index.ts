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
 * installs the orphan watchdog (parent PID disappears → exit).
 */

import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, type SettingItem, SettingsList } from "@earendil-works/pi-tui";
import { discoverAgents } from "./agents.ts";
import {
	discoverKeptTools,
	effectiveKeepTools,
	matchersForTool,
	toolIsKept,
	loadConfig,
	saveConfig,
	type DiscoveredTool,
	type OrchestratorConfig,
} from "./config.ts";
import { clearFleetWidget, idleFleetWidgetLines, killAllFleet, registerDelegateTool } from "./delegate.ts";
import { buildPolicy } from "./policy.ts";
import { truncateToWidth } from "./width.ts";
import type { AgentConfig } from "./agents.ts";

// ── Child mode: orphan watchdog, nothing else ───────────────────────────────

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

export default function (pi: any) {
	if (process.env.PI_ORCHESTRATOR_CHILD === "1") {
		installChildWatchdog();
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
				const effective = effectiveKeepTools(config.keepTools, discovered, config.autoKeepExtensions);
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
		if (ctx?.ui) lastUi = ctx.ui;

		// Re-apply the reduction: catches tools registered after session_start
		// (e.g. by other extensions) and any re-enablement that happened.
		applyReduction();

		const agents: AgentConfig[] = discoverAgents(config);
		// Policy text must only advertise tools the gate actually allows: under
		// keep-list-only (autoKeepExtensions:false) most discovered extensions
		// are not kept, so filter the discovered groups down to the kept tools.
		const effective = effectiveKeepTools(config.keepTools, discovered, config.autoKeepExtensions);
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
		const effective = effectiveKeepTools(config.keepTools, discovered, config.autoKeepExtensions);
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

	registerDelegateTool(pi, {
		getAgents: () => discoverAgents(config),
		getDispatchDefaults: (ctx: any) => ({
			model: ctx?.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
			thinkingLevel: ctx?.thinkingLevel,
		}),
		getCwd: () => process.cwd(),
		getSignal: () => undefined,
		getMaxTurns: () => config.maxTurns,
		getStallTimeoutMs: () => config.stallTimeoutMs,
		onIdle: () => updateIdleWidget(),
	});

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
			const effective = effectiveKeepTools(config.keepTools, discovered, config.autoKeepExtensions);
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
				const discoveredHeader = config.autoKeepExtensions
					? "auto-discovered (kept)"
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
