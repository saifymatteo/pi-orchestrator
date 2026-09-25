/**
 * Visible-width helpers for TUI rendering.
 *
 * pi's TUI crashes on rendered lines wider than the terminal, and ANSI-styled
 * strings (theme.fg() etc.) measure far wider than they look. These helpers
 * measure/truncate the PLAIN text; style AFTER truncating.
 */

/** ANSI CSI escape sequences (SGR colors, cursor moves, …) — zero visible width. */
const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;

/** Visible width of a line: code points, ANSI escapes excluded. */
export function visibleWidth(text: string): number {
	return Array.from(text.replace(ANSI_RE, "")).length;
}

/**
 * Truncate plain text to a visible width, ellipsizing the last cell.
 * Pass UNSTYLED text and apply theme.fg()/theme.bold() to the result —
 * escapes are stripped defensively if present. Width <= 0 yields "".
 */
export function truncateToWidth(text: string, width: number): string {
	if (!(width > 0)) return "";
	const plain = text.replace(ANSI_RE, "");
	const cps = Array.from(plain);
	if (cps.length <= width) return plain;
	if (width === 1) return "…";
	return `${cps.slice(0, width - 1).join("")}…`;
}
