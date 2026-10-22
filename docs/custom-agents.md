# Custom agents

[Quickstart](../README.md) · [Configuration](configuration.md) · [Usage](usage.md)

Every agent is a markdown file: YAML frontmatter plus a body that becomes the agent's system prompt.

| Field | Type | Meaning |
|---|---|---|
| `name` | string (required) | The name the orchestrator passes to `delegate` |
| `description` | string (required) | Shown to the orchestrator in the delegation policy so it can pick the right agent |
| `tools` | YAML list or comma-separated string | Restricts the child's toolset (e.g. `read, grep, find, ls`); entries are tool names or `*` patterns passed to pi's `--tools` (pi ≥ 1.0.4); MCP tools stay available unless an entry starts with `mcp__`; add `mcp__*` to exclude them; omit for the full toolset |
| `blockTools` | YAML list or comma-separated string | Tool matchers blocked for this agent (exact, `*` glob, `ext:<id>`); **additive** with the global `childBlockedTools` floor: it can extend but never re-grant |
| `model` | string | `provider/model` for this agent; falls back to the dispatching session's model |
| `thinking` | string | Thinking level for dispatches to this agent: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`; invalid values are ignored (inherit) |
| `hidden` | boolean | `true` excludes the agent from discovery |
| `maxTurns` | positive integer | Per-agent turn budget; overrides the config `maxTurns` |

```markdown
---
name: scout
description: "Fast recon for delegated lookups: find where X lives, how X works, what state Y is in, or gather facts before planning. Returns compressed findings with file:line citations."
tools: read, grep, find, ls
maxTurns: 20
---

You are scout working in an isolated context. …
```

pi-orchestrator skips files with a missing or non-string `name` or `description`. An invalid `maxTurns` falls back to the config default; an invalid `thinking` falls back to inheritance.

## Agent discovery

Agent directories, merged by name:

- **Builtin**: `agents/*.md` shipped with the extension (skipped when `builtinFleet: false`)
- **User**: `~/.pi/agent/agents/*.md`
- **Project**: `.pi/agents/` and `.agents/agents/` at every directory level, walking from the current directory up through the ancestor containing `.git` (or the filesystem root)

Precedence on name collision: project > user > builtin. Within the project tree, nearer directories win; at the same level, `.pi/agents` beats `.agents/agents`. A shadowed agent is replaced entirely: one winning definition per name.

For model precedence and reasoning effort, see [Thinking levels](configuration.md#thinking-levels) and [Pinning models](configuration.md#pinning-models). Global [child tool policy](configuration.md#child-tool-policy) and [turn budgets](configuration.md#turn-budgets-and-stall-recovery) apply alongside frontmatter.
