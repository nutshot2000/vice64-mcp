// Client for the VICE binary monitor protocol (VICE >= 3.5).
// Spec: https://vice-emu.sourceforge.io/vice_13.html
import net from "node:net";
import { spawn } from "node:child_process";
import path from "node:path";

export const CMD = {
  MEM_GET: 0x01,
  MEM_SET: 0x02,
  CHECKPOINT_GET: 0x11,
  CHECKPOINT_SET: 0x12,
  CHECKPOINT_DELETE: 0x13,
  CHECKPOINT_LIST: 0x14,
  CHECKPOINT_TOGGLE: 0x15,
  CONDITION_SET: 0x22,
  REGISTERS_GET: 0x31,
  REGISTERS_SET: 0x32,
  DUMP: 0x41,
  UNDUMP: 0x42,
  RESOURCE_GET: 0x51,
  RESOURCE_SET: 0x52,
  ADVANCE_INSTRUCTIONS: 0x71,
  KEYBOARD_FEED: 0x72,
  EXECUTE_UNTIL_RETURN: 0x73,
  PING: 0x81,
  BANKS_AVAILABLE: 0x82,
  REGISTERS_AVAILABLE: 0x83,
  DISPLAY_GET: 0x84,
  VICE_INFO: 0x85,
  PALETTE_GET: 0x91,
  JOYPORT_SET: 0xa2,
  USERPORT_SET: 0xb2,
  EXIT: 0xaa,
  QUIT: 0xbb,
  RESET: 0xcc,
  AUTOSTART: 0xdd,
};

const EVT = { CHECKPOINT: 0x11, REGISTERS: 0x31, JAM: 0x61, STOPPED: 0x62, RESUMED: 0x63 };
const EVENT_ID = 0xffffffff;
const STX = 0x02;
const API = 0x02;

const ERRORS = {
  0x01: "object does not exist",
  0x02: "invalid memspace",
  0x80: "invalid command length",
  0x81: "invalid parameter",
  0x82: "unsupported API version",
  0x83: "unknown command",
  0x8f: "general failure",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function parseCheckpoint(b) {
  return {
    id: b.readUInt32LE(0),
    hit: b[4] === 1,
    start: b.readUInt16LE(5),
    end: b.readUInt16LE(7),
    stop: b[9] === 1,
    enabled: b[10] === 1,
    op: b[11],
    temporary: b[12] === 1,
    hitCount: b.readUInt32LE(13),
    ignoreCount: b.readUInt32LE(17),
    hasCondition: b[21] === 1,
  };
}

export class Vice {
  constructor({ exe, host = "127.0.0.1", port = 6502, extraArgs = [] }) {
    this.exe = exe;
    this.host = host;
    this.port = port;
    this.extraArgs = extraArgs;
    this.sock = null;
    this.buf = Buffer.alloc(0);
    this.nextId = 1;
    this.pending = new Map();
    this.proc = null;
    // Set when the CPU was stopped on purpose (pause/step/breakpoint/JAM);
    // while true, tools leave the emulator stopped instead of resuming it.
    this.holdStopped = false;
    this.lastStop = null; // { reason, pc, checkpoint? }
    this.lastRegs = null;
    this.stopWaiters = [];
    this.banks = {};
    this.regNames = {}; // id -> name
    this.regIds = {}; // name -> id
  }

  get connected() {
    return this.sock !== null;
  }

  async connect(timeoutMs = 1500) {
    if (this.sock) return;
    const sock = await new Promise((resolve, reject) => {
      const s = net.createConnection({ host: this.host, port: this.port });
      const t = setTimeout(() => {
        s.destroy();
        reject(new Error("connect timeout"));
      }, timeoutMs);
      s.once("connect", () => {
        clearTimeout(t);
        resolve(s);
      });
      s.once("error", (e) => {
        clearTimeout(t);
        reject(e);
      });
    });
    sock.setNoDelay(true);
    sock.on("data", (d) => this._onData(d));
    sock.on("close", () => this._onClose(sock));
    sock.on("error", () => {});
    this.sock = sock;
    this.buf = Buffer.alloc(0);
    try {
      await this._loadMetadata();
    } catch (e) {
      // VICE can accept connections before it answers commands (still booting).
      this.disconnect();
      throw e;
    }
  }

  _onClose(sock) {
    if (this.sock === sock) this.sock = null;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error("VICE connection closed"));
    }
    this.pending.clear();
  }

  launch() {
    if (!this.exe) throw new Error("VICE (x64sc) was not found. Install VICE 3.5+ and put x64sc on your PATH, or set VICE_EXE to its full path, or start it yourself with: x64sc -binarymonitor");
    const args = ["-binarymonitor", "-binarymonitoraddress", `ip4://${this.host}:${this.port}`, ...this.extraArgs];
    this.proc = spawn(this.exe, args, {
      cwd: path.dirname(this.exe),
      detached: true,
      stdio: "ignore",
      windowsHide: false,
    });
    this.proc.unref();
    this.proc.on("exit", () => (this.proc = null));
  }

  /** Connect, launching VICE first if nothing is listening. Returns true if it launched VICE. */
  async ensure({ launch = true, waitMs = 30000 } = {}) {
    if (this.sock) return false;
    try {
      await this.connect();
      return false;
    } catch (e) {
      // Something is listening but not answering yet (VICE still booting): just wait for it.
      if (e.code !== "ECONNREFUSED") launch = false;
      else if (!launch) throw new Error(`VICE is not running with the binary monitor on port ${this.port} (${e.message}). Call vice_start.`);
    }
    if (launch) this.launch();
    const deadline = Date.now() + waitMs;
    let lastErr;
    while (Date.now() < deadline) {
      await sleep(400);
      try {
        await this.connect();
        return launch;
      } catch (e) {
        lastErr = e;
      }
    }
    throw new Error(`Launched VICE but could not connect to its binary monitor: ${lastErr?.message}`);
  }

  disconnect() {
    const s = this.sock;
    this.sock = null;
    if (s) s.destroy();
  }

  _onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    while (this.buf.length >= 12) {
      if (this.buf[0] !== STX) {
        // Resync: drop garbage until the next STX.
        const i = this.buf.indexOf(STX, 1);
        this.buf = i < 0 ? Buffer.alloc(0) : this.buf.subarray(i);
        continue;
      }
      const len = this.buf.readUInt32LE(2);
      if (this.buf.length < 12 + len) break;
      const type = this.buf[6];
      const error = this.buf[7];
      const id = this.buf.readUInt32LE(8);
      const body = Buffer.from(this.buf.subarray(12, 12 + len));
      this.buf = this.buf.subarray(12 + len);
      this._dispatch({ type, error, id, body });
    }
  }

  _dispatch(msg) {
    const { type, id, body } = msg;
    if (type === EVT.STOPPED && body.length >= 2) this.stopPc = body.readUInt16LE(0);
    if (type === EVT.REGISTERS && id === EVENT_ID) this.lastRegs = this._parseRegs(body);
    if (id === EVENT_ID) {
      if (type === EVT.CHECKPOINT) {
        const cp = parseCheckpoint(body);
        if (cp.hit && cp.stop) {
          this.holdStopped = true;
          this.lastStop = { reason: "checkpoint", checkpoint: cp, pc: null, at: Date.now() };
          this._notifyStop();
        }
      } else if (type === EVT.JAM) {
        this.holdStopped = true;
        this.lastStop = { reason: "jam", pc: body.readUInt16LE(0), at: Date.now() };
        this._notifyStop();
      } else if (type === EVT.STOPPED && this.lastStop && this.lastStop.pc === null) {
        this.lastStop.pc = body.readUInt16LE(0);
      }
      return;
    }
    const p = this.pending.get(id);
    if (!p) return;
    if (msg.error !== 0) {
      this.pending.delete(id);
      clearTimeout(p.timer);
      p.reject(new Error(`VICE error 0x${msg.error.toString(16)} (${ERRORS[msg.error] ?? "unknown"}) for command 0x${p.cmd.toString(16)}`));
      return;
    }
    if (p.finalType === null || type === p.finalType) {
      this.pending.delete(id);
      clearTimeout(p.timer);
      p.resolve({ body, extra: p.extra });
    } else {
      p.extra.push(msg);
    }
  }

  _notifyStop() {
    const ws = this.stopWaiters;
    this.stopWaiters = [];
    ws.forEach((w) => w());
  }

  waitForStop(timeoutMs) {
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.stopWaiters = this.stopWaiters.filter((w) => w !== done);
        resolve(false);
      }, timeoutMs);
      const done = () => {
        clearTimeout(t);
        resolve(true);
      };
      this.stopWaiters.push(done);
    });
  }

  send(cmd, body = Buffer.alloc(0), { finalType = null, timeout = 8000 } = {}) {
    if (!this.sock) return Promise.reject(new Error("not connected to VICE"));
    const id = this.nextId++;
    if (this.nextId >= EVENT_ID) this.nextId = 1;
    const hdr = Buffer.alloc(11);
    hdr[0] = STX;
    hdr[1] = API;
    hdr.writeUInt32LE(body.length, 2);
    hdr.writeUInt32LE(id, 6);
    hdr[10] = cmd;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout waiting for VICE response to command 0x${cmd.toString(16)}`));
      }, timeout);
      this.pending.set(id, { cmd, finalType, resolve, reject, timer, extra: [] });
      this.sock.write(Buffer.concat([hdr, body]));
    });
  }

  // ---- metadata ----

  async _loadMetadata() {
    const banks = await this.send(CMD.BANKS_AVAILABLE, undefined, { timeout: 3000 });
    this.banks = {};
    let b = banks.body;
    let n = b.readUInt16LE(0);
    let o = 2;
    for (let i = 0; i < n; i++) {
      const size = b[o];
      const id = b.readUInt16LE(o + 1);
      const nameLen = b[o + 3];
      this.banks[b.toString("latin1", o + 4, o + 4 + nameLen)] = id;
      o += size + 1;
    }
    const regs = await this.send(CMD.REGISTERS_AVAILABLE, Buffer.from([0]));
    b = regs.body;
    n = b.readUInt16LE(0);
    o = 2;
    this.regNames = {};
    this.regIds = {};
    for (let i = 0; i < n; i++) {
      const size = b[o];
      const id = b[o + 1];
      const nameLen = b[o + 3];
      const name = b.toString("latin1", o + 4, o + 4 + nameLen);
      this.regNames[id] = name;
      this.regIds[name.toUpperCase()] = id;
      o += size + 1;
    }
  }

  bankId(name = "cpu") {
    const id = this.banks[name];
    if (id === undefined) throw new Error(`unknown memory bank "${name}" (available: ${Object.keys(this.banks).join(", ")})`);
    return id;
  }

  // ---- commands ----

  async exit() {
    await this.send(CMD.EXIT);
  }

  async ping() {
    await this.send(CMD.PING);
  }

  async readMemory(start, length, bank = "cpu") {
    const out = [];
    // VICE handles up to 64K per request, but keep chunks moderate.
    for (let a = start; a < start + length; a += 0x4000) {
      const n = Math.min(0x4000, start + length - a);
      const body = Buffer.alloc(8);
      body[0] = 0; // no side effects
      body.writeUInt16LE(a & 0xffff, 1);
      body.writeUInt16LE((a + n - 1) & 0xffff, 3);
      body[5] = 0; // main memspace
      body.writeUInt16LE(this.bankId(bank), 6);
      const r = await this.send(CMD.MEM_GET, body);
      const len = r.body.readUInt16LE(0);
      out.push(r.body.subarray(2, 2 + (len === 0 ? 0x10000 : len)));
    }
    return Buffer.concat(out);
  }

  async writeMemory(start, data, bank = "cpu") {
    if (data.length === 0) return;
    const body = Buffer.alloc(8 + data.length);
    body[0] = 0;
    body.writeUInt16LE(start & 0xffff, 1);
    body.writeUInt16LE((start + data.length - 1) & 0xffff, 3);
    body[5] = 0;
    body.writeUInt16LE(this.bankId(bank), 6);
    Buffer.from(data).copy(body, 8);
    await this.send(CMD.MEM_SET, body);
  }

  _parseRegs(b) {
    const n = b.readUInt16LE(0);
    const regs = {};
    let o = 2;
    for (let i = 0; i < n; i++) {
      const size = b[o];
      const id = b[o + 1];
      regs[this.regNames[id] ?? `r${id}`] = b.readUInt16LE(o + 2);
      o += size + 1;
    }
    return regs;
  }

  async getRegisters() {
    const r = await this.send(CMD.REGISTERS_GET, Buffer.from([0]));
    return this._parseRegs(r.body);
  }

  async setRegisters(values) {
    const entries = Object.entries(values);
    const body = Buffer.alloc(3 + entries.length * 4);
    body[0] = 0;
    body.writeUInt16LE(entries.length, 1);
    let o = 3;
    for (const [name, v] of entries) {
      const id = this.regIds[name.toUpperCase()];
      if (id === undefined) throw new Error(`unknown register "${name}" (available: ${Object.values(this.regNames).join(", ")})`);
      body[o] = 3;
      body[o + 1] = id;
      body.writeUInt16LE(v & 0xffff, o + 2);
      o += 4;
    }
    await this.send(CMD.REGISTERS_SET, body);
  }

  async advance(count = 1, stepOver = false) {
    const body = Buffer.alloc(3);
    body[0] = stepOver ? 1 : 0;
    body.writeUInt16LE(count, 1);
    await this.send(CMD.ADVANCE_INSTRUCTIONS, body);
  }

  async executeUntilReturn() {
    await this.send(CMD.EXECUTE_UNTIL_RETURN);
  }

  async keyboardFeed(bytes) {
    for (let i = 0; i < bytes.length; i += 255) {
      const chunk = bytes.subarray(i, i + 255);
      await this.send(CMD.KEYBOARD_FEED, Buffer.concat([Buffer.from([chunk.length]), chunk]));
    }
  }

  async joyport(port, value) {
    const body = Buffer.alloc(4);
    body.writeUInt16LE(port, 0);
    body.writeUInt16LE(value, 2);
    await this.send(CMD.JOYPORT_SET, body);
  }

  async reset(type = 0) {
    await this.send(CMD.RESET, Buffer.from([type]));
  }

  async autostart(file, run = true, index = 0) {
    const name = Buffer.from(file, "utf8");
    const body = Buffer.alloc(4 + name.length);
    body[0] = run ? 1 : 0;
    body.writeUInt16LE(index, 1);
    body[3] = name.length;
    name.copy(body, 4);
    await this.send(CMD.AUTOSTART, body, { timeout: 20000 });
  }

  async checkpointSet({ start, end = start, stop = true, enabled = true, op = 4, temporary = false }) {
    const body = Buffer.alloc(8);
    body.writeUInt16LE(start, 0);
    body.writeUInt16LE(end, 2);
    body[4] = stop ? 1 : 0;
    body[5] = enabled ? 1 : 0;
    body[6] = op;
    body[7] = temporary ? 1 : 0;
    const r = await this.send(CMD.CHECKPOINT_SET, body);
    return parseCheckpoint(r.body);
  }

  async checkpointCondition(id, expr) {
    const e = Buffer.from(expr, "latin1");
    const body = Buffer.alloc(5 + e.length);
    body.writeUInt32LE(id, 0);
    body[4] = e.length;
    e.copy(body, 5);
    await this.send(CMD.CONDITION_SET, body);
  }

  async checkpointDelete(id) {
    const body = Buffer.alloc(4);
    body.writeUInt32LE(id, 0);
    await this.send(CMD.CHECKPOINT_DELETE, body);
  }

  async checkpointToggle(id, enabled) {
    const body = Buffer.alloc(5);
    body.writeUInt32LE(id, 0);
    body[4] = enabled ? 1 : 0;
    await this.send(CMD.CHECKPOINT_TOGGLE, body);
  }

  async checkpointList() {
    const r = await this.send(CMD.CHECKPOINT_LIST, undefined, { finalType: CMD.CHECKPOINT_LIST });
    return r.extra.filter((m) => m.type === 0x11).map((m) => parseCheckpoint(m.body));
  }

  async resourceGet(name) {
    const n = Buffer.from(name, "latin1");
    const r = await this.send(CMD.RESOURCE_GET, Buffer.concat([Buffer.from([n.length]), n]));
    const type = r.body[0];
    const len = r.body[1];
    const v = r.body.subarray(2, 2 + len);
    if (type === 0) return v.toString("latin1");
    return len === 1 ? v[0] : len === 2 ? v.readUInt16LE(0) : v.readInt32LE(0);
  }

  async resourceSet(name, value) {
    const n = Buffer.from(name, "latin1");
    let type, v;
    if (typeof value === "number") {
      type = 1;
      v = Buffer.alloc(4);
      v.writeInt32LE(value, 0);
    } else {
      type = 0;
      v = Buffer.from(String(value), "latin1");
    }
    await this.send(CMD.RESOURCE_SET, Buffer.concat([Buffer.from([type, n.length]), n, Buffer.from([v.length]), v]));
  }

  async dump(file, saveRoms = false, saveDisks = false) {
    const n = Buffer.from(file, "utf8");
    await this.send(CMD.DUMP, Buffer.concat([Buffer.from([saveRoms ? 1 : 0, saveDisks ? 1 : 0, n.length]), n]), { timeout: 20000 });
  }

  async undump(file) {
    const n = Buffer.from(file, "utf8");
    const r = await this.send(CMD.UNDUMP, Buffer.concat([Buffer.from([n.length]), n]), { timeout: 20000 });
    return r.body.readUInt16LE(0);
  }

  async info() {
    const r = await this.send(CMD.VICE_INFO);
    const b = r.body;
    const vlen = b[0];
    const ver = [...b.subarray(1, 1 + vlen)];
    return { version: ver.slice(0, 3).join(".") + (ver[3] ? `.${ver[3]}` : "") };
  }

  async display() {
    const r = await this.send(CMD.DISPLAY_GET, Buffer.from([1, 0]), { timeout: 10000 });
    const b = r.body;
    const fieldsLen = b.readUInt32LE(0);
    const info = {
      width: b.readUInt16LE(4),
      height: b.readUInt16LE(6),
      offsetX: b.readUInt16LE(8),
      offsetY: b.readUInt16LE(10),
      innerWidth: b.readUInt16LE(12),
      innerHeight: b.readUInt16LE(14),
      bpp: b[16],
    };
    const bufLen = b.readUInt32LE(17);
    info.pixels = b.subarray(4 + fieldsLen, 4 + fieldsLen + bufLen);
    if (info.pixels.length !== bufLen) info.pixels = b.subarray(b.length - bufLen);
    return info;
  }

  async palette() {
    const r = await this.send(CMD.PALETTE_GET, Buffer.from([1]));
    const b = r.body;
    const n = b.readUInt16LE(0);
    const pal = [];
    let o = 2;
    for (let i = 0; i < n; i++) {
      const size = b[o];
      pal.push([b[o + 1], b[o + 2], b[o + 3]]);
      o += size + 1;
    }
    return pal;
  }

  async quit() {
    try {
      await this.send(CMD.QUIT, Buffer.alloc(0), { timeout: 3000 });
    } catch {}
    this.disconnect();
  }
}
