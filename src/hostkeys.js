// Real key presses for VICE on Windows: post WM_KEYDOWN/WM_KEYUP to the VICE
// window (no focus change needed). VICE maps them onto the C64 keyboard
// matrix, so this works for games that scan the keyboard directly, unlike the
// monitor's keyboard-buffer feed. A single long-lived PowerShell helper does
// the Win32 calls.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

const SCRIPT = String.raw`
Add-Type @"
using System; using System.Runtime.InteropServices;
public static class K {
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern uint MapVirtualKey(uint c, uint t);
}
"@
$h = [IntPtr]::Zero
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($line -eq $null) { break }
  $p = $line.Split(' ')
  try {
    switch ($p[0]) {
      'find' {
        $proc = Get-Process -Name $p[1] -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
        if ($proc) { $h = $proc.MainWindowHandle; [Console]::Out.WriteLine("ok $h") } else { [Console]::Out.WriteLine("err no window") }
      }
      'down' {
        $vk = [uint32]$p[1]; $sc = [int64][K]::MapVirtualKey($vk, 0)
        $l = [int64]1 -bor ($sc -shl 16) -bor ([int64]$p[2] -shl 24)
        [void][K]::PostMessage($h, 0x100, [IntPtr][int64]$vk, [IntPtr]$l); [Console]::Out.WriteLine('ok')
      }
      'up' {
        $vk = [uint32]$p[1]; $sc = [int64][K]::MapVirtualKey($vk, 0)
        $l = [int64]1 -bor ($sc -shl 16) -bor ([int64]$p[2] -shl 24) -bor ([int64]1 -shl 30) -bor ([int64]1 -shl 31)
        [void][K]::PostMessage($h, 0x101, [IntPtr][int64]$vk, [IntPtr]$l); [Console]::Out.WriteLine('ok')
      }
      default { [Console]::Out.WriteLine('err unknown command') }
    }
  } catch { [Console]::Out.WriteLine("err $_") }
  [Console]::Out.Flush()
}
`;

// C64 key name -> [Windows virtual key, extended-key flag], per VICE's default symbolic keymap.
const KEYS = {
  SPACE: [0x20], RETURN: [0x0d], DEL: [0x08], HOME: [0x24, 1],
  F1: [0x70], F3: [0x72], F5: [0x74], F7: [0x76],
  CRSR_RIGHT: [0x27, 1], CRSR_LEFT: [0x25, 1], CRSR_UP: [0x26, 1], CRSR_DOWN: [0x28, 1],
  RUNSTOP: [0x1b], LSHIFT: [0x10], RSHIFT: [0xa1], CTRL: [0x09], CBM: [0x11],
  COMMA: [0xbc], PERIOD: [0xbe], SLASH: [0xbf], SEMICOLON: [0xba], MINUS: [0xbd], EQUALS: [0xbb],
};
const ALIASES = {
  " ": "SPACE", ENTER: "RETURN", "\n": "RETURN", BACKSPACE: "DEL", STOP: "RUNSTOP", ESC: "RUNSTOP",
  SHIFT: "LSHIFT", "C=": "CBM", COMMODORE: "CBM", RIGHT: "CRSR_RIGHT", LEFT: "CRSR_LEFT", UP: "CRSR_UP", DOWN: "CRSR_DOWN",
  ",": "COMMA", ".": "PERIOD", "/": "SLASH", ";": "SEMICOLON", "-": "MINUS", "=": "EQUALS",
};
export const KEY_NAMES = [...Object.keys(KEYS), "A-Z", "0-9"];

export function keyCode(name) {
  let k = String(name);
  if (k.length > 1) k = k.toUpperCase().replace(/[\s-]+/g, "_");
  k = ALIASES[k] ?? ALIASES[k.toUpperCase()] ?? k.toUpperCase();
  if (/^[A-Z0-9]$/.test(k)) return [k.charCodeAt(0), 0];
  const v = KEYS[k];
  if (!v) throw new Error(`unknown key "${name}" (use a letter, digit or one of ${Object.keys(KEYS).join(", ")})`);
  return [v[0], v[1] ?? 0];
}

export class HostKeys {
  constructor(processName) {
    this.processName = processName;
    this.proc = null;
    this.waiters = [];
    this.found = false;
    this.down = new Set();
  }

  _start() {
    if (this.proc) return;
    if (process.platform !== "win32") throw new Error("key presses are only implemented on Windows");
    const file = path.join(os.tmpdir(), "vice-mcp", "hostkeys.ps1");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, SCRIPT);
    this.proc = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", file], {
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    });
    readline.createInterface({ input: this.proc.stdout }).on("line", (l) => this.waiters.shift()?.(l.trim()));
    this.proc.on("exit", () => {
      this.proc = null;
      this.found = false;
      this.waiters.splice(0).forEach((w) => w("err helper exited"));
    });
  }

  _cmd(line) {
    this._start();
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("key helper timed out")), 15000);
      this.waiters.push((reply) => {
        clearTimeout(t);
        reply.startsWith("ok") ? resolve(reply) : reject(new Error(reply.slice(4) || reply));
      });
      this.proc.stdin.write(line + "\n");
    });
  }

  async _ensureWindow() {
    if (this.found) return;
    await this._cmd(`find ${this.processName}`);
    this.found = true;
  }

  async press(name) {
    const [vk, ext] = keyCode(name);
    await this._ensureWindow();
    await this._cmd(`down ${vk} ${ext}`);
    this.down.add(name);
  }

  async release(name) {
    const [vk, ext] = keyCode(name);
    await this._ensureWindow();
    await this._cmd(`up ${vk} ${ext}`);
    this.down.delete(name);
  }

  /** Make exactly `names` held: release others, press new ones. */
  async hold(names) {
    for (const k of [...this.down]) if (!names.includes(k)) await this.release(k);
    for (const k of names) if (!this.down.has(k)) await this.press(k);
  }

  async releaseAll() {
    for (const k of [...this.down]) await this.release(k).catch(() => {});
  }

  /** Forget the cached window (e.g. VICE was restarted). */
  reset() {
    this.found = false;
    this.down.clear();
  }
}
