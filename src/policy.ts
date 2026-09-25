/**
 * Delegation policy appended to the system prompt on every turn while
 * orchestration is engaged (ADR-0001).
 *
 * The TEXT is computed once per engagement episode and cached (ADR-0013):
 * pi rebuilds the system prompt each turn, so the append must stay
 * per-turn, but reusing identical text keeps the provider prompt-cache
 * prefix stable even when the fleet changes mid-session. Generated from
 * the discovered fleet and the tools actually kept (ADR-0004): no
 * other-package tool names and no fleet names are hardcoded.
 */

import type { AgentConfig } from "./agents.ts";
import type { DiscoveredTool, OrchestratorConfig } from "./config.ts";

export function buildPolicy(agents: AgentConfig[], config: OrchestratorConfig, keptTools: DiscoveredTool[]): string {
	const fleet = agents
		.map((a) => `- **${a.name}**${a.tools ? ` (tools: ${a.tools.join(", ")})` : " (full tools)"}: ${a.description}`)
		.join("\n");

	const retained = keptTools.flatMap((t) => t.names).sort();
	const allowList =
		retained.length > 0
			? `\`delegate\` (always available) plus these retained tools: ${retained.join(", ")}.`
			: "`delegate` is your only direct tool.";

	const names = agents.map((a) => a.name);
	// Dispatch-mode wording (ADR-0016): the config default must match what the
	// delegate tool actually does, or the model reads contradictory instructions
	// every turn. Under a blocking default the escape hatch is `{async: true}`.
	const dispatchIntro = config.async
		? "Dispatch is async by default — you get an acceptance immediately, and each subagent's settled result is delivered into this conversation automatically; never poll."
		: "Dispatch blocks by default — a delegate call returns the subagent's final result directly. Pass `{async: true}` to fire-and-forget: you get an acceptance immediately, and the settled result is delivered into this conversation automatically.";
	const modeRule = config.async
		? "4. Choose the mode that fits the work: `{agent, task}` for a single job, `tasks[]` for independent parallel work (both async by default — you get an acceptance with run ids, and each settled result is delivered into this conversation automatically), `chain[]` with the `{previous}` placeholder for dependent steps (always blocking), or `{async: false}` to block for a quick single job."
		: "4. Choose the mode that fits the work: `{agent, task}` for a single job, `tasks[]` for independent parallel work, `chain[]` with the `{previous}` placeholder for dependent steps (always blocking). Dispatches block until the final result; pass `{async: true}` to fire-and-forget when you want to keep working while a run settles.";
	const noPollRule = config.async
		? "5. After an async dispatch, do not wait and do not poll: settled results arrive in this conversation on their own. Dispatch more work, respond to the user, or end your turn. `{action: \"status\"}` lists live runs; `{action: \"cancel\", runId}` stops one."
		: "5. After a fire-and-forget dispatch (`{async: true}`), do not wait and do not poll: settled results arrive in this conversation on their own. Dispatch more work, respond to the user, or end your turn. `{action: \"status\"}` lists live runs; `{action: \"cancel\", runId}` stops one.";
	const flowLines: string[] = [];
	if (names.length === 1) {
		flowLines.push(`   - All real work goes to \`${names[0]}\`; split large tasks into several delegate calls.`);
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

You are running as an ORCHESTRATOR. Your toolset is reduced to an allow-list. The \`delegate\` tool is your path to real work: it spawns subagents with isolated contexts and the full toolset. ${dispatchIntro}

### Allow-list

${allowList}

### Fleet (agents available via \`delegate\`)

${fleet || "(no agents discovered — inform the user that the fleet is empty)"}

Call \`delegate\` with \`{action: "list"}\` to re-check the fleet mid-session (the listing reflects agents added after session start).
${flows}
### Rules

1. Any task involving reading, searching, writing, editing files, or running commands goes through \`delegate\`. Never say you cannot do something — delegate it.
2. Purely conversational replies (greetings, definitions, questions about this conversation, quick facts you already know) may be answered directly without delegating.
3. When a task is ambiguous, clarify with the user before delegating — use a clarification tool from your allow-list when one is retained.
${modeRule}
${noPollRule}
6. Task prompts must be self-contained: subagents cannot see this conversation. Include paths, constraints, and the exact expected output.
7. Report subagent results to the user in your own words. Never paste raw subagent output as your final answer.
8. Orchestration is flat: subagents cannot delegate further. Plan one level deep.
`.trim();
}
