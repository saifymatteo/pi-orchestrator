/**
 * Engaged-only delegation policy appended to the system prompt on every turn
 * while orchestration is engaged (ADR-0001).
 *
 * Scope split (ADR-0018): mode-invariant delegate usage guidance lives in the
 * delegate tool's `promptGuidelines` (src/delegate.ts), so it reaches the
 * system prompt's <rules> section in BOTH AUTO and engaged mode. This policy
 * carries only what is true while engaged: the orchestrator role, the
 * allow-list, the fleet, and the file-work mandate. Nothing here restates the
 * tool's guidelines.
 *
 * The TEXT is computed once per engagement episode and cached (ADR-0013):
 * pi rebuilds the system prompt each turn, so the append must stay
 * per-turn, but reusing identical text keeps the provider prompt-cache
 * prefix stable even when the fleet changes mid-session. Generated from
 * the discovered fleet and the tools actually kept (ADR-0004): no
 * other-package tool names and no fleet names are hardcoded.
 */

import type { AgentConfig } from "./agents.ts";
import type { DiscoveredTool } from "./config.ts";

export function buildPolicy(agents: AgentConfig[], keptTools: DiscoveredTool[]): string {
	const fleet = agents
		.map((a) => `- **${a.name}**${a.tools ? ` (tools: ${a.tools.join(", ")})` : " (full tools)"}: ${a.description}`)
		.join("\n");

	const retained = keptTools.flatMap((t) => t.names).sort();
	const allowList =
		retained.length > 0
			? `\`delegate\` (always available) plus these retained tools: ${retained.join(", ")}.`
			: "`delegate` is your only direct tool.";

	const names = agents.map((a) => a.name);
	const flowLines: string[] = [];
	if (names.length === 1) {
		flowLines.push(`   - Split large tasks into several delegate calls to \`${names[0]}\` (parallel via \`tasks[]\`).`);
	} else if (names.length > 1) {
		flowLines.push(
			`   - Match each phase of work to the agent whose description fits it best (for example: ${names
				.slice(0, 3)
				.join(" → ")}).`,
		);
	}
	const flows = flowLines.length > 0 ? `\n### Typical flows\n\n${flowLines.join("\n")}\n` : "";

	return `
## Orchestrator Mode (pi-orchestrator)

You are running as an ORCHESTRATOR: your toolset is the allow-list below, and the \`delegate\` tool is your path to real work — it spawns subagents with isolated contexts and the full toolset.

### Allow-list

${allowList}

### Fleet (agents available via \`delegate\`)

${fleet || "(no agents discovered — inform the user that the fleet is empty)"}

Call \`delegate\` with \`{action: "list"}\` to re-check the fleet mid-session (the listing reflects agents added after session start).
${flows}
### Rules

1. Any task involving reading, searching, writing, editing files, or running commands goes through \`delegate\`. Never say you cannot do something — delegate it.
2. Purely conversational replies (greetings, definitions, questions about this conversation, quick facts you already know) may be answered directly without delegating.
`.trim();
}
