/**
 * Unit tests for the pure config helpers (ADR-0004 consequence: "Tests must
 * cover tool discovery"). Runs on Node's built-in test runner with type
 * stripping; the pi package import is redirected to a stub via the resolve
 * hook in ../resolve-stub-hook.mjs (see ../register-stubs.mjs).
 *
 * Run: npm test  (or: node --test --experimental-strip-types --import ./tests/register-stubs.mjs tests/)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
	discoverKeptTools,
	effectiveKeepTools,
	loadConfig,
	toolIsKept,
	toolMatchesAnyMatcher,
} from "../config.ts";

// ── loadConfig / maxTurns validation ────────────────────────────────────────

function withConfigFile(body, fn) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-orch-config-"));
	const prev = process.env.PI_ORCH_TEST_AGENT_DIR;
	process.env.PI_ORCH_TEST_AGENT_DIR = dir;
	try {
		if (body !== null) fs.writeFileSync(path.join(dir, "orchestrator.json"), JSON.stringify(body), "utf-8");
		return fn();
	} finally {
		if (prev === undefined) delete process.env.PI_ORCH_TEST_AGENT_DIR;
		else process.env.PI_ORCH_TEST_AGENT_DIR = prev;
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

test("loadConfig: maxTurns rejects '30' (string), 0 and 12.5, falls back to default 50", () => {
	for (const bad of ["30", 0, 12.5]) {
		withConfigFile({ maxTurns: bad }, () => {
			assert.equal(loadConfig().maxTurns, 50, `maxTurns=${JSON.stringify(bad)} must fall back to 50`);
		});
	}
});

test("loadConfig: maxTurns accepts a positive integer", () => {
	withConfigFile({ maxTurns: 7 }, () => {
		assert.equal(loadConfig().maxTurns, 7);
	});
});

test("loadConfig: stallTimeoutMs rejects '600' (string), -1 and 0, falls back to default 600000", () => {
	for (const bad of ["600", -1, 0, Infinity, NaN]) {
		withConfigFile({ stallTimeoutMs: bad }, () => {
			assert.equal(loadConfig().stallTimeoutMs, 600000, `stallTimeoutMs=${String(bad)} must fall back to 600000`);
		});
	}
});

test("loadConfig: stallTimeoutMs accepts positive numbers including decimals (ms precision)", () => {
	withConfigFile({ stallTimeoutMs: 600000 }, () => {
		assert.equal(loadConfig().stallTimeoutMs, 600000);
	});
	withConfigFile({ stallTimeoutMs: 1234.5 }, () => {
		assert.equal(loadConfig().stallTimeoutMs, 1234.5);
	});
});

test("loadConfig: missing file yields full defaults", () => {
	withConfigFile(null, () => {
		const config = loadConfig();
		assert.deepEqual(config, {
			enabled: true,
			keepTools: ["delegate"],
			childBlockedTools: [],
			childExtensions: [],
			builtinFleet: true,
			autoKeepExtensions: false,
			modelOverrides: {},
			maxTurns: 50,
			stallTimeoutMs: 600000,
		});
	});
});

test("loadConfig: autoKeepExtensions accepts booleans only, defaults false", () => {
	withConfigFile({ autoKeepExtensions: true }, () => {
		assert.equal(loadConfig().autoKeepExtensions, true);
	});
	for (const bad of ["true", 1, null]) {
		withConfigFile({ autoKeepExtensions: bad }, () => {
			assert.equal(loadConfig().autoKeepExtensions, false, `autoKeepExtensions=${JSON.stringify(bad)} must fall back to false`);
		});
	}
});

test("loadConfig: keepTools drops non-string/blank entries", () => {
	withConfigFile({ keepTools: ["todo", "", 42, "  ", "hindsight_*"] }, () => {
		assert.deepEqual(loadConfig().keepTools, ["todo", "hindsight_*"]);
	});
});
test("loadConfig: childBlockedTools keeps valid matchers and drops non-string/blank entries", () => {
	withConfigFile({ childBlockedTools: ["bash", "hindsight_*", "", 42, "  ", "ext:@l/p"] }, () => {
		assert.deepEqual(loadConfig().childBlockedTools, ["bash", "hindsight_*", "ext:@l/p"]);
	});
});

test("loadConfig: childBlockedTools missing or non-array falls back to []", () => {
	withConfigFile(null, () => {
		assert.deepEqual(loadConfig().childBlockedTools, []);
	});
	withConfigFile({ childBlockedTools: "bash" }, () => {
		assert.deepEqual(loadConfig().childBlockedTools, []);
	});
});

// ── ADR-0008 child spawn policy fields ─────────────────────────────────────

test("loadConfig: childExtensions keeps valid strings and drops non-string/blank entries", () => {
	withConfigFile({ childExtensions: ["./my-ext.ts", "", 42, "  ", "npm:@foo/bar"] }, () => {
		assert.deepEqual(loadConfig().childExtensions, ["./my-ext.ts", "npm:@foo/bar"]);
	});
});

test("loadConfig: childExtensions missing or non-array falls back to []", () => {
	withConfigFile(null, () => {
		assert.deepEqual(loadConfig().childExtensions, []);
	});
	withConfigFile({ childExtensions: "./my-ext.ts" }, () => {
		assert.deepEqual(loadConfig().childExtensions, []);
	});
});

// ── toolMatchesAnyMatcher ───────────────────────────────────────────────────

test("toolMatchesAnyMatcher: exact matcher (case-insensitive)", () => {
	const t = tool("todo", nm("some-pkg", "i.js"));
	assert.equal(toolMatchesAnyMatcher(t, ["todo"]), "todo");
	assert.equal(toolMatchesAnyMatcher(t, ["TODO"]), "TODO");
	assert.equal(toolMatchesAnyMatcher(t, ["todo2"]), undefined);
	assert.equal(toolMatchesAnyMatcher(t, []), undefined);
});

test("toolMatchesAnyMatcher: glob matcher on tool name", () => {
	const t = tool("hindsight_recall", nm("@l/pi-hindsight", "i.js"));
	assert.equal(toolMatchesAnyMatcher(t, ["hindsight_*"]), "hindsight_*");
	assert.equal(toolMatchesAnyMatcher(t, ["hindsight_?ecall"]), "hindsight_?ecall");
	assert.equal(toolMatchesAnyMatcher(t, ["hindsight_*_retain"]), undefined);
});

test("toolMatchesAnyMatcher: ext:<id> matcher matches whole owning package", () => {
	const t = tool("hindsight_recall", nm("@l/pi-hindsight", "i.js"));
	assert.equal(toolMatchesAnyMatcher(t, ["ext:@l/pi-hindsight"]), "ext:@l/pi-hindsight");
	assert.equal(toolMatchesAnyMatcher(t, ["ext:@l/pi-hindsight2"]), undefined);
	assert.equal(toolMatchesAnyMatcher(t, ["ext:pi-hindsight"]), undefined);
});

test("toolMatchesAnyMatcher: returns the first matching matcher", () => {
	const t = tool("hindsight_recall", nm("@l/pi-hindsight", "i.js"));
	assert.equal(toolMatchesAnyMatcher(t, ["nope", "hindsight_*", "ext:@l/pi-hindsight"]), "hindsight_*");
	assert.equal(toolMatchesAnyMatcher(t, ["nope", "HINDSIGHT_RECALL", "hindsight_*"]), "HINDSIGHT_RECALL");
});


// ── discoverKeptTools ───────────────────────────────────────────────────────

const tool = (name, sourceInfo) => ({ name, sourceInfo });
const nm = (pkg, rest) => ({ path: `C:/repo/node_modules/${pkg}/${rest}` });

test("discoverKeptTools: skips builtin, delegate, and unknown (no sourceInfo) tools", () => {
	const discovered = discoverKeptTools(
		[
			tool("read", { path: "<builtin:core-tools>" }),
			tool("bash", { path: "<builtin:bash>" }),
			tool("delegate", nm("some-pkg", "index.js")),
			tool("mystery"), // no sourceInfo → extensionId "unknown" → not auto-kept
			tool("mystery2", {}), // empty sourceInfo → same
		],
		[],
	);
	assert.deepEqual(discovered, []);
});

test("discoverKeptTools: groups tools by extensionId and dedupes names", () => {
	const discovered = discoverKeptTools(
		[
			tool("hindsight_recall", nm("@luxusai/pi-hindsight", "dist/index.js")),
			tool("hindsight_retain", nm("@luxusai/pi-hindsight", "dist/retain.js")),
			tool("hindsight_recall", nm("@luxusai/pi-hindsight", "dist/index.js")), // duplicate name
			tool("foo_tool", nm("plain-pkg", "out/main.mjs")),
		],
		[],
	);
	assert.deepEqual(discovered, [
		{ extensionId: "@luxusai/pi-hindsight", names: ["hindsight_recall", "hindsight_retain"], partial: false },
		{ extensionId: "plain-pkg", names: ["foo_tool"], partial: false },
	]);
});

test("discoverKeptTools: unscoped single-segment paths become their own extension", () => {
	const discovered = discoverKeptTools([tool("x", { path: "C:/ext/my-ext.ts" })], []);
	assert.deepEqual(discovered, [{ extensionId: "my-ext", names: ["x"], partial: false }]);
});

test("discoverKeptTools: extension tool shadowing a builtin name is excluded (registerTool strips <builtin:> sourceInfo)", () => {
	const discovered = discoverKeptTools(
		[tool("bash", { path: "C:/ext/compact-tools.ts" }), tool("my_custom_thing", { path: "C:/ext/compact-tools.ts" })],
		[],
	);
	// "bash" is skipped; only the non-colliding tool survives, under its own
	// extension — and the group is marked partial (mixed-extension leak fix).
	assert.deepEqual(discovered, [{ extensionId: "compact-tools", names: ["my_custom_thing"], partial: true }]);
});

test("discoverKeptTools: ext:<id> in configKeepTools re-enables a builtin-shadowing extension", () => {
	const tools = [tool("bash", nm("@ff-labs/pi-fff", "dist/index.js")), tool("find", nm("@ff-labs/pi-fff", "dist/index.js"))];
	assert.deepEqual(discoverKeptTools(tools, []), []);
	assert.deepEqual(discoverKeptTools(tools, ["ext:@ff-labs/pi-fff"]), [
		{ extensionId: "@ff-labs/pi-fff", names: ["bash", "find"], partial: false },
	]);
});

test("discoverKeptTools: non-colliding extension tools are still auto-kept", () => {
	const discovered = discoverKeptTools(
		[tool("codegraph_search", nm("some-pkg", "index.js")), tool("hindsight_recall", nm("other-pkg", "index.js"))],
		[],
	);
	assert.deepEqual(discovered, [
		{ extensionId: "some-pkg", names: ["codegraph_search"], partial: false },
		{ extensionId: "other-pkg", names: ["hindsight_recall"], partial: false },
	]);
});

test("discoverKeptTools: builtin-shaped tools stay excluded even with ext: config matcher", () => {
	// Overridden builtins lose their <builtin:> sourceInfo, but untouched builtins keep it:
	// the "builtin" extension id is filtered before the config matcher could ever rescue them.
	const discovered = discoverKeptTools([tool("read", { path: "<builtin:read>" })], ["ext:builtin"]);
	assert.deepEqual(discovered, []);
});

test("discoverKeptTools: builtin-shadow exclusion is case-insensitive on tool name", () => {
	const discovered = discoverKeptTools([tool("Bash", { path: "C:/ext/compact-tools.ts" })], []);
	assert.deepEqual(discovered, []);
});

// ── effectiveKeepTools (keep-list-only default; autoKeepExtensions opt-in) ─

test("effectiveKeepTools: default is keep-list-only — discovered extensions are filtered out", () => {
	const config = ["delegate", " ext:@s/p ", "todo"];
	const discovered = [
		{ extensionId: "@s/p", names: ["a"], partial: false },
		{ extensionId: "q", names: ["b"], partial: false },
	];
	// Only the config matchers survive; @s/p stays via its explicit ext: matcher,
	// q (discovered, not in keepTools) is NOT kept.
	assert.deepEqual(effectiveKeepTools(config, discovered), ["delegate", "ext:@s/p", "todo"]);
	// never mutates the config array
	assert.deepEqual(config, ["delegate", " ext:@s/p ", "todo"]);
});

test("effectiveKeepTools: autoKeepExtensions=true restores ADR-0004 auto-keep", () => {
	const config = ["delegate", " ext:@s/p ", "todo"];
	const discovered = [
		{ extensionId: "@s/p", names: ["a"], partial: false },
		{ extensionId: "q", names: ["b"], partial: false },
	];
	assert.deepEqual(effectiveKeepTools(config, discovered, true), ["delegate", "ext:@s/p", "todo", "ext:q"]);
});

test("effectiveKeepTools: ext: matcher still keeps explicitly-listed extensions under the default", () => {
	const config = ["ext:@l/p"];
	const discovered = [
		{ extensionId: "@l/p", names: ["x"], partial: false },
		{ extensionId: "other", names: ["y"], partial: false },
	];
	const effective = effectiveKeepTools(config, discovered);
	assert.deepEqual(effective, ["ext:@l/p"]);
	assert.equal(toolIsKept(tool("x", nm("@l/p", "i.js")), effective), true);
	assert.equal(toolIsKept(tool("y", nm("other", "i.js")), effective), false);
});

// ── partial extension groups (mixed-extension leak fix) ───────────────────

const FFF = "@ff-labs/pi-fff";

function fffTools() {
	// Real case: pi-fff registers builtin-shadowing grep/find plus non-colliding
	// siblings — here just grep + ffgrep for brevity.
	return [tool("grep", nm(FFF, "src/index.ts")), tool("ffgrep", nm(FFF, "src/index.ts"))];
}

test("effectiveKeepTools: default filters partial groups; flag emits per-name matchers, not ext:<id>", () => {
	// "grep" is shadow-skipped; only "ffgrep" survives in the group → partial.
	const discovered = discoverKeptTools(fffTools(), []);
	assert.deepEqual(discovered, [{ extensionId: FFF, names: ["ffgrep"], partial: true }]);

	// Default (keep-list-only): the partial extension contributes nothing.
	assert.deepEqual(effectiveKeepTools([], discovered), []);

	// Opt-in auto-keep: sibling kept by exact name, shadowed builtin not re-kept.
	const effective = effectiveKeepTools([], discovered, true);
	assert.ok(effective.includes("ffgrep"), "sibling must be kept by exact name");
	assert.ok(!effective.includes(`ext:${FFF}`), "ext:<id> must NOT be emitted (would re-keep grep)");
	assert.ok(!effective.includes("grep"), "shadowed builtin name must not be re-kept");
});

test("effectiveKeepTools: explicit ext:<id> config entry keeps the whole partial extension", () => {
	const config = [`ext:${FFF}`];
	// With the ext: opt-in, "grep" is not shadow-skipped at discovery time.
	const discovered = discoverKeptTools(fffTools(), config);
	assert.deepEqual(discovered, [{ extensionId: FFF, names: ["grep", "ffgrep"], partial: false }]);

	const effective = effectiveKeepTools(config, discovered);
	assert.ok(effective.includes(`ext:${FFF}`), "whole extension kept via ext:<id>");
});

test("effectiveKeepTools: default does not auto-keep clean extensions; flag emits ext:<id>", () => {
	const discovered = discoverKeptTools([tool("hindsight_recall", nm("@l/pi-hindsight", "i.js"))], []);
	assert.deepEqual(discovered, [{ extensionId: "@l/pi-hindsight", names: ["hindsight_recall"], partial: false }]);
	assert.deepEqual(effectiveKeepTools([], discovered), [], "keep-list-only: nothing added");
	assert.deepEqual(effectiveKeepTools([], discovered, true), ["ext:@l/pi-hindsight"]);
});

test("partial group end-to-end (default keep-list-only): both grep and ffgrep blocked without config", () => {
	const effective = effectiveKeepTools([], discoverKeptTools(fffTools(), []));
	assert.equal(toolIsKept(tool("grep", nm(FFF, "src/index.ts")), effective), false, "shadowed grep blocked");
	assert.equal(toolIsKept(tool("ffgrep", nm(FFF, "src/index.ts")), effective), false, "sibling not auto-kept by default");
});

test("partial group end-to-end (autoKeepExtensions): toolIsKept blocks shadowed grep, allows ffgrep", () => {
	const effective = effectiveKeepTools([], discoverKeptTools(fffTools(), []), true);
	assert.equal(toolIsKept(tool("grep", nm(FFF, "src/index.ts")), effective), false, "shadowed grep blocked");
	assert.equal(toolIsKept(tool("ffgrep", nm(FFF, "src/index.ts")), effective), true, "sibling ffgrep kept");
});

// ── matcher semantics (toolIsKept) ──────────────────────────────────────────

test("toolIsKept: delegate is unconditionally kept", () => {
	assert.equal(toolIsKept(tool("delegate", nm("x", "i.js")), []), true);
});

test("toolIsKept: exact matcher (case-insensitive)", () => {
	const t = tool("todo", nm("some-pkg", "i.js"));
	assert.equal(toolIsKept(t, ["todo"]), true);
	assert.equal(toolIsKept(t, ["TODO"]), true);
	assert.equal(toolIsKept(t, ["todo2"]), false);
	assert.equal(toolIsKept(t, []), false);
});

test("toolIsKept: glob matcher on tool name", () => {
	const t = tool("hindsight_recall", nm("@l/pi-hindsight", "i.js"));
	assert.equal(toolIsKept(t, ["hindsight_*"]), true);
	assert.equal(toolIsKept(t, ["hindsight_?ecall"]), true);
	assert.equal(toolIsKept(t, ["hindsight_*_retain"]), false);
});

test("toolIsKept: ext: matcher matches whole owning package", () => {
	const t = tool("hindsight_recall", nm("@l/pi-hindsight", "i.js"));
	assert.equal(toolIsKept(t, ["ext:@l/pi-hindsight"]), true);
	assert.equal(toolIsKept(t, ["ext:@l/pi-hindsight2"]), false);
	assert.equal(toolIsKept(t, ["ext:pi-hindsight"]), false);
});
