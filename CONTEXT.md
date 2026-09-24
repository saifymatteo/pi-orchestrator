# CONTEXT.md — Glossary

Glossary for the **pi-orchestrator** extension. Pure vocabulary; no implementation details.

## Terms

### Orchestrator
The top-level pi session running with reduced capabilities. Its only path to real work is delegation. Distinguished from a Worker, which has full capabilities.

### Worker
A subagent: a fresh child `pi` process with an isolated context window and the full toolset. Workers never orchestrate (see ADR-0002) and never see the delegation policy.

### Fleet
The set of agent definitions the Orchestrator can delegate to. Shipped fleet: **scout** (read-only recon), **planner** (read-only planning), **worker** (general-purpose, full tools), **reviewer** (read-only + shell, code review). Builtins ship as markdown files with YAML frontmatter in the extension's own `agents/` directory; user-installed agents live in `~/.pi/agent/agents/`.

### Delegate (tool)
The single tool the Orchestrator uses to hand work to the Fleet. Modes: single (`agent` + `task`), parallel (`tasks[]`), chain (`chain[]` with `{previous}` placeholder), and discovery (`{action: "list"}` returns the live fleet, `{action: "sessions"}` lists the session's subagent transcripts, `{action: "status"}` lists live runs, `{action: "cancel"}` kills one run). Dispatch is asynchronous by default (see ADR-0014): the call returns an Accepted result at once, and the outcome follows via Result delivery when the Worker settles; `async: false` blocks until the final result, and chain mode is always blocking. Agent names are published as a schema enum of the fleet discovered at load (see ADR-0010). Always active, never blocked.

### Accepted
The immediate result of an asynchronous delegate dispatch: confirmation, with a run id, that the task was taken — before any work has finished. Distinct from the task's eventual outcome, which arrives later via Result delivery. A synchronous validation error (unknown agent, invalid parameters) is never an acceptance.

### Run id
The unique identifier a delegate dispatch receives at acceptance. Every later signal about that dispatch — a delivered result, a status listing, a cancel — echoes the same id, so acceptance and delivery stay correlated across turns.

### Result delivery
The push of a settled Worker's outcome into the Orchestrator's conversation: it starts a new turn when the Orchestrator is idle and joins the queue when it is mid-conversation. A delivery carries the three-state run status (see ADR-0012); failure after acceptance is delivered, never silent. The Orchestrator reacts to deliveries; it does not poll for them.

### Cancel
The explicit kill of one running delegation, as distinct from aborting the session, which kills the whole fleet. A cancelled run's transcript still lands in its Sub-session record.

### Sub-session (persistent subagent session)
The persistent pi session each delegate dispatch writes for its subagent (ADR-0011). File-per-run, stored in the parent's session directory, named `orch: <agent> — <task>`, and linked to the parent session via pi's session-format v3 `parentSession` header (written by the parent's RPC `new_session {parentSession}` before the task prompt). The delegate result ends with the session path; `delegate({action: "sessions"})` lists all of them from disk. Config: `childSessions` (default `true`).

### Engagement
Whether orchestration mode is active for a session. When engaged: the delegation policy is part of the system prompt every turn (the same cached text each turn — a stable guideline, not a per-turn reminder), and the Orchestrator's tools are reduced to the Keep-list. When disengaged: pi behaves normally. The `/orchestrator` command toggles engagement persistently (see ADR-0003).

### Keep-list
The configurable set of tool names that stay active for the Orchestrator while engaged. Everything else is removed from the active set AND hard-blocked. Semantics are derived from emptiness: an empty keep-list auto-keeps every discovered extension; a non-empty keep-list keeps exactly the configured matchers plus `delegate` — discovered extensions are displayed but not kept unless a matcher names them (see ADR-0004). Stored in `~/.pi/agent/orchestrator.json`.

### Gate
The hard enforcement layer: a `tool_call` interception that blocks any tool call from the Orchestrator that is not on the Keep-list, with a reason instructing it to use `delegate`. The Gate is the teeth; the policy is the instruction (see ADR-0001).

### Policy (delegation policy)
The guideline block in the Orchestrator's system prompt while engaged, defining the Orchestrator role, the Fleet, typical flows, and when trivial Q&A needs no delegation. Generated from the discovered Fleet and Keep-list at engagement time; its text then stays fixed for the engagement episode (mid-session Fleet additions are covered by the delegate tool's discovery actions, not by prompt rewrites). Distinct from the Gate, which enforces what the Policy describes (see ADR-0001).

### Child mode
The state in which the extension detects it is running inside a Worker's child `pi` process (via the `PI_ORCHESTRATOR_CHILD=1` environment variable) and fully self-disables: no policy, no Gate, no tool reduction.

### Project agent
An agent definition in markdown discovered from the project tree — in `.pi/agents/` or `.agents/agents/` directories, walking up from the working directory to the git root — rather than shipped with the extension or installed globally. On a name collision, a Project agent wins over a user-level agent, which wins over a builtin.

### Turn budget
The maximum number of assistant turns a subagent may spend on a delegation before the orchestrator intervenes. Enforced in two stages: Soft grace at the budget, Hard kill after a grace margin (see ADR-0006).

### Soft grace
The warning stage of the Turn budget: when a Worker reaches the budget, it is told to wrap up and finish rather than being cut off immediately.

### Hard kill
The abort stage of the Turn budget: once the grace margin past the budget is spent, the Worker is terminated and the run is reported as failed with a turn-budget-exhausted reason, plus whatever output it produced so far.

### Guardrail
An external package (e.g. `@aliou/pi-guardrails`) that gates dangerous tool calls. The orchestrator does not ship or configure one; users install it themselves, and child pi processes inherit it automatically through pi's own extension discovery (see ADR-0005).

### Fleet status (widget)
The persistent UI panel above the editor showing live subagent progress for the whole fleet. While any Worker runs it renders as a group: a header with the dispatch mode (`single`, `parallel`, `chain`, or `mixed`) and the running count, followed by one indented line per running Worker — agent name, current turn, context load, tokens (input/output), and a truncated task summary. When nothing runs, a single idle line shows the engaged orchestrator and fleet names. Cost appears in the result renderers, not the live widget.
