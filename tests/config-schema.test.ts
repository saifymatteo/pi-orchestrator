import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { Check } from "typebox/value";
import { CONFIG_SCHEMA } from "../src/config-schema.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";

test("editor schema accepts omitted settings and complete defaults but flags unknown names", () => {
	assert.equal(Check(CONFIG_SCHEMA, {}), true);
	assert.equal(Check(CONFIG_SCHEMA, DEFAULT_CONFIG), true);
	assert.equal(Check(CONFIG_SCHEMA, { $schema: "https://example.com/config.schema.json", maxTurns: 7 }), true);
	assert.equal(Check(CONFIG_SCHEMA, { maxTurn: 7 }), false);
});

test("published JSON schema describes defaults and validates editable values without inserting defaults", () => {
	const schema = JSON.parse(fs.readFileSync("schemas/orchestrator.schema.json", "utf8"));
	assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
	assert.deepEqual(schema.properties.keepTools.default, ["delegate"]);
	assert.match(schema.properties.keepTools.description, /auto-keeps/);
	assert.equal(schema.properties.maxTurns.default, 50);
	assert.equal(schema.properties.stallTimeoutMs.default, 600000);
	const empty = {};
	assert.equal(Check(schema, empty), true);
	assert.deepEqual(empty, {}, "validation must not populate document defaults");
	for (const valid of [
		{ keepTools: [], childExtensions: [], childBlockedTools: [] },
		{ builtinFleet: false },
		{ builtinFleet: {} },
		{ builtinFleet: { futureAgent: {}, worker: { thinking: "xhigh", hidden: true } } },
		{ modelOverrides: { "custom-agent": "openrouter/model", "custom\nagent": "provider/model" } },
		{ builtinFleet: { "custom\nagent": { thinking: "high", hidden: false } } },
		{ maxTurns: 1, stallTimeoutMs: 0.5, async: false },
		{ keepTools: ["hindsight_*", "ext:@example/tools", " tool "] },
	]) assert.equal(Check(schema, valid), true, JSON.stringify(valid));
	for (const invalid of [
		{ maxTurn: 7 }, { maxTurns: 0 }, { maxTurns: 1.5 }, { maxTurns: "7" },
		{ stallTimeoutMs: 0 }, { stallTimeoutMs: -1 }, { stallTimeoutMs: "600" },
		{ enabled: "yes" }, { async: "false" }, { forwardParentPrompt: null }, { childSessions: 1 },
		{ keepTools: [" "] }, { childBlockedTools: [42] }, { childExtensions: [""] },
		{ modelOverrides: { scout: "  " } }, { modelOverrides: [] },
		{ builtinFleet: [] }, { builtinFleet: { worker: { thinkng: "high" } } },
		{ builtinFleet: { worker: { hidden: "yes" } } }, { builtinFleet: { worker: { thinking: "ultra" } } },
		{ builtinFleet: { worker: false } }, { $schema: 42 },
		{ modelOverrides: { "custom\nagent": 42 } },
		{ builtinFleet: { "custom\nagent": { hidden: "yes", thinkng: "high" } } },
	]) assert.equal(Check(schema, invalid), false, JSON.stringify(invalid));
	for (const thinking of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
		assert.equal(Check(schema, { builtinFleet: { anyName: { thinking } } }), true);
	}
});
