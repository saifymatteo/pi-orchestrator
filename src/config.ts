/**
 * Orchestrator configuration (~/.pi/agent/orchestrator.jsonc)
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
import { isDeepStrictEqual } from "node:util";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import * as jsonc from "jsonc-parser";

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
	/** Append the orchestrator parent's system prompt (pre-policy; includes
	 *  installed extensions' promptGuidelines, e.g. CodeGraph usage) to every
	 *  subagent's system prompt. Default true. */
	forwardParentPrompt: boolean;
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
	/** Persistent sub-sessions (ADR-0011). When true (default), each child run
	 *  keeps a pi session file — written next to the parent's session, named
	 *  `orch: <agent> — <task>`, and linked to the parent session via pi's
	 *  parentSession header — so the transcript survives for reference
	 *  (`delegate({action: "sessions"})` lists them). false restores
	 *  ephemeral children (--no-session). */
	childSessions: boolean;
	/** Default dispatch mode for the delegate tool (ADR-0016). true (default):
	 *  a dispatch without an explicit `async` parameter returns an acceptance
	 *  immediately and the settled result is delivered into the conversation
	 *  later. false: dispatches block until the final result. The per-call
	 *  `async` parameter always overrides this default; chains are always
	 *  blocking regardless. */
	async: boolean;
}

export const DEFAULT_CONFIG: OrchestratorConfig = {
	enabled: true,
	keepTools: ["delegate"],
	childBlockedTools: [],
	childExtensions: [],
	forwardParentPrompt: true,
	builtinFleet: true,
	modelOverrides: {},
	maxTurns: 50,
	stallTimeoutMs: 600_000,
	childSessions: true,
	async: true,
};

const CONFIG_FILENAME = "orchestrator.jsonc";
const LEGACY_CONFIG_FILENAME = "orchestrator.json";

export function getConfigPath(): string {
	return path.join(getAgentDir(), CONFIG_FILENAME);
}

function getLegacyConfigPath(): string {
	return path.join(getAgentDir(), LEGACY_CONFIG_FILENAME);
}

/**
 * Read the config file's raw text (ADR-0015): prefers `orchestrator.jsonc`,
 * falls back to the legacy `orchestrator.json` (plain JSON is valid JSONC —
 * nothing breaks). Returns null when neither exists.
 */
function readConfigText(): string | null {
	try {
		return fs.readFileSync(getConfigPath(), "utf-8");
	} catch {
		/* fall through to legacy */
	}
	try {
		return fs.readFileSync(getLegacyConfigPath(), "utf-8");
	} catch {
		return null;
	}
}

export function loadConfig(): OrchestratorConfig {
	try {
		const text = readConfigText();
		if (text === null) throw new Error("no config file");
		// JSONC parse (comments + trailing commas are valid; plain JSON too).
		// jsonc-parser reports problems instead of throwing — treat any parse
		// error like today's JSON.parse throw: fall back to defaults.
		const errors: jsonc.ParseError[] = [];
		const raw = jsonc.parse(text, errors, { allowTrailingComma: true }) as Partial<OrchestratorConfig>;
		if (errors.length > 0 || !raw || typeof raw !== "object") throw new Error("invalid config");
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
			forwardParentPrompt:
				typeof raw.forwardParentPrompt === "boolean"
					? raw.forwardParentPrompt
					: DEFAULT_CONFIG.forwardParentPrompt,
			builtinFleet: typeof raw.builtinFleet === "boolean" ? raw.builtinFleet : DEFAULT_CONFIG.builtinFleet,
			modelOverrides:
				raw.modelOverrides && typeof raw.modelOverrides === "object" && !Array.isArray(raw.modelOverrides)
					? Object.fromEntries(
							Object.entries(raw.modelOverrides).filter(([, v]) => typeof v === "string" && v.trim() !== ""),
						)
					: {},
			maxTurns: parseMaxTurns(raw.maxTurns) ?? DEFAULT_CONFIG.maxTurns,
			childSessions:
				typeof raw.childSessions === "boolean" ? raw.childSessions : DEFAULT_CONFIG.childSessions,
			async: typeof raw.async === "boolean" ? raw.async : DEFAULT_CONFIG.async,
			stallTimeoutMs: parseStallTimeoutMs(raw.stallTimeoutMs) ?? DEFAULT_CONFIG.stallTimeoutMs,
		};
	} catch {
		return {
			...DEFAULT_CONFIG,
			keepTools: [...DEFAULT_CONFIG.keepTools],
			childBlockedTools: [...DEFAULT_CONFIG.childBlockedTools],
			childExtensions: [...DEFAULT_CONFIG.childExtensions],
			forwardParentPrompt: DEFAULT_CONFIG.forwardParentPrompt,
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
	const preferred = getConfigPath();
	const legacy = getLegacyConfigPath();
	fs.mkdirSync(path.dirname(preferred), { recursive: true });

	// Comment-preserving write (ADR-0015): per-property edits applied to the
	// existing file's text — comments and unknown keys elsewhere in the file
	// survive. Without an existing file (fresh install, or a file so malformed
	// there is nothing to edit) the config is written as formatted JSON.
	const sourceText = readConfigText();
	let text: string;
	if (sourceText !== null && sourceText.trim() !== "") {
		const formatting: jsonc.FormattingOptions = { tabSize: 2, insertSpaces: true };
		// Sequential per-property edits: each modify() is computed against the
		// text as updated by the previous one. New properties all insert near
		// EOF, so batch-computing every edit against the original text would
		// overlap. Keys whose value did not change are skipped entirely —
		// rewriting them would drop comments INSIDE their values (e.g. keepTools).
		const current = jsonc.parse(sourceText, [], { allowTrailingComma: true }) as Record<string, unknown>;
		text = sourceText;
		for (const [key, value] of Object.entries(config)) {
			if (isDeepStrictEqual(current?.[key], value)) continue;
			text = jsonc.applyEdits(text, jsonc.modify(text, [key], value, { formattingOptions: formatting }));
		}
	} else {
		text = `${JSON.stringify(config, null, 2)}\n`;
	}
	fs.writeFileSync(preferred, text.endsWith("\n") ? text : `${text}\n`, "utf-8");
	// One-time migration: remove the legacy file only AFTER the .jsonc was
	// written successfully, so a failed write never loses the user's config.
	if (fs.existsSync(legacy)) fs.rmSync(legacy);
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
 * `config.keepTools` is written back to orchestrator.jsonc.
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
