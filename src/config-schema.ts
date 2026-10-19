/** Shared configuration reference. Exported JSON is for editors, never a runtime validation gate. */
import { Type, type Static } from "typebox";
import { Create } from "typebox/value";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

const builtinFleetEntry = Type.Object({
	thinking: Type.Optional(Type.Enum(THINKING_LEVELS, {
		description: "Thinking level for this builtin, overriding its shipped frontmatter. Omit to use frontmatter, then normal inheritance. User/project agents of the same name are unaffected. Unsupported model/level combinations are passed to pi.",
		examples: ["high"],
	})),
	hidden: Type.Optional(Type.Boolean({
		description: "Exclude this builtin before merging agents by name. A user/project agent of the same name remains available. Omit or set false to include it.",
		default: false,
	})),
}, { additionalProperties: false });

export type BuiltinFleetEntry = Static<typeof builtinFleetEntry>;

const nonblankString = Type.String({ pattern: "\\S" });
// Unlike Type.Record's default .* pattern, this also covers names containing line terminators.
const agentName = Type.String({ pattern: "^[\\s\\S]*$" });

const configDefinition = Type.Object({
	enabled: Type.Boolean({
		description: "Engage orchestration by default. /orchestrator toggles engagement and persists it here; false leaves normal pi tools available (AUTO mode).",
		default: true,
	}),
	keepTools: Type.Array(nonblankString, {
		description: "Tools kept while engaged: case-insensitive exact names, globs (* for any run, ? for one character), or ext:<extension-id>. delegate is always kept. Omitted uses [\"delegate\"] (keep-list-only); [] instead auto-keeps discovered non-builtin extensions. Extensions shadowing builtin tool names contribute only non-colliding tools unless explicitly listed by ext:<id>. Non-empty lists keep only matching tools plus delegate. Stale matchers are harmless; discovery alone does not grant access.",
		default: ["delegate"],
		examples: [[], ["delegate", "hindsight_*", "ext:@luxusai/pi-hindsight"]],
	}),
	keepToolOverrides: Type.Record(nonblankString, Type.Enum(["allowed", "blocked"]), {
		additionalProperties: false,
		description: "Exact tool-name exceptions to keepTools for the engaged parent, case-insensitive. allowed or blocked overrides the baseline rule; delegate is always allowed. Omitted or {} follows keepTools. Keys are literal names, not globs or ext: matchers. The binary tool editor changes only these exceptions and removes an exception when the selected access matches the baseline. AUTO mode and subagents are unaffected.",
		default: {},
		examples: [{ foo_a: "blocked", read: "allowed" }],
	}),
	childBlockedTools: Type.Array(nonblankString, {
		description: "Tool matchers blocked in every subagent: exact names, * / ? globs, or ext:<extension-id>, case-insensitive. [] or omission blocks nothing globally. Per-agent blockTools adds to this floor and cannot re-grant tools. Exact names and * patterns pass to pi's --exclude-tools; other matchers expand parent-side. A child-side tool-call gate is the backstop when this extension loads in the child.",
		default: [],
		examples: [["bash", "hindsight_*", "ext:@example/tools"]],
	}),
	childExtensions: Type.Array(nonblankString, {
		description: "Extension sources (path, npm, or git) loaded in every child. [] or omission inherits discovered extensions. Non-empty uses --no-extensions and one -e per source; include this package itself to retain the child-side gate and orphan watchdog under selective loading.",
		default: [],
		examples: [["npm:@saifymatteo/pi-orchestrator", "./my-extension.ts"]],
	}),
	forwardParentPrompt: Type.Boolean({
		description: "Append the parent's pre-policy system prompt, including installed extension guidelines, to each child's prompt. Byte-identical project context, cwd, and skills already present in the child are stripped. false disables this forwarding; the child's own context and tool policy remain.",
		default: true,
	}),
	builtinFleet: Type.Union([Type.Boolean(), Type.Record(agentName, builtinFleetEntry)], {
		description: "Include shipped agents: true includes all, false none. An object sets per-builtin thinking/hidden overrides by name. Unlisted builtins remain included; unknown names are inert; {} includes all with no overrides. User/project agents always win by name. Invalid runtime entries are ignored with existing warnings; invalid thinking falls back to inheritance.",
		default: true,
		examples: [false, { worker: { thinking: "xhigh" }, planner: { hidden: true } }],
	}),
	modelOverrides: Type.Record(agentName, nonblankString, {
		description: "Models keyed by agent name (provider/modelId), taking precedence over agent frontmatter and the dispatching session. {} or omission pins no models. Agents without a pinned model or explicit thinking level inherit the session's thinking level. Blank/non-string runtime values are filtered out.",
		default: {},
		examples: [{ scout: "openrouter/some-cheap-model" }],
	}),
	maxTurns: Type.Integer({
		description: "Default subagent turn budget; per-agent frontmatter maxTurns overrides it. Soft grace asks the child to wrap up at the budget; hard kill at budget + 5 reports turn-budget-exhausted and preserves partial output. Must be a positive integer; invalid runtime values fall back to the default without coercion.",
		minimum: 1,
		default: 50,
		examples: [30],
	}),
	maxConcurrency: Type.Integer({
		description: "Maximum concurrently running subagents in the live session. Must be a positive safe integer; invalid runtime values fall back to the default without coercion.",
		minimum: 1,
		maximum: Number.MAX_SAFE_INTEGER,
		default: 4,
	}),
	maxQueuedRuns: Type.Integer({
		description: "Maximum subagent runs waiting for a concurrency slot in the live session. 0 disables the waiting queue. Must be a nonnegative safe integer; invalid runtime values fall back to the default without coercion.",
		minimum: 0,
		maximum: Number.MAX_SAFE_INTEGER,
		default: 32,
	}),
	stallTimeoutMs: Type.Number({
		description: "Subagent wall-clock stall timeout in milliseconds. Any stdout activity resets it; a silent child is hard-killed with stall-timeout and partial output preserved. Any positive finite number (including decimals); there is no disable switch—use a huge value instead. Invalid runtime values fall back to the default without coercion.",
		exclusiveMinimum: 0,
		default: 600_000,
		examples: [120_000],
	}),
	childSessions: Type.Boolean({
		description: "Keep persistent subagent pi sessions beside the parent's session, named orch: <agent> — <task> and linked to the parent. delegate({action: \"sessions\"}) lists them; partial transcripts survive failure/cancellation. false restores ephemeral children (--no-session).",
		default: true,
	}),
	async: Type.Boolean({
		description: "Default delegate dispatch mode. true returns an acceptance immediately and delivers the settled result later; false blocks for the final result. An explicit per-call async overrides this; chains always block regardless.",
		default: true,
	}),
});

export type OrchestratorConfig = Static<typeof configDefinition>;
export const DEFAULT_CONFIG: OrchestratorConfig = Create(configDefinition);

export const CONFIG_SCHEMA = Type.Object({
	$schema: Type.Optional(Type.String({ description: "Editor JSON Schema reference; not a runtime setting." })),
	...Type.Partial(configDefinition).properties,
}, {
	$schema: "https://json-schema.org/draft/2020-12/schema",
	title: "pi-orchestrator configuration",
	description: "Settings for orchestrator.jsonc or legacy orchestrator.json. All settings are optional. Described defaults apply when omitted; editor diagnostics do not change runtime normalization or fallback behavior.",
	additionalProperties: false,
});
