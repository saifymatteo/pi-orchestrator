# pi-orchestrator

A pi extension that turns the main agent into an **orchestrator**: its tools are reduced to a user-configured allow-list, and its only path to real work is the `delegate` tool, which spawns subagent workers with isolated contexts and full capabilities.

## Disclaimer

This whole project is wholly written by GLM 5.3 Flash via Pi harness. This package is intended to disable most of main agent capabilities and force it to delegate work to a subagent fleet.

## Install

Requires pi >= 0.84.0.

```bash
# From npm
pi install npm:@saifymatteo/pi-orchestrator

# From git
pi install git:github.com/saifymatteo/pi-orchestrator
```

Or from a cloned repo

```bash
git clone https://github.com/saifymatteo/pi-orchestrator.git

# Add this entry into your `~/.pi/agent/settings.json`
# "packages": [
#   # Your other packages
#   "<path-to-your-clone>/pi-orchestrator"
# ]

# Or, quick test
pi -e <path-to-your-clone>/pi-orchestrator/index.ts
```

## How it works

| Layer | Mechanism |
|---|---|
| Policy | `before_agent_start` appends a delegation policy every turn, generated from the discovered fleet and the tools actually kept (ADR-0004) |
| Reduction | `setActiveTools` keeps only the keep-list (re-applied every turn to catch late-registered tools) |
| Gate | `tool_call` blocks anything not on the keep-list, with guidance to delegate (ADR-0001) |
| Delegate tool | spawns `pi --mode rpc --no-session` children with `PI_ORCHESTRATOR_CHILD=1` (ADR-0002) |
| Turn budget | soft-grace steer at the budget, hard kill at budget + 5 turns (ADR-0006) |
| Stall watchdog | hard-kills a child silent for `stallTimeoutMs` (default 10 min); any output resets it (ADR-0006) |
| Child mode | children self-disable this extension; a parent-PID heartbeat watchdog exits them if pi dies |
| Child tool gate | children block tools matching `childBlockedTools` / per-agent `blockTools` two ways: expanded to concrete names and unregistered at spawn via `--exclude-tools`, plus a `tool_call` gate backstop with a visible reason (ADR-0007/0008) |
| UI | grouped fleet widget above the editor — `⏳ Fleet · <mode> · N running` header with one indented line per subagent (agent, turn, ctx load, tokens, task summary); idle line when nothing runs |

Child success is state-based (the RPC `agent_settled` event); child exit codes are informational only, since settled children are SIGTERMed by design.

`delegate` takes three dispatch shapes: `{agent, task}` for a single job, `tasks[]` (max 8, concurrency 4) for independent parallel work, and `chain[]` with a `{previous}` placeholder for dependent steps — plus a discovery shape, `{action: "list"}`, which returns the live fleet (names, sources, tools, descriptions) without spawning anything.

Agent names are discoverable before the first call: every `agent` field in the tool schema carries a JSON-Schema `enum` of the fleet discovered at extension load (fallback: free-form when the fleet is empty), so models pick from real names instead of inventing plausible ones. The `list` action and the `Unknown agent: ... Available agents: ...` error always reflect the fleet as of right now, including agents added mid-session.

## Config — `~/.pi/agent/orchestrator.json`

```json
{
  "enabled": true,
  "keepTools": ["delegate"],
  "childBlockedTools": [],
  "childExtensions": [],
  "forwardParentPrompt": true,
  "builtinFleet": true,
  "modelOverrides": {},
  "maxTurns": 50,
  "stallTimeoutMs": 600000
}
```

### `enabled` (boolean, default `true`)

Orchestration engaged by default. `/orchestrator` toggles it and persists the new value here.

### `keepTools` (string[], default `["delegate"]`)

Matchers for tools the orchestrator keeps while engaged. Matcher semantics (all case-insensitive):

- **Exact tool name** — `"todo"` matches the `todo` tool.
- **Glob on tool name** — `"hindsight_*"`; `*` matches any run of characters, `?` a single one.
- **Extension id** — `"ext:@luxusai/pi-hindsight"` matches every tool registered by that package, including tools added in future versions.

`delegate` is always kept, with or without a matcher.

**Empty vs non-empty `keepTools` (derived rule, ADR-0004):** an **empty** `keepTools` list auto-keeps every discovered non-builtin extension — each contributes an `ext:<id>` matcher to the effective keep-list each turn, so its tools stay available without config entries; extensions that re-register a builtin tool name still only contribute their non-colliding tools, kept by exact name (see below). A **non-empty** `keepTools` list is an exact allowlist — only the matching tools stay, plus `delegate`. The default `"keepTools": ["delegate"]` is therefore keep-list-only.

By default the effective keep-list is exactly your config matchers plus `delegate` — keep-list-only. Non-builtin packages are still discovered at runtime and shown in `/orchestrator-tools` (read-only), but their tools are NOT available to the orchestrator unless a matcher above names them or `keepTools` is empty (ADR-0004). Discovery covers non-builtin packages only — pi's core tools stay excluded unless a matcher names them. The derived information is never persisted; only your config matchers are written back to `orchestrator.json`. Existing config entries with old `ext:` ids remain valid — they simply match nothing while that package is absent, and match again if it returns.

**Builtin-shadowing exclusions:** extensions that re-register a builtin tool name (`read`, `bash`, `powershell`, `edit`, `write`, `grep`, `find`, `ls`) are excluded from discovery unless explicitly listed as `ext:<id>` in keepTools. Registration replaces the builtin wholesale, so keeping the shadow would silently resurrect a core tool the config never listed; an explicit `ext:<id>` entry re-enables the whole extension.

### `childBlockedTools` (string[], default `[]`)

Tool matchers blocked in **every subagent** (ADR-0007), enforced child-side. Matcher semantics are the same as `keepTools` (all case-insensitive):

- **Exact tool name** — `"advisor"` matches the `advisor` tool.
- **Glob on tool name** — `"hindsight_*"`; `*` matches any run of characters, `?` a single one.
- **Extension id** — `"ext:@luxusai/pi-hindsight"` matches every tool registered by that package.

Empty or absent means nothing is blocked — children run unrestricted. Semantics:

- **Additive union with per-agent `blockTools`**: the effective child block list is the global config matchers plus the agent's frontmatter matchers. Global config is a policy floor — a per-agent definition can add blocks but can never re-grant a globally blocked tool.
- **Always enforced twice (ADR-0008)**: the matchers are expanded parent-side to concrete tool names (glob and `ext:` matchers are resolved against the parent's tool registry at spawn time; matchers that expand to nothing are skipped silently) and the names are unregistered at spawn via pi's `--exclude-tools` comma list, so the child never even sees them — requires pi >= 0.84.0, which package.json already enforces. On top of that, a child-side interception gate blocks any matching tool call with a visible reason (`Blocked by orchestrator policy: ...`), so the subagent can adapt instead of failing opaquely. The gate is the backstop for tools the parent's registry could not see (e.g. a child loaded via a per-task `cwd` with extra project extensions) — blocked tools there stay *visible* but never execute.
- **System-prompt hint**: when tools are blocked, the agent's system prompt gets a `# Tool policy` section listing the blocked matchers.
- **Requires the extension in the child**: the backstop gate and the system-prompt hint run inside the child process, so pi-orchestrator must load there too. Children inherit installed packages automatically (ADR-0005); a user-level `~/.pi/agent` install is recommended so the gate is always present. If the extension does not load in the child, enforcement is fail-soft: the spawn-time `--exclude-tools` unregistration still applies, but nothing blocks anything else.

### `childExtensions` (string[], default `[]`)

Extension sources loaded in every child, with derived semantics (ADR-0008):

- **Empty (default)** — children inherit all discovered extensions, exactly as pi's own discovery provides (ADR-0005).
- **Non-empty** — children spawn with pi's `--no-extensions` flag (no global extensions load at all) and load only these entries via pi's repeatable `-e`/`--extension` flag (a path, npm, or git source).

Note: to keep the child-side tool gate and orphan watchdog alive in isolated children, add this package's entry via `childExtensions` (e.g. `["npm:@saifymatteo/pi-orchestrator"]`) — otherwise nothing loads child-side, this extension included. See [Child extension control](#child-extension-control) for the motivating case.

### `forwardParentPrompt` (boolean, default `true`)

When `true`, every subagent gets the orchestrator parent's pre-policy system prompt appended at the **END** of its system prompt (after pi's base prompt, the agent body, project context, skills, and cwd). The forwarding is done child-side: the parent writes the prompt to a temp file and passes its path via `PI_ORCHESTRATOR_PARENT_PROMPT_FILE`; a child-side `before_agent_start` hook appends it last. This ordering maximizes the stable shared prefix (base, context, skills, cwd) across children, which improves provider prompt-cache hit rates — only the task-specific tail differs. The appended prompt carries installed extensions' promptGuidelines — e.g. CodeGraph's tool usage guidance, which is injected into the parent's prompt — into subagents, so they use those tools effectively. Before appending, the hook **delta-strips** the segments the child already receives verbatim through its own prompt assembly — the `<project_context>` block, the `Current working directory:` line, and the `## Agent skills` section (only when the parent's entire skills slice appears verbatim in the child's prompt) — so they are not paid for twice; a segment is only removed when it appears byte-identical in the child's own prompt (so a per-task `cwd` override keeps the forwarded copy intact). Set to `false` to keep subagent prompts minimal (agent body + tool-policy hint only; no file or env var is set).

### `builtinFleet` (boolean, default `true`)

Include the fleet shipped with the extension: **scout** (read-only recon), **planner** (read-only planning), **worker** (general-purpose, full tools), **reviewer** (read-only + shell). User and project agents always shadow builtins by name (see [Agent discovery](#agent-discovery)).

### `modelOverrides` (object, default `{}`)

Pins a model per agent name, e.g. `{ "scout": "openrouter/some-cheap-model" }`. An agent's frontmatter `model` wins over the session's; a `modelOverrides` entry wins over both. When the agent defines no model, the child also inherits the dispatching session's thinking level.

### `maxTurns` (positive integer, default `50`)

The turn budget for subagents (ADR-0006), enforced in two stages:

- **Soft grace** at the budget: the child is steered once to wrap up and deliver its final answer.
- **Hard kill** at budget + 5 turns: the child is terminated and the run is reported as failed with a `turn-budget-exhausted` reason, preserving whatever output was produced so far.

The value must be a positive integer — strings, floats, zero, and negatives are rejected and fall back to the default. A per-agent frontmatter `maxTurns` overrides this config default.

### `stallTimeoutMs` (positive number, default `600000`)

The wall-clock stall watchdog for subagents (ADR-0006): any line a child writes to stdout — responses, message deltas, tool events — resets the timer, and a child that produces nothing for this long is hard-killed and reported as failed with a `stall-timeout` reason, preserving whatever output was produced so far.

The value must be a positive number (decimals allowed — it is milliseconds); strings, zero, and negatives are rejected and fall back to the default. There is no disable switch — to effectively disable the watchdog, set a huge value.

## Agent definitions

Every agent is a markdown file: YAML frontmatter plus a body that becomes the agent's system prompt.

| Field | Type | Meaning |
|---|---|---|
| `name` | string (required) | The name the orchestrator passes to `delegate` |
| `description` | string (required) | Shown to the orchestrator in the delegation policy so it can pick the right agent |
| `tools` | YAML list or comma-separated string | Restricts the child's toolset (e.g. `read, grep, find, ls`); omit for the full toolset |
| `blockTools` | YAML list or comma-separated string | Tool matchers blocked for this agent (exact, glob, `ext:<id>`); **additive** with the global `childBlockedTools` floor — it can extend but never re-grant (ADR-0007) |
| `model` | string | `provider/model` for this agent; falls back to the dispatching session's model |
| `hidden` | boolean | `true` excludes the agent from discovery |
| `maxTurns` | positive integer | Per-agent turn budget; overrides the config `maxTurns` |

```markdown
---
name: scout
description: Fast read-only codebase recon; returns compressed, structured findings
tools: read, grep, find, ls
maxTurns: 20
---

You are scout, a fast reconnaissance agent. ...
```

Files with a missing or non-string `name` or `description` are skipped. An invalid `maxTurns` (not a positive integer) is ignored — that agent falls back to the config default.

## Agent discovery

Agent directories, merged by name:

- **Builtin** — `agents/*.md` shipped with the extension (skipped when `builtinFleet: false`)
- **User** — `~/.pi/agent/agents/*.md`
- **Project** — `.pi/agents/` and `.agents/agents/` at every directory level, walking from the current directory up through the ancestor containing `.git` (or to the filesystem root)

Precedence on name collision: **project > user > builtin**. Within the project tree, nearer directories win, and at the same level `.pi/agents` beats `.agents/agents`. A shadowed agent is replaced entirely — there is one winning definition per name.

## Child extension control

Children inherit every globally installed extension (ADR-0005), and pi offers no way to suppress extensions at handler level — only spawn-time flags (`--no-extensions` plus selective `-e`). That matters because some extensions misbehave in short-lived RPC children: pi-workspace-history's 60s cleanup deletes other sessions' shadow repos (`repo.git`) when more than three sessions share a workspace, and its cached validation never re-checks, so the parent TUI spams `fatal: not a git repository` banners on every `turn_end`/`agent_settled`. To isolate children, list the extension sources a child actually needs in `childExtensions` — a non-empty list spawns children with `--no-extensions` plus one `-e` per entry, so nothing else loads (note this removes pi-orchestrator itself too, so the ADR-0007 tool gate and orphan watchdog go quiet unless the package is re-added via `childExtensions`); an empty list keeps the inherit-all default (ADR-0008).

## Stable child session ids

Children are spawned with a deterministic `--session-id` (works alongside `--no-session`, which only disables on-disk persistence): the id is a hash of `orchestrator:<agent-name>:<model>`, so it is stable per (agent, model) pair across spawns and parent restarts. OpenAI-compatible providers derive their `prompt_cache_key` / session-affinity key from the session id, so this keeps a given agent's requests on the same cache shard; Anthropic's native caching is content-prefix based and unaffected.

## Guardrails (optional)

[`@aliou/pi-guardrails`](https://www.npmjs.com/package/@aliou/pi-guardrails) gates dangerous tool calls with user approval. It is an optional recommendation, not a dependency of this extension:

```bash
pi install npm:@aliou/pi-guardrails
```

Child processes inherit installed extensions automatically through pi's own extension discovery (ADR-0005). Children run headless and fail closed: a dangerous operation is blocked with no UI to confirm it, so a subagent cannot talk its way past a guardrail. Pre-approve operations via `~/.pi/agent/extensions/guardrails.json` (session or always grants).

## Commands

- `/orchestrator` — toggle orchestration (persisted to orchestrator.json; startup notifies when disengaged)
- `/orchestrator-tools` — checkbox UI over the keep-list (TUI only); discovered `ext:` matchers are shown read-only; long tool lists truncate to terminal width (capped at 6 names + `+N more`)

## Policy and fleet text

The delegation policy is generated each turn from what is actually installed (ADR-0004): the allow-list names the tools currently retained, the fleet section lists the discovered agents and their tool restrictions, and the typical-flows example is composed from the discovered agent names. No other-package tool names or fleet names are hardcoded, so two installs with different packages produce slightly different policy text. `builtinFleet: false`, `hidden: true`, and project agents all change what the policy says.

## Files

- `index.ts` — entry: child watchdog, engagement, reduction, gate, commands
- `config.ts` — orchestrator.json, keep-list matchers, runtime tool discovery
- `width.ts` — visible-width helpers (ANSI-aware truncation for TUI rendering)
- `agents.ts` — fleet discovery (builtin, user, project tree)
- `policy.ts` — delegation policy text generated from fleet + kept tools
- `delegate.ts` — the delegate tool: RPC child spawning, turn budget, stall watchdog, progress streaming, renderers, reaping
- `agents/*.md` — builtin fleet definitions
- `docs/adr/` — decision records
