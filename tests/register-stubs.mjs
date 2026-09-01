// Loaded via `--import` so the resolve hook is active before test modules load.
import { register } from "node:module";

register(new URL("./resolve-stub-hook.mjs", import.meta.url));
