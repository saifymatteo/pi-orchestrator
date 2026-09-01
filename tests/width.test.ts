// Unit tests for the visible-width helpers used by the /orchestrator-tools
// header component (pi crashes on rendered lines wider than the terminal).
import { test } from "node:test";
import assert from "node:assert/strict";

import { truncateToWidth, visibleWidth } from "../width.ts";

test("visibleWidth: counts code points, ignoring ANSI escapes", () => {
	assert.equal(visibleWidth("hello"), 5);
	assert.equal(visibleWidth("\x1b[31mhello\x1b[0m"), 5);
	assert.equal(visibleWidth("\x1b[1;32mstyled\x1b[39m plain"), 12);
	assert.equal(visibleWidth(""), 0);
});

test("truncateToWidth: returns text unchanged when it fits", () => {
	assert.equal(truncateToWidth("hello", 5), "hello");
	assert.equal(truncateToWidth("hello", 50), "hello");
	assert.equal(truncateToWidth("", 10), "");
});

test("truncateToWidth: ellipsizes to exactly the requested width", () => {
	assert.equal(truncateToWidth("hello world", 8), "hello w…");
	assert.equal(visibleWidth(truncateToWidth("hello world", 8)), 8);
	const long = "ext:@luxusai/pi-hindsight (hindsight_recall, hindsight_retain, …)";
	assert.equal(visibleWidth(truncateToWidth(long, 40)), 40);
	assert.equal(truncateToWidth(long, 40).endsWith("…"), true);
});

test("truncateToWidth: degenerate widths", () => {
	assert.equal(truncateToWidth("abc", 1), "…");
	assert.equal(truncateToWidth("abc", 0), "");
	assert.equal(truncateToWidth("abc", -3), "");
});

test("truncateToWidth: strips ANSI from input (style AFTER truncating)", () => {
	assert.equal(truncateToWidth("\x1b[31mhello world\x1b[0m", 6), "hello…");
});
