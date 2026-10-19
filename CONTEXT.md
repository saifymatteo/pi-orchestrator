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
The tool for handing work to the Fleet, singly, in parallel, or as a chain of dependent steps. It also provides discovery and controls for runs and Result delivery.

### Run
One admitted task with a stable identity, whether waiting for capacity, executing in a Worker, or awaiting Result delivery. A Run is distinct from its Worker: an accepted Run need not have a Worker yet.

### Accepted
Confirmation that the live parent session has taken responsibility for a Run, including one waiting for capacity. Distinct from starting a Worker, completing the task, or delivering its outcome.

### Run id
The unique identity of a Run, shared by its acceptance, progress, outcome, cancellation, and Result delivery attempts.

### Live-session owner
The authority responsible for admitted Runs and their outcomes within one parent session's lifetime. Distinct from the Fleet status view and from the Worker carrying out a task.

### Queued run
An accepted Run waiting for Worker capacity. It has not started a Worker.

### Terminal outcome
The final success, failure, or cancellation of a Run. Distinct from Delivery state: a task can be finished while its outcome still awaits delivery.

### Delivery state
Whether an async Run's Terminal outcome is awaiting submission or confirmation, has a reported submission failure, or has confirmed insertion into the parent conversation. Confirmation does not imply that the model has consumed the outcome or that it is durable on disk.

### Result delivery
The submission of an async Run's Terminal outcome to its parent conversation, correlated by Run id. A blocking Run instead returns its outcome in its tool result.

### Delivery retry
An explicit request to resubmit a retained outcome whose insertion is unconfirmed, with possible duplicate delivery. It never repeats the Worker's task.

### Cancel
The explicit stop of one accepted Run, including a Queued run, producing a cancelled Terminal outcome. Distinct from stopping the entire session and suppressing result pushes.

### Sub-session (persistent subagent session)
The persistent pi session each delegate dispatch writes for its subagent (ADR-0011). File-per-run, stored in the parent's session directory, named `orch: <agent> — <task>`, and linked to the parent session via pi's session-format v3 `parentSession` header (written by the parent's RPC `new_session {parentSession}` before the task prompt). The delegate result ends with the session path; `delegate({action: "sessions"})` lists all of them from disk. Config: `childSessions` (default `true`).

### Engagement
Whether orchestration mode is active for a session. When engaged: the delegation policy is part of the system prompt every turn (the same cached text each turn — a stable guideline, not a per-turn reminder), and the Orchestrator's tools are reduced to the Keep-list. When disengaged: pi behaves normally. The `/orchestrator` command toggles engagement persistently (see ADR-0003).

### Keep-list
The set of tools available to the engaged Orchestrator: its baseline comes from `keepTools` in `~/.pi/agent/orchestrator.jsonc` — empty means auto-kept discovered non-builtin extension tools with builtin-shadow exclusions; non-empty means configured matchers plus `delegate` (see ADR-0004). The effective Keep-list is that baseline after Per-tool overrides, with `delegate` always allowed; tools outside it are removed from the active set and hard-blocked.

### Per-tool override
An individual allowed/blocked exception to the Keep-list baseline for one exact tool name, matched case-insensitively, without changing automatic discovery or group rules for siblings and future tools. It applies only to the engaged Orchestrator, never AUTO mode or Workers, and cannot block `delegate`.

### Gate
The hard enforcement layer: a `tool_call` interception that blocks any tool call from the Orchestrator that is not on the effective Keep-list, with a reason instructing it to use `delegate`. The Gate is the teeth; the policy is the instruction (see ADR-0001).

### Policy (delegation policy)
The guideline block in the Orchestrator's system prompt while engaged, defining the Orchestrator role, the Fleet, typical flows, and when trivial Q&A needs no delegation. Generated from the discovered Fleet and Keep-list at engagement time; its text then stays fixed until an engagement boundary or an explicit tool-permission edit (mid-session Fleet additions are covered by the delegate tool's discovery actions, not by prompt rewrites). Distinct from the Gate, which enforces what the Policy describes (see ADR-0001).

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

### Thinking level
The reasoning effort a Worker runs with, from `off` to `max`. Independent of the Model: an explicit level applies even to a pinned-model Worker, while the Orchestrator's own live session level is only inherited by Workers without a pinned model. A Builtin defers to user configuration; a user-owned agent's own declaration is authoritative.

### Guardrail
An external package (e.g. `@aliou/pi-guardrails`) that gates dangerous tool calls. The orchestrator does not ship or configure one; users install it themselves, and child pi processes inherit it automatically through pi's own extension discovery (see ADR-0005).

### Fleet status (widget)
The parent session's view of queued and active Runs, Worker progress, and pending or failed Result delivery. A projection of the Live-session owner's state, not an independent authority over Runs.
