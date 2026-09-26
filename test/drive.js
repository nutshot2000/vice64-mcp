// Drive the MCP server with a JSON list of tool calls in ONE session (so state
// like assembled symbols persists). Images are saved as shot-N.png.
// usage: node test/drive.js calls.json   (or a JSON string)
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs";
import path from "node:path";

const arg = process.argv[2];
const calls = JSON.parse(fs.existsSync(arg) ? fs.readFileSync(arg, "utf8") : arg);
const outDir = process.argv[3] || ".";
const server = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, "$1")), "..", "src", "server.js");
const client = new Client({ name: "drive", version: "0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [server] }));
let shot = 0;
for (const [name, args = {}] of calls) {
  const t = Date.now();
  const r = await client.callTool({ name, arguments: args });
  const parts = r.content.map((c) => {
    if (c.type !== "image") return c.text;
    const f = path.join(outDir, `shot-${++shot}.png`);
    fs.writeFileSync(f, Buffer.from(c.data, "base64"));
    return `[image saved: ${f}]`;
  });
  console.log(`\n=== ${name} ${JSON.stringify(args)} (${Date.now() - t} ms)${r.isError ? " ERROR" : ""}\n${parts.join("\n")}`);
}
await client.close();
