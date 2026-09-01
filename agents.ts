/**
 * Fleet discovery.
 *
 * Sources, merged by name (later wins):
 *   - <extension dir>/agents/*.md        (builtin fleet, skippable via config.builtinFleet)
 *   - ~/.pi/agent/agents/*.md            (user)
 *   - <cwd>/.pi/agents + <cwd>/.agents/agents, walking cwd→ancestors
 *                                        (project; see projectAgentDirs)
 *
 * So: project beats user beats builtin. Among project dirs, nearer ones win
 * (and `.pi/agents` beats `.agents/agents` at the same level).
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
	/** Per-agent turn budget override (ADR-0006); positive integer or undefined. */
	maxTurns?: number;
	systemPrompt: string;
	source: "project" | "user" | "builtin";
	filePath: string;
}

interface AgentFrontmatter {
	[key: string]: unknown;
	name?: unknown;
	description?: unknown;
	tools?: unknown;
	model?: unknown;
	maxTurns?: unknown;
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

function loadAgentsFromDir(dir: string, source: AgentConfig["source"]): AgentConfig[] {
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
			// Strict positive integer: strings and other types are rejected, no coercion.
			maxTurns:
				typeof frontmatter.maxTurns === "number" && Number.isInteger(frontmatter.maxTurns) && frontmatter.maxTurns > 0
					? frontmatter.maxTurns
					: undefined,
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

/**
 * Project agent directories, nearest level first. Walks cwd up through its
 * ancestors and stops AFTER the ancestor containing `.git` (or at the
 * filesystem root). Each level contributes `<dir>/.pi/agents` then
 * `<dir>/.agents/agents`, in that order.
 */
export function projectAgentDirs(cwd: string): string[] {
	const dirs: string[] = [];
	let current = path.resolve(cwd);
	for (;;) {
		dirs.push(path.join(current, ".pi", "agents"));
		dirs.push(path.join(current, ".agents", "agents"));
		if (fs.existsSync(path.join(current, ".git"))) break;
		const parent = path.dirname(current);
		if (parent === current) break; // filesystem root
		current = parent;
	}
	return dirs;
}

export function discoverAgents(config: OrchestratorConfig, cwd: string = process.cwd()): AgentConfig[] {
	const userDir = path.join(getAgentDir(), "agents");

	const builtinAgents = config.builtinFleet ? loadAgentsFromDir(builtinAgentsDir(), "builtin") : [];
	const userAgents = loadAgentsFromDir(userDir, "user");

	// Merge precedence: builtin < user < project (later wins). projectAgentDirs
	// is nearest-first with .pi/agents before .agents/agents within a level, so
	// iterating it in REVERSE and overwriting makes nearer project dirs win and
	// .pi/agents beat .agents/agents at the same level.
	const projectAgents: AgentConfig[] = [];
	const projectDirs = projectAgentDirs(cwd);
	for (let i = projectDirs.length - 1; i >= 0; i--) {
		projectAgents.push(...loadAgentsFromDir(projectDirs[i], "project"));
	}

	const byName = new Map<string, AgentConfig>();
	for (const agent of builtinAgents) byName.set(agent.name, agent);
	for (const agent of userAgents) byName.set(agent.name, agent);
	for (const agent of projectAgents) byName.set(agent.name, agent); // project wins

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
