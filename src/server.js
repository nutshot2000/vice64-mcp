#!/usr/bin/env node
// MCP server for the VICE Commodore 64 emulator, via its binary monitor protocol.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Vice } from "./vice.js";
import { assemble, evaluate } from "./asm6502.js";
import { HostKeys, KEY_NAMES } from "./hostkeys.js";
import { findVice } from "./findvice.js";
import { screenToText, textToPetscii, disassemble, hexDump, indexedToPng, h2, h4 } from "./c64.js";

const VICE_EXE = findVice(); // may be null: then we can only connect to an already-running VICE
const VICE_PORT = Number(process.env.VICE_PORT || 6502);
// VICE 3.10 dropped Speed=0 ("no limit") and has no warp command in the binary
// monitor, so warp is a very high speed limit instead (~30x on a typical PC).
const WARP_SPEED = 5000;
// Sound can't keep up at warp speed (VICE pops a "Cannot initialize SID
// engine" error), so sound is switched off while warping and restored after.
let soundBeforeWarp = null;
async function setWarp(on, speed = WARP_SPEED) {
  if (on) {
    if (soundBeforeWarp === null) soundBeforeWarp = await vice.resourceGet("Sound");
    await vice.resourceSet("Sound", 0);
    await vice.resourceSet("Speed", speed);
  } else {
    await vice.resourceSet("Speed", 100);
    if (soundBeforeWarp !== null) await vice.resourceSet("Sound", soundBeforeWarp);
    soundBeforeWarp = null;
  }
}
const TMP = path.join(os.tmpdir(), "vice-mcp");
fs.mkdirSync(TMP, { recursive: true });

const vice = new Vice({ exe: VICE_EXE, port: VICE_PORT });
const hostKeys = new HostKeys(VICE_EXE ? path.basename(VICE_EXE, path.extname(VICE_EXE)) : "x64sc");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const COLOR_NAMES = ["black", "white", "red", "cyan", "purple", "green", "blue", "yellow",
  "orange", "brown", "light red", "dark gray", "gray", "light green", "light blue", "light gray"];

// ---------- plumbing ----------

let queue = Promise.resolve();
/**
 * Run fn with exclusive access to VICE. Every binary-monitor command stops
 * the emulated CPU, so afterwards we resume it unless it was deliberately
 * stopped (vice_pause, stepping, a breakpoint hit or a CPU JAM).
 */
function withVice(fn, { launch = true } = {}) {
  const run = async () => {
    const launched = await vice.ensure({ launch });
    try {
      return await fn(launched);
    } finally {
      if (vice.connected && !vice.holdStopped) {
        try {
          await vice.exit();
        } catch {}
      }
    }
  };
  const p = queue.then(run, run);
  queue = p.catch(() => {});
  return p;
}

/** Let the emulator run (unless held) for ms milliseconds, then return with it stopped. */
async function runFor(ms) {
  if (!vice.holdStopped) await vice.exit();
  await sleep(ms);
  await vice.ping(); // any command re-enters the monitor
}

/**
 * Autostart a .prg we built, fast: VICE's default loads PRGs through an emulated
 * disk (seconds, plus a random delay), so switch to RAM injection for this start.
 * If range is given, wait until the CPU is executing inside it. Returns ms taken, or -1 on timeout.
 */
async function autostartBuilt(prgPath, range, timeoutMs = 15000, settleMs = 0) {
  const prev = {};
  for (const r of ["AutostartPrgMode", "AutostartDelayRandom"]) prev[r] = await vice.resourceGet(r).catch(() => undefined);
  await vice.resourceSet("AutostartPrgMode", 1).catch(() => {});
  await vice.resourceSet("AutostartDelayRandom", 0).catch(() => {});
  vice.holdStopped = false;
  const t0 = Date.now();
  try {
    await vice.autostart(prgPath, true, 0);
    if (!range) {
      await runFor(settleMs); // settings must stay changed until VICE has loaded the file
      return 0;
    }
    while (Date.now() - t0 < timeoutMs) {
      await runFor(100);
      const pc = (await vice.getRegisters()).PC;
      if (pc >= range[0] && pc <= range[1]) return Date.now() - t0;
    }
    return -1;
  } finally {
    for (const [r, v] of Object.entries(prev)) if (v !== undefined) await vice.resourceSet(r, v).catch(() => {});
  }
}

const text = (s) => ({ content: [{ type: "text", text: s }] });
const fail = (e) => ({ content: [{ type: "text", text: `Error: ${e.message ?? e}` }], isError: true });
function tool(name, description, shape, handler) {
  server.registerTool(name, { description, inputSchema: shape }, async (args) => {
    try {
      return await handler(args);
    } catch (e) {
      return fail(e);
    }
  });
}

// Symbols from the last vice_assemble, so addresses can be given as labels.
// Persisted to disk so they survive server restarts.
const SYMBOLS_FILE = path.join(TMP, "symbols.json");
let symbols = {};
let symbolsByAddr = [];
function setSymbols(syms, save = true) {
  symbols = syms;
  symbolsByAddr = Object.entries(syms)
    .filter(([name]) => !name.includes("@"))
    .sort((a, b) => a[1] - b[1]);
  if (save) {
    try {
      fs.writeFileSync(SYMBOLS_FILE, JSON.stringify(syms));
    } catch {}
  }
}
try {
  setSymbols(JSON.parse(fs.readFileSync(SYMBOLS_FILE, "utf8")), false);
} catch {}
/** "label+3" for an address that falls shortly after a known label. */
function symbolize(addr) {
  let best = null;
  for (const [name, v] of symbolsByAddr) {
    if (v > addr) break;
    if (addr - v < 256) best = [name, v];
  }
  if (!best) return "";
  return best[1] === addr ? best[0] : `${best[0]}+${addr - best[1]}`;
}
/** Put label lines above disassembly lines that start at a known label. */
function annotate(lines) {
  const byAddr = new Map(symbolsByAddr.map(([n, v]) => [v, n]));
  return lines.flatMap((l) => {
    const n = byAddr.get(parseInt(l.slice(0, 4), 16));
    return n ? [`${n}:`, l] : [l];
  }).join("\n");
}

const Addr = z
  .union([z.number().int(), z.string()])
  .describe('Address: 49152, "$C000", "0xC000", "C000", or a label/expression from the last vice_assemble such as "game_loop" or "score+2"');
function parseAddr(v) {
  if (typeof v === "number") return v & 0xffff;
  const s = v.trim();
  let n;
  if (/^[0-9a-f]{1,4}$/i.test(s) && !(s in symbols) && !/^\d+$/.test(s)) n = parseInt(s, 16);
  else {
    let r;
    try {
      r = evaluate(s, (name) => symbols[name], 0);
    } catch (e) {
      throw new Error(`bad address "${v}": ${e.message}`);
    }
    if (!r.known) throw new Error(`unknown label in "${v}" (assemble with vice_assemble first, or see vice_symbols)`);
    n = r.value;
  }
  if (Number.isNaN(n) || n < 0 || n > 0xffff) throw new Error(`bad address: ${v}`);
  return n;
}
function parseHex(s) {
  const clean = s.replace(/\$|0x|,|\s/gi, "");
  if (clean.length % 2 || /[^0-9a-f]/i.test(clean)) throw new Error("hex data must be pairs of hex digits, e.g. 'A9 01 8D 20 D0'");
  return Buffer.from(clean, "hex");
}

async function stateLine() {
  const regs = await vice.getRegisters();
  const pc = regs.PC;
  const code = await vice.readMemory(pc, 3);
  const dis = disassemble(code, pc, 1).lines[0] ?? "";
  const r = (n) => (regs[n] !== undefined ? h2(regs[n]) : "??");
  const flags = regs.FL ?? regs["NV-BDIZC"];
  const flagStr = flags !== undefined ? "NV-BDIZC".split("").map((f, i) => ((flags >> (7 - i)) & 1 ? f : ".")).join("") : "";
  const sym = symbolize(pc);
  return `PC=$${h4(pc)}${sym ? ` (${sym})` : ""} A=$${r("A")} X=$${r("X")} Y=$${r("Y")} SP=$${r("SP")} ${flagStr}${regs.LIN !== undefined ? ` raster=${regs.LIN}` : ""}\n> ${dis}`;
}

async function readScreen({ reverse = false } = {}) {
  const io = await vice.readMemory(0xd011, 8); // $D011-$D018
  const d011 = io[0];
  const d016 = io[5];
  const d018 = io[7];
  const dd00 = (await vice.readMemory(0xdd00, 1))[0];
  const cols = await vice.readMemory(0xd020, 2);
  const vicBank = (3 - (dd00 & 3)) * 0x4000;
  const screenAddr = vicBank + ((d018 >> 4) & 0x0f) * 0x400;
  const charSlot = (d018 >> 1) & 7;
  const romChars = (vicBank === 0 || vicBank === 0x8000) && (charSlot === 2 || charSlot === 3);
  const lowercase = romChars && charSlot === 3;
  const bytes = await vice.readMemory(screenAddr, 1000, "ram");
  const notes = [];
  if (!(d011 & 0x10)) notes.push("screen is blanked ($D011 bit 4 clear)");
  if (d011 & 0x20) notes.push("BITMAP mode: text below is meaningless, use vice_screenshot");
  if (d016 & 0x10 && !(d011 & 0x20)) notes.push("multicolor text mode");
  if (!romChars) notes.push(`custom charset at $${h4(vicBank + charSlot * 0x800)}: characters decoded as if ROM charset`);
  const cur = await vice.readMemory(0xd3, 4); // $D3 column, $D6 row
  const header =
    `screen $${h4(screenAddr)} (${lowercase ? "lower/upper" : "upper/graphics"} case), ` +
    `border ${COLOR_NAMES[cols[0] & 15]}, background ${COLOR_NAMES[cols[1] & 15]}, ` +
    `cursor row ${cur[3]} col ${cur[0]}` +
    (notes.length ? `\nnote: ${notes.join("; ")}` : "");
  return { header, text: screenToText(bytes, 40, 25, lowercase, { markReverse: reverse }) };
}

async function screenText(opts) {
  const s = await readScreen(opts);
  return `${s.header}\n${"-".repeat(40)}\n${s.text}\n${"-".repeat(40)}`;
}

// The monitor's joyport command drives VICE's "Joyport I/O simulation" device
// (lines are active-low), so that device is plugged into the port while a
// direction is held and the user's own device is put back on release.
const JOYPORT_IO_SIMULATION = 37;
const savedJoyDevice = {};
async function pressJoystick(port, value) {
  const res = `JoyPort${port}Device`;
  if (!(port in savedJoyDevice)) {
    savedJoyDevice[port] = await vice.resourceGet(res);
    await vice.resourceSet(res, JOYPORT_IO_SIMULATION);
  }
  await vice.joyport(port - 1, 0xff & ~value);
}
async function releaseJoystick(port) {
  if (!(port in savedJoyDevice)) return;
  await vice.joyport(port - 1, 0xff);
  await vice.resourceSet(`JoyPort${port}Device`, savedJoyDevice[port]);
  delete savedJoyDevice[port];
}

async function readPrgInput({ path: file, hex }) {
  if (file) return fs.readFileSync(file);
  if (hex) return parseHex(hex);
  throw new Error("give either path or hex");
}

// ---------- server ----------

const server = new McpServer(
  { name: "vice", version: "0.2.0" },
  {
    instructions:
      "Controls a real VICE C64 emulator window that the user can see and may be using themselves. " +
      "Before disruptive actions (vice_reset, vice_autostart, vice_assemble with autostart, vice_memory_write, vice_quit) " +
      "in a session where the user might be playing, look first (vice_screenshot / vice_status) or ask. " +
      "Typical loop for building software: vice_assemble -> vice_screenshot / vice_screen_text -> vice_input_sequence " +
      "(joystick + keys, with memory watches using assembler labels) -> breakpoints and vice_step for debugging.",
  }
);

tool(
  "vice_start",
  "Start the VICE C64 emulator (x64sc) with its binary monitor, or connect to one already running. Other tools also auto-start VICE, so this is only needed for the options.",
  {
    warp: z.boolean().optional().describe("Turn warp (max speed) mode on or off after starting"),
    ntsc: z.boolean().optional().describe("Launch as NTSC instead of PAL (only applies when this call launches VICE)"),
  },
  async ({ warp, ntsc }) => {
    if (ntsc && !vice.connected) vice.extraArgs = ["-ntsc"];
    return withVice(async (launched) => {
      const info = await vice.info();
      if (warp !== undefined) await setWarp(warp);
      if (launched) await runFor(2500); // let it reach the READY prompt
      return text(`${launched ? "Launched" : "Connected to running"} VICE ${info.version} on port ${VICE_PORT}.\n${await stateLine()}`);
    });
  }
);

tool("vice_status", "Show whether VICE is connected, whether the CPU is running or held stopped, and the current CPU state.", {}, async () => {
  if (!vice.connected) {
    try {
      await vice.ensure({ launch: false });
    } catch (e) {
      return text(`Not connected: ${e.message}`);
    }
  }
  return withVice(async () => {
    let s = `Connected on port ${VICE_PORT}. CPU is ${vice.holdStopped ? "STOPPED (held; call vice_resume to continue)" : "running"}.`;
    if (vice.lastStop) {
      const ls = vice.lastStop;
      s += `\nLast stop: ${ls.reason}${ls.checkpoint ? ` #${ls.checkpoint.id} ($${h4(ls.checkpoint.start)})` : ""}${ls.pc != null ? ` at $${h4(ls.pc)}` : ""}`;
    }
    const speed = await vice.resourceGet("Speed").catch(() => null);
    if (speed !== null) s += `\nSpeed: ${speed}%${speed > 100 ? " (warp)" : ""}`;
    return text(`${s}\n${await stateLine()}`);
  });
});

tool("vice_quit", "Quit the VICE emulator.", {}, async () => {
  if (!vice.connected) {
    try {
      await vice.ensure({ launch: false });
    } catch {
      return text("VICE is not running.");
    }
  }
  await vice.quit();
  vice.holdStopped = false;
  return text("VICE quit.");
});

tool(
  "vice_reset",
  "Reset the C64. Soft reset keeps RAM; hard reset is like a power cycle. Waits for the READY prompt by default.",
  { hard: z.boolean().optional(), wait_ms: z.number().int().optional().describe("How long to let it boot before returning the screen (default 2500)") },
  async ({ hard = false, wait_ms = 2500 }) =>
    withVice(async () => {
      await vice.reset(hard ? 1 : 0);
      vice.holdStopped = false;
      vice.lastStop = null;
      await runFor(wait_ms);
      return text(await screenText());
    })
);

tool(
  "vice_autostart",
  "Autostart a program or image (.prg, .d64, .t64, .crt, .tap, ...) the way VICE's 'smart attach' does: resets, loads and optionally runs it.",
  {
    path: z.string().describe("Absolute path to the file"),
    run: z.boolean().optional().describe("RUN after loading (default true)"),
    index: z.number().int().optional().describe("Directory entry of a disk image to load (0 = first)"),
    wait_ms: z.number().int().optional().describe("Let it run this long before returning the screen (default 4000)"),
  },
  async ({ path: file, run = true, index = 0, wait_ms = 4000 }) => {
    if (!fs.existsSync(file)) return fail(new Error(`file not found: ${file}`));
    return withVice(async () => {
      vice.holdStopped = false;
      await vice.autostart(path.resolve(file), run, index);
      await runFor(wait_ms);
      return text(await screenText());
    });
  }
);

tool(
  "vice_run_basic",
  "Tokenize a BASIC V2 program (with VICE's petcat) and autostart it. Write keywords in any case; control codes like {clr}, {down}, {red} work inside strings.",
  {
    source: z.string().describe('Program text, one numbered line per line, e.g. 10 PRINT "HELLO"\\n20 GOTO 10'),
    wait_ms: z.number().int().optional().describe("Let it run this long before returning the screen (default 4000)"),
  },
  async ({ source, wait_ms = 4000 }) => {
    if (!VICE_EXE) return fail(new Error("VICE not found, so petcat is unavailable: set VICE_EXE to the path of x64sc"));
    const petcat = path.join(path.dirname(VICE_EXE), process.platform === "win32" ? "petcat.exe" : "petcat");
    const src = path.join(TMP, "program.bas");
    const prg = path.join(TMP, "program.prg");
    // petcat reads lowercase ASCII as unshifted PETSCII (keywords, capitals on screen).
    fs.writeFileSync(src, source.replace(/\r/g, "").toLowerCase() + "\n", "latin1");
    try {
      fs.rmSync(prg, { force: true });
      await promisify(execFile)(petcat, ["-w2", "-o", prg, "--", src], { cwd: path.dirname(VICE_EXE) });
    } catch (e) {
      return fail(new Error(`petcat failed: ${e.stderr || e.message}`));
    }
    if (!fs.existsSync(prg)) return fail(new Error("petcat produced no output"));
    const size = fs.statSync(prg).size;
    return withVice(async () => {
      await autostartBuilt(prg, null, 0, wait_ms);
      return text(`Tokenized to ${size} bytes (${prg}).\n${await screenText()}`);
    });
  }
);

tool(
  "vice_load_prg",
  "Inject a PRG straight into memory without resetting (fast edit-run loop). Loads at the PRG's own load address. For BASIC programs at $0801 the BASIC pointers are fixed up. Optionally types RUN or SYS <load address> (needs the READY prompt).",
  {
    path: z.string().optional().describe("Path to a .prg file (first two bytes = load address)"),
    hex: z.string().optional().describe("Or PRG bytes as hex, including the 2-byte load address"),
    run: z.enum(["none", "run", "sys"]).optional().describe("What to type afterwards (default none)"),
    wait_ms: z.number().int().optional().describe("If running, let it run this long before returning the screen (default 1500)"),
  },
  async ({ path: file, hex, run = "none", wait_ms = 1500 }) => {
    const data = await readPrgInput({ path: file, hex });
    if (data.length < 3) return fail(new Error("PRG too short"));
    const load = data.readUInt16LE(0);
    const body = data.subarray(2);
    const end = load + body.length;
    if (end > 0x10000) return fail(new Error("PRG runs past $FFFF"));
    return withVice(async () => {
      await vice.writeMemory(load, body, "ram");
      let note = "";
      if (load === 0x0801) {
        const p = Buffer.from([end & 0xff, end >> 8]);
        await vice.writeMemory(0x2d, Buffer.concat([p, p, p]), "ram");
        note = " (BASIC pointers set)";
      }
      let out = `Loaded ${body.length} bytes at $${h4(load)}-$${h4(end - 1)}${note}.`;
      if (run !== "none") {
        await vice.keyboardFeed(textToPetscii(run === "run" ? "RUN\n" : `SYS ${load}\n`));
        await runFor(wait_ms);
        out += `\n${await screenText()}`;
      }
      return text(out);
    });
  }
);

tool(
  "vice_assemble",
  "Assemble 6502 source and load it into the C64. Two-pass assembler: labels, @local labels (scoped to the previous global label), NAME = expr, * = $addr, #<x / #>x lo/hi, expressions (+ - * / & | ^ << >>), directives .byte .word .text (PETSCII) .scr (screen codes) .fill .align .bits (\"..##..\" bitmaps, great for sprites) .basic (BASIC SYS stub). Labels become usable as addresses in the other tools.",
  {
    source: z.string().optional().describe("Assembly source text"),
    path: z.string().optional().describe("Or a path to a .asm/.s file"),
    out_prg: z.string().optional().describe("Also save the result as a .prg at this path"),
    load: z.enum(["autostart", "inject", "none"]).optional().describe("autostart = reset + load + RUN (default when the program starts with a .basic stub); inject = write into RAM without reset (default otherwise); none = only assemble"),
    jump: z.boolean().optional().describe("After inject, set PC to the entry point (.basic target, else label 'start', else first byte)"),
    listing: z.boolean().optional().describe("Include the full listing in the result"),
    wait_ms: z.number().int().optional().describe("Once the program is running, let it run this long before returning (default 500)"),
  },
  async ({ source, path: file, out_prg, load, jump = false, listing = false, wait_ms = 500 }) => {
    const src = source ?? (file ? fs.readFileSync(file, "utf8") : null);
    if (src === null) return fail(new Error("give source or path"));
    let res;
    try {
      res = assemble(src, file ? { baseDir: path.dirname(path.resolve(file)), fileName: path.basename(file) } : {});
    } catch (e) {
      return fail(new Error(`assembly failed: ${e.message}`));
    }
    setSymbols(res.symbols);
    const prg = Buffer.concat([Buffer.from([res.start & 0xff, res.start >> 8]), res.bytes]);
    const prgPath = out_prg ? path.resolve(out_prg) : path.join(TMP, "assembled.prg");
    fs.writeFileSync(prgPath, prg);
    load ??= res.hasBasicStub ? "autostart" : "inject";
    let out = `Assembled $${h4(res.start)}-$${h4(res.end)} (${res.bytes.length} bytes), entry $${h4(res.entry)}, ${Object.keys(res.symbols).length} symbols. Saved ${prgPath}.`;
    if (listing) out += "\n" + res.listing.map((l) => `${h4(l.addr)}  ${l.bytes.slice(0, 8).map(h2).join(" ").padEnd(24)} ${l.text}`).join("\n");
    if (load === "none") return text(out);
    return withVice(async () => {
      if (load === "autostart") {
        const took = await autostartBuilt(prgPath, [res.start, res.end]);
        if (took < 0) return text(`${out}\nAutostarted, but the CPU never reached the program within 15 s.\n${await stateLine()}`);
        await runFor(wait_ms);
        return text(`${out}\nAutostarted; program running after ${took} ms.\n${await stateLine()}`);
      }
      await vice.writeMemory(res.start, res.bytes, "ram");
      out += "\nInjected into RAM.";
      if (jump) {
        await vice.setRegisters({ PC: res.entry });
        await runFor(wait_ms);
        out += `\nJumped to $${h4(res.entry)}.\n${await stateLine()}`;
      }
      return text(out);
    });
  }
);

tool(
  "vice_symbols",
  "List or look up symbols (labels and constants) from the last vice_assemble.",
  { filter: z.string().optional().describe("Substring to match (case-insensitive)") },
  async ({ filter }) => {
    const rows = Object.entries(symbols)
      .filter(([n]) => !filter || n.toLowerCase().includes(filter.toLowerCase()))
      .sort((a, b) => a[1] - b[1])
      .map(([n, v]) => `$${h4(v & 0xffff)}  ${n}`);
    return text(rows.length ? rows.join("\n") : "No symbols (assemble something with vice_assemble first).");
  }
);

tool(
  "vice_screen_text",
  "Read the C64 text screen (40x25) as plain text, decoded from screen RAM wherever the VIC-II is currently pointing. Cheap and exact for text screens; use vice_screenshot for graphics.",
  { mark_reverse: z.boolean().optional().describe("Show reverse-video spaces (like the cursor) as █") },
  async ({ mark_reverse = false }) => withVice(async () => text(await screenText({ reverse: mark_reverse })))
);

tool(
  "vice_screenshot",
  "Capture the emulator display as a PNG image.",
  {
    scale: z.number().int().min(1).max(4).optional().describe("Pixel scale factor (default 2)"),
    border: z.number().int().min(0).max(64).optional().describe("Pixels of border to keep around the 320x200 area (default 16)"),
  },
  async ({ scale = 2, border = 16 }) => withVice(async () => ({ content: [await screenshotContent(scale, border)] }))
);

async function screenshotContent(scale = 2, border = 16) {
  const d = await vice.display();
  const pal = await vice.palette();
  const x = Math.max(0, d.offsetX - border);
  const y = Math.max(0, d.offsetY - border);
  const w = Math.min(d.width - x, d.innerWidth + 2 * border);
  const h = Math.min(d.height - y, d.innerHeight + 2 * border);
  const png = indexedToPng(d.pixels, d.width, pal, { x, y, w, h, scale });
  return { type: "image", data: png.toString("base64"), mimeType: "image/png" };
}

/** Read labelled values for a play-test report, e.g. ["score:3", "lives"]. */
async function watchReport(watch) {
  const out = [];
  for (const w of watch) {
    const [expr, n = "1"] = w.split(":");
    const a = parseAddr(expr);
    const bytes = await vice.readMemory(a, Math.max(1, Math.min(16, Number(n))));
    out.push(`${expr}=${[...bytes].map(h2).join(" ")}`);
  }
  return out.join("  ");
}

tool(
  "vice_type",
  "Type text into the C64 through the KERNAL keyboard buffer (works for BASIC and programs using GETIN; games that scan the keyboard matrix directly won't see it). Newline = RETURN. Use {RETURN}, {CLR}, {HOME}, {UP}/{DOWN}/{LEFT}/{RIGHT}, {DEL}, {F1}-{F8}, {STOP}, {$xx} for raw PETSCII, and {DOWN*5} to repeat.",
  {
    text: z.string(),
    shift_uppercase: z.boolean().optional().describe("Send A-Z as SHIFTed letters (default false: all letters typed unshifted, which is normal in uppercase mode)"),
    wait_ms: z.number().int().optional().describe("Let it run this long, then return the screen (default 800; 0 = don't read the screen)"),
  },
  async ({ text: t, shift_uppercase = false, wait_ms = 800 }) =>
    withVice(async () => {
      const bytes = textToPetscii(t, { shiftUppercase: shift_uppercase });
      await vice.keyboardFeed(bytes);
      if (!wait_ms) return text(`Queued ${bytes.length} keys.`);
      await runFor(wait_ms + Math.floor(bytes.length * 20));
      return text(await screenText());
    })
);

tool(
  "vice_joystick",
  "Press joystick directions/fire for a while, then release. Most games use port 2.",
  {
    port: z.number().int().min(1).max(2).optional().describe("Control port 1 or 2 (default 2)"),
    directions: z.array(z.enum(["up", "down", "left", "right"])).optional(),
    fire: z.boolean().optional(),
    hold_ms: z.number().int().optional().describe("How long to hold (default 200). 0 = hold until the next vice_joystick call."),
  },
  async ({ port = 2, directions = [], fire = false, hold_ms = 200 }) =>
    withVice(async () => {
      const bits = { up: 1, down: 2, left: 4, right: 8 };
      const value = directions.reduce((v, d) => v | bits[d], 0) | (fire ? 16 : 0);
      if (value) {
        await pressJoystick(port, value);
        if (hold_ms > 0) {
          await runFor(hold_ms);
          await releaseJoystick(port);
        }
      } else await releaseJoystick(port);
      if (!value) return text(`Port ${port}: released.`);
      return text(`Port ${port}: ${[...directions, fire ? "fire" : ""].filter(Boolean).join("+")}${hold_ms > 0 ? ` for ${hold_ms} ms` : " (held until the next vice_joystick call)"}.`);
    })
);

tool(
  "vice_input_sequence",
  "Play-test a game: run a script of joystick steps in one call. Each step holds the given input for ms milliseconds (no directions/fire = hands off). Optionally screenshot and/or read memory (labels from vice_assemble work) after chosen steps.",
  {
    port: z.number().int().min(1).max(2).optional().describe("Default 2"),
    steps: z
      .array(
        z.object({
          directions: z.array(z.enum(["up", "down", "left", "right"])).optional(),
          fire: z.boolean().optional(),
          keys: z.array(z.string()).optional().describe('C64 keys held during this step (real keyboard matrix, like vice_keys), e.g. ["O", "SPACE"]'),
          ms: z.number().int().min(0).describe("How long to hold this input"),
          screenshot: z.boolean().optional().describe("Screenshot at the end of this step"),
          watch: z.array(z.string()).optional().describe('Memory to read at the end of this step: "label" or "label:count", e.g. ["score:3", "lives"]'),
        })
      )
      .min(1)
      .max(100),
    scale: z.number().int().min(1).max(4).optional().describe("Screenshot scale (default 1 to keep sequences light)"),
  },
  async ({ port = 2, steps, scale = 1 }) =>
    withVice(async () => {
      const bits = { up: 1, down: 2, left: 4, right: 8 };
      const content = [];
      const log = [];
      if (steps.some((s) => s.keys?.length)) hostKeys.reset(); // re-find the VICE window
      try {
        for (const [i, s] of steps.entries()) {
          const value = (s.directions ?? []).reduce((v, d) => v | bits[d], 0) | (s.fire ? 16 : 0);
          if (value) await pressJoystick(port, value);
          else await releaseJoystick(port);
          await hostKeys.hold(s.keys ?? []);
          await runFor(s.ms);
          const label = [...(s.directions ?? []), s.fire ? "fire" : "", ...(s.keys ?? []).map((k) => `key ${k}`)].filter(Boolean).join("+") || "idle";
          let line = `step ${i + 1}: ${label} ${s.ms}ms`;
          if (s.watch?.length) line += `  ${await watchReport(s.watch)}`;
          if (vice.holdStopped) line += "  (CPU stopped: breakpoint/JAM)";
          log.push(line);
          if (s.screenshot) {
            content.push({ type: "text", text: log.splice(0).join("\n") });
            content.push(await screenshotContent(scale, 16));
          }
          if (vice.holdStopped) break;
        }
      } finally {
        await releaseJoystick(port);
        await hostKeys.releaseAll();
      }
      if (log.length) content.push({ type: "text", text: log.join("\n") });
      return { content };
    })
);

tool(
  "vice_keys",
  `Press real C64 keys (Windows): key events go to the VICE window without taking focus, and VICE maps them onto the C64 keyboard matrix, so games that scan the keyboard directly see them (unlike vice_type). Either hold a chord of keys, or tap a text one key at a time. Key names: ${KEY_NAMES.join(", ")}.`,
  {
    keys: z.array(z.string()).optional().describe('Keys to hold together, e.g. ["LSHIFT", "CRSR_DOWN"] or ["SPACE"]'),
    hold_ms: z.number().int().min(0).optional().describe("How long to hold the chord (default 150)"),
    tap: z.string().optional().describe('Or tap these characters in order (letters, digits, space, "\\n" for RETURN)'),
    wait_ms: z.number().int().optional().describe("Run this long afterwards, then return the screen text (default 0 = don't)"),
  },
  async ({ keys, hold_ms = 150, tap, wait_ms = 0 }) =>
    withVice(async () => {
      hostKeys.reset();
      try {
        if (keys?.length) {
          await hostKeys.hold(keys);
          await runFor(hold_ms);
          await hostKeys.releaseAll();
        }
        for (const ch of tap ?? "") {
          await hostKeys.hold([ch]);
          await runFor(60);
          await hostKeys.releaseAll();
          await runFor(40);
        }
      } finally {
        await hostKeys.releaseAll();
      }
      const did = [keys?.length ? `held ${keys.join("+")} for ${hold_ms} ms` : "", tap ? `tapped ${JSON.stringify(tap)}` : ""].filter(Boolean).join(", ");
      if (!wait_ms) return text(`Keys: ${did || "nothing to do"}.`);
      await runFor(wait_ms);
      return text(`Keys: ${did}.\n${await screenText()}`);
    })
);

tool(
  "vice_wait",
  "Let the emulator run for a while, then optionally return the screen text.",
  { ms: z.number().int().describe("Milliseconds to run"), screen: z.boolean().optional().describe("Return the screen text afterwards (default true)") },
  async ({ ms, screen = true }) =>
    withVice(async () => {
      await runFor(ms);
      return text(screen ? await screenText() : `Ran for ${ms} ms.`);
    })
);

tool(
  "vice_wait_for_text",
  "Run until the given text appears on the text screen (case-insensitive), or time out.",
  { text: z.string(), timeout_ms: z.number().int().optional().describe("Default 10000") },
  async ({ text: needle, timeout_ms = 10000 }) =>
    withVice(async () => {
      const deadline = Date.now() + timeout_ms;
      const want = needle.toLowerCase();
      for (;;) {
        const s = await readScreen();
        if (s.text.toLowerCase().includes(want)) return text(`Found "${needle}".\n${s.header}\n${s.text}`);
        if (Date.now() >= deadline) return text(`Timed out after ${timeout_ms} ms without seeing "${needle}".\n${s.header}\n${s.text}`);
        await runFor(250);
      }
    })
);

tool(
  "vice_memory_read",
  "Read C64 memory as a hex dump, raw hex, disassembly or decoded screen codes.",
  {
    address: Addr,
    length: z.number().int().min(1).max(65536).optional().describe("Bytes to read (default 256)"),
    format: z.enum(["dump", "hex", "disasm", "screencodes"]).optional().describe("Default dump"),
    bank: z.enum(["cpu", "ram", "rom", "io"]).optional().describe("cpu = what the CPU sees now (default); ram = underlying RAM"),
  },
  async ({ address, length = 256, format = "dump", bank = "cpu" }) =>
    withVice(async () => {
      const a = parseAddr(address);
      const n = Math.min(length, 0x10000 - a);
      const bytes = await vice.readMemory(a, n + (format === "disasm" ? 2 : 0), bank);
      if (format === "hex") return text(bytes.toString("hex").toUpperCase());
      if (format === "disasm") return text(disassemble(bytes, a).lines.filter((l) => parseInt(l.slice(0, 4), 16) - a < n).join("\n"));
      if (format === "screencodes") return text(screenToText(bytes, 40, Math.ceil(n / 40), false));
      return text(hexDump(bytes, a));
    })
);

tool(
  "vice_memory_write",
  "Write bytes into C64 memory (POKE). Use bank 'ram' to write under ROM/IO.",
  {
    address: Addr,
    hex: z.string().optional().describe("Bytes as hex, e.g. 'A9 01 8D 20 D0'"),
    bytes: z.array(z.number().int().min(0).max(255)).optional(),
    bank: z.enum(["cpu", "ram", "rom", "io"]).optional(),
  },
  async ({ address, hex, bytes, bank = "cpu" }) =>
    withVice(async () => {
      const a = parseAddr(address);
      const data = hex ? parseHex(hex) : Buffer.from(bytes ?? []);
      if (!data.length) throw new Error("nothing to write: give hex or bytes");
      await vice.writeMemory(a, data, bank);
      return text(`Wrote ${data.length} bytes at $${h4(a)}.`);
    })
);

tool(
  "vice_disassemble",
  "Disassemble 6502 code. Defaults to the current PC.",
  { address: Addr.optional(), lines: z.number().int().min(1).max(200).optional().describe("Default 20") },
  async ({ address, lines = 20 }) =>
    withVice(async () => {
      const a = address !== undefined ? parseAddr(address) : (await vice.getRegisters()).PC;
      const bytes = await vice.readMemory(a, Math.min(lines * 3, 0x10000 - a));
      return text(annotate(disassemble(bytes, a, lines).lines));
    })
);

tool(
  "vice_registers",
  "Get CPU registers, or set some (e.g. {\"PC\": \"$C000\", \"A\": 0}).",
  { set: z.record(z.string(), z.union([z.number(), z.string()])).optional() },
  async ({ set }) =>
    withVice(async () => {
      if (set) {
        const vals = {};
        for (const [k, v] of Object.entries(set)) vals[k] = parseAddr(v);
        await vice.setRegisters(vals);
      }
      const regs = await vice.getRegisters();
      return text(`${await stateLine()}\n${Object.entries(regs).map(([k, v]) => `${k}=${v}`).join(" ")}`);
    })
);

tool("vice_pause", "Stop the emulated CPU and keep it stopped (for debugging) until vice_resume.", {}, async () =>
  withVice(async () => {
    vice.holdStopped = true;
    vice.lastStop = { reason: "pause", pc: null, at: Date.now() };
    return text(`Paused.\n${await stateLine()}`);
  })
);

tool("vice_resume", "Resume emulation after a pause, step or breakpoint.", {}, async () =>
  withVice(async () => {
    vice.holdStopped = false;
    return text("Resumed.");
  })
);

tool(
  "vice_step",
  "Execute instructions one at a time and stay stopped. 'over' treats JSR as one step; 'out' runs until the current subroutine returns.",
  {
    count: z.number().int().min(1).max(65535).optional().describe("Default 1"),
    mode: z.enum(["into", "over", "out"]).optional().describe("Default into"),
  },
  async ({ count = 1, mode = "into" }) =>
    withVice(async () => {
      vice.holdStopped = true;
      if (mode === "out") await vice.executeUntilReturn();
      else await vice.advance(count, mode === "over");
      return text(await stateLine());
    })
);

tool(
  "vice_breakpoint_set",
  "Set a breakpoint (exec) or watchpoint (load/store) on an address or range. When hit, the CPU stops and stays stopped; use vice_wait_for_breakpoint to wait for it.",
  {
    address: Addr,
    end: Addr.optional().describe("End of range (inclusive); defaults to address"),
    on: z.array(z.enum(["exec", "load", "store"])).optional().describe("Default [exec]"),
    condition: z.string().optional().describe('VICE monitor condition, e.g. "A == $05" or "X > $10"'),
    temporary: z.boolean().optional().describe("Delete after first hit"),
    stop: z.boolean().optional().describe("Stop when hit (default true); false = just count hits (tracepoint)"),
  },
  async ({ address, end, on = ["exec"], condition, temporary = false, stop = true }) =>
    withVice(async () => {
      const op = on.reduce((v, k) => v | { load: 1, store: 2, exec: 4 }[k], 0);
      const cp = await vice.checkpointSet({ start: parseAddr(address), end: end !== undefined ? parseAddr(end) : undefined, op, temporary, stop });
      if (condition) await vice.checkpointCondition(cp.id, condition);
      return text(`Breakpoint #${cp.id} on ${on.join("/")} $${h4(cp.start)}${cp.end !== cp.start ? `-$${h4(cp.end)}` : ""}${condition ? ` if ${condition}` : ""}.`);
    })
);

tool("vice_breakpoint_list", "List breakpoints and watchpoints with hit counts.", {}, async () =>
  withVice(async () => {
    const list = await vice.checkpointList();
    if (!list.length) return text("No breakpoints.");
    const ops = (o) => ["load", "store", "exec"].filter((_, i) => o & (1 << i)).join("/");
    return text(
      list
        .map((c) => `#${c.id} ${ops(c.op)} $${h4(c.start)}${c.end !== c.start ? `-$${h4(c.end)}` : ""} ${c.enabled ? "enabled" : "disabled"} hits=${c.hitCount}${c.hasCondition ? " (conditional)" : ""}${c.temporary ? " (temporary)" : ""}${c.stop ? "" : " (trace only)"}`)
        .join("\n")
    );
  })
);

tool(
  "vice_breakpoint_delete",
  "Delete a breakpoint by id, or all of them.",
  { id: z.number().int().optional(), all: z.boolean().optional() },
  async ({ id, all }) =>
    withVice(async () => {
      const ids = all ? (await vice.checkpointList()).map((c) => c.id) : id !== undefined ? [id] : [];
      if (!ids.length) throw new Error("give id or all: true");
      for (const i of ids) await vice.checkpointDelete(i);
      return text(`Deleted ${ids.map((i) => `#${i}`).join(", ")}.`);
    })
);

tool(
  "vice_wait_for_breakpoint",
  "Resume (if needed) and wait until a breakpoint/watchpoint is hit or the CPU jams.",
  { timeout_ms: z.number().int().optional().describe("Default 10000") },
  async ({ timeout_ms = 10000 }) =>
    withVice(async () => {
      vice.holdStopped = false;
      const since = Date.now();
      const hit = vice.waitForStop(timeout_ms);
      await vice.exit();
      const ok = await hit;
      if (!ok || !vice.lastStop || vice.lastStop.at < since) {
        await vice.ping();
        return text(`No breakpoint hit within ${timeout_ms} ms (still running).`);
      }
      await vice.ping(); // make sure we're in the monitor and registers are current
      const ls = vice.lastStop;
      const what = ls.reason === "jam" ? "CPU JAM" : `Breakpoint #${ls.checkpoint.id} hit`;
      return text(`${what}. CPU held stopped.\n${await stateLine()}`);
    })
);

tool(
  "vice_warp",
  "Turn warp on (run as fast as the host allows) or off (back to 100% real time). Waits in other tools are wall-clock, so more C64 time passes per ms in warp.",
  { on: z.boolean(), percent: z.number().int().min(1).optional().describe(`Custom speed limit in percent (default ${WARP_SPEED} when on)`) },
  async ({ on, percent }) =>
    withVice(async () => {
      const speed = on ? (percent ?? WARP_SPEED) : 100;
      await setWarp(on, speed);
      return text(`Speed ${speed}%${on ? " (warp)" : ""}.`);
    })
);

tool(
  "vice_snapshot",
  "Save or load a full machine snapshot (.vsf).",
  {
    action: z.enum(["save", "load"]),
    path: z.string().describe("Snapshot file path"),
    include_disks: z.boolean().optional().describe("On save, include attached disk images"),
  },
  async ({ action, path: file, include_disks = false }) =>
    withVice(async () => {
      const abs = path.resolve(file);
      if (action === "save") {
        await vice.dump(abs, false, include_disks);
        return text(`Saved snapshot to ${abs}.`);
      }
      const pc = await vice.undump(abs);
      return text(`Loaded snapshot ${abs}; PC=$${h4(pc)}.`);
    })
);

tool(
  "vice_resource",
  "Get or set a VICE resource (setting), e.g. SidModel, VICIIBorderMode, Drive8Type, Speed, JoyPort2Device.",
  { name: z.string(), value: z.union([z.number(), z.string()]).optional().describe("Omit to read") },
  async ({ name, value }) =>
    withVice(async () => {
      if (value !== undefined) await vice.resourceSet(name, value);
      return text(`${name} = ${JSON.stringify(await vice.resourceGet(name))}`);
    })
);

await server.connect(new StdioServerTransport());
