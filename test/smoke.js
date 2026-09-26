// End-to-end check: spawns the MCP server and drives VICE through it.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs";

const client = new Client({ name: "smoke", version: "0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: ["src/server.js"] }));

async function call(name, args = {}) {
  const t = Date.now();
  const r = await client.callTool({ name, arguments: args });
  const out = r.content.map((c) => (c.type === "text" ? c.text : `[${c.type} ${c.mimeType} ${c.data.length} b64 chars]`)).join("\n");
  console.log(`\n=== ${name} ${JSON.stringify(args)} (${Date.now() - t} ms)${r.isError ? " ERROR" : ""}\n${out}`);
  return r;
}

const tools = await client.listTools();
console.log(`${tools.tools.length} tools: ${tools.tools.map((t) => t.name).join(", ")}`);

await call("vice_quit");
await new Promise((r) => setTimeout(r, 1500));
await call("vice_start");
await call("vice_screen_text");
await call("vice_type", { text: "print 6*7\n" });
await call("vice_run_basic", { source: '10 print "{clr}hello from mcp"\n20 for i=1 to 3:print i*i:next\n30 poke 53280,2' });
await call("vice_memory_read", { address: "$D020", length: 2 });
const shot = await call("vice_screenshot");
fs.writeFileSync("test/shot.png", Buffer.from(shot.content[0].data, "base64"));
await call("vice_disassemble", { address: "$FCE2", lines: 6 });
// machine code: INC $D020 ; JMP loop at $C000
await call("vice_load_prg", { hex: "00C0 EE 20 D0 4C 00 C0", run: "sys", wait_ms: 300 });
await call("vice_breakpoint_set", { address: "$C003" });
await call("vice_wait_for_breakpoint", { timeout_ms: 3000 });
await call("vice_step", { count: 2 });
await call("vice_registers");
await call("vice_breakpoint_list");
await call("vice_breakpoint_delete", { all: true });
await call("vice_resume");
await call("vice_status");
// joystick: a loop that ANDs $DC00 into $C100 records any pressed bit
await call("vice_load_prg", { hex: "00C0 78 AD 00 DC 2D 00 C1 8D 00 C1 4C 01 C0" });
await call("vice_memory_write", { address: "$C100", hex: "FF" });
await call("vice_registers", { set: { PC: "$C000" } });
await call("vice_joystick", { port: 2, directions: ["left"], fire: true, hold_ms: 300 });
await call("vice_memory_read", { address: "$C100", length: 1, format: "hex" });
await call("vice_resource", { name: "JoyPort2Device" });
await call("vice_warp", { on: true });
await call("vice_status");
await call("vice_warp", { on: false });
await call("vice_resource", { name: "Sound" });
await call("vice_reset", { wait_ms: 2500 });
await client.close();
