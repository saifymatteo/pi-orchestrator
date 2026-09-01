/**
 * Orchestrator configuration (~/.pi/agent/orchestrator.json)
 *
 * keepTools matcher syntax:
 *   - exact tool name            "todo"
 *   - glob on tool name          "hindsight_*"
 *   - extension id               "ext:@luxusai/pi-hindsight"
 *     (matches every tool registered by that package, including
 *      tools added in future versions, e.g. `recall`)
 *
 * "delegate" is always kept regardless of config (the gate never blocks it).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface OrchestratorConfig {
	/** Orchestration engaged by default (persistent toggle via /orchestrator). */
	enabled: boolean;
	/** Matchers for tools the orchestrator keeps while engaged. */
	keepTools: string[];
	/** Include the fleet shipped with the extension (user agents always win by name). */
	builtinFleet: boolean;
	/** Per-agent model overrides, e.g. { "scout": "openrouter/some-cheap-model" }. */
	modelOverrides: Record<string, string>;
}

export const DEFAULT_CONFIG: OrchestratorConfig = {
	enabled: true,
	keepTools: [
		"delegate",
		"ext:@luxusai/pi-hindsight",
		"ext:@juicesharp/rpiv-todo",
		"ext:@juicesharp/rpiv-ask-user-question",
		"ext:@juicesharp/rpiv-advisor",
	],
	builtinFleet: true,
	modelOverrides: {},
};

export function getConfigPath(): string {
	return path.join(getAgentDir(), "orchestrator.json");
}

export function loadConfig(): OrchestratorConfig {
	const file = getConfigPath();
	try {
		const raw = JSON.parse(fs.readFileSync(file, "utf-8")) as Partial<OrchestratorConfig>;
		return {
			enabled: typeof raw.enabled === "boolean" ? raw.enabled : DEFAULT_CONFIG.enabled,
			keepTools: Array.isArray(raw.keepTools)
				? raw.keepTools.filter((m): m is string => typeof m === "string" && m.trim().length > 0)
				: DEFAULT_CONFIG.keepTools,
			builtinFleet: typeof raw.builtinFleet === "boolean" ? raw.builtinFleet : DEFAULT_CONFIG.builtinFleet,
			modelOverrides:
				raw.modelOverrides && typeof raw.modelOverrides === "object" && !Array.isArray(raw.modelOverrides)
					? Object.fromEntries(
							Object.entries(raw.modelOverrides).filter(([, v]) => typeof v === "string" && v.trim() !== ""),
						)
					: {},
		};
	} catch {
		return { ...DEFAULT_CONFIG, keepTools: [...DEFAULT_CONFIG.keepTools], modelOverrides: {} };
	}
}

export function saveConfig(config: OrchestratorConfig): void {
	fs.mkdirSync(path.dirname(getConfigPath()), { recursive: true });
	fs.writeFileSync(getConfigPath(), `${JSON.stringify(config, null, 2)}\n`, "utf-8");
}

/** Derive the owning package/extension id from a tool's sourceInfo path. */
export function deriveExtensionId(tool: { name: string; sourceInfo?: { path?: string; source?: string } }): string {
	const src = tool.sourceInfo;
	if (!src?.path) return src?.source ?? "unknown";
	if (src.path.startsWith("<builtin:")) return "builtin";

	const nm = src.path.toLowerCase().lastIndexOf("node_modules");
	if (nm !== -1) {
		const segments = src.path
			.slice(nm + "node_modules".length)
			.split(/[\\/]+/)
			.filter(Boolean);
		if (segments.length > 0) {
			return segments[0].startsWith("@") && segments.length > 1
				? `${segments[0]}/${segments[1]}`
				: segments[0];
		}
	}
	return path.basename(src.path).replace(/\.(ts|js|mjs|cjs)$/i, "");
}

function globToRegex(pattern: string): RegExp {
	const escaped = pattern
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		.replace(/\*/g, ".*")
		.replace(/\?/g, ".");
	return new RegExp(`^${escaped}$`, "i");
}

function matcherMatches(matcher: string, toolName: string, extensionId: string): boolean {
	const m = matcher.trim().toLowerCase();
	if (m.startsWith("ext:")) {
		return extensionId.toLowerCase() === m.slice(4); // exact, case-insensitive
	}
	if (m.includes("*") || m.includes("?")) return globToRegex(m).test(toolName);
	return toolName.toLowerCase() === m;
}

/**
 * True when a tool stays available to the orchestrator.
 * `delegate` is unconditionally kept.
 */
export function toolIsKept(
	tool: { name: string; sourceInfo?: { path?: string; source?: string } },
	keepTools: string[],
): boolean {
	if (tool.name === "delegate") return true;
	const extensionId = deriveExtensionId(tool);
	return keepTools.some((matcher) => matcherMatches(matcher, tool.name, extensionId));
}

/** Matchers currently responsible for keeping a tool (used by the /orchestrator-tools UI). */
export function matchersForTool(
	tool: { name: string; sourceInfo?: { path?: string; source?: string } },
	keepTools: string[],
): string[] {
	if (tool.name === "delegate") return ["<built-in>"];
	const extensionId = deriveExtensionId(tool);
	return keepTools.filter((matcher) => matcherMatches(matcher, tool.name, extensionId));
}
