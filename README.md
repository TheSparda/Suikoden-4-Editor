# Suikoden 4 Editor

> **▶ [Open the editor](https://thesparda.github.io/Suikoden-4-Editor/web/)**, edit
> your saves *and your disc* right in the browser, or install it on Android. Nothing to
> download, nothing uploaded.

A **save + ISO editor** for **Suikoden IV** (PlayStation 2) that runs entirely in your
browser. Edit recruitment, levels, stats, runes, equipment, unite attacks, money, your
item bag, your ships, and more directly in your PS2 saves (the file is re-checksummed
and re-ECC'd so the game loads it normally), and patch the game disc itself: encounter
rate, battle toggles, free rune casting, infinite item use, shareable mod recipes, and a
browser for the disc's FILEDATA archives.

Everything runs on your device via [Pyodide](https://pyodide.org) (CPython in WebAssembly);
your save never leaves the machine. Works on desktop and Android, and installs as an offline
PWA. One rule throughout: **never write unverified data**. Every offset was
reverse-engineered and verified against real saves or the real disc before its input
appears in the UI.

Supports **NTSC-U** (SLUS-209.79) and **PAL** (SLES-529.13) saves: the save layout and
checksum are identical across regions, and each save shows a region badge. (ISO editing is
NTSC-U only.)

> This project was formerly **Suikoden-4-Save-Editor**; it outgrew the name once the disc
> editor landed. Old GitHub links redirect here, but the old web address does not carry
> over, so use the link above.
> Full UI walkthrough, install/offline details, and the Android flow are in
> [`web/README.md`](web/README.md).

---

## Save editor

### Per character (all 113)
| Field | Range | Notes |
|---|---|---|
| **Recruitment status** | Not Recruited / In Your Company / Recruited / In Party / Permanently In Party | The exact per-character flag the game checks, the first public recruitment editor for S4 |
| **Level / EXP** | 1–99 / 0–98,999 | Level drives EXP via the game's flat `EXP = (Lv−1)×1000` curve |
| **Weapon level** | 1–15 | Skip the sharpening costs |
| **Max HP** | 0–9,999 | |
| **Stats** | STR SKL MAG EVA PDF MDF SPD LUK, 0–999 | |
| **Runes** | 3 slots, full 42-rune list | Searchable name pickers, with each character's elemental rune affinities shown inline |
| **Rune uses** | Per spell level (1–4), remaining vs max, with one-tap **refill** | Two separate arrays in the save; see the correction note under *How it works* |
| **Unite attacks** | 0–3 per combo | All **29 combos listed by name** with partner tooltips (e.g. Ted's Bow & Arrow + Barrage 1–4) |
| **Equipment** | 7 slots (head/body/hands/feet + 3 accessories), 519-item list | Searchable name pickers |

A per-character **★ Max out** preset (stats, HP, level, weapon Lv, unites) speeds up big edits.

### Subtabs
- **Characters**, the per-character cards above, with search and a recruited-only filter.
- **Recruit**, set recruitment for the whole roster in one table, with a live recruited
  counter and **Recruit all / Unrecruit all** bulk actions (staged like everything else).
- **Party**, everyone carrying the In Party flag, with add/remove. Late-game saves
  legitimately flag more than the four who fight (support and ship roles share the flag),
  so no artificial cap is enforced.
- **Items**, the party bag: 75 slots, one slot per physical item (15 Medicines = 15
  slots). Add, remove, and restock by name; oversize or out-of-range changes are refused,
  never truncated.

### Per save
- **Hero name** and **ship name**
- **Potch** (money, up to 99,999,999)
- **Game time** (the playtime clock, in seconds with h:mm display)
- **World map**, shows % explored, one-click **"mark fully explored"**
- **Ships (naval upgrades)**: Shooting Distance / Armoring / Mobility / Remaining Points
  for all four ships in the fleet battles.

### Workflow
- **Health lint** on every load: checksum, recruitment values, bag contents, rune uses
  above max, cap violations, flagged in plain language before you edit.
- **Undo / redo** for staged edits (buttons or Ctrl+Z / Ctrl+Y).
- **Snapshots**: export the decoded save as JSON, or export/import your staged edits as a
  small `.edits.json` file to resume or share a work-in-progress.
- Every edit is **staged** and shown in an explicit **old → new review** before it is written.

> Recruiting via the dropdown flips the same byte the game uses, so the unit appears
> recruited exactly as if you'd met them. Story-gated events tied to specific plot beats
> remain governed by separate event state.

## Supported save formats

Open whole memory-card images *or* the individual exported saves people trade online:

| Format | Extension | Read | Write |
|---|---|:--:|:--:|
| PS2 memory card (PS2MFS) | `.ps2` `.mcd` `.mc2` `.bin` | ✅ | ✅ |
| CodeBreaker | `.cbs` | ✅ | ✅ |
| EMS / uLaunchELF | `.psu` | ✅ | ✅ |
| SharkPort / X-Port | `.sps` | ✅ | ✅ |
| MAX Drive | `.max` | ✅ | read-only\* |
| PS3 export (signed) | `.psv` | ✅ | read-only\* |

\* `.max` is decoded via an LZARI decompressor ported from mymc, but re-encoding isn't
implemented; `.psv` carries an HMAC-SHA1 signature that needs Sony's key to rebuild. To
edit either, convert it to a memory card / `.psu` / `.cbs` first.

## Safe writes

- The gamedata **checksum** (CRC32 + byte-reversed MD5) is recomputed on every write, so
  edited saves load normally.
- Memory-card writes refresh each page's **Hamming ECC**; single-file containers are
  re-packed and then **re-decoded to verify** the payload survived byte-for-byte.
- Your original file is never touched, edits download an edited *copy* (or write in place
  only when you pick a file via the browser's File System Access API and confirm).
- Inputs clamp to the game's own caps (EXP 98,999, weapon level 15, potch 99,999,999, …).

---

## ISO editor (NTSC-U disc)

Open the disc image and switch between two tabs:

### Patches
- **Encounter rate**, a slider that scales how often random battles trigger. The game
  rolls the threshold as `rand(0..N-1)`; scaling N scales the rate
  (`N = round(10000 / percent)`, so 50% ≈ half as many battles).
- **Champion's Rune effect, always on**, the game's own selective suppression (skip
  enemies weaker than the party) party-wide, without equipping the rune.
- **Turn off random battles completely**, replaces the encounter-gate call with a no-op.
- **Infinite item use**, items are not consumed when used (the community trainer patch:
  NOP the item-count load on the use path; verified unique on the disc).
- **Free rune casting**, casting never spends a rune use. Located by static
  reverse-engineering of the cast path: the deduction call is NOP'd, leaving the
  per-level counts untouched.

Every patch site is verified against the pristine disc's stock bytes before writing.
A **Changes** card lists what is already patched on the opened disc, with per-patch
**restore-to-stock** and a restore-all.

### Sharing patches
- **`.s4mod` recipes**, export your patch set as a small JSON recipe; anyone can apply
  it to their own disc. Import validates every patch against the editor's known patch
  windows before touching anything.
- **`.xdelta`**, export/apply standard xdelta patches, restricted to the same verified
  windows.
- **pnach export**, copy the changes as a PCSX2 `.pnach` cheat instead of writing the disc.

### Files
A browser for the disc's three FILEDATA containers, built from the project's own index
(2,845 archives, 114,769 entries across FILEDATA.BI1 / .BI2 / .BIN): pick a container and
archive, filter entries by id, and see each entry's flags, offset, and size.

Two ways to write the disc, both fully reversible (restore-to-stock is one click):
in the web app (in place on desktop Chromium, or a streamed patched copy on Android), or
the CLI [`Editor/s4_encounter_rate.py`](Editor/s4_encounter_rate.py) for the encounter rate:
```bash
python3 Editor/s4_encounter_rate.py 50    # half as many encounters
python3 Editor/s4_encounter_rate.py 100   # restore default
```

## Reference mode
Browse the verified reference tables, all 113 characters, 519 items, and 42 runes with
their in-game ids, plus per-character rune affinities.

---

## Run

The editor is a static web app. Easiest: just **[open the live site](https://thesparda.github.io/Suikoden-4-Editor/web/)**.

To run it locally, serve the **repo root** (the app fetches the Python engine + reference
JSON from `../Editor/` at runtime), then open `web/`:

```bash
python3 -m http.server 8791     # from the repo root
# open http://localhost:8791/web/
```

That's the only Python needed, it serves the files; the actual editing runs in your browser.

---

## How it works (verified internals)

**Save checksum: solved.** The 57,952-byte gamedata payload is gated by a 20-byte digest
at `0x0C`, reverse-engineered from the game's MIPS code. Over
`body = gamedata[0x20 : 0x20+0xE240]`: `+0x0C` = `CRC32(body)` and `+0x10` = `MD5(body)`
stored byte-reversed. Write-back reproduces both exactly.

**The save is a RAM snapshot.** MIPS disassembly of `SLUS_209.79` showed the gamedata is a
verbatim image of the game's state block at EE address `0x532860`, so every live-RAM
address from the community cheat table maps linearly to a save offset
(`save = ram − 0x532860`). This single fact unlocked most of the fields below.

**Character records.** 240-byte (`0xF0`) records from `0x1E4`, one per roster index:
runes at `+0x00/02/04`, stats at `+0x74…`, equipment at `+0xBC…+0xC8`. Anchored with known
facts (Hero = Rune of Punishment, Ted = Soul Eater) across independent playthroughs.

**Recruitment flag: solved.** One byte per character at `0x164 + index*0x78`
(0 / 1 / 10 / 11 / 15). Verified across saves in both regions: values are enum-pure,
counts track story progression. One genuine save also holds a character at value 8, a
state the cheat tables never listed; its meaning is unconfirmed.

**Progression record.** `0x108 + index*0x78`: EXP (u32, capped 98,999), weapon level
(u8), the five named unite-attack level slots (`+0x65…+0x6D`), and the rune-use arrays.

**Rune uses: a correction.** The community cheat tables label the two per-level byte
arrays backwards. Disassembly shows `+0x49` is the **max** array (the refill routines copy
it into the other) and `+0x4D` is the **remaining** array (the cast path decrements it,
and the free-casting patch above NOPs exactly that call). The editor uses the corrected
mapping; real saves confirm it (spent casters show remaining < max on single levels).

**Party bag: located.** A flat array of u32 item ids at gamedata `0xCC24`, one slot per
physical item, 75 slots. Found by diffing consecutive saves (a Soap became a Green Bottle
in place); the capacity is corroborated by the only two `slti …, 75` bounds in the boot
ELF, in the inventory-list code. The game does not compact the bag, and there is no count
word: the array is the truth.

**Ship upgrades.** Four 0x20-byte records at `0xD4E2`; u16 Range / Armor / Mobility /
Remaining Points at `+0/+2/+4/+6`. From the cheat tables, verified against real saves
(a late-game save shows all four ships upgraded with 0 points left).

**FILEDATA: cracked.** The disc's three FILEDATA containers share one archive format
(16-byte index rows of id/flags/offset/size behind a `0x82734927` header). The index tool
(`Editor/build_s4_subfile_index.py`) enumerates all 2,845 archives / 114,769 entries;
every entry offset is 16-byte aligned, and the flags=2 entries' +16 payload rule holds
across all 39,000 of them. FILEDATA.BIN, long assumed unrelated, is a third container.

**Single-file containers.** The payload is located by *self-validation*, the one window
whose internal CRC/MD5 checks out. CodeBreaker files are RC4+zlib decoded; SharkPort's
trailing checksum was reverse-engineered and verified; MAX Drive is LZARI-decompressed.

Full notes: [`Editor/Suikoden4_offsets.md`](Editor/Suikoden4_offsets.md).

## Not included (and why)

- **Definition-table editors (spells, growth, gear stats, shops, enemies)**, the tables
  are not in the boot ELF and are not resident in a field save state; an exhaustive static
  hunt (whole-disc string fingerprints, savestate RAM census, affinity fingerprints) came
  up empty. The evidence says they load at runtime from FILEDATA overlays when a menu or
  battle opens, so the route to them is dynamic (PCSX2 watchpoints), not more static RE.
- **EXP / potch multipliers, guaranteed drops, always-flee**, the award functions are
  identified (`addEXP` clamps at 98,999; `addPotch` is the sole potch writer), but their
  battle callers live in the same runtime overlays, so there is no honest disc patch yet.
- **`.psv` / `.max` writing**, Sony signature / LZARI re-encoder respectively.

---

## Layout
```
web/                     the editor, a static browser app (Save + ISO editors, Reference, PWA)
  index.html · style.css · app.js · iso.js · vcdiff.js · sw.js · manifest.webmanifest · icons/
  README.md              the web app's own docs (UI, install, Android flow)
  tests/                 npm test, static checks + synthetic-fixture engine round-trips
Editor/                  the save engine + reference data the web app loads at runtime
  s4save.py              PS2 memory-card reader + writer (PS2MFS + ECC) and save codec
  s4files.py             single-file containers (.cbs/.psu/.sps/.psv/.max)
  s4lzari.py             LZARI decoder (ported from mymc) for MAX Drive saves
  s4_encounter_rate.py   CLI: set the random-encounter rate by % (in-place ISO edit)
  build_s4_subfile_index.py  builds s4_subfile_index.json from a disc image
  s4_subfile_index.json  the FILEDATA index (2,845 archives, 114,769 entries)
  s4_char_offsets.json   113 characters (record offset -> name)
  s4_item_names.json     519 item ids -> names
  s4_rune_names.json     42 rune ids -> names
  s4_unites.json         per-character unite-attack slot names + partners
  s4_affinities.json     per-character rune affinities
  Suikoden4_offsets.md   reverse-engineering notes (save layout + checksum + FILEDATA)
  Suikoden4_encounter_rate.md  reverse-engineering notes for the encounter-rate patches
Base ISO/                your Suikoden IV disc image (USA or PAL), not included
```

## Support & feature requests
Feature requests/Support avail on the **Toran Castle Discord**: https://discord.gg/KesHMX5P2Z

## Credits
Data model derived from the community PCSX2 Cheat Engine tables for Suikoden IV.
PS2 memory-card ECC, the CodeBreaker RC4 constant, and the LZARI algorithm from `mymc`
(Ross Ridge, public domain). Unite-attack names from ninjaskipper's GameFAQs Combo
Attacks guide; rune affinities from OmegaDL50's GameFAQs Rune Affinity FAQ. Save files,
disc images, and third-party guides are **not** included in this repository.
