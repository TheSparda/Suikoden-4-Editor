// Stock-restore test — the "Restore all to stock" button is only meaningful if the
// stock bytes baked into web/iso.js are the bytes a pristine disc actually carries.
// This reads every patch site's expected stock bytes out of iso.js (off + offBytes,
// plus the encounter-rate field's stock immediate) and asserts them against the real
// NTSC-U ISO. Skips cleanly when no disc is available (CI, fresh clones): set
// S4_ISO=/path/to.iso or keep the disc at <repo>/Base ISO/Suikoden IV (USA).iso.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ISO = process.env.S4_ISO || path.resolve(WEB, "../Base ISO/Suikoden IV (USA).iso");

let fails = 0;
const check = (name, cond, extra = "") => {
  console.log(`  ${cond ? "✓" : "✗"} ${name}${extra ? " — " + extra : ""}`);
  if (!cond) fails++;
};

console.log("Stock-restore constants vs the pristine disc:");
if (!fs.existsSync(ISO)) {
  console.log(`  (skipped — no ISO at ${ISO})`);
  process.exit(0);
}
const src = fs.readFileSync(path.join(WEB, "iso.js"), "utf8");
const sites = [];   // {off, offBytes|null} in FIELDS order
{
  const re = /off:\s*(0x[0-9A-Fa-f]+)|offBytes:\s*\[([^\]]+)\]/g;
  let m, cur = null;
  while ((m = re.exec(src))) {
    if (m[1]) { cur = { off: parseInt(m[1], 16), offBytes: null }; sites.push(cur); }
    else if (cur) cur.offBytes = m[2].split(",").map((s) => parseInt(s.trim(), 16));
  }
}
check("parsed 5 patch sites from iso.js", sites.length === 5, String(sites.length));
const fd = fs.openSync(ISO, "r");
const readAt = (off, n) => { const b = Buffer.alloc(n); fs.readSync(fd, b, 0, n, off); return b; };
for (const s of sites) {
  const disc = readAt(s.off, 4);
  if (s.offBytes) {
    check(`stock bytes at 0x${s.off.toString(16).toUpperCase()}`,
      [...disc].every((v, i) => v === s.offBytes[i]),
      `disc=${disc.toString("hex")} editor=${Buffer.from(s.offBytes).toString("hex")}`);
  } else {
    // encounter-rate field: stock is addiu a0, zero, 100 (N=100 -> 100% rate)
    check(`encounter stock immediate at 0x${s.off.toString(16).toUpperCase()}`,
      disc[2] === 0x04 && disc[3] === 0x24 && disc.readUInt16LE(0) === 100,
      `disc=${disc.toString("hex")}`);
  }
}
fs.closeSync(fd);
console.log(fails ? `\n${fails} stock-restore check(s) FAILED.` : "\nAll stock-restore checks passed.");
process.exit(fails ? 1 : 0);
