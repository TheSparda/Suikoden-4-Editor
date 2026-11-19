# Suikoden IV (USA, SLUS-209.79) — reverse-engineering notes

Ground-truth sources used:
- `Cheats/Suikoden IV NTSC PCSX2 1_7_5_332.CT` — Cheat Engine table (in-**RAM** layout).
- 5 real PS2 saves (`BASLUS-20979s400/401/402`) pulled from two local memcards.
- The USA ISO (`Suikoden IV (USA).iso`), serial **SLUS-209.79**, VER 1.00, NTSC.

Two independent layouts live here — keep them straight:
- **RAM layout** (from the CT): valid only while the game is running; base pointer is
  found by an AOB scan. Useful as a *map* of the record shape, NOT as file offsets.
- **Save layout** (the memcard `gamedata` payload): what the save editor reads/writes.
- **ISO layout**: flat byte offsets into the disc image, for new-game editing.

---

## ISO9660 layout (2048-byte sectors)

| File            | LBA (sector) | Size (bytes)  | Notes |
|-----------------|--------------|---------------|-------|
| `SYSTEM.CNF`    | 366          | 54            | `BOOT2 = cdrom0:\SLUS_209.79;1` |
| `SLUS_209.79`   | 367          | 3,214,528     | boot ELF (`\x7fELF`) |
| `STR.BIN`       | 389,722      | 1,186,701,312 | streamed movie/audio |
| `TRG.BIN`       | 969,166      | 30,523,392    | |
| `FILEDATA.BIN`  | 984,070      | 1,078,327,296 | main packed game data |
| `FILEDATA.BI1`  | 1,510,597    | 1,074,509,824 | |
| `FILEDATA.BI2`  | 2,035,260    | 60,162,048    | |
| `MARGIN.DAT`    | 2,064,636    | 134,217,728   | padding |

Raw byte offset of a file = `LBA * 2048`. Character/item strings are NOT in the ELF as
plain ASCII (searched: not found), so game text lives packed inside `FILEDATA.*` — the
initial-stats table location is still **UNCONFIRMED** (research task #3).

---

## RAM character record (from the CT) — the record SHAPE

The trainer walks an array of `CharacterInfoNumPartyMembers = 0x71 (113)` records with
**stride `0x78` (120 bytes)**. The "Character" dropdown values ARE `charIndex * 0x78`
byte offsets (all 113 verified divisible by 0x78). Two parallel base pointers:

- `FirstPartyExp`  base = `OurBasePtr + 0x532968` — the stat/exp record
- `FirstPartyItem` base = `OurBasePtr + 0x532920` — equipment record (0x48 earlier)
- `PotchOffset`         = `OurBasePtr + 0x535EF8` — money (u32)
- `CurrentHP` (battle)  = `OurBasePtr + 0x1B8D60`
- World-map flags       = `OurBasePtr + 0x53D1B0` (0x175 u32 flags)

### Stat record (relative to `iPartySlot` = charIndex*0x78, on `FirstPartyExp` base)
| Off | Type | Field |
|-----|------|-------|
| +0x00 | u16 | Experience (toward next) |
| +0x0A | u16 | Current HP |
| +0x1E | u16 | Max HP |
| +0x20 | u16 | STR |
| +0x22 | u16 | SKL |
| +0x24 | u16 | MAG |
| +0x26 | u16 | EVA |
| +0x28 | u16 | PDF |
| +0x2A | u16 | MDF |
| +0x2C | u16 | SPD |
| +0x2E | u16 | LUK |
| +0x49 | u8[4] | MAX rune uses per spell level 1..4 (array A) — CORRECTED 2026-11-15: the CT had the two arrays swapped; code RE (lab reward_sites.md Site 5) shows the refill routines copy +0x49 -> +0x4D and the cast deduction decrements +0x4D |
| +0x4D | u8[4] | CURRENT (remaining) rune uses per spell level 1..4 (array B) |

### Equipment record (relative to `iPartySlot`, on `FirstPartyItem` base)
| Off | Type | Field |
|-----|------|-------|
| +0x00 | u16 | Equipped Head |
| +0x02 | u16 | Equipped Body |
| +0x04 | u16 | Equipped Hands |
| +0x06 | u16 | Equipped Feet |
| +0x08 | u16 | Equipped Other 1 |
| +0x0A | u16 | Equipped Other 2 |
| +0x0C | u16 | Equipped Other 3 |
| +0x10 | u8  | Head Rune |
| +0x11 | u8  | Right-Hand Rune |
| +0x12 | u8  | Left-Hand Rune |

ID tables extracted to JSON: `s4_char_offsets.json` (113), `s4_item_names.json` (519),
`s4_rune_names.json` (42).

---

## Save file (`gamedata` payload) — 57,952 bytes

Header (confirmed by hexdump + cross-save diff of 3 saves in the same playthrough):

| Off | Type | Field | Evidence |
|-----|------|-------|----------|
| +0x00 | u32 | version = 6 | constant across all saves |
| +0x04 | u32 | = 1 | constant |
| +0x08 | u16 | slot number | 0/1/2 match folder s400/401/402 |
| +0x0C | u32 | **CRC32** of `gamedata[0x20:0x20+0xE240]` (little-endian) | **CRACKED** — verified on all saves. |
| +0x10 | 16 bytes | **MD5** of `gamedata[0x20:0x20+0xE240]`, **byte-reversed** | **CRACKED** — the game stores the 16-byte MD5 digest in reverse byte order. Verified on all saves. |

## Character records (corrected)
**Record size = 0xF0 (240 bytes)**, array starts at gamedata `0x1E4`, one record per roster
index (`index = cheat_table_offset / 0x78`). An earlier reading used stride `0x78`, which is
wrong: `0x78` is half a record, so it only aligned for index 0 (the Hero) and mislabeled
everyone else. Proven with known anchors across two independent playthroughs — Hero (idx 0)
holds the Rune of Punishment; Ted (idx 3) always holds the Soul Eater — both decode exactly,
and every roster name lines up.

Within each record (offsets relative to record base at `0x1E4 + index*0xF0`):
| Offset | Type | Field |
|---|---|---|
| +0x00 | u16 (low byte = id) | Rune slot 1 |
| +0x02 | u16 (low byte = id) | Rune slot 2 |
| +0x04 | u16 (low byte = id) | Rune slot 3 |
| +0x74 | u16 | EXP toward next (stat sub-block starts here; lands at 0x258 for idx 0) |
| +0x74+0x0A | u16 | Current HP (reads 0 when saved out of battle) |
| +0x74+0x1E | u16 | Max HP |
| +0x74+0x20 | u16[8] | STR SKL MAG EVA PDF MDF SPD LUK |

Equipment block (7 u16 slots, offsets relative to record base):
| Offset | Slot |
|---|---|
| +0xBC | Head |
| +0xBE | Body |
| +0xC0 | Hands |
| +0xC2 | Feet |
| +0xC4 | Accessory 1 |
| +0xC6 | Accessory 2 |
| +0xC8 | Accessory 3 |

Located and slot-ordered **by category purity**, no controlled save needed: diffing units
recruited in one playthrough but not the other showed this region is all-zero for unrecruited
units and fills with wearables once recruited. Tallying item categories per slot across all
recruited characters in two playthroughs, +0xBE holds only armor/robes and +0xC2 only
boots/shoes (100% pure); head/hands/accessory slots hold only their category once garbage
(unrecruited) records are excluded. +0xCA is always empty, so the block is exactly 7 slots.
Runes + stats + HP + equipment are all verified and write-enabled.

### Checksum, fully solved (write-enabled)
Found by disassembling `SLUS_209.79` (MIPS64, PS2). The save serializer at vaddr
`0x471C34` calls, over `base = gamedata+0x20`, `len = 0xE240` (57920 bytes):
1. `0x4E1848` → CRC32 (standard reflected table at vaddr `0x583AB4`) → stored LE at `+0x0C`.
2. `0x4E1890` → MD5 (init constants `67452301/EFCDAB89/98BADCFE/10325476` at `0x4E2CF0`) →
   the 16-byte digest is written **reversed** to `+0x10`.

```python
import hashlib, zlib, struct
body = gamedata[0x20:0x20+0xE240]
struct.pack_into("<I", gd, 0x0C, zlib.crc32(body) & 0xFFFFFFFF)
gd[0x10:0x20] = hashlib.md5(body).digest()[::-1]
```
| +0x28 | char[16?] | Hero name ("Sparda") | ASCII, null-padded |
| +0x38 | char[] | 2nd name ("Sta"…) | |
| +0x4A | char[] | Ship name ("Basel") | |
| +0x5C | u32 | 0x1D (29) | matches on-screen level LVL29 in the save title |

The save title (icon.sys, Shift-JIS full-width) parses as
`Suikoden4 [NN] LVLnn / H:MM` — chapter, level, playtime.

**Checksum status: FULLY CRACKED (write-enabled).** Both fields are reproducible (CRC32 +
reversed MD5 over `0x20..0x20+0xE240`), verified against all sample saves. Save write-back
recomputes them before committing, then refreshes each memcard page's Hamming ECC.

Playtime appears mirrored as several incrementing u32 copies (+0x108, +0x2E8, +0x5B8,
+0x720 all step by 112 between the 4:42 and 4:49 saves). Potch offset in the save is
still **UNCONFIRMED** (RAM potch is +0x535EF8, but the save is a compacted structure).

## FILEDATA archive format (BI1 / BI2) — CRACKED
`FILEDATA.BI1` and `FILEDATA.BI2` are packed archives (NOT flat data). Header + file table:
- `+0x00` u32 magic `0x82734927`
- `+0x04` u32 = 0
- `+0x08` u32 total archive size
- `+0x0C` u32 = 0
- `+0x10` onward: 16-byte entries `(id u32, flags u32, offset u32, size u32)`.
  - `id` is a content hash/key (e.g. 0xE94F, 0x50EC); families share high bits.
  - `flags`: 0 = stored, 2 = compressed (observed on the larger paired entries).
  - `offset` is relative to the archive (file) start; entries are offset-ordered.
  - Header row's first field doubles as the entry count (BI2: 0x38 = 56 slots).
BI2 (60MB) has 55 real entries; many appear as a 256-byte header entry (flags 0)
immediately followed by a flags=2 data entry — a header+compressed-payload pairing.
`FILEDATA.BIN` is unrelated (starts with a copy of SYSTEM.CNF text).

> **Superseded 2026-11-15** (the two claims above; original kept per #33): the
> "55 real entries" are only the FIRST archive's table in BI2 — each FILEDATA
> file is a run of back-to-back archives. And `FILEDATA.BIN` is NOT unrelated:
> it holds the same archives in six runs. Full verified census in the next
> section. The "flags=2 means compressed" reading is also in doubt (#46):
> sampled flags=2 payloads have a stored/compressed ratio of ~1.00x.

## FILEDATA census — verified 2026-11-15 (#44, extends #31)

Measured on the pristine NTSC-U disc by `Editor/build_s4_subfile_index.py`
(index: `Editor/s4_subfile_index.json`; invariants asserted by
`web/tests/subfile-index.mjs`). Every count below is exact, zero exceptions.

| File | Archives | Entries | Flags 0 / 2 / 3 | Chain end |
|---|---|---|---|---|
| `FILEDATA.BI2` | 259 | 4,537 | 3,840 / 697 / 0 | last archive ends 2,048 bytes early |
| `FILEDATA.BI1` | 1,066 | 57,771 | 37,095 / 20,456 / 220 | ends on the file's exact final byte |
| `FILEDATA.BIN` | 1,520 | 52,461 | 33,505 / 18,788 / 168 | ends on the file's exact final byte |
| **Total** | **2,845** | **114,769** | | |

- BI1/BI2 chains tile perfectly from offset 0 (258/258 and 1065/1065
  consecutive pairs, `next = offset + align2048(total)`). Issue #44 said
  260 BI2 archives / 1,326 total; the chain walk and a full magic scan
  both find 259 in BI2 — the extra was the trailing sector (next point).
- BI2's final 2,048-byte sector is not zero padding: it holds a copy of
  the SYSTEM.CNF text (54 non-zero bytes). That same stamp at the head of
  `FILEDATA.BIN` is what made BIN look unrelated; BIN's archive runs start
  at 2,490,368 and cover 1,026 MB of its 1,078 MB in 6 runs (the big run:
  1,446 archives / 45,367 entries from 115,269,632). The 6 non-archive
  gaps total 52,015,104 bytes and are recorded in the index.
- Every entry offset in all three files is 16-byte aligned
  (114,769/114,769). The #45 "+16 rule" for flags=2 entries holds across
  all three files: 39,000/39,000 (690 BI2 + 20,140 BI1 + 18,170 BIN).
- flags=3 exists in BIN too (168 entries), not just BI1 (220).

STATUS: container format decoded and now indexed end to end. Which entry
holds the character/item/spell tables is the remaining question (#47);
the first fingerprint sweep is recorded in the PS2 RE lab writeup
(`~/workspace/ps2-re/games/suikoden4/FILEDATA.md`).

Update 2026-11-15 (#47, later the same day): the savestate-RAM census
(attack 4) matched 16,872 entries resident in RAM, but the item/rune/
character definition tables are not among them (the savestate was taken
in the field; they likely load with menus/battles). Every static name
fingerprint also came up empty: the item/rune/character name lists
appear nowhere on the disc as terminated-string sequences (whole-ISO
scan) or as record-embedded name fields (282,715 combos). The BIN gaps
hold MPEG video and a second fixed-block container family (magic
0x29857294), not tables. Next route is the PCSX2 harness (#34):
menu-open RAM snapshots diffed against the field savestate. Full
record: lab `games/suikoden4/FILEDATA.md`.

## Recruitment flags — CRACKED (write-enabled)
**Recruited[i] = gamedata `0x164 + rosterIndex*0x78` (one byte per character).**
Values (decimal): `0` Not Recruited · `1` In Your Company (guest) · `10` Recruited ·
`11` In Party · `15` Permanently In Party (hero).

How it fell: a newer community Cheat Engine table ("Suikoden IV (USA).ct") exposes a live
per-character "Recruited" byte in RAM. MIPS disassembly of `SLUS_209.79` then showed the
function pair at `0x468710/0x468720` returning a **static pointer `0x532860` and size
`0xE260`** — i.e. the save gamedata is a **verbatim image of the game's state block at EE
`0x532860`**, so every RAM address maps linearly to a save offset (`save = ram - 0x532860`;
the CT's Recruited `0x5329C4` → save `0x164`). The CT dropdown values are decimal (15 =
0xF "Permanently In Party"), which the hero byte confirms in every save.

The array is indexed by our roster index but with **stride 0x78** — it threads through the
0xF0 character records' unclaimed bytes (`+0x70`/`+0xE8`), which is why per-record scans
never found it. Verified on 8 saves (NTSC-U + PAL): all values enum-pure, recruited counts
track story progression (4 → 62 → 107), and decoding `11/15` as "party" reproduces
story-accurate party lists (e.g. the canonical early party Hero/Chiepoo/Paula/Jewel).
Note: unrecruited-but-statted records (the new-game seed) plus guests (`1`) explain every
earlier heuristic mismatch — non-combat stars recruit with placeholder battle records.

The editor exposes this as a per-character dropdown; only the five known enum values are
writable. Caveat: setting `10` marks a unit recruited exactly as the game tracks it, but
story-gated availability (e.g. HQ facilities tied to plot beats) is separate state.

## (superseded) earlier investigation notes
Recruitment is **not** stored inside the 0xF0 character record (every record offset was
checked across a controlled same-playthrough pair; none flips on recruit).

A deep search of the gamedata body did not yield a verifiable recruit bit-table. Two
leads looked promising by magnitude but both proved to be **coincidences**:
- `0x97D8`/`0xA090` gain ~+50 bits between CodeBreaker saves `11240`→`11251` (a near-ideal
  controlled pair: same playthrough, level 99, playtime 98999, ~50 units recruited between
  them). But these regions are **empty in early saves** where the Hero et al. are already
  recruited, so they can't be a persistent recruit flag — they track some other ~50-entry
  event/collection that happened to grow by the same count.
- `0x9606` has ~50 bits set in every save (an "every-third-bit" `001`-per-entry pattern),
  but the region is **byte-identical across all five saves** — a static config table, not
  recruitment.

Root cause of the blocker: solving this from saves alone needs a trustworthy per-character
"is recruited" ground truth, and the only one available (equip/maxHP/rune record-filled)
is a **heuristic** — the new-game seed pre-fills maxHP, so it over/mis-counts. Against that
fuzzy truth, several unrelated regions match by count, and none matches the full
across-saves *signature* multiset. ELF disassembly didn't rescue it either: the game text
is packed (no name-string anchors), there is no static character↔star permutation table
(the one 108-value run found at vaddr `0x501D90` is a graphics byte-swizzle table), and the
save block is assembled via indirection that hides the recruit table's RAM base.

**What would finish it (verified, cheap):** a **single-recruit** controlled pair — save,
recruit exactly ONE known unit, save again to a new slot. A one-unit diff pinpoints the
single bit that flips, giving that unit's exact bit with zero ambiguity; a few such pairs
reveal the ordering for all units. A speculative toggle is intentionally NOT shipped — and
note that flipping a recruit bit alone may not make a unit usable, since HQ/party
availability and story gates are separate state.

## Spell / action table: LOCATED 2026-11-19 (write-enabled, #50)
Not in the ELF: the table loads with the menu/battle database from FILEDATA.BIN
archive 3, entry 656 (id 0x6AB, ISO 0x7867DFE0, 35,514 bytes), at entry +660.
A byte-identical duplicate sits in archive 7, entry 2 (id 0x6AA, ISO 0x7874D740)
at entry +52. Grid: 205 records x 48 bytes (ISO 0x7867E274 / 0x7874D774).
The LOGICAL record for action a starts 12 bytes into grid record a:
+0/+2 text unit indices (2a, 2a+1), +4 element/family, +6 target-scope code
(0x0A damage one enemy, 0x22 damage all enemies, 0x07 heal one ally, 0x13 heal
all allies, 0x06 buff one ally, 0x12 buff all allies, 0x42 special, 0x87 revive
one ally), clause words at +8/+16/+28 (high byte scope bits: 0x10 one, 0x04 all,
0x80 drain, 0x40 self, 0x20 grounded), +24 magnitude, +44 power, +46 secondary %.
Text is glyph-encoded (unit = 0x8A00 + (ord - 0x20), space 0xC400, end C100 FFFF);
the entry's own pool decodes all 202 actions. Proven in game: flipping Healing
Wind's +6 code 0x07 to 0x13 in RAM changed its menu targeting from one ally to
all allies (the clause words alone did not). Data: Editor/s4_spells.json,
generator Editor/build_s4_spells.py. Full analysis: lab spell_table.md.

## Inventory + rune uses — LOCATED 2026-11-15 (write-enabled)

Party bag: u32 item ids at gamedata 0xCC24 (RAM 0x53F484), one slot per physical
item (quantity = slot count; 15 Medicines = 15 slots). Found by save diffing: the
s401->s402 diff rewrites exactly one slot in place (Soap -> Green Bottle) alongside
potch/time/EXP changes, and the array decodes to in-range ids (1..518) packed from
slot 0 with a zero tail in all 16 real saves examined (NTSC + PAL, four
playthroughs). The next identified array starts at 0xCD50, bounding the bag at 75
slots. Static RE (lab inventory_sites.md, 2026-11-15) corroborates 75: the ELF's
only two slti bounds of 75 live in func_0046BFE8 (words verified on the pristine
disc at ISO 0x2A49FC / 0x2A4B04), in a paged-list routine whose counters cap at
75 and 4. The bag is not compacted by the game (holes can exist mid-array); the
editor's decode skips empty slots and its writes preserve the item multiset.
Shipped as the save editor's Items tab (INVENTORY_OFF / INVENTORY_SLOTS in
s4save.py).

Rune uses: the CT's RAM stat record is the save's prog record (its base 0x532968 is
PROG_BASE in save terms). The uses are per spell LEVEL: array A at prog +0x49 is
the MAX per level, array B at prog +0x4D is the CURRENT (remaining) per level.
(The CT's labels had A and B swapped; corrected by code RE, lab reward_sites.md
Site 5: refill funcs copy A -> B, the cast deduction decrements B, the cast gate
reads A.) Real-save shape confirms it: max arrays read [9,5,2,1] / [5,2,1,0] by
level, at-rest saves hold current == max, and spent casters show current < max on
single levels (Josh's Ted Lv4 1/2; Sparda s402 hero Lv2 1/2; Lo Fong Lv1 max 7,
current 4 - the byte pair that looked anomalous under the swapped labels).
Shipped as the character card's per-level Rune uses fields + refill button
(stages current := max on all four levels). The ISO editor also gained the
matching disc patch: Free rune casting NOPs the deduction call (jal 0x2BBA58 at
vaddr 0x45F26C, ISO 0x297A6C, stock bytes verified).

Party membership: derived from the recruitment enum (11 = In Party, 15 =
Permanently In Party). CORRECTED 2026-11-15: the count is NOT capped at 4.
Early saves hold exactly 4 (hero at 15 plus three at 11), but late-game saves
legitimately hold 6 (Josh) and 10 (Brian 11251) at 11/15, including support
and ship-role characters (Jeane, Rikie), so the flag means more than the four
who fight. The Party tab therefore enforces no cap. The save records no
separate slot order, so the tab lists roster order. Brian's save also holds
one character (Agnes) at state 8, a value the CT enum does not list; meaning
unconfirmed.

Located but NOT yet identified (static RE, lab inventory_sites.md 2026-11-15):
- Trade-goods records at 0xC8D0 (RAM 0x53F130): the region is 852 bytes = 53
  records of 16 bytes plus one trailing u32 (always zero). Fields +4/+8/+12 are
  zero in every save examined, populated or not, so quantity is NOT stored in
  the record (runtime-only, elsewhere, or the records are an encountered /
  offered registry rather than stock). No trade editor until that resolves.
- A 13-entry u32 item list at 0xCD50 (RAM 0x53F5B0) followed by one varying
  negative s32 word; present only in late-game saves. Mixed gear, consumables
  and rune orbs/pieces.
- A structure at 0xCDB4 (RAM 0x53F614): u32 values 1,1,1,2,2,2,3,3,3,...
  (ascending ids, each exactly 3 times, at least ids 1..11), late-game only,
  with a byte array starting 01 02 03 04 05 01 01 01 at 0xCE9C right after it.
