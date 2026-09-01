# Flat orchestration — children self-disable via environment variable

Child `pi` subagent processes load global extensions too. Without explicit handling, a spawned worker would itself run in orchestrator mode: its tools would be reduced to the keep-list and it could not do the work it was delegated. We decided on flat, single-level orchestration: the `delegate` tool sets `PI_ORCHESTRATOR_CHILD=1` when spawning, and the extension fully self-disables in any process carrying that variable — no policy injection, no gate, no tool reduction. Workers run plain pi with the full toolset.

## Considered options

- Nested orchestration (workers can delegate to sub-workers): more expressive for huge tasks, but token/cost multiplication per level, harder progress accounting, and depth-cap complexity. Rejected for v1; revisit if large multi-phase tasks prove painful.
