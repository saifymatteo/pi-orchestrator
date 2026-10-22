# Configuration

[Quickstart](../README.md) · [Usage](usage.md) · [Custom agents](custom-agents.md)

Configuration file: `~/.pi/agent/orchestrator.jsonc`.

## On this page

- [Editor assistance and field reference](#editor-assistance-and-field-reference)
- [Shared Worker capacity](#shared-worker-capacity)
- [Engagement and parent tool access](#engagement-and-parent-tool-access)
- [Child tool policy](#child-tool-policy)
- [Parent prompt forwarding](#parent-prompt-forwarding)
- [Persistent child transcripts](#persistent-child-transcripts)
- [Choosing the dispatch mode](#choosing-the-dispatch-mode)
- [Customizing the builtin fleet](#customizing-the-builtin-fleet)
- [Thinking levels](#thinking-levels)
- [Pinning models](#pinning-models)
- [Turn budgets and stall recovery](#turn-budgets-and-stall-recovery)
- [Match custom and local extensions](#match-custom-and-local-extensions)
- [Child extension control](#child-extension-control)
- [Guardrails (optional)](#guardrails-optional)

The config is JSONC: comments next to any key survive every save, because the extension edits only the keys it changes through `jsonc-parser`'s comment-preserving modify API. A legacy `orchestrator.json` is still read; the first save writes `orchestrator.jsonc` before removing the old file. Every setting is optional; `{}` is valid and uses the runtime defaults.

## Editor assistance and field reference

The [configuration schema](../schemas/orchestrator.schema.json) owns the exhaustive field types, defaults, constraints, descriptions, and examples, authored in the shared [definition](../src/config-schema.ts). The concepts and recipes below explain how to use those settings together. This schema covers only `orchestrator.jsonc` and legacy `orchestrator.json`, not pi settings or agent frontmatter.

A standard `$schema` reference enables completion, hover documentation, and strict unknown-key diagnostics in schema-capable JSON/JSONC editors. For example, this recipe keeps a memory tool available to the parent but blocks it in children:

```jsonc
{
  // Match this version to the installed package.
  "$schema": "https://cdn.jsdelivr.net/npm/@saifymatteo/pi-orchestrator@0.9.0/schemas/orchestrator.schema.json",
  "keepTools": ["delegate", "hindsight_*"],
  "childBlockedTools": ["hindsight_*"]
}
```

Use the schema URL matching your installed package version, shown above for `0.9.0`. In a development checkout, use a local reference instead, such as `"$schema": "../schemas/orchestrator.schema.json"` for a config one directory below the checkout root. Adjust the relative path from your config's directory to the checkout's schema; the same path will not generally work in `~/.pi/agent/`.

Editor diagnostics are **not runtime validation**. Unknown setting names (including typos such as `maxTurn`) are flagged in the editor but remain ignored by the loader and preserved on save. Invalid values such as `maxTurns: 0` get editor diagnostics while retaining the existing runtime fallback behavior. Supported agent-name maps allow arbitrary names; their values and known nested fields are still checked by the editor. Schema `default` annotations document defaults, not instructions to insert them into your file. `$schema` is metadata, not a runtime option.

Normal configuration saves (for example, `/orchestrator`) add a missing `$schema` reference or refresh a recognized extension-owned reference to the installed version's pinned URL. Custom schema URLs and comments are preserved, including during legacy-file migration. Existing configs get a reference on their next normal save, or you can add one manually. **Loading never writes files or fetches schemas.** Your editor may fetch or cache the schema; an offline editor or unavailable CDN affects assistance only, not runtime loading. For an unreleased checkout, use the local reference above even if a save inserted a not-yet-published version URL.

See [ADR-0019](adr/0019-config-json-schema.md) for the editor/runtime boundary and publishing decision.

## Shared Worker capacity

Two optional settings configure the shared Worker pool:

```jsonc
{
  "maxConcurrency": 4, // positive safe integer: shared active Worker limit
  "maxQueuedRuns": 32 // nonnegative safe integer: waiting capacity; 0 disables queueing
}
```

Both are bounded by JavaScript's maximum safe integer (`9007199254740991`); missing or invalid runtime values fall back to their defaults. `maxQueuedRuns: 0` allows dispatch only when every task can immediately take an active slot. These limits apply across delegate calls and modes in one parent session, not across independent parent sessions. The maximum of 8 tasks in a parallel request is unchanged.

The limits follow the existing configuration lifecycle: loaded at extension initialization and reloaded on `session_start`. Editing the file does not install a live file watcher. Whenever changed limits take effect, already accepted runs remain owned; lowering a limit drains existing work without killing active Workers or evicting queued runs. See [ADR-0020](adr/0020-live-session-run-lifecycle.md) for admission and delivery semantics.

## Engagement and parent tool access

Orchestration starts engaged unless configured otherwise with `enabled`. `/orchestrator` toggles it and persists the new value here.

`keepTools` defines the baseline for the engaged parent's tool access; `keepToolOverrides` applies individual exceptions. Neither changes AUTO (disengaged) mode or Workers' tool access.

Baseline matchers, all case-insensitive:

- **Exact name**: `"todo"` matches the `todo` tool.
- **Glob**: `"hindsight_*"`, where `*` matches any run of characters and `?` a single one.
- **Extension id**: `"ext:@luxusai/pi-hindsight"` matches every tool registered by that package, including tools added in future versions.

`delegate` is always kept, with or without a matcher or override. The list's emptiness decides the baseline mode:

- **Empty**: auto-keeps every discovered non-builtin extension, each contributing an `ext:<id>` matcher each turn. Extensions that re-register a builtin tool name contribute only their non-colliding tools, kept by exact name.
- **Non-empty** (the default): only matching tools stay, plus `delegate`, before per-tool overrides.

Discovered extension groups appear read-only in `/orchestrator-tools`; individual tools can be toggled without changing the baseline. Stale `ext:` entries stay valid: they match nothing while the package is absent and match again when it returns.

**Builtin-shadowing:** extensions that re-register a builtin tool name (`read`, `bash`, `powershell`, `edit`, `write`, `grep`, `find`, `ls`) are excluded from auto-keep unless explicitly listed as `ext:<id>`. Registration replaces the builtin wholesale, so auto-keeping the shadow would resurrect a core tool the config never listed. An explicit `ext:<id>` entry re-enables the whole extension; a per-tool override can allow just one tool.

`keepToolOverrides` defaults to `{}`. Its keys are exact tool names matched case-insensitively, **not** globs or `ext:` matchers; values are `"allowed"` or `"blocked"`. Each override wins over the baseline for that tool, except that `delegate` is always allowed. The result is the **effective keep-list**, used by both tool reduction and the Gate.

```jsonc
{
  "keepTools": ["delegate", "hindsight_*"],
  "keepToolOverrides": {
    "hindsight_reflect": "blocked", // block one member of the kept group
    "todo": "allowed" // allow one tool outside the baseline
  }
}
```

`/orchestrator-tools` offers a binary allowed/blocked choice per tool. It writes only that tool's override, never `keepTools`; choosing the baseline result removes the tool's override instead. Automatic discovery and group matchers keep governing siblings and future tools, so toggling one tool never freezes the discovered tool list or rewrites a group rule. A successful manual edit refreshes the cached policy on the next engaged turn so its advertised allow-list matches the new permissions; ordinary turns and background discovery retain the existing cache (ADR-0013). If saving fails, the editor restores the previous choice and leaves permissions unchanged.

## Child tool policy

`childBlockedTools` blocks tool matchers in every subagent, using the same matcher semantics as `keepTools`. It applies to every `delegate` spawn whether the parent is engaged or in AUTO; it does not restrict the parent's tools. Empty or absent means nothing is blocked.

- **Additive with per-agent `blockTools`**: the effective block list is the global matchers plus the agent's frontmatter matchers. The config is a floor: an agent can add blocks but never re-grant a globally blocked tool.
- **Enforced twice**: matchers pi's `--exclude-tools` accepts (exact names and `*` globs) pass through to it verbatim, so the child's own registry filters them (covering tools the parent's registry cannot see, e.g. when a per-task `cwd` loads extra project extensions); `ext:<id>` and `?` matchers expand against the parent's registry to concrete names first (matchers that expand to nothing are skipped silently there). On top of that, a child-side gate blocks any matching tool call with a visible reason (`Blocked by orchestrator policy: …`), so the subagent can adapt instead of failing opaquely. The gate also covers case-mismatched or unseen tools the spawn-time pass misses: blocked tools stay visible but never execute.
- **System-prompt hint**: when tools are blocked, the child's system prompt gets a `# Tool policy` section listing the matchers.
- **Fail-soft**: the gate and hint run inside the child, so pi-orchestrator must load there too. Children inherit installed packages automatically; a user-level `~/.pi/agent` install keeps the gate always present. Without it, only the spawn-time unregistration applies.

## Parent prompt forwarding

With `forwardParentPrompt: true`, every subagent gets the parent's pre-policy system prompt appended at the end of its own. The parent captures the current prompt on every turn in both AUTO and engaged mode; AUTO still leaves the parent's toolset untouched and appends no delegation policy. The parent writes the prompt to a temp file and passes the path via `PI_ORCHESTRATOR_PARENT_PROMPT_FILE`; a child-side hook appends it last, after pi's base prompt, the agent body, project context, skills, and cwd.

This ordering maximizes the stable shared prefix across children, which improves provider prompt-cache hit rates: only the task-specific tail differs. The appended prompt also carries installed extensions' prompt guidelines (e.g. CodeGraph's tool usage guidance) into subagents.

Before appending, the hook strips segments the child already receives verbatim, so they aren't paid for twice:

- the `<project_context>` block
- the `Current working directory:` line
- the `## Agent skills` section, only when the child's entire skills slice appears byte-identical

The strip only fires on byte-identical matches, so a per-task `cwd` override keeps the forwarded copy intact. Set to `false` to keep subagent prompts minimal: agent body plus tool-policy hint, no file, no env var.

## Persistent child transcripts

With `childSessions: true`, every subagent keeps a persistent pi session instead of running ephemeral: the child spawns without `--no-session` and with `--session-dir` pointing at the parent's session directory, and the parent links it via RPC `new_session {parentSession}` before the task prompt. The session is named `orch: <agent> — <task-summary>` so it's findable in `/resume` (filter named sessions with Ctrl+N).

- Every `delegate` result ends with `Subagent session: <path>`: the full transcript on disk (task, tool calls, readings), not the returned summary alone.
- The transcript survives normal completion, turn-budget kill, stall kill, aborts, and parent death. Partial work from a killed child stays inspectable.
- `delegate({action: "sessions"})` lists the current parent session's sub-sessions (newest first), derived from on-disk headers, so it works after restarts and resumes.
- Sessions are file-per-run: two concurrent runs of the same agent never share a JSONL. The deterministic per-(agent, model) id is only used for ephemeral runs, where it stabilizes the OpenAI-compat `prompt_cache_key`. Sessions are created lazily: a child killed before its first message leaves no file.

For stable cache-affinity ids in ephemeral mode, see [Usage](usage.md#stable-child-session-ids). Persistent transcripts are inspection artifacts, not restart recovery for the live queue or delivery state.

Set to `false` to restore ephemeral children (`--no-session`). A child spawned with a per-task `cwd` override still writes into the parent's session dir: the link is by parent session, not by cwd.

## Choosing the dispatch mode

See [dispatch modes and examples](usage.md#dispatch-modes) for tool calls.

`async` sets the default dispatch mode for the delegate tool. `true`: a dispatch without an explicit `async` parameter returns an acceptance immediately and the settled result is delivered into the conversation later. `false`: dispatches block until the final result, which suits short, sequential fleets.

- The per-call `async` parameter always overrides this default; chains are always blocking regardless.
- The delegate tool description and the policy text are generated from this value, so the model's instructions always match the configured behavior.

## Customizing the builtin fleet

Include the fleet shipped with the extension: **scout** (read-only recon), **planner** (read-only planning), **worker** (general-purpose, full tools), **reviewer** (read-only + shell). User and project agents always shadow builtins by name.

- `true` (default): every builtin is included. `false`: none are.
- Object form overrides per builtin, keyed by agent name, reusing agent-frontmatter fields:
  - `"hidden": true` excludes the builtin from the fleet, filtered before the name-merge, so a user/project agent of the same name still works.
  - `"thinking"` sets the builtin's thinking level (see [Thinking levels](#thinking-levels)), overriding its shipped frontmatter: config outranks what you cannot edit.
  - Builtins not listed stay included with no explicit level; entries for unknown names are inert.

```jsonc
{
  "builtinFleet": {
    "worker": { "thinking": "xhigh" }, // config beats the shipped frontmatter
    "planner": { "hidden": true } // remove planner; define your own instead
  }
}
```

## Thinking levels

The reasoning effort a subagent runs with: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. An explicit level is independent of the model: it applies even to an agent with a pinned `model` (an unsupported model/level combination passes through to pi, which errors or clamps).

Set it in agent frontmatter (`thinking: high`) or, for builtins only, in the `builtinFleet` map. Precedence:

1. Explicit level: for a **builtin**, the `builtinFleet` entry beats its shipped frontmatter; for a **user/project** agent, the frontmatter `thinking` is the only source.
2. No explicit level: the dispatching session's live thinking level is inherited, but only by agents without a pinned `model`.
3. Otherwise pi's per-model default applies.

An invalid value warns once and falls back to inheritance. The shipped fleet comes tuned: scout `low`, planner `high`, worker `medium`, reviewer `high`.

## Pinning models

`modelOverrides` pins a model per agent name, e.g. `{ "scout": "openrouter/some-cheap-model" }`. Precedence: a `modelOverrides` entry beats the agent's frontmatter `model`, which beats the dispatching session's model. When the agent defines neither a model nor an explicit thinking level (see [Thinking levels](#thinking-levels)), the child also inherits the session's thinking level.

## Turn budgets and stall recovery

`maxTurns` sets the turn budget for subagents, enforced in two stages:

- **Soft grace** at the budget: the child is steered once to wrap up and deliver its final answer.
- **Hard kill** at budget + 5 turns: the child is terminated and the run reported as failed with a `turn-budget-exhausted` reason, preserving output produced so far.

A per-agent frontmatter `maxTurns` overrides this config default; invalid runtime values fall back to the default.

`stallTimeoutMs` controls the wall-clock stall watchdog: any line a child writes to stdout resets the timer, and a child silent for this long is hard-killed and reported as failed with a `stall-timeout` reason, preserving output produced so far. There is no disable switch: to effectively disable it, set a huge value.

## Match custom and local extensions

Matcher semantics never read `settings.json` or any install manifest: pi-orchestrator derives each tool's extension id at runtime from the `sourceInfo` path of the registered tool. `ext:<id>` therefore works for extensions loaded from any source, but the id is not always the product name you expect.

The derivation rules:

- **Package source**: a path under `node_modules` yields the package name, scope included: `~/.pi/agent/npm/node_modules/@plannotator/pi-extension/dist/index.js` → `@plannotator/pi-extension`.
- **File source**: any other path yields the filename without extension: `~/.pi/agent/extensions/bg-bash.ts` → `bg-bash`.

Two consequences worth checking against your own installs:

- **The entry file's name decides the id.** An `extensions` entry in `settings.json` such as `~/.hindsight/coding-agents/dist/pi.js` derives the id `pi`, not `hindsight`: `ext:hindsight` matches nothing, and `ext:pi` would match every tool that file registers. Match by tool-name glob instead (`hindsight_*`).
- **Builtin replacements keep their own id.** An extension that re-registers a builtin (bg-bash, for example, replaces `bash` and `powershell`) is reachable only through `ext:<id>` (`ext:bg-bash`); a bare `bash` matcher targets the tool name, whichever implementation registered it.

Common goals and the config that expresses each:

| Goal | Parent (main agent) | Children |
|---|---|---|
| Keep for parent, block for children | add the matcher to `keepTools` | add the same matcher to `childBlockedTools` |
| Block for parent, keep for children | exclude it from the baseline, or block an individual tool with `keepToolOverrides` | leave it out of `childBlockedTools` |
| Keep everywhere | add to `keepTools`, or allow an individual tool with `keepToolOverrides` | leave `childBlockedTools` alone |
| Block everywhere | exclude it from the baseline, or block an individual tool with `keepToolOverrides` | add to `childBlockedTools` |

The parent column applies only while orchestration is engaged: availability follows the baseline plus per-tool overrides, with `delegate` always allowed. Omitting a matcher blocks a tool only if no other baseline rule keeps it (including automatic discovery with `keepTools: []`) and no override allows it. AUTO mode (via `/orchestrator`) exposes all tools again. The child column applies on every `delegate` spawn regardless of engagement. To exclude an extension's code from children entirely, not just its tools, see [Child extension control](#child-extension-control).

To find the id a tool actually derives, run `/orchestrator-tools`: every discovered extension group appears read-only as `ext:<id>` with the tool names it registered; individual tool choices write per-tool overrides.

## Child extension control

Children inherit every globally installed extension, and pi offers no way to suppress extensions at handler level, only at spawn time. That matters because some extensions misbehave in short-lived RPC children. Example: pi-workspace-history's cleanup deletes other sessions' shadow repos when more than three sessions share a workspace, and the parent TUI then spams `fatal: not a git repository` banners on every turn end.

Use `childExtensions` to choose extension sources loaded in every child: a path, npm, or git source.

- **Empty (default)**: children inherit all discovered extensions, as pi's own discovery provides.
- **Non-empty**: children spawn with `--no-extensions` and load only these entries via pi's repeatable `-e` flag.

Isolation removes pi-orchestrator itself too. Re-add it, e.g. `"childExtensions": ["npm:@saifymatteo/pi-orchestrator"]`, or the child-side tool gate and orphan watchdog go quiet.

## Guardrails (optional)

[`@aliou/pi-guardrails`](https://www.npmjs.com/package/@aliou/pi-guardrails) gates dangerous tool calls with user approval. It is an optional recommendation, not a dependency:

```bash
pi install npm:@aliou/pi-guardrails
```

Children inherit installed extensions automatically and run headless: a dangerous operation is blocked with no UI to confirm it, so a subagent cannot talk its way past a guardrail. Pre-approve operations via `~/.pi/agent/extensions/guardrails.json` (session or always grants).
