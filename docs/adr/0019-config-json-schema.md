# Shared-source configuration schema for editors

The field reference for orchestrator configuration currently lives in source comments and the README; user comments are useful annotations, not a dependable reference. We will expose a standard JSON Schema for editor completion, hover documentation, and diagnostics, deriving it together with the runtime configuration type and defaults from one TypeBox definition. This design is accepted and implemented; publication remains a separate release action. The bounded implementation plan is recorded locally in `.scratch/config-json-schema/spec.md` (gitignored under the repository's issue-tracker convention).

## Decision

- Use the already-used `typebox` library to author field names, types, constraints, descriptions, defaults, and examples once. Derive the resolved runtime configuration type and defaults from that definition; export a standard JSON Schema draft 2020-12 artifact at `schemas/orchestrator.schema.json`. The editable document permits omitted settings, while the resolved runtime type retains all settings. `$schema` is document metadata, not a runtime setting.
- One schema covers `orchestrator.jsonc` and the legacy `orchestrator.json`. Unknown setting names are editor diagnostics, with `$schema` explicitly allowed. Agent-name maps remain open where configuration supports arbitrary names; their values and known nested fields remain described and constrained.
- Keep runtime parsing, filtering, warnings, defaults, and fallback behavior unchanged. The schema is an editor contract, not a new runtime acceptance gate. An unknown property can therefore be flagged by an editor while remaining ignored by the loader and preserved by the writer. JSON Schema `default` annotations describe defaults; they do not themselves populate a user's document.
- Commit the generated JSON artifact and include it in the npm package. Expose it through the version-pinned URL `https://cdn.jsdelivr.net/npm/@saifymatteo/pi-orchestrator@<version>/schemas/orchestrator.schema.json`. Provide an explicit regeneration command. Do not add a CI drift gate or CI workflow; regeneration of the committed artifact is a maintainer responsibility.
- On normal configuration saves, insert the installed version's `$schema` reference when absent and refresh extension-owned references to that version. Preserve a user's custom reference and existing comments. Loading configuration must not write files or fetch schemas. Existing configurations acquire a reference on their next normal save, or through a documented manual edit. Preserve ADR-0015's legacy-file migration and write-before-delete ordering.

The shared definition owns the exhaustive field reference. The README retains setup instructions, conceptual explanations, and configuration recipes rather than a separately maintained exhaustive specification. Comments remain optional explanations of a user's choices.

## Considered options

- **Hand-authored schema alongside the existing interface and defaults:** rejected because field definitions and defaults could drift across independent declarations.
- **Schema-driven runtime validation:** rejected for this scope because it changes today's permissive normalization and fallback contract. Strict editor diagnostics do not justify changing which existing configurations load.
- **Bundled schema copied beside the user's config:** rejected in favor of a version-pinned public URL, avoiding a second managed user-side artifact and its synchronization lifecycle.
- **Automatic CI artifact-drift enforcement:** deliberately omitted by user choice; the artifact is committed, with an explicit local regeneration command instead.

## Consequences

- Editor assistance depends on schema fetching or an editor cache. A missing network connection or unavailable CDN does not affect runtime configuration loading.
- The JSON artifact can become stale unless regenerated when the shared definition changes; single-source authoring alone does not keep a committed export current.
- The first schema-bearing release must actually publish the artifact before its version-pinned URL can resolve. A development checkout may not have a corresponding public schema version. This decision does not authorize a version bump, release, or publish.
- Regression checks should cover exported schema structure, configuration normalization, and schema-reference ownership/comment preservation using the existing test setup; no additional CI gate is part of this decision.
