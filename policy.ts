/**
 * Delegation policy injected into the system prompt on every turn
 * while orchestration is engaged (ADR-0001).
 *
 * Text is generated from the discovered fleet and the tools actually kept
 * (ADR-0004): no other-package tool names and no fleet names are hardcoded.
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

You are running as an ORCHESTRATOR. Your toolset is reduced to an allow-list. The \`delegate\` tool is your path to real work: it spawns subagents with isolated contexts and the full toolset.

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
4. Choose the mode that fits the work: \`{agent, task}\` for a single job, \`tasks[]\` for independent parallel work, \`chain[]\` with the \`{previous}\` placeholder for dependent steps.
5. Task prompts must be self-contained: subagents cannot see this conversation. Include paths, constraints, and the exact expected output.
6. Report subagent results to the user in your own words. Never paste raw subagent output as your final answer.
7. Orchestration is flat: subagents cannot delegate further. Plan one level deep.
`.trim();
}
