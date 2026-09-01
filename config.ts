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
 *
 * The effective keep-list is derived from keepTools (see effectiveKeepTools):
 * non-empty keepTools is keep-list-only — exactly the config matchers plus
 * `delegate` (added by the caller); empty keepTools auto-keeps every
 * discovered non-builtin extension (old ADR-0004 behavior; extensions that
 * re-register builtin tool names stay excluded from that auto-keep unless
 * explicitly listed as `ext:<id>` in keepTools). `discoverKeptTools` still
 * discovers non-builtin tools at runtime for the /orchestrator-tools display
 * and the policy text.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface OrchestratorConfig {
	/** Orchestration engaged by default (persistent toggle via /orchestrator). */
	enabled: boolean;
	/** Matchers for tools the orchestrator keeps while engaged. */
	keepTools: string[];
	/** Tool matchers blocked in every subagent (exact, glob, ext:<id>); always
	 *  enforced two ways (ADR-0008): expanded parent-side to concrete tool names
	 *  and unregistered via `--exclude-tools`, plus child-side via tool_call
	 *  block (backstop for tools the parent's registry could not see). */
	childBlockedTools: string[];
	/** Extension sources (path, npm, or git — pi's repeatable `-e` flag) loaded
	 *  in every child (ADR-0008). Derived semantics: non-empty spawns children
	 *  with `--no-extensions` plus one `-e` per entry (selective loading);
	 *  empty lets children inherit every discovered extension (ADR-0005). */
	childExtensions: string[];
	/** Include the fleet shipped with the extension (user agents always win by name). */
	builtinFleet: boolean;
	/** Per-agent model overrides, e.g. { "scout": "openrouter/some-cheap-model" }. */
	modelOverrides: Record<string, string>;
	/** Turn budget for subagents (ADR-0006). Must be a positive integer. */
	maxTurns: number;
	/** Wall-clock stall timeout for subagents in ms (ADR-0006). Any stdout
	 *  activity resets it; a child silent for this long is hard-killed. Any
	 *  positive number (no disable switch — use a huge value instead). */
	stallTimeoutMs: number;
}

export const DEFAULT_CONFIG: OrchestratorConfig = {
	enabled: true,
	keepTools: ["delegate"],
	childBlockedTools: [],
	childExtensions: [],
	builtinFleet: true,
	modelOverrides: {},
	maxTurns: 50,
	stallTimeoutMs: 600_000,
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
			childBlockedTools: Array.isArray(raw.childBlockedTools)
				? raw.childBlockedTools.filter((m): m is string => typeof m === "string" && m.trim().length > 0)
				: DEFAULT_CONFIG.childBlockedTools,
			childExtensions: Array.isArray(raw.childExtensions)
				? raw.childExtensions.filter((m): m is string => typeof m === "string" && m.trim().length > 0)
				: DEFAULT_CONFIG.childExtensions,
			builtinFleet: typeof raw.builtinFleet === "boolean" ? raw.builtinFleet : DEFAULT_CONFIG.builtinFleet,
			modelOverrides:
				raw.modelOverrides && typeof raw.modelOverrides === "object" && !Array.isArray(raw.modelOverrides)
					? Object.fromEntries(
							Object.entries(raw.modelOverrides).filter(([, v]) => typeof v === "string" && v.trim() !== ""),
						)
					: {},
			maxTurns: parseMaxTurns(raw.maxTurns) ?? DEFAULT_CONFIG.maxTurns,
			stallTimeoutMs: parseStallTimeoutMs(raw.stallTimeoutMs) ?? DEFAULT_CONFIG.stallTimeoutMs,
		};
	} catch {
		return {
			...DEFAULT_CONFIG,
			keepTools: [...DEFAULT_CONFIG.keepTools],
			childBlockedTools: [...DEFAULT_CONFIG.childBlockedTools],
			childExtensions: [...DEFAULT_CONFIG.childExtensions],
			modelOverrides: {},
			maxTurns: DEFAULT_CONFIG.maxTurns,
		};
	}
}

/** Positive integer or undefined (rejects strings, floats, zero, negatives — no coercion). */
function parseMaxTurns(value: unknown): number | undefined {
	return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

/** Positive number (floats allowed — ms precision) or undefined (rejects strings,
 *  zero, negatives, NaN, Infinity — no coercion). No disable switch: to disable
 *  the stall watchdog, set a huge value instead. */
function parseStallTimeoutMs(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

export function saveConfig(config: OrchestratorConfig): void {
	fs.mkdirSync(path.dirname(getConfigPath()), { recursive: true });
	fs.writeFileSync(getConfigPath(), `${JSON.stringify(config, null, 2)}\n`, "utf-8");
}

/**
 * Canonical pi builtin tool names (lowercase). Kept explicitly because tools
 * that override a builtin lose their `<builtin:` sourceInfo — registerTool
 * replaces the builtin wholesale — so the `<builtin:` prefix check in
 * deriveExtensionId cannot detect the shadow. Verified against pi's docs:
 * extensions.md / settings.md / usage.md list exactly these eight builtins.
 */
export const BUILTIN_TOOL_NAMES: ReadonlySet<string> = new Set([
	"read",
	"bash",
	"powershell",
	"edit",
	"write",
	"grep",
	"find",
	"ls",
]);

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

/** ext:<id> matcher vs a derived extension id (exact, case-insensitive). */
function extMatcherMatches(matcher: string, extensionId: string): boolean {
	const m = matcher.trim().toLowerCase();
	return m.startsWith("ext:") && extensionId.toLowerCase() === m.slice(4);
}

function matcherMatches(matcher: string, toolName: string, extensionId: string): boolean {
	const m = matcher.trim().toLowerCase();
	if (m.startsWith("ext:")) {
		return extMatcherMatches(matcher, extensionId);
	}
	if (m.includes("*") || m.includes("?")) return globToRegex(m).test(toolName);
	return toolName.toLowerCase() === m;
}

/**
 * First matcher that matches the tool (exact, glob, ext:<id>), or undefined.
 * Thin wrapper over matcherMatches/deriveExtensionId — same semantics as
 * toolIsKept, but returns the responsible matcher instead of a boolean.
 */
export function toolMatchesAnyMatcher(
	tool: { name: string; sourceInfo?: unknown },
	matchers: string[],
): string | undefined {
	const extensionId = deriveExtensionId(tool as { name: string; sourceInfo?: { path?: string; source?: string } });
	return matchers.find((matcher) => matcherMatches(matcher, tool.name, extensionId));
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

/** A tool discovered at runtime, grouped by its owning extension/package (ADR-0004). */
export interface DiscoveredTool {
	/** Owning extension id, as returned by deriveExtensionId. */
	extensionId: string;
	/** Tool names registered under this extension id (shadow-skipped ones excluded). */
	names: string[];
	/** True when at least one tool of this extension was builtin-shadow-skipped.
	 *  effectiveKeepTools must then emit per-name matchers instead of `ext:<id>`,
	 *  which would re-keep the shadowed builtin too. */
	partial: boolean;
}

/**
 * Discover the non-builtin tools currently installed (ADR-0004).
 *
 * Accepts a plain tool array (pi's getAllTools() shape) so config.ts stays
 * free of pi imports. `delegate` and builtin tools are excluded; the rest
 * are grouped and deduped by extensionId.
 *
 * Tools whose name shadows a pi builtin (BUILTIN_TOOL_NAMES) are excluded —
 * registerTool strips the builtin's `<builtin:` sourceInfo, so the shadow
 * would otherwise be auto-kept and resurrect the builtin — unless the tool's
 * derived extension id is explicitly referenced as `ext:<id>` in
 * `configKeepTools` (case-insensitive), which re-enables the whole extension.
 */
export function discoverKeptTools(
	tools: Array<{ name: string; sourceInfo?: { path?: string; source?: string } }>,
	configKeepTools: string[],
): DiscoveredTool[] {
	const byExtension = new Map<string, DiscoveredTool>();
	// Extensions with at least one builtin-shadow-skipped tool (see loop below).
	// Tracked separately because a shadowed tool may be visited before or after
	// its non-colliding siblings create the group entry.
	const shadowSkipped = new Set<string>();
	for (const tool of tools) {
		if (tool.name === "delegate") continue;
		const extensionId = deriveExtensionId(tool);
		if (extensionId === "builtin") continue;
		// Tools with no sourceInfo derive the "unknown" extension id; keeping
		// them via `ext:unknown` would bypass the keep-list gate blindly, so
		// they are not auto-kept (they can still be kept via explicit matchers).
		if (extensionId === "unknown") continue;
		// Shadowed builtin names are not auto-kept (see docblock) unless this
		// extension is explicitly opted in via an `ext:<id>` config matcher.
		if (
			BUILTIN_TOOL_NAMES.has(tool.name.toLowerCase()) &&
			!configKeepTools.some((matcher) => extMatcherMatches(matcher, extensionId))
		) {
			shadowSkipped.add(extensionId);
			continue;
		}

		let entry = byExtension.get(extensionId);
		if (!entry) {
			entry = { extensionId, names: [], partial: false };
			byExtension.set(extensionId, entry);
		}
		if (!entry.names.includes(tool.name)) entry.names.push(tool.name);
	}
	// Assign after the loop so visit order doesn't matter: a shadowed tool
	// seen after its group entry exists must still mark the group partial.
	for (const entry of byExtension.values()) {
		entry.partial = shadowSkipped.has(entry.extensionId);
	}
	return Array.from(byExtension.values());
}

/**
 * The effective keep-list, derived from `configKeepTools` emptiness:
 *   - Empty (no matchers) ⇒ auto-keep (old ADR-0004 behavior): an `ext:<id>`
 *     matcher is added for every fully-kept discovered extension. A *partial*
 *     extension — one of whose tools was builtin-shadow-skipped (see
 *     discoverKeptTools) — instead gets one exact per-name matcher for each
 *     surviving tool, so the siblings are kept without the `ext:<id>` matcher
 *     re-keeping the shadowed builtin. (With an empty list there are no
 *     explicit `ext:<id>` config entries, so no explicit-wins precedence
 *     applies.)
 *   - Non-empty ⇒ keep-list-only: exactly the config matchers (deduped);
 *     discovered extensions contribute nothing. An explicit `ext:<id>`
 *     config entry keeps the whole extension, partial or not.
 * DEFAULT_CONFIG.keepTools is ["delegate"] (non-empty), so the out-of-the-box
 * behavior is keep-list-only. Derived per turn — never persisted; only
 * `config.keepTools` is written back to orchestrator.json.
 */
export function effectiveKeepTools(configKeepTools: string[], discovered: DiscoveredTool[]): string[] {
	const matchers = new Set<string>();
	for (const matcher of configKeepTools) {
		const trimmed = matcher.trim();
		if (trimmed) matchers.add(trimmed);
	}
	if (matchers.size > 0) return Array.from(matchers);
	for (const d of discovered) {
		if (d.partial) {
			for (const name of d.names) matchers.add(name);
		} else {
			matchers.add(`ext:${d.extensionId}`);
		}
	}
	return Array.from(matchers);
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
