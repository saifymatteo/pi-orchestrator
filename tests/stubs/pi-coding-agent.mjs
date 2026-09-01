// Minimal stand-in for @earendil-works/pi-coding-agent, just enough surface
// for the unit tests (config.ts / agents.ts imports).
import * as os from "node:os";
import * as path from "node:path";

/**
 * pi's real getAgentDir() returns ~/.pi/agent. Tests point it at a temp dir
 * via PI_ORCH_TEST_AGENT_DIR; otherwise a harmless OS-tmp fallback.
 */
export function getAgentDir() {
	return process.env.PI_ORCH_TEST_AGENT_DIR || path.join(os.tmpdir(), "pi-orchestrator-test-agent-dir");
}

export function getMarkdownTheme() {
	return {};
}

export function withFileMutationQueue(fn) {
	return fn;
}

export function getSettingsListTheme() {
	return {};
}

/**
 * Minimal frontmatter parser matching the real signature used by agents.ts:
 * `parseFrontmatter<T>(content) -> { frontmatter, body }`.
 * Supports simple `key: value` pairs (string/number/boolean); not a YAML impl.
 */
export function parseFrontmatter(content) {
	const text = String(content);
	const open = text.match(/^---[ \t]*\r?\n/);
	if (!open) return { frontmatter: {}, body: text };
	const start = open[0].length;
	const close = text.indexOf("\n---", start);
	if (close === -1) return { frontmatter: {}, body: text };

	const frontmatter = {};
	for (const line of text.slice(start, close).split(/\r?\n/)) {
		const idx = line.indexOf(":");
		if (idx === -1) continue;
		const key = line.slice(0, idx).trim();
		let value = line.slice(idx + 1).trim();
		if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
			value = value.slice(1, -1);
		} else if (value === "true" || value === "false") {
			frontmatter[key] = value === "true";
			continue;
		} else if (value !== "" && !Number.isNaN(Number(value))) {
			frontmatter[key] = Number(value);
			continue;
		}
		frontmatter[key] = value;
	}
	const body = text.slice(close + 4).replace(/^\r?\n/, "");
	return { frontmatter, body };
}
