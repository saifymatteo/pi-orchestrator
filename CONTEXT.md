# CONTEXT.md — Glossary

Glossary for the **pi-orchestrator** extension. Pure vocabulary; no implementation details.

## Terms

### Orchestrator
The top-level pi session running with reduced capabilities. Its only path to real work is delegation. Distinguished from a Worker, which has full capabilities.

### Worker
A subagent: a fresh child `pi` process with an isolated context window and the full toolset. Workers never orchestrate (see ADR-0002) and never see the delegation policy.

### Fleet
The set of agent definitions the Orchestrator can delegate to. Shipped fleet: **scout** (read-only recon), **planner** (read-only planning), **worker** (general-purpose, full tools), **reviewer** (read-only + shell, code review). Defined as markdown files with YAML frontmatter in `agents/`, installed to `~/.pi/agent/agents/`.

### Delegate (tool)
The single tool the Orchestrator uses to hand work to the Fleet. Modes: single (`agent` + `task`), parallel (`tasks[]`), chain (`chain[]` with `{previous}` placeholder). Always active, never blocked.

### Engagement
Whether orchestration mode is active for a session. When engaged: the delegation policy is injected every turn, and the Orchestrator's tools are reduced to the Keep-list. When disengaged: pi behaves normally. The `/orchestrator` command toggles engagement persistently (see ADR-0003).

### Keep-list
The configurable set of tool names (glob patterns allowed) that stay active for the Orchestrator while engaged. Everything else is removed from the active set AND hard-blocked. Defaults: `delegate`, `hindsight_*`, `todo`, `ask_user_question`, `advisor`. Stored in `~/.pi/agent/orchestrator.json`.

### Gate
The hard enforcement layer: a `tool_call` interception that blocks any tool call from the Orchestrator that is not on the Keep-list, with a reason instructing it to use `delegate`. The Gate is the teeth; the policy is the instruction (see ADR-0001).

### Policy (delegation policy)
The system-prompt injection, applied on every turn while engaged, that defines the Orchestrator role, the Fleet, typical flows (scout → planner → workers → reviewer), and when trivial Q&A needs no delegation.

### Child mode
The state in which the extension detects it is running inside a Worker's child `pi` process (via the `PI_ORCHESTRATOR_CHILD=1` environment variable) and fully self-disables: no policy, no Gate, no tool reduction.

### Fleet status (widget)
The persistent UI panel above the editor showing live subagent progress: current turn, context load, tokens, and cost per running Worker.
