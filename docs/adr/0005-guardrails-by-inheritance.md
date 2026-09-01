# Guardrails by inheritance, not integration

Guardrails (gating dangerous tool calls) are desirable in subagents, but we decided the orchestrator does not integrate, wrap, or configure any guardrail package. Guardrails (e.g. npm:@aliou/pi-guardrails) are installed by the user via `pi install`; child `pi --mode rpc` processes inherit them automatically through pi's own extension discovery. Headless children fail closed: a dangerous operation is blocked with no UI to confirm it, so the orchestrator cannot talk a child past a guardrail. The orchestrator.json `childExtensions` pass-through was rejected because it double-loads extensions pi would discover anyway and duplicates pi's own mechanism.

## Considered options

- orchestrator.json childExtensions pass-through (explicitly listing extensions to inject into children): double-load risk and redundant with pi's own discovery — rejected.

## Consequences

- Approval prompts cannot appear inside subagents (children run headless); users pre-grant via guardrails.json (session/always grants) or approve in their own interactive runs.
- README documents guardrails as an optional recommendation, not a dependency.
