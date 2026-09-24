# JSONC config — comments survive reads and writes

`orchestrator.json` is the extension's only user-facing configuration surface (keys from `enabled` to `childSessions`), and the meaning of each key lives in the README and docs. JSON forbids comments, so every "what does `childExtensions` do?" costs a docs trip. Allowing comments is a parse swap; *keeping* them is not: `saveConfig` rewrites the whole file via `JSON.stringify` on every engagement toggle and keep-list edit, which would silently delete any comment the first time the extension saves. The write path is why this needs a deliberate decision rather than a one-line parser change.

## Decision

- The config format becomes **JSONC** (comments and trailing commas), parsed with `jsonc-parser` (Microsoft's parser, zero dependencies). Plain JSON remains valid JSONC — existing files need no content migration.
- **Reads**: prefer `orchestrator.jsonc`; fall back to the legacy `orchestrator.json` when only it exists. Parse errors fall back to defaults exactly as today — jsonc-parser reports errors instead of throwing, so the error array is checked and the existing catch-and-default behavior is preserved; no new warning surface in this change.
- **Writes**: comment-preserving. `saveConfig` applies per-property edits (`modify` + `applyEdits`) instead of whole-file `JSON.stringify`, so the extension's own saves leave user comments intact. On first save the extension writes `orchestrator.jsonc` and removes the legacy `.json` only after the new file is successfully written — a one-time, content-preserving migration.

## Considered options

- **Keep the `.json` filename with JSONC content**: rejected by product decision — the `.jsonc` extension is honest about content type and gives editors comment support out of the box; the migration costs one read-path check.
- **Hand-rolled comment stripper**: rejected — strings containing `//` and similar make it a classic bug source, and it provides nothing for the write path, which the library's edit API solves.
- **Switch to YAML/TOML**: rejected — format churn for marginal gain; JSONC is the minimal step from valid-today JSON.

## Consequences

- The file a user edits is the file that keeps their comments; extension-owned rewrites no longer battle user annotation.
- `saveConfig` gains a migration obligation (legacy read fallback, rename on first write) that must be tested as a round trip, not assumed.
