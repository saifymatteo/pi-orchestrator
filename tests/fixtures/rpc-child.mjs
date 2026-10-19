// Minimal real RPC child: no pi executable, provider, mock process or transport.
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";

const [scenario, directory, ...args] = process.argv.slice(2);
const auditFile = path.join(directory, "audit.json");
const flag = (name) => args[args.indexOf(name) + 1];
const promptFile = args.includes("--append-system-prompt") ? flag("--append-system-prompt") : undefined;
const parentFile = process.env.PI_ORCHESTRATOR_PARENT_PROMPT_FILE;
const audit = {
	pid: process.pid, args, commands: [], promptFile, parentFile,
	prompt: promptFile ? fs.readFileSync(promptFile, "utf8") : undefined,
	parentPrompt: parentFile ? fs.readFileSync(parentFile, "utf8") : undefined,
	child: process.env.PI_ORCHESTRATOR_CHILD,
	blocked: process.env.PI_ORCHESTRATOR_BLOCKED_TOOLS,
};
const save = () => fs.writeFileSync(auditFile, JSON.stringify(audit));
const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
const assistant = (text) => ({
	role: "assistant", content: [{ type: "text", text }], stopReason: "stop",
	usage: { input: 11, output: 7, cacheRead: 2, cacheWrite: 1, totalTokens: 21, cost: { total: 0.01 } },
});
const partial = () => emit({ type: "message_end", message: assistant("partial output") });
const turn = () => emit({ type: "turn_end", message: { role: "assistant", content: [{ type: "toolCall", name: "read", id: "t", arguments: {} }] } });
setInterval(() => {}, 1000);
save();
if (scenario === "early-exit") {
	process.stderr.write("fixture unexpected failure\n");
	process.exit(23);
}
if (scenario === "ignore-term") process.on("SIGTERM", () => { audit.termCount = (audit.termCount ?? 0) + 1; save(); });
// On POSIX delay termination to prove settlement is not the completion boundary.
else process.on("SIGTERM", () => {
	audit.termCount = (audit.termCount ?? 0) + 1;
	save();
	setTimeout(() => {
		audit.filesAtClose = [promptFile, parentFile].filter(Boolean).every((p) => fs.existsSync(p));
		audit.closed = true;
		save();
		process.exit(0);
	}, 40);
});
let linked = false;
readline.createInterface({ input: process.stdin }).on("line", (line) => {
	const command = JSON.parse(line);
	audit.commands.push(command);
	save();
	if (command.type === "get_state") {
		if (scenario === "setup-stall") return;
		emit({ type: "response", id: command.id, success: true, data: { sessionId: linked ? "linked" : "startup", sessionFile: path.join(directory, linked ? "linked.jsonl" : "startup.jsonl") } });
	} else if (command.type === "new_session") {
		linked = true;
		emit({ type: "response", id: command.id, success: true, data: { cancelled: false } });
	} else if (command.type === "set_session_name") {
		emit({ type: "response", id: command.id, success: true });
	} else if (command.type === "steer") {
		emit({ type: "response", id: command.id, success: true });
		if (scenario === "budget") for (let i = 0; i < 5; i++) turn();
	} else if (command.type === "prompt") {
		if (scenario === "rejected") {
			emit({ type: "response", id: command.id, success: false, error: "fixture rejection" });
			return;
		}
		emit({ type: "response", id: command.id, success: true });
		if (scenario === "malformed") process.stdout.write('not json\nnull\n42\n{"broken":\n');
		partial();
		if (scenario === "cancel" || scenario === "ignore-term" || scenario === "stall") return;
		if (scenario === "noise") {
			let n = 0;
			const timer = setInterval(() => {
				process.stdout.write("unparseable activity\n");
				if (++n === 25) { clearInterval(timer); emit({ type: "agent_settled" }); }
			}, 30);
			return;
		}
		turn();
		if (scenario === "budget") return; // More turns only after the soft-grace steer.
		emit({ type: "agent_settled" });
	}
});
