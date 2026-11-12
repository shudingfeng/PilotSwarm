// An MCP server for environment probes: no credentials or network services.
// Writes the variables named after argv[2] to the file argv[2] names, as
// { NAME: value or null }, when it starts, then serves an empty tool list.
import readline from "node:readline";
import { writeFileSync } from "node:fs";

const [output, ...names] = process.argv.slice(2);
writeFileSync(output, JSON.stringify(Object.fromEntries(names.map((name) => [name, process.env[name] ?? null]))));
readline.createInterface({ input: process.stdin }).on("line", (line) => {
    const message = JSON.parse(line);
    if (message.id === undefined) return;
    let result = {};
    if (message.method === "initialize") {
        result = { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "env-probe", version: "1" } };
    } else if (message.method === "tools/list") {
        result = { tools: [] };
    }
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\n");
});
