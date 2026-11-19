// Spell targeting test (issue #50): the Spells view edits the target-scope
// code (record +6) and the clause scope bits in the action definition table
// inside FILEDATA.BIN (two identical copies). This test:
//   1. checks Editor/s4_spells.json against known spells (always runs),
//   2. extracts the shipped scopeFlipWord rule from web/iso.js and verifies
//      flips reproduce the game's own native one/all spell pairs,
//   3. when the real ISO is present, parses both table copies from the disc,
//      asserts they are identical and match s4_spells.json, and round-trips
//      scope edits on a temp copy. Skips (3) cleanly with no disc:
//      set S4_ISO=/path/to.iso or keep the disc at <repo>/Base ISO/.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ISO = process.env.S4_ISO || path.resolve(WEB, "../Base ISO/Suikoden IV (USA).iso");

let fails = 0;
const check = (name, cond, extra = "") => {
  console.log(`  ${cond ? "✓" : "✗"} ${name}${extra ? ": " + extra : ""}`);
  if (!cond) fails++;
};

// ---- 1) s4_spells.json sanity -------------------------------------------------
console.log("Spell data (Editor/s4_spells.json):");
const data = JSON.parse(fs.readFileSync(path.resolve(WEB, "../Editor/s4_spells.json"), "utf8"));
const S = data.spells;
check("202 actions decoded", S.length === 202, String(S.length));
const expect = {
  1: ["Flaming Arrows", 0x0A], 2: ["Dancing Flames", 0x22], 6: ["Kindness Drops", 0x07],
  8: ["Kindness Rain", 0x13], 12: ["Healing Wind", 0x07], 16: ["Clay Guardian", 0x12],
  17: ["Vengeful Child", 0x06], 22: ["Thunder Runner", 0x0A], 33: ["Finger of Death", 0x0A],
  36: ["Judgment", 0x0A], 9: ["Silent Lake", 0x42], 38: ["Spirit Yell", 0x87],
};
for (const [id, [name, code]] of Object.entries(expect)) {
  const s = S[+id];
  check(`action ${id} is ${name} with scope code 0x${code.toString(16)}`,
    s && s.name === name && s.code === code, s ? `${s.name}/0x${s.code.toString(16)}` : "missing");
}
check("Thunder Runner power is 300", S[22].power === 300, String(S[22].power));
check("Healing Wind clauses are the one-ally pair", JSON.stringify(S[12].clauses) === JSON.stringify([0x1018, 0x1012, 0]),
  JSON.stringify(S[12].clauses));

// ---- 2) the shipped flip rule, extracted from iso.js ---------------------------
console.log("Scope flip rule (extracted from web/iso.js):");
const src = fs.readFileSync(path.join(WEB, "iso.js"), "utf8");
function extractFn(name) {
  const i = src.indexOf(`function ${name}`);
  if (i < 0) return null;
  let depth = 0, j = src.indexOf("{", i);
  const start = j;
  for (; j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}" && --depth === 0) break;
  }
  return src.slice(i, j + 1);
}
const flipSrc = extractFn("scopeFlipWord");
check("scopeFlipWord found in iso.js", !!flipSrc);
const scopeFlipWord = eval(`(${flipSrc.replace(/^function scopeFlipWord/, "function")})`);
check("0x1011 (one) flips to 0x0411 (all)", scopeFlipWord(0x1011, true) === 0x0411);
check("0x0411 (all) flips to 0x1011 (one)", scopeFlipWord(0x0411, false) === 0x1011);
check("0x9010 (drain one) flips to 0x8410 (drain all, Hades' native word)", scopeFlipWord(0x9010, true) === 0x8410);
check("0x4011 (self clause) is untouched", scopeFlipWord(0x4011, true) === 0x4011);
check("0x0000 is untouched", scopeFlipWord(0x0000, true) === 0x0000);
check("0x1104 (Vengeful Child) flips to 0x0504 (Canopy Defense's native word)", scopeFlipWord(0x1104, true) === 0x0504);

// table offsets as shipped in iso.js (key "at", not "off", by design)
const tabOffs = [...src.matchAll(/SPELL_TABS = \[[\s\S]*?\];/g)].length
  ? [...src.match(/SPELL_TABS = \[([\s\S]*?)\];/)[1].matchAll(/at:\s*(0x[0-9A-Fa-f]+)/g)].map((m) => parseInt(m[1], 16))
  : [];
check("two spell table offsets parsed from iso.js", tabOffs.length === 2, tabOffs.map((x) => "0x" + x.toString(16)).join(", "));

// apply a scope change to a table buffer the way applySpellScope/writeSpell do
function applyScope(buf, id, newCode) {
  const pair = { 0x0A: [0x0A, 0x22], 0x22: [0x0A, 0x22], 0x07: [0x07, 0x13], 0x13: [0x07, 0x13], 0x06: [0x06, 0x12], 0x12: [0x06, 0x12] }[newCode];
  const toAll = newCode === pair[1];
  const base = 48 * id + 12;
  buf.writeUInt8(newCode, base + 6);
  for (const o of [8, 16, 28]) buf.writeUInt16LE(scopeFlipWord(buf.readUInt16LE(base + o), toAll), base + o);
}

// ---- 3) against the real disc ---------------------------------------------------
console.log("Spell tables on the pristine disc:");
if (!fs.existsSync(ISO)) {
  console.log(`  (skipped: no ISO at ${ISO})`);
} else if (tabOffs.length === 2) {
  const fd = fs.openSync(ISO, "r");
  const readAt = (off, n) => { const b = Buffer.alloc(n); fs.readSync(fd, b, 0, n, off); return b; };
  const tabA = readAt(tabOffs[0], 9840), tabB = readAt(tabOffs[1], 9840);
  check("both table copies are byte-identical", tabA.equals(tabB));
  let mism = 0;
  for (let id = 1; id <= 45; id++) {
    const base = 48 * id + 12;
    const code = tabA.readUInt8(base + 6);
    const clauses = [8, 16, 28].map((o) => tabA.readUInt16LE(base + o));
    const power = tabA.readUInt16LE(48 * (id + 1) + 8);
    const pair = [tabA.readUInt16LE(base), tabA.readUInt16LE(base + 2)];
    if (code !== S[id].code || JSON.stringify(clauses) !== JSON.stringify(S[id].clauses) ||
        power !== S[id].power || pair[0] !== 2 * id || pair[1] !== 2 * id + 1) mism++;
  }
  check("all 45 spells' code/clauses/power/text indices match s4_spells.json", mism === 0, `${mism} mismatch(es)`);

  // round-trip on a temp copy: Thunder Runner one -> all -> one
  const tmp = Buffer.from(tabA);
  applyScope(tmp, 22, 0x22);
  const b22 = 48 * 22 + 12;
  check("Thunder Runner flipped: code 0x22, damage clause 0x0411 (Dancing Flames' native values)",
    tmp.readUInt8(b22 + 6) === 0x22 && tmp.readUInt16LE(b22 + 28) === 0x0411);
  applyScope(tmp, 22, 0x0A);
  check("Thunder Runner flipped back: table identical to stock", tmp.equals(tabA));
  // Healing Wind one -> all must reproduce Kindness Rain's native clause words
  applyScope(tmp, 12, 0x13);
  const b12 = 48 * 12 + 12;
  check("Healing Wind flipped: clauses equal Kindness Rain's native [0x0418, 0x0412, 0]",
    JSON.stringify([8, 16, 28].map((o) => tmp.readUInt16LE(b12 + o))) === JSON.stringify(S[8].clauses));
  // Finger of Death one -> all: drain clause 0x9010 -> 0x8410 (Hades), self/drain clause 0x4012 kept
  applyScope(tmp, 33, 0x22);
  const b33 = 48 * 33 + 12;
  check("Finger of Death flipped: clause 0x9010 -> 0x8410, clause 0x4012 untouched",
    tmp.readUInt16LE(b33 + 28) === 0x8410 && tmp.readUInt16LE(b33 + 8) === 0x4012);
  fs.closeSync(fd);
}
console.log(fails ? `\n${fails} spell check(s) FAILED.` : "\nAll spell checks passed.");
process.exit(fails ? 1 : 0);
