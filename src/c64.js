// C64-specific helpers: screen codes, PETSCII, 6502 disassembly, PNG encoding.
import zlib from "node:zlib";

// ---------- screen codes -> text ----------

const UPPER_GFX = "─♠│─────│╭╮╯│╲╱╰╮●─♥│╭╳○♣│♦┼▒│π◥";
const BLOCKS = " ▌▄▔▁▎▒▕▄◤▕├▗└┐▂┌┴┬┤▎▍▕▔▀▃✓▖▝┘▘▚";

/** Convert one screen code (0-255) to a printable character. */
export function screenCodeToChar(code, lowercase) {
  const c = code & 0x7f;
  if (c === 0) return "@";
  if (c <= 26) return String.fromCharCode((lowercase ? 96 : 64) + c);
  if (c === 27) return "[";
  if (c === 28) return "£";
  if (c === 29) return "]";
  if (c === 30) return "↑";
  if (c === 31) return "←";
  if (c < 64) return String.fromCharCode(c);
  if (c < 96) {
    if (lowercase && c >= 65 && c <= 90) return String.fromCharCode(c);
    return UPPER_GFX[c - 64] ?? "▒";
  }
  return BLOCKS[c - 96] ?? "▒";
}

export function screenToText(bytes, cols, rows, lowercase, { markReverse = false } = {}) {
  const lines = [];
  for (let r = 0; r < rows; r++) {
    let line = "";
    for (let c = 0; c < cols; c++) {
      const b = bytes[r * cols + c];
      let ch = screenCodeToChar(b, lowercase);
      if (markReverse && b >= 128 && ch === " ") ch = "█";
      line += ch;
    }
    lines.push(line.replace(/\s+$/, ""));
  }
  return lines.join("\n");
}

// ---------- text -> PETSCII for the keyboard buffer ----------

export const PETSCII_CODES = {
  RETURN: 0x0d, CR: 0x0d, ENTER: 0x0d,
  CLR: 0x93, CLEAR: 0x93, HOME: 0x13,
  DOWN: 0x11, UP: 0x91, LEFT: 0x9d, RIGHT: 0x1d,
  DEL: 0x14, INST: 0x94, INS: 0x94,
  SPACE: 0x20, STOP: 0x03, RUNSTOP: 0x03,
  F1: 0x85, F3: 0x86, F5: 0x87, F7: 0x88, F2: 0x89, F4: 0x8a, F6: 0x8b, F8: 0x8c,
  RVSON: 0x12, RVSOFF: 0x92,
  BLK: 0x90, WHT: 0x05, RED: 0x1c, CYN: 0x9f, PUR: 0x9c, GRN: 0x1e, BLU: 0x1f, YEL: 0x9e,
  ORANGE: 0x81, BROWN: 0x95, LRED: 0x96, GRAY1: 0x97, GRAY2: 0x98, LGRN: 0x99, LBLU: 0x9a, GRAY3: 0x9b,
  LOWER: 0x0e, UPPER: 0x8e, PI: 0xff, POUND: 0x5c,
};

/**
 * Convert text to PETSCII bytes. Newlines become RETURN. {NAME} inserts a
 * control code from PETSCII_CODES, {$xx} a raw byte. Letters are sent
 * unshifted (what you get typing on a C64 in its default uppercase mode)
 * unless shiftUppercase is set, in which case A-Z become shifted letters.
 */
export function textToPetscii(text, { shiftUppercase = false } = {}) {
  const out = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{") {
      const end = text.indexOf("}", i);
      if (end > i) {
        const name = text.slice(i + 1, end).trim().toUpperCase();
        let m;
        if ((m = /^\$([0-9A-F]{1,2})$/.exec(name))) {
          out.push(parseInt(m[1], 16));
          i = end;
          continue;
        }
        const rep = /^(.*?)\s*\*\s*(\d+)$/.exec(name);
        const key = rep ? rep[1] : name;
        if (key in PETSCII_CODES) {
          for (let k = 0; k < (rep ? +rep[2] : 1); k++) out.push(PETSCII_CODES[key]);
          i = end;
          continue;
        }
      }
    }
    if (ch === "\r") continue;
    if (ch === "\n") out.push(0x0d);
    else if (ch >= "a" && ch <= "z") out.push(ch.charCodeAt(0) - 32);
    else if (ch >= "A" && ch <= "Z") out.push(ch.charCodeAt(0) + (shiftUppercase ? 128 : 0));
    else if (ch === "£") out.push(0x5c);
    else if (ch === "↑" || ch === "^") out.push(0x5e);
    else if (ch === "←" || ch === "_") out.push(0x5f);
    else if (ch === "π") out.push(0xff);
    else {
      const c = ch.charCodeAt(0);
      if (c >= 0x20 && c < 0x60) out.push(c);
    }
  }
  return Buffer.from(out);
}

// ---------- 6502 disassembler ----------

export const OPS = {};
`00 BRK imp|01 ORA izx|05 ORA zp|06 ASL zp|08 PHP imp|09 ORA imm|0A ASL acc|0D ORA abs|0E ASL abs|
10 BPL rel|11 ORA izy|15 ORA zpx|16 ASL zpx|18 CLC imp|19 ORA aby|1D ORA abx|1E ASL abx|
20 JSR abs|21 AND izx|24 BIT zp|25 AND zp|26 ROL zp|28 PLP imp|29 AND imm|2A ROL acc|2C BIT abs|2D AND abs|2E ROL abs|
30 BMI rel|31 AND izy|35 AND zpx|36 ROL zpx|38 SEC imp|39 AND aby|3D AND abx|3E ROL abx|
40 RTI imp|41 EOR izx|45 EOR zp|46 LSR zp|48 PHA imp|49 EOR imm|4A LSR acc|4C JMP abs|4D EOR abs|4E LSR abs|
50 BVC rel|51 EOR izy|55 EOR zpx|56 LSR zpx|58 CLI imp|59 EOR aby|5D EOR abx|5E LSR abx|
60 RTS imp|61 ADC izx|65 ADC zp|66 ROR zp|68 PLA imp|69 ADC imm|6A ROR acc|6C JMP ind|6D ADC abs|6E ROR abs|
70 BVS rel|71 ADC izy|75 ADC zpx|76 ROR zpx|78 SEI imp|79 ADC aby|7D ADC abx|7E ROR abx|
81 STA izx|84 STY zp|85 STA zp|86 STX zp|88 DEY imp|8A TXA imp|8C STY abs|8D STA abs|8E STX abs|
90 BCC rel|91 STA izy|94 STY zpx|95 STA zpx|96 STX zpy|98 TYA imp|99 STA aby|9A TXS imp|9D STA abx|
A0 LDY imm|A1 LDA izx|A2 LDX imm|A4 LDY zp|A5 LDA zp|A6 LDX zp|A8 TAY imp|A9 LDA imm|AA TAX imp|AC LDY abs|AD LDA abs|AE LDX abs|
B0 BCS rel|B1 LDA izy|B4 LDY zpx|B5 LDA zpx|B6 LDX zpy|B8 CLV imp|B9 LDA aby|BA TSX imp|BC LDY abx|BD LDA abx|BE LDX aby|
C0 CPY imm|C1 CMP izx|C4 CPY zp|C5 CMP zp|C6 DEC zp|C8 INY imp|C9 CMP imm|CA DEX imp|CC CPY abs|CD CMP abs|CE DEC abs|
D0 BNE rel|D1 CMP izy|D5 CMP zpx|D6 DEC zpx|D8 CLD imp|D9 CMP aby|DD CMP abx|DE DEC abx|
E0 CPX imm|E1 SBC izx|E4 CPX zp|E5 SBC zp|E6 INC zp|E8 INX imp|E9 SBC imm|EA NOP imp|EC CPX abs|ED SBC abs|EE INC abs|
F0 BEQ rel|F1 SBC izy|F5 SBC zpx|F6 INC zpx|F8 SED imp|F9 SBC aby|FD SBC abx|FE INC abx`
  .split("|")
  .forEach((e) => {
    const [op, mn, mode] = e.trim().split(" ");
    OPS[parseInt(op, 16)] = [mn, mode];
  });

const SIZE = { imp: 1, acc: 1, imm: 2, zp: 2, zpx: 2, zpy: 2, izx: 2, izy: 2, rel: 2, abs: 3, abx: 3, aby: 3, ind: 3 };
const h2 = (n) => n.toString(16).toUpperCase().padStart(2, "0");
const h4 = (n) => n.toString(16).toUpperCase().padStart(4, "0");

/** Disassemble `bytes` located at `addr`. Returns lines like "C000  A9 01     LDA #$01". */
export function disassemble(bytes, addr, maxLines = Infinity) {
  const lines = [];
  let i = 0;
  while (i < bytes.length && lines.length < maxLines) {
    const pc = (addr + i) & 0xffff;
    const op = bytes[i];
    const def = OPS[op];
    const size = def ? SIZE[def[1]] : 1;
    if (i + size > bytes.length) break;
    const raw = [...bytes.subarray(i, i + size)].map(h2).join(" ");
    let text;
    if (!def) text = `.BYTE $${h2(op)}`;
    else {
      const [mn, mode] = def;
      const b1 = bytes[i + 1];
      const w = bytes[i + 1] | (bytes[i + 2] << 8);
      const arg = {
        imp: "",
        acc: "A",
        imm: `#$${h2(b1)}`,
        zp: `$${h2(b1)}`,
        zpx: `$${h2(b1)},X`,
        zpy: `$${h2(b1)},Y`,
        izx: `($${h2(b1)},X)`,
        izy: `($${h2(b1)}),Y`,
        rel: `$${h4((pc + 2 + ((b1 << 24) >> 24)) & 0xffff)}`,
        abs: `$${h4(w)}`,
        abx: `$${h4(w)},X`,
        aby: `$${h4(w)},Y`,
        ind: `($${h4(w)})`,
      }[mode];
      text = arg ? `${mn} ${arg}` : mn;
    }
    lines.push(`${h4(pc)}  ${raw.padEnd(9)} ${text}`);
    i += size;
  }
  return { lines, bytesUsed: i };
}

export function hexDump(bytes, addr) {
  const lines = [];
  for (let i = 0; i < bytes.length; i += 16) {
    const row = bytes.subarray(i, i + 16);
    const hex = [...row].map(h2).join(" ");
    const txt = [...row].map((b) => screenCodeToChar(b, false)).join("");
    lines.push(`${h4((addr + i) & 0xffff)}  ${hex.padEnd(47)}  ${txt}`);
  }
  return lines.join("\n");
}

export { h2, h4 };

// ---------- PNG ----------

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/** Encode an 8-bit indexed image (with an [r,g,b] palette) as an RGB PNG, cropped and scaled. */
export function indexedToPng(pixels, width, palette, { x = 0, y = 0, w, h, scale = 1 }) {
  const outW = w * scale;
  const outH = h * scale;
  const raw = Buffer.alloc((outW * 3 + 1) * outH);
  let o = 0;
  for (let row = 0; row < outH; row++) {
    raw[o++] = 0;
    const sy = y + Math.floor(row / scale);
    for (let col = 0; col < outW; col++) {
      const sx = x + Math.floor(col / scale);
      const rgb = palette[pixels[sy * width + sx]] ?? [255, 0, 255];
      raw[o++] = rgb[0];
      raw[o++] = rgb[1];
      raw[o++] = rgb[2];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(outW, 0);
  ihdr.writeUInt32BE(outH, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
