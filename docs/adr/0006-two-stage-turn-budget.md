# Two-stage turn budget for subagents

Subagents (children run `pi --mode rpc --no-session`) can idle or spiral indefinitely, burning tokens with no user watching. We decided to give subagents a turn budget (default 50, configurable via orchestrator.json `maxTurns`, overridable per agent in frontmatter) enforced in two stages: at the budget the agent receives a soft-grace wrap-up instruction telling it to finish; at budget + 5 turns it is hard-killed and the run is reported as failed with a "turn budget exhausted" reason plus any output produced so far. A single-stage hard kill was rejected because it discards legitimate near-done work; the soft grace lets an agent that is almost finished land the result.

## Considered options

- pi-native limit: none exists, so the orchestrator must enforce it itself — rejected as unavailable.
- Hard-kill only (kill immediately at the budget): no wrap-up chance, loses near-done work — rejected.

The budget counts turns, but a child stalled mid-turn emits no events — a hung tool call or dead model stream idles forever without spending a turn, so the budget alone cannot reap it. A wall-clock stall watchdog complements the budget (orchestrator.json `stallTimeoutMs`, default 600000 ms): any line on the child's stdout resets it, and a child that stays silent for the timeout is hard-killed through the same path as budget exhaustion and reported as failed (`stall-timeout`) with partial output preserved. This extends ADR-0006's own motivation — a run that hangs is as much a runaway as one that spirals — so the watchdog lives in the same decision record rather than a new one.
