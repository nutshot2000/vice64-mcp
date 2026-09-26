// Two-pass 6502 assembler (documented opcodes) for C64 programs.
//
// Syntax:
//   label:            global label        @loop:  local label (scoped to the last global)
//   NAME = expr       constant            * = $0801 / .org $0801   set program counter
//   lda #<table, ldy #>table              < low byte, > high byte
//   expr operators: + - * / % & | ^ << >> ~, parentheses, * = current PC,
//   numbers: $ff, 0xff, %1010, 255, 'A'
// Directives:
//   .byte/.db, .word/.dw, .text "petscii {clr}", .scr "screen codes",
//   .fill count[,value], .align n[,value], .bits "..##..##" (8 chars per byte, # or X or 1 = set),
//   .basic entry      BASIC stub "10 SYS entry" (put at $0801)
//   .include "file"   insert another source file (path relative to the including file)
import fs from "node:fs";
import path from "node:path";
import { OPS, textToPetscii } from "./c64.js";

const OPCODES = {};
for (const [op, [mn, mode]] of Object.entries(OPS)) (OPCODES[mn] ??= {})[mode] = Number(op);
const SIZE = { imp: 1, acc: 1, imm: 2, zp: 2, zpx: 2, zpy: 2, izx: 2, izy: 2, rel: 2, abs: 3, abx: 3, aby: 3, ind: 3 };
const ZP_OF = { abs: "zp", abx: "zpx", aby: "zpy" };

export class AsmError extends Error {
  constructor(msg, line, text) {
    super(line ? `${line}: ${msg}\n    ${text?.trim() ?? ""}` : msg);
    this.line = line;
  }
}

// ---------- expressions ----------

function tokenize(s) {
  const toks = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) { i++; continue; }
    let m;
    const rest = s.slice(i);
    if ((m = /^\$[0-9a-f]+/i.exec(rest)) || (m = /^0x[0-9a-f]+/i.exec(rest))) {
      toks.push({ t: "num", v: parseInt(m[0].replace(/^\$|^0x/i, ""), 16) });
    } else if ((m = /^%[01]+/.exec(rest))) {
      toks.push({ t: "num", v: parseInt(m[0].slice(1), 2) });
    } else if ((m = /^\d+/.exec(rest))) {
      toks.push({ t: "num", v: parseInt(m[0], 10) });
    } else if ((m = /^'(.)'/.exec(rest))) {
      toks.push({ t: "num", v: m[1].charCodeAt(0) });
    } else if ((m = /^[A-Za-z_@.][\w.@]*/.exec(rest))) {
      toks.push({ t: "id", v: m[0] });
    } else if ((m = /^(<<|>>|[-+*/%&|^~<>()])/.exec(rest))) {
      toks.push({ t: "op", v: m[0] });
    } else throw new Error(`unexpected character '${c}' in expression`);
    i += m[0].length;
  }
  return toks;
}

const BINARY = [["|"], ["^"], ["&"], ["<<", ">>"], ["+", "-"], ["*", "/", "%"]];

/** Evaluate an expression. resolve(name) returns a number or undefined. Returns { value, known }. */
export function evaluate(expr, resolve, pc) {
  const toks = tokenize(expr);
  let pos = 0;
  let known = true;
  const peek = () => toks[pos];
  const isOp = (v) => peek()?.t === "op" && peek().v === v;

  function primary() {
    const t = toks[pos++];
    if (!t) throw new Error("unexpected end of expression");
    if (t.t === "num") return t.v;
    if (t.t === "id") {
      const v = resolve(t.v);
      if (v === undefined) {
        known = false;
        return 0;
      }
      return v;
    }
    if (t.v === "(") {
      const v = binary(0);
      if (!isOp(")")) throw new Error("missing )");
      pos++;
      return v;
    }
    if (t.v === "*") return pc;
    if (t.v === "-") return -primary();
    if (t.v === "~") return ~primary() & 0xffff;
    if (t.v === "<") return primary() & 0xff;
    if (t.v === ">") return (primary() >> 8) & 0xff;
    if (t.v === "+") return primary();
    throw new Error(`unexpected '${t.v}'`);
  }
  function binary(level) {
    if (level >= BINARY.length) return primary();
    let v = binary(level + 1);
    while (peek()?.t === "op" && BINARY[level].includes(peek().v)) {
      const op = toks[pos++].v;
      const r = binary(level + 1);
      v = { "|": v | r, "^": v ^ r, "&": v & r, "<<": v << r, ">>": v >> r, "+": v + r, "-": v - r, "*": v * r, "/": r ? Math.trunc(v / r) : 0, "%": r ? v % r : 0 }[op];
    }
    return v;
  }
  const value = binary(0);
  if (pos < toks.length) throw new Error(`unexpected '${toks[pos].v}' in expression`);
  return { value, known };
}

// ---------- helpers ----------

function splitArgs(s) {
  const out = [];
  let cur = "";
  let q = null;
  for (const c of s) {
    if (q) {
      cur += c;
      if (c === q) q = null;
    } else if (c === '"') {
      q = c;
      cur += c;
    } else if (c === ",") {
      out.push(cur.trim());
      cur = "";
    } else cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function stripComment(line) {
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') q = !q;
    else if (c === "'" && !q && line[i + 2] === "'") i += 2;
    else if (c === ";" && !q) return line.slice(0, i);
  }
  return line;
}

export function toScreenCodes(str) {
  const out = [];
  for (const ch of str) {
    const c = ch.toUpperCase().charCodeAt(0);
    if (c >= 64 && c <= 95) out.push(c - 64);
    else if (c >= 32 && c <= 63) out.push(c);
    else if (ch === "£") out.push(28);
    else out.push(32);
  }
  return out;
}

function unquote(arg) {
  const m = /^"(.*)"$/.exec(arg);
  return m ? m[1] : null;
}

// ---------- assembler ----------

/**
 * Assemble source. Returns { start, end, bytes (Buffer, start..end contiguous),
 * symbols {name: value}, listing [ {addr, bytes, line, text} ], entry }.
 */
export function assemble(source, { baseDir = process.cwd(), fileName = "source" } = {}) {
  // Expand .include first, remembering where each line came from for error messages.
  const lines = [];
  const origin = [];
  const expand = (src, dir, name, depth) => {
    if (depth > 16) throw new AsmError(".include nested too deeply");
    src.replace(/\r/g, "").split("\n").forEach((l, i) => {
      const m = /^\s*\.include\s+"([^"]+)"/i.exec(l);
      if (!m) {
        lines.push(l);
        origin.push(`${name}:${i + 1}`);
        return;
      }
      const p = path.resolve(dir, m[1]);
      let inc;
      try {
        inc = fs.readFileSync(p, "utf8");
      } catch {
        throw new AsmError(`${name}:${i + 1}: cannot read include file ${p}`);
      }
      expand(inc, path.dirname(p), path.basename(p), depth + 1);
    });
  };
  expand(source, baseDir, fileName, 0);
  const symbols = {};
  const modes = new Map(); // line index -> chosen addressing mode (fixed in pass 1)
  let mem, written, listing, pc, scope, basicEntry;

  const resolveIn = (strict) => (name) => {
    const key = name.startsWith("@") ? scope + name : name;
    if (key in symbols) return symbols[key];
    if (strict) throw new Error(`undefined symbol '${name}'`);
    return undefined;
  };

  for (const pass of [1, 2]) {
    mem = new Uint8Array(0x10000);
    written = new Uint8Array(0x10000);
    listing = [];
    pc = 0x0801;
    scope = "";
    const strict = pass === 2;
    const resolve = resolveIn(strict);
    const ev = (e) => evaluate(e, resolve, pc);

    for (let li = 0; li < lines.length; li++) {
      const raw = lines[li];
      let text = stripComment(raw).trim();
      const lineNo = origin[li];
      const emitted = [];
      const startPc = pc;
      const emit = (b) => {
        if (pc > 0xffff) throw new Error("program counter past $FFFF");
        if (pass === 2) {
          if (written[pc]) throw new Error(`overlapping output at $${pc.toString(16)}`);
          mem[pc] = b & 0xff;
          written[pc] = 1;
        }
        emitted.push(b & 0xff);
        pc++;
      };
      try {
        // labels
        let m;
        while ((m = /^([A-Za-z_@][\w.@]*)\s*:(?!=)/.exec(text))) {
          const name = m[1];
          if (!name.startsWith("@")) scope = name;
          const key = name.startsWith("@") ? scope + name : name;
          if (pass === 1 && key in symbols) throw new Error(`duplicate label '${name}'`);
          symbols[key] = pc;
          text = text.slice(m[0].length).trim();
        }
        if (!text) continue;
        // constants / org
        if ((m = /^\*\s*=\s*(.+)$/.exec(text))) {
          pc = ev(m[1]).value & 0xffff;
          continue;
        }
        if ((m = /^([A-Za-z_][\w.]*)\s*(?:=|\.equ\b|\.set\b)\s*(.+)$/i.exec(text))) {
          const r = ev(m[2]);
          if (r.known || pass === 2) symbols[m[1]] = r.value;
          continue;
        }
        // directives
        if ((m = /^\.(\w+)\s*(.*)$/.exec(text))) {
          const dir = m[1].toLowerCase();
          const args = splitArgs(m[2]);
          const val = (a) => ev(a).value;
          switch (dir) {
            case "org":
              pc = val(args[0]) & 0xffff;
              break;
            case "byte":
            case "db":
            case "by":
              for (const a of args) {
                const s = unquote(a);
                if (s !== null) for (const c of s) emit(c.charCodeAt(0));
                else {
                  const v = val(a);
                  if (strict && (v < -128 || v > 255)) throw new Error(`byte value out of range: ${v}`);
                  emit(v);
                }
              }
              break;
            case "word":
            case "dw":
              for (const a of args) {
                const v = val(a);
                emit(v);
                emit(v >> 8);
              }
              break;
            case "text":
            case "petscii":
              for (const a of args) {
                const s = unquote(a);
                if (s !== null) for (const b of textToPetscii(s)) emit(b);
                else emit(val(a));
              }
              break;
            case "scr":
              for (const a of args) {
                const s = unquote(a);
                if (s !== null) for (const b of toScreenCodes(s)) emit(b);
                else emit(val(a));
              }
              break;
            case "fill":
            case "res": {
              const n = val(args[0]);
              const v = args[1] !== undefined ? val(args[1]) : 0;
              for (let i = 0; i < n; i++) emit(v);
              break;
            }
            case "align": {
              const n = val(args[0]);
              const v = args[1] !== undefined ? val(args[1]) : 0;
              while (pc % n) emit(v);
              break;
            }
            case "bits": {
              const s = unquote(args[0]);
              if (s === null || s.length % 8) throw new Error(".bits needs a quoted string whose length is a multiple of 8");
              for (let i = 0; i < s.length; i += 8) {
                let b = 0;
                for (let k = 0; k < 8; k++) b = (b << 1) | (/[#X1*]/i.test(s[i + k]) ? 1 : 0);
                emit(b);
              }
              break;
            }
            case "basic": {
              const entry = val(args[0]);
              basicEntry = entry;
              const digits = String(entry).padStart(5, " ");
              const next = pc + 2 + 2 + 1 + digits.length + 1;
              emit(next);
              emit(next >> 8);
              emit(10);
              emit(0);
              emit(0x9e);
              for (const d of digits) emit(d.charCodeAt(0));
              emit(0);
              emit(0);
              emit(0);
              break;
            }
            default:
              throw new Error(`unknown directive .${dir}`);
          }
        } else {
          // instruction
          if (!(m = /^([A-Za-z]{3})\b\s*(.*)$/.exec(text))) throw new Error("syntax error");
          const mn = m[1].toUpperCase();
          const opnd = m[2].trim();
          const table = OPCODES[mn];
          if (!table) throw new Error(`unknown instruction ${mn}`);
          let mode, expr;
          if (!opnd) mode = table.imp !== undefined ? "imp" : "acc";
          else if (/^a$/i.test(opnd) && table.acc !== undefined) mode = "acc";
          else if (opnd.startsWith("#")) (mode = "imm"), (expr = opnd.slice(1));
          else if ((m = /^\((.*)\)\s*,\s*y$/i.exec(opnd))) (mode = "izy"), (expr = m[1]);
          else if ((m = /^\((.*),\s*x\s*\)$/i.exec(opnd))) (mode = "izx"), (expr = m[1]);
          else if (mn === "JMP" && (m = /^\((.*)\)$/.exec(opnd))) (mode = "ind"), (expr = m[1]);
          else if ((m = /^(.*),\s*x$/i.exec(opnd))) (mode = "abx"), (expr = m[1]);
          else if ((m = /^(.*),\s*y$/i.exec(opnd))) (mode = "aby"), (expr = m[1]);
          else (mode = table.rel !== undefined ? "rel" : "abs"), (expr = opnd);

          let value = 0;
          if (expr !== undefined) {
            const r = ev(expr);
            value = r.value;
            if (mode in ZP_OF) {
              if (pass === 1) {
                const zp = ZP_OF[mode];
                const useZp = r.known && value >= 0 && value < 256 && table[zp] !== undefined;
                if (useZp || table[mode] === undefined) mode = zp;
                modes.set(li, mode);
              } else mode = modes.get(li);
            }
          }
          const opcode = table[mode];
          if (opcode === undefined) throw new Error(`${mn} does not support ${mode} addressing`);
          emit(opcode);
          if (mode === "rel") {
            const off = value - (pc + 1);
            if (strict && (off < -128 || off > 127)) throw new Error(`branch out of range (${off} bytes)`);
            emit(off);
          } else if (SIZE[mode] === 2) {
            if (strict && mode !== "imm" && (value < 0 || value > 255)) throw new Error(`zero page address out of range: ${value}`);
            if (strict && mode === "imm" && (value < -128 || value > 255)) throw new Error(`immediate value out of range: ${value}`);
            emit(value);
          } else if (SIZE[mode] === 3) {
            emit(value);
            emit(value >> 8);
          }
        }
      } catch (e) {
        throw new AsmError(e.message, lineNo, raw);
      }
      if (pass === 2 && emitted.length) listing.push({ addr: startPc, bytes: emitted, line: lineNo, text: raw });
    }
  }

  let start = 0x10000;
  let end = -1;
  for (let a = 0; a < 0x10000; a++)
    if (written[a]) {
      if (a < start) start = a;
      end = a;
    }
  if (end < 0) throw new AsmError("no output");
  return {
    start,
    end,
    bytes: Buffer.from(mem.subarray(start, end + 1)),
    symbols,
    listing,
    entry: basicEntry ?? symbols.start ?? start,
    hasBasicStub: basicEntry !== undefined && start === 0x0801,
  };
}
