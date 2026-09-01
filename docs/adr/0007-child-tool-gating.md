# Child-side tool gate for per-agent tool policy (gate-only, not `--exclude-tools`) (superseded in part by ADR-0008)

Subagents inherit all globally installed extensions (ADR-0005), so a child spawned by `delegate` carries the full toolset — including orchestrator-only tools such as `advisor` that should never run inside a worker. We need a way to block specific tools per orchestrator policy and per agent frontmatter. We decided on a child-side `tool_call` gate: the `delegate` tool computes the blocked matchers (additive union of the global `childBlockedTools` config floor and the agent's `blockTools` frontmatter), passes them to the child via `PI_ORCHESTRATOR_BLOCKED_TOOLS`, and the extension — which self-disables everything else in child mode — installs a gate-only `tool_call` handler that blocks matching tools with a visible reason. The parent also appends a `# Tool policy` section to the child's system prompt listing the blocked matchers, so the subagent knows before it tries.

## Considered options

- `pi --exclude-tools` (rejected): the flag silently removes tools with no reason surfaced to the model, its glob/`ext:` semantics are undocumented, it diverges the parent's and child's tool lists (a per-task `cwd` can change what is discovered), and the behavior is version-dependent. The gate is self-contained in this extension and fail-soft.
- Parent-side enforcement only (rejected): the parent cannot intercept the child's tool calls; only the child process can police itself.
- Allowlist per child (rejected): inverted policy — every new global extension would silently leak into children until allowlisted. A denylist fails open only for unknown tool names, which is mitigated by glob and `ext:<id>` matchers.

## Consequences

- Fail-soft when the extension is absent: enforcement runs inside the child, so if pi-orchestrator does not load there, blocked tools simply execute. Children inherit installed packages automatically (ADR-0005); a user-level `~/.pi/agent` install is recommended so the gate is always present.
- Denylist fail-open for unknown names: a blocked tool registered under an unexpected name slips through; globs and `ext:<id>` matchers close most of that gap.
- Additive union: the global `childBlockedTools` config is a policy floor — per-agent `blockTools` can only extend the block list, never re-grant a globally blocked tool.
- Blocked tools stay visible to the child and every block carries a reason, so the subagent can route around the policy with the remaining tools instead of failing opaquely.
- Later refinement (ADR-0008): `--exclude-tools` was subsequently adopted as an always-on complement — blocked matchers are expanded to concrete names parent-side and unregistered at spawn — while this gate remains the universal backstop for all matcher types and for tools the parent's registry could not see.
