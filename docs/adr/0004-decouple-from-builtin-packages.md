# Decouple from builtin packages

The default keep-list and policy text previously hardcoded references to other packages — `ext:` ids in the default keepTools, and specific tool names in the policy and gate messages. That coupling breaks the moment the user's install differs (a package missing, renamed, or replaced), leaving the orchestrator keeping tools that don't exist and explaining tools the model doesn't have. We decided to remove all hardcoded other-package references and replace them with dynamic discovery: at startup the orchestrator introspects which tools actually exist and generates the keep-list additions and policy text from what is installed; unknown installs get generic policy.

## Considered options

- Registration API (other packages declare how they should be kept and described): cleanest, but requires other packages to change — rejected.
- Static generic text for everything: robust but loses the useful, concrete guidance for well-known tools — rejected.

## Consequences

- Policy text varies per install — two users' orchestrators may behave and instruct slightly differently.
- Tests must cover tool discovery, not just the static policy path.
- Refinement: extensions that re-register builtin tool names (`read`, `bash`, `powershell`, `edit`, `write`, `grep`, `find`, `ls`) are excluded from auto-keep. Registration replaces the builtin wholesale, stripping its `<builtin:` sourceInfo, so the shadowed name would otherwise be auto-kept and silently resurrect the builtin — breaking ADR-0001's forced-delegation guarantee. Such extensions are auto-kept only when explicitly referenced as `ext:<id>` in keepTools; tools that do not collide with builtin names keep the normal auto-keep behavior.
- Reversal (default): blanket auto-keep broke ADR-0001's keep-list-only contract — the orchestrator regained every installed extension's tools without any config entry. The default is now keep-list-only: the effective list is exactly the `keepTools` matchers plus `delegate`; discovered extensions are shown read-only in `/orchestrator-tools` but not kept. Set `autoKeepExtensions: true` in orchestrator.json to restore the auto-keep behavior described above (with the builtin-shadow exclusion still applied). The delegation policy only names tools that pass the effective keep-list, so it never advertises blocked tools.
