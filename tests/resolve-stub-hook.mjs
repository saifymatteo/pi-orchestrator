// Module-resolution hook: redirects the `@earendil-works/pi-coding-agent`
// import (available only inside a full pi install) to a minimal local stub so
// the pure functions in config.ts / agents.ts can be unit-tested standalone.
const STUBS = new Map([
	["@earendil-works/pi-coding-agent", new URL("./stubs/pi-coding-agent.mjs", import.meta.url).href],
	["@earendil-works/pi-tui", new URL("./stubs/pi-tui.mjs", import.meta.url).href],
	["typebox", new URL("./stubs/typebox.mjs", import.meta.url).href],
]);

export async function resolve(specifier, context, nextResolve) {
	const stub = STUBS.get(specifier);
	if (stub) {
		return { url: stub, shortCircuit: true };
	}
	return nextResolve(specifier, context);
}
