# Config-level async default — one knob in orchestrator.jsonc, not per-agent frontmatter

The delegate tool's dispatch mode (fire-and-forget acceptance vs. blocking on the final result) was hard-coded async-by-default, with `{async: false}` as a per-call escape hatch. Making some agents blocking would then require flagging each agent definition — frontmatter on every subagent markdown — which scatters one behavioral decision across N files the user must keep in sync.

## Decision

- The default dispatch mode is a single config key, **`async`** (boolean, default `true`) in `orchestrator.jsonc`. `async: false` makes delegate calls block until the final result unless a call passes `{async: true}`.
- The per-call `async` parameter always overrides the config default; chain mode remains unconditionally blocking regardless of either (its `{previous}` substitution needs each prior result in-process).
- The delegate tool's schema description, the tool description, and the delegation policy text are generated from the effective default, so the model never reads instructions that contradict the actual behavior (the policy is rebuilt per engagement episode, ADR-0013 — a config change takes effect on the next engagement episode).
- **Per-agent frontmatter `async` is deliberately rejected.** Dispatch mode is a property of how the orchestrator works, not of what an agent is; a global default with per-call override covers every use case without duplicating the decision per agent definition.

## Considered options

- **Per-agent frontmatter `async: false`**: rejected — N copies of one decision, no single place to see or flip the default, and frontmatter already carries per-agent concern (tools, model, maxTurns) that would now be mixed with an orchestrator-session concern.
- **Per-agent override *plus* config default**: rejected for now — no concrete use case once the config default exists; add an agent-level override only when a real workflow needs one agent blocking while the default is async (YAGNI).

## Consequences

- `orchestrator.jsonc` gains one key; `saveConfig`'s comment-preserving write handles it like any other (no code path change).
- `DelegateDeps` gains `getAsyncDefault?` (fallback `true`), read live per dispatch so a config change mid-session applies without re-registration.
- A blocking default changes the orchestrator's concurrency profile: parallel and chain work still dispatch, but each call holds the turn until settled. Fleet-widget and run-watcher behavior (ADR-0014) are unaffected — blocking runs use the same runner.
