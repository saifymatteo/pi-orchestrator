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
import { matchersForTool, toolIsKept, loadConfig, saveConfig, type OrchestratorConfig } from "./config.ts";
import { clearFleetWidget, idleFleetWidgetLines, killAllFleet, registerDelegateTool } from "./delegate.ts";
import { buildPolicy } from "./policy.ts";
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
	// SIGKILL, is caught within 5s. stdin is "ignore" in children — pi's
	// print mode would deadlock waiting for stdin EOF on a held-open pipe,
	// so stdin-close can't be used as a liveness signal.)
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
			if (engaged) {
				const kept = all.filter((t) => toolIsKept(t, config.keepTools)).map((t) => t.name);
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
		return { systemPrompt: `${event.systemPrompt}\n\n${buildPolicy(agents, config)}` };
	});

	// ── Hard gate (ADR-0001) ────────────────────────────────────────────────

	pi.on("tool_call", async (event: any) => {
		if (!engaged) return;
		if (event.toolName === "delegate") return;

		const tool = pi.getAllTools().find((t: any) => t.name === event.toolName);
		const allowed = toolIsKept({ name: event.toolName, sourceInfo: tool?.sourceInfo }, config.keepTools);
		if (allowed) return;

		return {
			block: true,
			reason:
				`Blocked: you are an ORCHESTRATOR. "${event.toolName}" is not on your allow-list. ` +
				`Delegate this work instead: delegate({ agent: "...", task: "..." }) — ` +
				`use scout for recon/search, worker for implementation, reviewer for verification. ` +
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
			const items: SettingItem[] = allTools.map((tool) => ({
				id: tool.name,
				label: tool.name,
				currentValue: matchersForTool(tool, config.keepTools).length > 0 ? "allowed" : "blocked",
				values: ["allowed", "blocked"],
			}));

			await ctx.ui.custom((tui: any, theme: any, _kb: any, done: any) => {
				const container = new Container();
				container.addChild(
					new (class {
						render(_width: number) {
							return [
								theme.fg("accent", theme.bold("Orchestrator keep-list")),
								...config.keepTools.map((m) => theme.fg("dim", `  · ${m}`)),
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
