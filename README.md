# pi-orchestrator

A pi extension that turns the main agent into an **orchestrator**: its tools are reduced to a user-configured allow-list, and its only path to real work is the `delegate` tool, which spawns subagent workers with isolated contexts and full capabilities.

## Install

Point pi at this directory (pick one):

```bash
# quick test
pi -e D:\Git\pi-orchestrator\index.ts

# or add to settings.json extensions array:
#   "extensions": ["D:/Git/pi-orchestrator"]
# or junction ~/.pi/agent/extensions/orchestrator -> D:\Git\pi-orchestrator
```

## How it works

| Layer | Mechanism |
|---|---|
| Policy | `before_agent_start` appends the orchestrator policy every turn |
| Reduction | `setActiveTools` keeps only the keep-list (re-applied every turn) |
| Gate | `tool_call` blocks anything not on the keep-list, with guidance to delegate |
| Delegate tool | spawns `pi --mode json -p --no-session` children with `PI_ORCHESTRATOR_CHILD=1` |
| Child mode | children self-disable this extension; parent-PID heartbeat watchdog kills them if pi dies |
| UI | live progress per subagent (turn, ctx load, tokens) + fleet widget above the editor |

## Config — `~/.pi/agent/orchestrator.json`

```json
{
  "enabled": true,
  "keepTools": [
    "delegate",
    "ext:@luxusai/pi-hindsight",
    "ext:@juicesharp/rpiv-todo",
    "ext:@juicesharp/rpiv-ask-user-question",
    "ext:@juicesharp/rpiv-advisor"
  ],
  "builtinFleet": true,
  "modelOverrides": {}
}
```

- **keepTools** matchers: exact tool name (`todo`), glob (`hindsight_*`), or extension id (`ext:@luxusai/pi-hindsight` — covers every tool that package registers, including future ones). `delegate` is always kept.
- **builtinFleet: false** disables the shipped scout/planner/worker/reviewer agents. User agents in `~/.pi/agent/agents/*.md` always override builtins by name; `hidden: true` frontmatter hides any agent.
- **modelOverrides** pins a model per agent, e.g. `{ "scout": "openrouter/…" }`. Without overrides, agents inherit the dispatching session's model.

## Commands

- `/orchestrator` — toggle orchestration (persisted to orchestrator.json)
- `/orchestrator-tools` — checkbox UI over the keep-list (TUI only)

## Fleet flows

- scout → planner → worker(s) → reviewer (unfamiliar codebase)
- worker directly (clear small change)
- `tasks[]` for independent parallel work; `chain[]` with `{previous}` for dependent steps

## Files

- `index.ts` — entry: child watchdog, engagement, gate, commands
- `config.ts` — orchestrator.json + keep-list matcher logic
- `agents.ts` — fleet discovery (user dir + builtin dir)
- `policy.ts` — delegation policy text
- `delegate.ts` — the delegate tool: spawning, progress streaming, renderers, reaping
- `agents/*.md` — builtin fleet definitions
- `docs/adr/` — decision records
