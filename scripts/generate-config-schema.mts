import * as fs from "node:fs";
import { CONFIG_SCHEMA } from "../src/config-schema.ts";

const directory = new URL("../schemas/", import.meta.url);
fs.mkdirSync(directory, { recursive: true });
fs.writeFileSync(new URL("orchestrator.schema.json", directory), `${JSON.stringify(CONFIG_SCHEMA, null, 2)}\n`);
