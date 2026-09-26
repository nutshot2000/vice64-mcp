// Generates data.asm for NEON RAID: sprites (as .bits art), flight paths,
// sine table, row tables, logo and keyboard names.
import fs from "node:fs";

const out = [];
const put = (s) => out.push(s);

// ---------------- sprites (24x21) ----------------
// mirror(): left half (12 chars) -> symmetric 24-char row.
const mirror = (half) => half + [...half].reverse().join("");
// scale2(): an 11-wide pixel-art row doubled to 22 and padded to 24.
const scale2 = (row) => "." + [...row].map((c) => c + c).join("") + ".";
const blank = () => ".".repeat(24);

const sprites = [];
function sprite(name, rows) {
  rows = rows.slice();
  if (rows.length > 21) throw new Error(`${name}: ${rows.length} rows`);
  while (rows.length < 21) rows.push(blank());
  for (const r of rows) if (r.length !== 24) throw new Error(`${name}: row "${r}" is ${r.length} wide`);
  sprites.push([name, rows]);
}

sprite("ship", [
  "...........#", "...........#", "..........##", "..........##", ".........##.",
  ".........#.#", "........##.#", "........####", ".......#####", "...#..###.##",
  "...#.####.##", "...#########", "..##########", ".###########", "####.#######",
  "###..###.###", "##...##...##", "#....#.....#", ".....#......", "............",
].map(mirror));

// enemy fighter plane, nose pointing down; frame B has the propeller turned
const plane = (prop) => [
  "............", "........####", "...........#", "...........#", "..........##",
  "#.........##", "##########.#", "############", ".###########", "..........##",
  "..........##", "...........#", "...........#", prop,
].map(mirror);
sprite("fighter_a", plane("........####"));
sprite("fighter_b", plane("...........#"));

// kamikaze dart (chevron pointing down); frame B flickers the exhaust
const dart = (flame) => [
  flame ? "##.........." : "............", flame ? ".##........." : "............",
  "..##........", "..###.......", "...###......", "...####.....", "....####....",
  "....#####...", ".....#####..", ".....######.", "......######", "......#####.",
  ".......####.", "........###.", ".........##.", "..........##", "...........#",
].map(mirror);
sprite("diver_a", dart(true));
sprite("diver_b", dart(false));

// armoured gunship; frame B blinks the cockpit lights
const gunship = (lit) => [
  "...#########", "..##########", ".###.....###", lit ? "####.###.###" : "####.#.#.###",
  lit ? "####.###.###" : "####.#.#.###", "####.....###", "############", "#.##########",
  "#.#.########", "#.#.#.######", "#.#.#.######", "..#.#.######", "....#.######",
  "......####.#", "........##.#", "...........#", "...........#",
].map(mirror);
sprite("heavy_a", gunship(true));
sprite("heavy_b", gunship(false));

const invader = (rows) => [blank(), blank(), ...rows.flatMap((r) => [scale2(r), scale2(r)])];
sprite("alien_a", invader(["..#.....#..", "...#...#...", "..#######..", ".##.###.##.", "###########", "#.#######.#", "#.#.....#.#", "...##.##..."]));
sprite("alien_b", invader(["..#.....#..", "#..#...#..#", "#.#######.#", "###.###.###", "###########", ".#########.", "..#.....#..", ".#.......#."]));
sprite("boom_a", invader(["...........", "..#..#..#..", "...#.#.#...", ".#..###..#.", "...#.#.#...", "..#..#..#..", "...........", "..........."]));
sprite("boom_b", invader(["#....#....#", ".#...#...#.", "...........", "#.#.....#.#", "...........", ".#...#...#.", "#....#....#", "..........."]));

// power-up capsules: rounded box with a big letter
const FONT = {
  P: ["####.", "#...#", "#...#", "####.", "#....", "#....", "#...."],
  S: [".####", "#....", "#....", ".###.", "....#", "....#", "####."],
  B: ["####.", "#...#", "#...#", "####.", "#...#", "#...#", "####."],
};
function capsule(letter) {
  const g = Array.from({ length: 21 }, () => Array(24).fill("."));
  for (let x = 3; x <= 20; x++) g[1][x] = g[19][x] = "#";
  for (let y = 3; y <= 17; y++) g[y][1] = g[y][22] = "#";
  g[2][2] = g[2][21] = g[18][2] = g[18][21] = "#";
  FONT[letter].forEach((row, y) =>
    [...row].forEach((c, x) => {
      if (c === "#") for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) g[3 + y * 2 + dy][7 + x * 2 + dx] = "#";
    })
  );
  return g.map((r) => r.join(""));
}
sprite("cap_p", capsule("P"));
sprite("cap_s", capsule("S"));
sprite("cap_b", capsule("B"));

// boss: a 48x42 mothership, split into four sprites shown double size (96x84 on screen)
function bossArt() {
  const W = 48, H = 42, cx = 23.5;
  const g = Array.from({ length: H }, () => Array(W).fill("."));
  const set = (x, y) => { if (x >= 0 && x < W && y >= 0 && y < H) g[y][x] = "#"; };
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const dx = (x - cx) / 23.5, dy = (y - 15) / 14;
      const hull = dx * dx + dy * dy <= 1;
      const d = Math.hypot(x - cx, (y - 15) * 1.1);
      const panel = y % 5 === 0 && Math.abs(x - cx) > 9;
      const ring = d > 5 && d < 7.5;
      const eye = d <= 3;
      if ((hull && !panel && !ring) || eye) set(x, y);
    }
  for (const x0 of [5, 39]) for (let y = 24; y < 40; y++) for (let x = x0; x < x0 + 4; x++) set(x, y); // side cannons
  for (let y = 27; y < 42; y++) for (let x = 20; x < 28; x++) if (!(x >= 23 && x <= 24 && y > 32)) set(x, y); // centre gun
  for (let y = 10; y < 26; y++) for (let x = 0; x < 48; x++) if (Math.abs(x - cx) > 23 - (y - 10) * 0.4 && Math.abs(x - cx) < 24) set(x, y); // wing tips
  return g.map((r) => r.join(""));
}
const boss = bossArt();
sprite("boss_tl", boss.slice(0, 21).map((r) => r.slice(0, 24)));
sprite("boss_tr", boss.slice(0, 21).map((r) => r.slice(24)));
sprite("boss_bl", boss.slice(21, 42).map((r) => r.slice(0, 24)));
sprite("boss_br", boss.slice(21, 42).map((r) => r.slice(24)));

put("; generated by gen-data.mjs - do not edit");
put("        .align 64");
put("sprites:");
for (const [name, rows] of sprites) {
  put(`spr_${name}:`);
  for (const r of rows) put(`        .bits "${r}"`);
  put("        .byte 0");
}
sprites.forEach(([name]) => put(`SP_${name.toUpperCase()} = spr_${name}/64`));

// ---------------- flight paths ----------------
// Each segment: vx, vy (signed, 1/16 pixel per frame), frames. frames 0 = end (keep going).
// Angles: 0 = straight down, 90 = right, 180 = up.
const rad = (d) => (d * Math.PI) / 180;
const vel = (deg, speed) => [Math.round(Math.sin(rad(deg)) * speed), Math.round(Math.cos(rad(deg)) * speed)];
const go = (deg, speed, frames) => {
  const segs = [];
  for (let f = frames; f > 0; f -= 255) segs.push([...vel(deg, speed), Math.min(255, f)]);
  return segs;
};
const turn = (from, to, speed, frames, step = 4) => {
  const n = Math.max(1, Math.round(frames / step));
  return Array.from({ length: n }, (_, i) => [...vel(from + ((to - from) * (i + 0.5)) / n, speed), step]);
};
const PATHS = {
  dive: [...go(0, 40, 255)],
  uturn: [...go(0, 36, 40), ...turn(0, 180, 36, 44), ...go(180, 40, 255)],
  snake: [...go(0, 30, 20), ...[0, 1, 2, 3].flatMap(() => [...turn(0, 50, 30, 16), ...turn(50, -50, 30, 32), ...turn(-50, 0, 30, 16)]), ...go(0, 30, 255)],
  loop: [...go(0, 36, 36), ...turn(0, 360, 36, 64), ...go(0, 40, 255)],
  sweep: [...go(0, 36, 26), ...turn(0, 90, 36, 16), ...go(90, 40, 255)],
  hover: [...go(0, 24, 60), [0, 0, 100], ...go(0, 40, 255)],
  weave: [...go(20, 30, 40), ...turn(20, -20, 30, 40), ...turn(-20, 20, 30, 40), ...turn(20, -20, 30, 40), ...go(0, 34, 255)],
};
Object.entries(PATHS).forEach(([name, segs], i) => {
  put(`PATH_${name.toUpperCase()} = ${i}`);
  put(`path_${name}:`);
  for (let k = 0; k < segs.length; k += 6) put(`        .byte ${segs.slice(k, k + 6).map((s) => s.join(", ")).join(",  ")}`);
  put("        .byte 0, 0, 0");
});
put("path_lo:");
put(`        .byte ${Object.keys(PATHS).map((n) => `<path_${n}`).join(", ")}`);
put("path_hi:");
put(`        .byte ${Object.keys(PATHS).map((n) => `>path_${n}`).join(", ")}`);

// ---------------- tables ----------------
put("sine:");
const sine = Array.from({ length: 64 }, (_, i) => Math.round(40 * Math.sin((2 * Math.PI * i) / 64)));
for (let i = 0; i < 64; i += 16) put(`        .byte ${sine.slice(i, i + 16).join(", ")}`);
put("rowlo:");
put(`        .byte ${Array.from({ length: 25 }, (_, r) => `<(SCREEN+${r * 40})`).join(", ")}`);
put("rowhi:");
put(`        .byte ${Array.from({ length: 25 }, (_, r) => `>(SCREEN+${r * 40})`).join(", ")}`);

// title logo: 4x5 block glyphs, "NEON" over "RAID", 19 columns wide, 11 rows (3..13)
const G = {
  N: ["#..#", "##.#", "#.##", "#..#", "#..#"],
  E: ["####", "#...", "###.", "#...", "####"],
  O: [".##.", "#..#", "#..#", "#..#", ".##."],
  R: ["###.", "#..#", "###.", "#.#.", "#..#"],
  A: [".##.", "#..#", "####", "#..#", "#..#"],
  I: ["###.", ".#..", ".#..", ".#..", "###."],
  D: ["###.", "#..#", "#..#", "#..#", "###."],
};
const word = (w) => [0, 1, 2, 3, 4].map((r) => [...w].map((ch) => G[ch][r]).join(".").replace(/\./g, " "));
const logo = [...word("NEON"), " ".repeat(19), ...word("RAID")];
put("logo:");
for (const row of logo) {
  if (row.length !== 19) throw new Error(`logo row is ${row.length} wide`);
  put(`        .scr "${row}"`);
}

// keyboard matrix names, index = column*8 + row (column = $DC00 bit, row = $DC01 bit), 4 chars each.
// ^ and _ are the C64's up-arrow and left-arrow characters.
const MATRIX = [
  ["DEL", "RET", "CR.R", "F7", "F1", "F3", "F5", "CR.D"],
  ["3", "W", "A", "4", "Z", "S", "E", "LSHF"],
  ["5", "R", "D", "6", "C", "F", "T", "X"],
  ["7", "Y", "G", "8", "B", "H", "U", "V"],
  ["9", "I", "J", "0", "M", "K", "O", "N"],
  ["+", "P", "L", "-", ".", ":", "@", ","],
  ["£", "*", ";", "HOME", "RSHF", "=", "^", "/"],
  ["1", "_", "CTRL", "2", "SPC", "C=", "Q", "STOP"],
];
put("keynames:");
for (const col of MATRIX) put(`        .scr ${col.map((n) => `"${n.padEnd(4)}"`).join(", ")}`);

fs.writeFileSync(new URL("./data.asm", import.meta.url), out.join("\n") + "\n");
console.log(`wrote data.asm (${out.length} lines, ${sprites.length} sprites, ${Object.keys(PATHS).length} paths)`);
