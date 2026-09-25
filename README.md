# pi-orchestrator

A pi extension that turns the main agent into an orchestrator: its tools are reduced to a configurable allow-list, and its only path to real work is the `delegate` tool, which spawns subagent workers with isolated contexts and full capabilities.

## Disclaimer

This project is written entirely by GLM 5.3 Flash via the pi harness. It intentionally disables most main-agent capabilities and forces delegation to a subagent fleet.

## Install

Requires pi >= 0.84.0.

From npm:

```bash
pi install npm:@saifymatteo/pi-orchestrator
```

From git:

```bash
pi install git:github.com/saifymatteo/pi-orchestrator
```

From a local clone, add the path to `packages` in `~/.pi/agent/settings.json`:

```jsonc
"packages": [
  // your other packages
  "<path-to-your-clone>/pi-orchestrator"
]
```

For a quick test without installing:

```bash
pi -e <path-to-your-clone>/pi-orchestrator/src/index.ts
```

## How it works

While engaged, the orchestrator parent runs on these layers:

| Layer | Mechanism |
|---|---|
| Policy | `before_agent_start` appends a delegation policy every turn: cached text, computed once per engagement from the discovered fleet and kept tools |
| Reduction | `setActiveTools` keeps only the keep-list, re-applied every turn to catch late-registered tools |
| Gate | `tool_call` blocks anything not on the keep-list and nudges the model to delegate |
| Delegate tool | spawns `pi --mode rpc` children with `PI_ORCHESTRATOR_CHILD=1`; persistent sub-sessions by default (file-per-run in the parent's session dir, linked via `new_session {parentSession}`) |
| Turn budget | soft-grace steer at the budget, hard kill at budget + 5 turns |
| Stall watchdog | hard-kills a child silent for `stallTimeoutMs` (default 10 min); any output resets it |
| Child mode | children self-disable this extension; a parent-PID heartbeat watchdog exits them if pi dies |
| Child tool gate | children block tools matching `childBlockedTools` / per-agent `blockTools` at spawn (`--exclude-tools`) plus a child-side gate backstop |
| UI | fleet widget above the editor: `⏳ Fleet · <mode> · N running` header plus one line per subagent (agent, turn, ctx load, tokens, task summary); idle line when nothing runs |

Child success is state-based (the RPC `agent_settled` event); exit codes are informational only.

**Dispatch modes.** Dispatch is async by default: single and parallel dispatches (`tasks[]`, max 8, concurrency 4) return run ids immediately, and each settled result is pushed into the conversation automatically, so the orchestrator never polls and stays free to talk with you or dispatch more work mid-flight. Pass `async: false` to block until the final result. Chains are always blocking because each step consumes the prior result. These control and discovery shapes never spawn anything:

- `{action: "list"}`: the live fleet
- `{action: "status"}`: live runs
- `{action: "cancel", runId}`: kill one run
- `{action: "sessions"}`: persistent subagent transcripts

**Fleet discovery.** Every `agent` field in the tool schema carries an enum of the fleet discovered at extension load (free-form input when the fleet is empty), so models pick real names instead of inventing plausible ones. The `list` action and the `Unknown agent` error always reflect the fleet as of right now, including agents added mid-session.

**Lifecycle.** ESC and session shutdown kill the whole fleet; a crashed parent's children self-terminate within ~5s via the heartbeat.

Design decisions live in the architecture decision records under `docs/adr/`.

## Config: `~/.pi/agent/orchestrator.jsonc`

The config is JSONC: comments next to any key survive every save, because the extension edits only the keys it changes through `jsonc-parser`'s comment-preserving modify API. A legacy `orchestrator.json` is still read; the first save writes `orchestrator.jsonc` and removes the old file. Copy the example below and delete the keys you don't need: every key is optional and falls back to its default when absent.

```jsonc
{
  "enabled": true, // orchestration engaged by default (/orchestrator toggles)
  "keepTools": ["delegate"], // tools the orchestrator keeps while engaged: exact name, "glob_*", or "ext:<extension-id>"
  "childBlockedTools": [], // tools blocked in every subagent, e.g. ["bash", "hindsight_*"]
  "childExtensions": [], // extension sources loaded in every child (path, npm, or git)
  "forwardParentPrompt": true, // append the orchestrator parent's system prompt to every subagent
  "childSessions": true, // persistent sub-sessions, listed via delegate({action: "sessions"})
  "async": true, // delegate dispatches return an acceptance immediately; false = block for the final result
  "builtinFleet": true, // include the built-in fleet: scout, planner, worker, reviewer
  "modelOverrides": {}, // pin a model per agent, e.g. { "scout": "openrouter/some-cheap-model" }
  "maxTurns": 50, // per-subagent turn budget
  "stallTimeoutMs": 600000 // hard-kill a child silent for this long (600000 = 10 min)
}
```

### `enabled` (boolean, default `true`)

Orchestration engaged by default. `/orchestrator` toggles it and persists the new value here.

### `keepTools` (string[], default `["delegate"]`)

Matchers for tools the orchestrator keeps while engaged, all case-insensitive:

- **Exact name**: `"todo"` matches the `todo` tool.
- **Glob**: `"hindsight_*"`, where `*` matches any run of characters and `?` a single one.
- **Extension id**: `"ext:@luxusai/pi-hindsight"` matches every tool registered by that package, including tools added in future versions.

`delegate` is always kept, with or without a matcher. The list's emptiness decides the mode:

- **Empty**: auto-keeps every discovered non-builtin extension, each contributing an `ext:<id>` matcher each turn. Extensions that re-register a builtin tool name contribute only their non-colliding tools, kept by exact name.
- **Non-empty** (the default): an exact allow-list. Only matching tools stay, plus `delegate`.

Discovered packages always appear read-only in `/orchestrator-tools`; availability is decided by the mode above. Stale `ext:` entries stay valid: they match nothing while the package is absent and match again when it returns.

**Builtin-shadowing:** extensions that re-register a builtin tool name (`read`, `bash`, `powershell`, `edit`, `write`, `grep`, `find`, `ls`) are excluded from auto-keep unless explicitly listed as `ext:<id>`. Registration replaces the builtin wholesale, so auto-keeping the shadow would resurrect a core tool the config never listed. An explicit `ext:<id>` entry re-enables the whole extension.

### `childBlockedTools` (string[], default `[]`)

Tool matchers blocked in every subagent, same matcher semantics as `keepTools`. Empty or absent means nothing is blocked.

- **Additive with per-agent `blockTools`**: the effective block list is the global matchers plus the agent's frontmatter matchers. The config is a floor: an agent can add blocks but never re-grant a globally blocked tool.
- **Enforced twice**: matchers are expanded to concrete names (matchers that expand to nothing are skipped silently) and unregistered at spawn via `--exclude-tools`, so the child never sees them. On top of that, a child-side gate blocks any matching tool call with a visible reason (`Blocked by orchestrator policy: ...`), so the subagent can adapt instead of failing opaquely. The gate also covers tools the parent's registry could not see, e.g. when a per-task `cwd` loads extra project extensions: blocked tools stay visible but never execute.
- **System-prompt hint**: when tools are blocked, the child's system prompt gets a `# Tool policy` section listing the matchers.
- **Fail-soft**: the gate and hint run inside the child, so pi-orchestrator must load there too. Children inherit installed packages automatically; a user-level `~/.pi/agent` install keeps the gate always present. Without it, only the spawn-time unregistration applies.

### `childExtensions` (string[], default `[]`)

Extension sources loaded in every child: a path, npm, or git source.

- **Empty (default)**: children inherit all discovered extensions, as pi's own discovery provides.
- **Non-empty**: children spawn with `--no-extensions` and load only these entries via pi's repeatable `-e` flag.

To keep the child-side tool gate and orphan watchdog alive in isolated children, add this package itself to the list, e.g. `["npm:@saifymatteo/pi-orchestrator"]`. See [Child extension control](#child-extension-control).

### `forwardParentPrompt` (boolean, default `true`)

When `true`, every subagent gets the parent's pre-policy system prompt appended at the end of its own. The parent writes the prompt to a temp file and passes the path via `PI_ORCHESTRATOR_PARENT_PROMPT_FILE`; a child-side hook appends it last, after pi's base prompt, the agent body, project context, skills, and cwd.

This ordering maximizes the stable shared prefix across children, which improves provider prompt-cache hit rates: only the task-specific tail differs. The appended prompt also carries installed extensions' prompt guidelines (e.g. CodeGraph's tool usage guidance) into subagents.

Before appending, the hook strips segments the child already receives verbatim, so they aren't paid for twice:

- the `<project_context>` block
- the `Current working directory:` line
- the `## Agent skills` section, only when the child's entire skills slice appears byte-identical

The strip only fires on byte-identical matches, so a per-task `cwd` override keeps the forwarded copy intact. Set to `false` to keep subagent prompts minimal: agent body plus tool-policy hint, no file, no env var.

### `childSessions` (boolean, default `true`)

When `true`, every subagent keeps a persistent pi session instead of running ephemeral: the child spawns without `--no-session` and with `--session-dir` pointing at the parent's session directory, and the parent links it via RPC `new_session {parentSession}` before the task prompt. The session is named `orch: <agent> — <task-summary>` so it's findable in `/resume` (filter named sessions with Ctrl+N).

- Every `delegate` result ends with `Subagent session: <path>`: the full transcript on disk (task, tool calls, readings), not just the returned summary.
- The transcript survives normal completion, turn-budget kill, stall kill, aborts, and parent death. Partial work from a killed child stays inspectable.
- `delegate({action: "sessions"})` lists the current parent session's sub-sessions (newest first), derived from on-disk headers, so it works after restarts and resumes.
- Sessions are file-per-run: two concurrent runs of the same agent never share a JSONL. The deterministic per-(agent, model) id is only used for ephemeral runs, where it stabilizes the OpenAI-compat `prompt_cache_key`. Sessions are created lazily: a child killed before its first message leaves no file.

Set to `false` to restore ephemeral children (`--no-session`). A child spawned with a per-task `cwd` override still writes into the parent's session dir: the link is by parent session, not by cwd.

### `async` (boolean, default `true`)

Default dispatch mode for the delegate tool. `true`: a dispatch without an explicit `async` parameter returns an acceptance immediately and the settled result is delivered into the conversation later. `false`: dispatches block until the final result, which suits short, sequential fleets.

- The per-call `async` parameter always overrides this default; chains are always blocking regardless.
- The delegate tool description and the policy text are generated from this value, so the model's instructions always match the configured behavior.

### `builtinFleet` (boolean, default `true`)

Include the fleet shipped with the extension: **scout** (read-only recon), **planner** (read-only planning), **worker** (general-purpose, full tools), **reviewer** (read-only + shell). User and project agents always shadow builtins by name.

### `modelOverrides` (object, default `{}`)

Pins a model per agent name, e.g. `{ "scout": "openrouter/some-cheap-model" }`. Precedence: a `modelOverrides` entry beats the agent's frontmatter `model`, which beats the dispatching session's model. When the agent defines no model, the child also inherits the session's thinking level.

### `maxTurns` (positive integer, default `50`)

Turn budget for subagents, enforced in two stages:

- **Soft grace** at the budget: the child is steered once to wrap up and deliver its final answer.
- **Hard kill** at budget + 5 turns: the child is terminated and the run reported as failed with a `turn-budget-exhausted` reason, preserving output produced so far.

Values must be positive integers: strings, floats, zero, and negatives fall back to the default. A per-agent frontmatter `maxTurns` overrides this config default.

### `stallTimeoutMs` (positive number, default `600000`)

Wall-clock stall watchdog: any line a child writes to stdout resets the timer, and a child silent for this long is hard-killed and reported as failed with a `stall-timeout` reason, preserving output produced so far. There is no disable switch: to effectively disable it, set a huge value.

## Agent definitions

Every agent is a markdown file: YAML frontmatter plus a body that becomes the agent's system prompt.

| Field | Type | Meaning |
|---|---|---|
| `name` | string (required) | The name the orchestrator passes to `delegate` |
| `description` | string (required) | Shown to the orchestrator in the delegation policy so it can pick the right agent |
| `tools` | YAML list or comma-separated string | Restricts the child's toolset (e.g. `read, grep, find, ls`); omit for the full toolset |
| `blockTools` | YAML list or comma-separated string | Tool matchers blocked for this agent (exact, glob, `ext:<id>`); **additive** with the global `childBlockedTools` floor: it can extend but never re-grant |
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

Files with a missing or non-string `name` or `description` are skipped. An invalid `maxTurns` is ignored and falls back to the config default.

## Agent discovery

Agent directories, merged by name:

- **Builtin**: `agents/*.md` shipped with the extension (skipped when `builtinFleet: false`)
- **User**: `~/.pi/agent/agents/*.md`
- **Project**: `.pi/agents/` and `.agents/agents/` at every directory level, walking from the current directory up through the ancestor containing `.git` (or the filesystem root)

Precedence on name collision: project > user > builtin. Within the project tree, nearer directories win; at the same level, `.pi/agents` beats `.agents/agents`. A shadowed agent is replaced entirely: one winning definition per name.

## Child extension control

Children inherit every globally installed extension, and pi offers no way to suppress extensions at handler level, only at spawn time. That matters because some extensions misbehave in short-lived RPC children. Example: pi-workspace-history's cleanup deletes other sessions' shadow repos when more than three sessions share a workspace, and the parent TUI then spams `fatal: not a git repository` banners on every turn end.

To isolate children, list the sources a child actually needs in `childExtensions`: a non-empty list spawns children with `--no-extensions` plus one `-e` per entry, so nothing else loads. An empty list keeps the inherit-all default. Note that isolation removes pi-orchestrator itself too: re-add it via `childExtensions` or the tool gate and orphan watchdog go quiet.

## Stable child session ids

Children are spawned with a deterministic `--session-id`: a hash of `orchestrator:<agent-name>:<model>`, stable per (agent, model) pair across spawns and parent restarts. It works alongside `--no-session`, which only disables on-disk persistence. OpenAI-compatible providers derive their cache-affinity key from the session id, so this keeps an agent's requests on the same cache shard; Anthropic's native caching is content-prefix based and unaffected.

## Guardrails (optional)

[`@aliou/pi-guardrails`](https://www.npmjs.com/package/@aliou/pi-guardrails) gates dangerous tool calls with user approval. It is an optional recommendation, not a dependency:

```bash
pi install npm:@aliou/pi-guardrails
```

Children inherit installed extensions automatically and run headless: a dangerous operation is blocked with no UI to confirm it, so a subagent cannot talk its way past a guardrail. Pre-approve operations via `~/.pi/agent/extensions/guardrails.json` (session or always grants).

## Commands

- `/orchestrator`: toggle orchestration (persisted to `orchestrator.jsonc`; startup notifies when disengaged)
- `/orchestrator-tools`: checkbox UI over the keep-list (TUI only); discovered `ext:` matchers are read-only; long tool lists truncate to terminal width (capped at 6 names + `+N more`)

## Policy and fleet text

The delegation policy is computed once per engagement from what is actually installed, then reused verbatim every turn: the allow-list names the tools retained at compute time, the fleet section lists the agents discovered at that point, and the typical-flows example is composed from the discovered names. The text is regenerated when engagement turns on again (session start with `enabled: true`, or `/orchestrator` re-engage). Mid-session agent additions are covered by the delegate tool's `list` action and the schema enum, not by prompt rewrites. Nothing about other packages is hardcoded, so two installs with different packages produce slightly different policy text, and `builtinFleet: false`, `hidden: true`, and project agents all change what it says.

## Files

- `src/index.ts` — entry: child watchdog, engagement, reduction, gate, commands
- `src/config.ts` — orchestrator.jsonc (JSONC, comment-preserving writes), keep-list matchers, runtime tool discovery
- `src/width.ts` — visible-width helpers (ANSI-aware truncation for TUI rendering)
- `src/agents.ts` — fleet discovery (builtin, user, project tree)
- `src/policy.ts` — delegation policy text generated from fleet + kept tools
- `src/delegate.ts` — the delegate tool: RPC child spawning, turn budget, stall watchdog, progress streaming, renderers, reaping
- `agents/*.md` — builtin fleet definitions
- `docs/adr/` — decision records
