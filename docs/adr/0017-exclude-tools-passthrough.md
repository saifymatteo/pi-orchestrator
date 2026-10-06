# Matcher pass-through to `--exclude-tools` (pi ≥ 1.0.4 patterns)

ADR-0008 routes every blocked matcher through a parent-side expansion (`expandBlockedToolsToNames` against the parent's tool registry) because pi's `--exclude-tools` accepted concrete names only — its glob semantics were undocumented and `ext:<id>` unsupported. pi 1.0.4 changed that: the flag (and `--tools`) now accepts `*` patterns, documented in `docs/cli.md#tools`. Verifying the 1.0.4 binary confirmed the exact semantics: entries are either exact names (case-**sensitive** `Set` membership) or patterns where `*` matches any characters and every other regex metacharacter — including `?` — is escaped literal; `ext:<id>` still cannot match, because the flag only ever sees tool names.

## Decision

- **Pass-through first**: blocked matchers the flag can express — exact names and `*` globs — are passed to `--exclude-tools` verbatim (`passThroughMatchers`). The child's own registry does the filtering, which covers tools the parent's registry cannot see (a per-task `cwd` can load extra project extensions); before this, such tools were caught only by the ADR-0007 gate after the child tried them.
- **Parent-side expansion is retained for all matchers**, not dropped: it resolves case-insensitively to registry-case names (so a case-mismatched exact matcher still unregisters parent-visible tools — pi's flag matching is case-sensitive), and it is the only way to express `ext:<id>` and `?` matchers. The two lists merge into one flag value (`resolveChildExcludeTools`), deduplicated case-insensitively, pass-through entries first.
- **The ADR-0007 gate remains the universal backstop**: `?` matchers on tools the parent cannot see, case mismatches on child-only tools, and any divergent child toolset are still blocked at `tool_call` with a visible reason.
- **Version floor raised to pi ≥ 1.0.4** (peer deps `>=1.0.4`): spawn-time exclusion is documented behavior, not a best-effort optimization, so the package requires the pi that supports it rather than silently degrading to gate-only on older versions.

## Considered options

- **Drop expansion entirely for exact/glob matchers**: rejected — pi's case-sensitive matching would silently miss a case-mismatched exact matcher at spawn (gate-only), a regression against ADR-0008 for zero code savings; expansion already existed.
- **Keep the status quo (expand everything, no pass-through)**: rejected — the known gap (child-only tools unregistered only after a blocked call) was the one thing the gate could not prevent, and the upstream change removes the reason the gap existed.
- **Convert `ext:<id>` to globs**: rejected — extension ids are not tool names; there is no sound derivation of a tool-name glob from an extension id.

## Consequences

- `resolveChildExcludeTools` replaces the bare `expandBlockedToolsToNames` call at the spawn site; `buildChildSpawnArgs` is unchanged (it still receives a ready list).
- On pi ≥ 1.0.4 the flag list may contain entries redundant with the expansion (a glob plus its parent-visible expansions); pi deduplicates internally and the extra entries are harmless.
- On older pi the pass-through entries match nothing and enforcement degrades to expansion + gate — the pre-ADR-0008 behavior — but the version floor makes this a contract violation, not a silent expectation.
- Agent frontmatter `tools` and `blockTools` inherit the same matcher syntax, so `*` globs written there now take effect at spawn too (previously only via the gate); documented in the README rather than changed in code — the values are already passed through unmodified.
- The floor bump itself changes behavior for agents with a `tools` frontmatter: pi ≥ 1.0.4's `--tools` keeps MCP tools unless an entry starts with `mcp__` (older pi removed MCP tools entirely), so a restricted child gains MCP tool reach it did not have before. That is upstream semantics, not this package's matcher logic; the README and CHANGELOG document `mcp__*` as the exclusion.
