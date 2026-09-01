# pi-orchestrator

A pi extension that turns the main agent into an **orchestrator**: its tools are reduced to a user-configured allow-list, and its only path to real work is the `delegate` tool, which spawns subagent workers with isolated contexts and full capabilities.

## Disclaimer

This whole project is wholly written by GLM 5.3 Flash via Pi harness. This package is intended to disable most of main agent capabilities and force it to delegate work to a subagent fleet.

## Install

```bash
pi install git:github.com/saifymatteo/pi-orchestrator
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
| UI | grouped fleet widget above the editor — `⏳ Fleet · <mode> · N running` header with one indented line per subagent (agent, turn, ctx load, tokens, task summary); idle line when nothing runs |

Child success is state-based (the RPC `agent_settled` event); child exit codes are informational only, since settled children are SIGTERMed by design.

`delegate` takes three shapes: `{agent, task}` for a single job, `tasks[]` (max 8, concurrency 4) for independent parallel work, and `chain[]` with a `{previous}` placeholder for dependent steps.

## Config — `~/.pi/agent/orchestrator.json`

```json
{
  "enabled": true,
  "keepTools": ["delegate"],
  "builtinFleet": true,
  "autoKeepExtensions": false,
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

By default the effective keep-list is exactly your config matchers plus `delegate` — keep-list-only. Non-builtin packages are still discovered at runtime and shown in `/orchestrator-tools` (read-only), but their tools are NOT available to the orchestrator unless a matcher above names them (ADR-0004). Discovery covers non-builtin packages only — pi's core tools stay excluded unless a matcher names them. The derived information is never persisted; only your config matchers are written back to `orchestrator.json`. Existing config entries with old `ext:` ids remain valid — they simply match nothing while that package is absent, and match again if it returns.

**Builtin-shadowing exclusions:** extensions that re-register a builtin tool name (`read`, `bash`, `powershell`, `edit`, `write`, `grep`, `find`, `ls`) are excluded from discovery unless explicitly listed as `ext:<id>` in keepTools. Registration replaces the builtin wholesale, so keeping the shadow would silently resurrect a core tool the config never listed; an explicit `ext:<id>` entry re-enables the whole extension.

### `autoKeepExtensions` (boolean, default `false`)

Opt back into the original ADR-0004 auto-keep behavior: every discovered non-builtin extension contributes an `ext:<id>` matcher to the effective keep-list each turn, so its tools stay available without config entries. Builtin-shadowing extensions stay excluded unless explicitly listed as `ext:<id>` (see above). With the default `false`, nothing is auto-kept — the keep-list alone decides (ADR-0004).

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
