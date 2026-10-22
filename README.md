# pi-orchestrator

A pi extension that turns the main agent into an orchestrator. While engaged, the parent keeps a configurable tool allow-list and delegates work to subagents with isolated contexts. You describe the task; the orchestrator picks agents, dispatches work, and receives their results.

## Disclaimer

This project is written entirely by GLM 5.3 Flash via the pi harness. It intentionally disables most main-agent capabilities and forces delegation to a subagent fleet.

## Quickstart

Requires **Pi >= 1.0.4**. Install from npm:

```bash
pi install npm:@saifymatteo/pi-orchestrator
```

Start Pi in your project:

```bash
cd <path-to-your-project>
pi
```

Ask for a task in natural language, for example:

> Have scout find how configuration is loaded in this project, then ask planner to propose tests for the fallback behavior. Return a short plan with file references; don't edit anything.

The builtin fleet is ready to use; no configuration file is required. Async dispatches return acceptance first, then deliver outcomes into the conversation. Accepted work may be queued, not yet running. The fleet widget shows queued and active work, progress, and pending or failed delivery. You can keep talking or dispatch more work without polling.

For git/local installs and testing a checkout, see [Development](docs/development.md#alternative-installs).

## Engaged vs AUTO

Orchestration starts **engaged** by default:

| Mode | Parent tools | Delegation |
|---|---|---|
| Engaged | Effective keep-list only; `delegate` is always available | Real work goes through Workers. |
| AUTO (disengaged) | Normal tool access; no delegation policy | `delegate` remains available when useful. |

Child tool policy applies to every delegated spawn in either mode. Workers do not orchestrate further.

- `/orchestrator` toggles engagement and persists it in `~/.pi/agent/orchestrator.jsonc`; startup notifies when disengaged.
- `/orchestrator-tools` opens the TUI's per-tool allowed/blocked editor. It saves individual overrides, never rewrites the baseline `keepTools`, and shows discovered extension groups read-only. Choosing the baseline result removes the override. Long lists truncate to terminal width (at most 6 names plus `+N more`).

See [parent tool access](docs/configuration.md#engagement-and-parent-tool-access) for matching rules, overrides, and safety caveats.

## Builtin fleet

| Agent | Role | Shipped thinking level |
|---|---|---|
| `scout` | Read-only reconnaissance | `low` |
| `planner` | Read-only planning | `high` |
| `worker` | General-purpose work, full tools | `medium` |
| `reviewer` | Read-only tools plus shell, code review | `high` |

User and project agents shadow builtins by name. [Define custom agents](docs/custom-agents.md) or [tune the builtin fleet](docs/configuration.md#customizing-the-builtin-fleet).

## Dispatch and results

`delegate` supports single jobs, parallel tasks (up to 8 per request), and sequential chains. Single/parallel dispatches are async by default; pass `async: false` to return the outcome directly. Chains always block. All modes share one live-session capacity pool (default: 4 active Workers, 32 queued runs).

Discovery/control actions include `list`, `sessions`, `status`, `cancel`, and `retry-delivery`. Cancellation of one run returns or delivers a cancelled outcome; Escape and session teardown stop the fleet and suppress pushes into that interrupted session. Async delivery retains unconfirmed outcomes, with explicit retry rather than automatic blind retries. It does not promise restart recovery, disk durability, or exactly-once insertion.

**Extension integration (Pi 1.3.0):** other extensions in the same parent session can tap into our agent-result mechanism through the `async-work:providers:v1` event-bus protocol. Emit a discovery request to obtain the agent provider, then claim and collect results through its lease API. No specific consumer extension is required or added as a dependency. See [Event-bus integration](docs/usage.md#event-bus-integration-pi-130) for the protocol and an example.

## Guides

- [Configuration](docs/configuration.md): schema/editor help, parent and child tools, extension control, models, thinking, budgets, and optional guardrails.
- [Usage](docs/usage.md): dispatch examples, actions, lifecycle guarantees, event-bus integration, delivery, cancellation, and session ids.
- [Custom agents](docs/custom-agents.md): frontmatter, discovery directories, and precedence.
- [Development](docs/development.md): alternative installs, architecture, schema maintenance, lifecycle verification, and file map.
- [Architecture decision records](docs/adr/): design rationale and contracts.
