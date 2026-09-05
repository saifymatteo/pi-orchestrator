// Minimal stand-in for typebox — only what delegate.ts's schema uses.
// Shapes mirror real TypeBox output closely enough for schema assertions:
// `Type.Object(props, options)` → { type: "object", properties, ...options },
// so tests can walk properties/tasks.items to verify the fleet enum.
export const Type = {
	Object: (properties, options) => ({ type: "object", properties, ...options }),
	String: (options) => ({ type: "string", ...options }),
	Number: (options) => ({ type: "number", ...options }),
	Boolean: (options) => ({ type: "boolean", ...options }),
	Array: (items, options) => ({ type: "array", items, ...options }),
	Optional: (schema) => schema,
};
