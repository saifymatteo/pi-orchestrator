# Fleet discoverability in the delegate tool

The `delegate` tool's `agent` parameter was a free-form string with no way to discover valid names from the tool itself. A fresh orchestrator session in a foreign repo had to learn the fleet out-of-band (from the delegation policy's prose, or not at all when disengaged or compacted); models pattern-matched role concepts onto the string field and invented plausible names (`explorer-ui`, `explorer-logic`), burning a guaranteed failed round-trip on the first delegate call of every such session. The unknown-agent error did list valid names, but only after the wasted call. We decided to make the fleet discoverable before the first call: the tool schema publishes the discovered agent names as a JSON-Schema `enum` on every `agent` field (single, `tasks[]`, `chain[]`), and a `{action: "list"}` discovery shape returns the live fleet (names, sources, tools, descriptions) without spawning anything.

## Considered options

- Enum in the schema only: prevents hallucinated names where the model actually looks (the tool schema), but the enum reflects the fleet at registration time and cannot see mid-session agent files — rejected as the sole mechanism.
- `list` action only: always-fresh, but relies on the model choosing to call it before its first dispatch — the exact judgment step that failed in practice — rejected as the sole mechanism.
- Hardcode the builtin names in the tool description: violates ADR-0004's no-hardcoded-fleet rule and goes stale with `builtinFleet: false` or custom fleets — rejected.
- Re-register the tool on every turn to keep the enum fresh: relies on unverified `pi.registerTool` overwrite semantics for an already-registered name and re-sends the schema every turn — rejected; the unknown-agent error plus the live `list` action already make the correction one hop.

## Consequences

- The schema enum is a load-time snapshot: agents added mid-session are callable after the next session start, or discoverable immediately via `list` — but the schema enum won't advertise them until then. The error path names them, so the failure remains one-hop correctable.
- The `list` action is free (no child process); it reads `discoverAgents` live, so its output always matches what dispatch would actually resolve.
- Empty fleets (e.g. `builtinFleet: false`, no project/user agents) publish no enum — a plain string field, avoiding an empty-enum trap.
- Policy prose (ADR-0001) stays the primary fleet education; the enum and `list` action are the machine-checkable layer beneath it.
