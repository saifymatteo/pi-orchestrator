// Minimal stand-in for typebox — only what delegate.ts's schema uses.
const passthrough = (_schema, options) => options ?? {};
const wrap = (schema) => schema ?? {};
export const Type = {
	Object: passthrough,
	String: passthrough,
	Number: passthrough,
	Boolean: passthrough,
	Array: passthrough,
	Optional: wrap,
};
