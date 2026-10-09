# Mode-invariant delegate guidance in `promptGuidelines` (AUTO-mode reliability)

AUTO mode (`enabled:false`) is hands-off by contract (ADR-0003): no policy append, toolset left to pi and other extensions. `delegate` stays active, so the only thing telling the model to use it is the tool description. In practice AUTO sessions under-used the tool. A tool description is a tool *contract*; behavioral guidance lands in the system prompt's `<rules>` section. The usage guidance existed only inside the engaged-mode delegation policy, so AUTO never saw it. Meanwhile, engaged mode read the same usage rules twice — once from the policy, once from the always-present tool description — and the policy is rebuilt per engagement episode (ADR-0013), while the description is fixed at registration.

## Decision

- **The mode-invariant delegate usage guidance moves to the tool's `promptGuidelines`** (`buildDelegatePromptGuidelines`, src/delegate.ts): when to reach for the tool, self-contained task prompts, dispatch/delivery semantics, mode selection, result reporting, one-level-deep, and clarify-before-dispatch. pi injects a tool's guidelines into the system prompt's `<rules>` section whenever the tool is active; `delegate` is active in both AUTO and engaged mode, so AUTO now carries the guidance with no policy at all.
- **The delegation policy narrows to engaged-only content** (src/policy.ts): the orchestrator role line, the allow-list, the fleet list, the file-work mandate (rule 1), the conversational carve-out (rule 2), and typical flows. The policy's dispatch/mode/no-poll rules are deleted — mode selection moved to the guidelines, while dispatch and no-poll already live in the description and schema — along with the `config.async` branches; `buildPolicy` loses its `config` parameter. The two layers no longer overlap in an engaged request.
- **The guidelines carry no config-derived text.** The dispatch default and the no-poll/`{action:"status"}`/`{action:"cancel"}` guidance stay in the tool description and the parameter schemas (ADR-0016's generated sites). The guidelines therefore depend on no configuration, so the `<rules>` section is byte-stable across config changes and the guidelines add no cache-invalidating variance — and no duplicated restatement of a site that is always present.
- **The file-work mandate stays engaged-only.** The AUTO guidance must never contain an "otherwise do it yourself" clause or any orchestrator vocabulary: the same bytes must be true in both modes. A unit test asserts the guidelines contain no engaged-only vocabulary and no config-derived wording.

## Considered options

- **Append a policy in AUTO too**: rejected — AUTO's contract is hands-off (ADR-0003), and a delegation mandate is false in AUTO.
- **Register a separate guidance tool active only in AUTO**: rejected — tools cannot be unregistered, exposure is registration-time, and it would duplicate `delegate`'s declaration.
- **Restate the mode-invariant rules in both the guidelines and the policy**: rejected — the engaged request would carry each rule twice; the policy is the engaged-only layer.
- **Parameterize the guidelines on the `async` default**: rejected — it would make the `<rules>` section vary with a config key the tool description and schema already state, adding a third config-dependent prompt site and avoidable cache-prefix churn for no behavioural gain.
- **Leave the description as AUTO's only nudge**: rejected — that is the observed under-use this ADR fixes.

## Consequences

- AUTO turns now spend the guidelines' tokens in `<rules>`; engaged turns see guidelines + policy with no overlapping rule.
- Behavior-changing prompt text: a running session picks it up on the next turn (the guidelines ride the active tool's declaration, diffed into the `<rules>` section).
- `buildPolicy(agents, keptTools)` — the `config` parameter is gone; callers and tests updated. A new invariant test (`tests/delegate.test.ts`) asserts mode-invariance and the no-engaged-vocabulary rule.
- A mid-session `async` config edit leaves the guidelines untouched (they are config-free); dispatch behaviour is still read live per call (`getAsyncDefault`), and the description/schema keep their registration snapshot exactly as ADR-0016 specifies.
