// Locate the VICE C64 emulator (x64sc): $VICE_EXE, then PATH, then common install folders.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const EXE = process.platform === "win32" ? "x64sc.exe" : "x64sc";

function onPath() {
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    const p = path.join(dir, EXE);
    if (dir && fs.existsSync(p)) return p;
  }
  return null;
}

/** Breadth-first search a few levels deep for a folder holding x64sc (directly or in bin/). */
function searchUnder(root, depth) {
  let level = [root];
  for (let d = 0; d <= depth && level.length; d++) {
    const next = [];
    for (const dir of level) {
      for (const p of [path.join(dir, EXE), path.join(dir, "bin", EXE)]) if (fs.existsSync(p)) return p;
      let entries = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) if (e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules") next.push(path.join(dir, e.name));
    }
    level = next.slice(0, 400);
  }
  return null;
}

export function findVice() {
  if (process.env.VICE_EXE) return process.env.VICE_EXE;
  const found = onPath();
  if (found) return found;
  const home = os.homedir();
  const roots =
    process.platform === "win32"
      ? [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], path.join(home, "Desktop"), path.join(home, "Downloads"), path.join(home, "Documents"), home, "C:\\"]
      : process.platform === "darwin"
        ? ["/Applications", path.join(home, "Applications"), "/opt/homebrew/bin", "/usr/local/bin", home]
        : ["/usr/bin", "/usr/local/bin", "/opt", path.join(home, ".local", "bin"), home];
  for (const root of roots.filter(Boolean)) {
    if (!fs.existsSync(root)) continue;
    // Only look inside folders that look like VICE installs, except shallow bin dirs.
    const direct = searchUnder(root, 0);
    if (direct) return direct;
    let entries = [];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const p = path.join(root, e.name);
      const hit = /vice/i.test(e.name) ? searchUnder(p, 2) : /emu/i.test(e.name) ? searchUnder(p, 3) : null;
      if (hit) return hit;
    }
  }
  return null;
}
