/**
 * Fleet discovery.
 *
 * Sources, merged by name (user agents win over builtin fleet):
 *   - ~/.pi/agent/agents/*.md            (user)
 *   - <extension dir>/agents/*.md        (builtin fleet, skippable via config.builtinFleet)
 *
 * Agents with `hidden: true` frontmatter are skipped.
 * config.modelOverrides[name] overrides an agent's frontmatter model.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { OrchestratorConfig } from "./config.ts";

export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	systemPrompt: string;
	source: "user" | "builtin";
	filePath: string;
}

interface AgentFrontmatter {
	name?: unknown;
	description?: unknown;
	tools?: unknown;
	model?: unknown;
	hidden?: unknown;
}

function parseToolList(value: unknown): string[] | undefined {
	const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
	const tools = raw
		.filter((t): t is string => typeof t === "string")
		.map((t) => t.trim())
		.filter(Boolean);
	return tools.length > 0 ? tools : undefined;
}

function loadAgentsFromDir(dir: string, source: "user" | "builtin"): AgentConfig[] {
	const agents: AgentConfig[] = [];
	if (!fs.existsSync(dir)) return agents;

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return agents;
	}

	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(dir, entry.name);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		const { frontmatter, body } = parseFrontmatter<AgentFrontmatter>(content);
		if (frontmatter.hidden === true) continue;
		if (typeof frontmatter.name !== "string" || typeof frontmatter.description !== "string") continue;

		agents.push({
			name: frontmatter.name,
			description: frontmatter.description,
			tools: parseToolList(frontmatter.tools),
			model: typeof frontmatter.model === "string" ? frontmatter.model : undefined,
			systemPrompt: body,
			source,
			filePath,
		});
	}

	return agents;
}

export function builtinAgentsDir(): string {
	// agents.ts sits next to agents/ in the extension directory
	return path.join(path.dirname(fileURLToPath(import.meta.url)), "agents");
}

export function discoverAgents(config: OrchestratorConfig): AgentConfig[] {
	const userDir = path.join(getAgentDir(), "agents");

	const userAgents = loadAgentsFromDir(userDir, "user");
	const builtinAgents = config.builtinFleet ? loadAgentsFromDir(builtinAgentsDir(), "builtin") : [];

	const byName = new Map<string, AgentConfig>();
	for (const agent of builtinAgents) byName.set(agent.name, agent);
	for (const agent of userAgents) byName.set(agent.name, agent); // user wins

	const agents = Array.from(byName.values());
	for (const agent of agents) {
		const override = config.modelOverrides[agent.name];
		if (override) agent.model = override;
	}
	return agents;
}

export function formatAgentList(agents: AgentConfig[]): string {
	if (agents.length === 0) return "none";
	return agents.map((a) => `${a.name} — ${a.description}`).join("\n");
}
