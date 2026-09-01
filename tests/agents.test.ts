/**
 * Unit tests for fleet discovery pure surfaces: projectAgentDirs walking,
 * frontmatter maxTurns strict parsing, and merge precedence (project >
 * user > builtin; .pi/agents before .agents/agents per level).
 *
 * Runs on Node's built-in test runner with type stripping; the pi package
 * import is redirected to a stub via ../resolve-stub-hook.mjs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { discoverAgents, projectAgentDirs } from "../agents.ts";

function tempRoot(label) {
	return fs.mkdtempSync(path.join(os.tmpdir(), `pi-orch-agents-${label}-`));
}

function writeAgent(dir, file, frontmatter, body = "Body.") {
	fs.mkdirSync(dir, { recursive: true });
	const lines = Object.entries(frontmatter)
		.map(([k, v]) => `${k}: ${v}`)
		.join("\n");
	fs.writeFileSync(path.join(dir, file), `---\n${lines}\n---\n${body}\n`, "utf-8");
}

/** Points the stub getAgentDir() at a temp "user" dir for the test duration. */
function withUserDir(userRoot, fn) {
	const prev = process.env.PI_ORCH_TEST_AGENT_DIR;
	process.env.PI_ORCH_TEST_AGENT_DIR = userRoot;
	try {
		return fn();
	} finally {
		if (prev === undefined) delete process.env.PI_ORCH_TEST_AGENT_DIR;
		else process.env.PI_ORCH_TEST_AGENT_DIR = prev;
	}
}

const baseConfig = { enabled: true, keepTools: ["delegate"], builtinFleet: false, modelOverrides: {}, maxTurns: 50 };

// ── projectAgentDirs ────────────────────────────────────────────────────────

test("projectAgentDirs: nearest-first, .pi/agents before .agents/agents, stops after .git ancestor", () => {
	const root = tempRoot("git");
	fs.mkdirSync(path.join(root, "a", "b"), { recursive: true });
	fs.writeFileSync(path.join(root, ".git"), "", "utf-8"); // .git may be a file

	const dirs = projectAgentDirs(path.join(root, "a", "b"));
	assert.deepEqual(dirs, [
		path.join(root, "a", "b", ".pi", "agents"),
		path.join(root, "a", "b", ".agents", "agents"),
		path.join(root, "a", ".pi", "agents"),
		path.join(root, "a", ".agents", "agents"),
		path.join(root, ".pi", "agents"),
		path.join(root, ".agents", "agents"),
	]);
});

test("projectAgentDirs: without a .git marker the walk continues past temp root toward the filesystem root", () => {
	const root = tempRoot("nogit");
	const dirs = projectAgentDirs(path.join(root, "sub"));
	// Starts at the cwd itself, nearest-first, .pi before .agents per level...
	assert.equal(dirs[0], path.join(root, "sub", ".pi", "agents"));
	assert.equal(dirs[1], path.join(root, "sub", ".agents", "agents"));
	// ...and reaches the filesystem root, where it terminates (last entry is
	// <fsRoot>/.agents/agents, and the walk stops there).
	const last = dirs[dirs.length - 1];
	const fsRoot = path.dirname(path.dirname(last)); // strip ".agents" then "agents"
	assert.equal(path.dirname(fsRoot), fsRoot); // dirname of the fs root is itself
	assert.equal(last, path.join(fsRoot, ".agents", "agents"));
});

// ── frontmatter maxTurns strict parsing + merge precedence (via discoverAgents) ──

test("discoverAgents: maxTurns accepts 7 and rejects 'seven', 0, 1.5 (no coercion)", () => {
	const user = tempRoot("turns");
	const agentsDir = path.join(user, "agents");
	writeAgent(agentsDir, "a.md", { name: "a", description: "ok", maxTurns: 7 });
	writeAgent(agentsDir, "b.md", { name: "b", description: "string", maxTurns: "seven" });
	writeAgent(agentsDir, "c.md", { name: "c", description: "zero", maxTurns: 0 });
	writeAgent(agentsDir, "d.md", { name: "d", description: "float", maxTurns: 1.5 });

	const byName = new Map(withUserDir(user, () => discoverAgents(baseConfig, user)).map((a) => [a.name, a]));
	assert.equal(byName.get("a").maxTurns, 7);
	assert.equal(byName.get("b").maxTurns, undefined);
	assert.equal(byName.get("c").maxTurns, undefined);
	assert.equal(byName.get("d").maxTurns, undefined);
	fs.rmSync(user, { recursive: true, force: true });
});

test("discoverAgents: blockTools parses arrays and comma strings, absent means undefined", () => {
	const user = tempRoot("blocks");
	const agentsDir = path.join(user, "agents");
	writeAgent(agentsDir, "a.md", { name: "a", description: "array", blockTools: ["bash", "grep"] });
	writeAgent(agentsDir, "b.md", { name: "b", description: "comma string", blockTools: "bash, grep" });
	writeAgent(agentsDir, "c.md", { name: "c", description: "absent" });

	const byName = new Map(withUserDir(user, () => discoverAgents(baseConfig, user)).map((a) => [a.name, a]));
	assert.deepEqual(byName.get("a").blockTools, ["bash", "grep"]);
	assert.deepEqual(byName.get("b").blockTools, ["bash", "grep"]);
	assert.equal(byName.get("c").blockTools, undefined);
	fs.rmSync(user, { recursive: true, force: true });
});

test("discoverAgents: project beats user, and .pi/agents beats .agents/agents at the same level", () => {
	const user = tempRoot("user");
	const project = tempRoot("proj");
	fs.writeFileSync(path.join(project, ".git"), "", "utf-8");

	writeAgent(path.join(user, "agents"), "dup.md", { name: "dup", description: "user version", blockTools: "bash" });
	writeAgent(path.join(project, ".agents", "agents"), "dup.md", { name: "dup", description: "project .agents", blockTools: "bash,grep" });
	writeAgent(path.join(project, ".pi", "agents"), "dup.md", { name: "dup", description: "project .pi", blockTools: ["grep"] });
	writeAgent(path.join(user, "agents"), "only-user.md", { name: "only-user", description: "user only" });

	const agents = withUserDir(user, () => discoverAgents(baseConfig, project));
	const dup = agents.find((a) => a.name === "dup");
	assert.equal(dup.source, "project");
	assert.equal(dup.description, "project .pi"); // .pi/agents wins over .agents/agents
	// Merge precedence applies to blockTools too: the project copy replaces the user copy wholesale.
	assert.deepEqual(dup.blockTools, ["grep"]);
	assert.ok(agents.some((a) => a.name === "only-user" && a.source === "user"));

	fs.rmSync(user, { recursive: true, force: true });
	fs.rmSync(project, { recursive: true, force: true });
});

test("discoverAgents: builtinFleet false excludes the shipped fleet; modelOverrides apply", () => {
	const user = tempRoot("fleet");
	const agents = withUserDir(user, () => discoverAgents(baseConfig, user));
	assert.equal(agents.length, 0); // no user/project agents, builtin skipped

	const withFleet = withUserDir(user, () =>
		discoverAgents({ ...baseConfig, builtinFleet: true, modelOverrides: { scout: "test/test-model" } }, user),
	);
	const scout = withFleet.find((a) => a.name === "scout");
	assert.ok(scout, "builtin fleet should include scout when builtinFleet is true");
	assert.equal(scout.source, "builtin");
	assert.equal(scout.model, "test/test-model"); // config override beats frontmatter

	fs.rmSync(user, { recursive: true, force: true });
});
