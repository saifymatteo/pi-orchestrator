# Hard tool-gate enforcement, not prompt-only

"Forced delegation" must survive a disobedient model. We decided on two layers: a delegation policy injected into the system prompt every turn (`before_agent_start`), AND a hard gate (`tool_call` interception) that blocks any non-keep-list tool with a reason instructing the model to use `delegate`. Prompt-only was rejected because tools technically remain callable; we wanted the `delegate` tool to be the only path to real work. The cost — the orchestrator can get blocked when it legitimately needs a quick `read` — is accepted and mitigated by delegating even small lookups to scout.

## Considered options

- Prompt policy only (rejected: not actually forced)
- Maximum force: also intercept turn-end and re-prompt when no delegation happened on work-looking prompts (rejected: fights the model on trivial asks, burns tokens)
