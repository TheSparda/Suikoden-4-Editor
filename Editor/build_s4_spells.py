#!/usr/bin/env python3
"""Build Editor/s4_spells.json: the Suikoden IV action/spell definition table.

Source: FILEDATA.BIN archive 3, entry id 0x6AB (a 35,514-byte database entry,
also duplicated in archive 7 entry 0x6AA). Inside the entry, at +660, sits a
table of 205 grid records of 48 bytes. The LOGICAL spell record for action `a`
starts 12 bytes into grid record `a` (the name/description text-index pair
heads the record) and runs 48 bytes, so its power field lands at +44 (the
next grid record's +8). Layout of the logical record:

  +0  u16  name text unit index (2a)
  +2  u16  description text unit index (2a+1)
  +4  u16  element / rune family (1 Fire, 5 Water, 2 Wind, 3 Earth,
           4 Lightning, 9 Punishment, 10 Blinking, 7 Soul Eater,
           6 Resurrection, 0 unite/special, 11 passive)
  +6  u8   target-scope / effect-type code (see SCOPE_CODES in web/iso.js):
           0x0A damage one enemy, 0x22 damage all enemies,
           0x07 heal/cure one ally, 0x13 heal all allies,
           0x06 buff one ally, 0x12 buff all allies,
           0x42 special mixed, 0x87 revive one ally, others fixed
  +7  u8   tier byte (1 normally; 5 on some top-tier spells, 9 on unites)
  +8  u16  effect clause word 1 (high byte carries scope bits: 0x10 = one,
           0x04 = all, 0x40 = self, 0x80 = drain, 0x20 = grounded only)
  +16 u16  effect clause word 2 (same encoding)
  +24 u16  primary magnitude (heal amount, self-damage, status chance)
  +28 u16  effect clause word 3 (the damage clause on attack spells)
  +44 u16  power (damage; matches the in-game description)
  +46 u16  secondary percent (death chance, self-damage percent, ...)

Spell names/descriptions come from the entry's own glyph-encoded text pool
(each character is a u16 unit 0x8A00 + (ord - 0x20), space is 0xC400, and
strings end with C100 FFFF; units alternate name, description).

Verified 2026-11-19 by RAM correlation against the live game (the loaded
table in EE RAM is byte-identical to this entry's) and by in-game tests:
flipping Healing Wind's +6 code 0x07 -> 0x13 in RAM changed its menu target
selection from one ally to all allies. See lab spell_table.md.

Usage: python3 build_s4_spells.py [path-to-iso]
Writes Editor/s4_spells.json next to this script.
"""
import json
import struct
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
ISO_DEFAULT = REPO / "Base ISO" / "Suikoden IV (USA).iso"
INDEX = HERE / "s4_subfile_index.json"

ELEMENTS = {0: "Unite / special", 1: "Fire", 2: "Wind", 3: "Earth",
            4: "Lightning", 5: "Water", 6: "Resurrection", 7: "Soul Eater",
            9: "Rune of Punishment", 10: "Blinking", 11: "Passive"}


def glyph_encode(s):
    out = bytearray()
    for c in s:
        if c == " ":
            out += struct.pack("<H", 0xC400)
        else:
            out += struct.pack("<H", 0x8A00 + (ord(c) - 0x20))
    return bytes(out)


def glyph_decode(unit_bytes):
    chars = []
    for (v,) in struct.iter_unpack("<H", unit_bytes):
        if v == 0xC400:
            chars.append(" ")
        elif 0x8A00 <= v < 0x8A00 + 0x60:
            chars.append(chr(v - 0x8A00 + 0x20))
        else:
            chars.append("?")
    return "".join(chars)


def find_entry(iso_path):
    """Locate the 0x6AB database entry via the subfile index; return its bytes."""
    idx = json.loads(INDEX.read_text())
    cont = idx["files"]["FILEDATA.BIN"]
    base = cont["lba"] * 2048
    with open(iso_path, "rb") as f:
        for arch in cont["archives"]:
            for e in arch["entries"]:
                if e["id"] == 0x6AB:
                    f.seek(base + arch["offset"] + e["offset"])
                    return f.read(e["size"])
    raise SystemExit("entry 0x6AB not found in the index")


def main():
    iso_path = Path(sys.argv[1]) if len(sys.argv) > 1 else ISO_DEFAULT
    entry = find_entry(iso_path)

    # Table: find grid record 0 by its text-pair signature (0, 1) at +12 with
    # record 1's pair (2, 3) 48 bytes later.
    tab_off = None
    for off in range(0, len(entry) - 9840):
        if struct.unpack_from("<HH", entry, off + 12) == (0, 1) and \
           struct.unpack_from("<HH", entry, off + 60) == (2, 3):
            tab_off = off
            break
    if tab_off is None:
        raise SystemExit("action table not found in entry 0x6AB")
    tab = entry[tab_off:tab_off + 9840]

    def logical(a):
        return tab[48 * a + 12:48 * a + 48] + tab[48 * (a + 1):48 * (a + 1) + 12]

    # Text pool: search for the glyph encoding of the first unit, "Dummy Magic".
    pool_off = entry.find(glyph_encode("Dummy Magic"))
    if pool_off < 0:
        raise SystemExit("text pool not found in entry 0x6AB")
    units = entry[pool_off:].split(b"\x00\xc1\xff\xff")
    texts = [glyph_decode(u) for u in units[:404]]

    spells = []
    for a in range(202):
        r = logical(a)
        name_i, desc_i, elem = struct.unpack_from("<HHH", r, 0)
        code, code_hi = r[6], r[7]
        w8, w16, mag, w28 = struct.unpack_from("<HHHH", r, 8)[0], \
            struct.unpack_from("<H", r, 16)[0], \
            struct.unpack_from("<H", r, 24)[0], \
            struct.unpack_from("<H", r, 28)[0]
        power, sub = struct.unpack_from("<HH", r, 44)
        spells.append({
            "id": a,
            "name": texts[name_i] if name_i < len(texts) else "",
            "desc": texts[desc_i] if desc_i < len(texts) else "",
            "element": elem,
            "elementName": ELEMENTS.get(elem, "Unknown %d" % elem),
            "code": code, "codeHi": code_hi,
            "clauses": [w8, w16, w28],
            "magnitude": mag, "power": power, "sub": sub,
        })

    # sanity: names the menu proved in game
    assert spells[1]["name"] == "Flaming Arrows", spells[1]
    assert spells[12]["name"] == "Healing Wind", spells[12]
    assert spells[33]["name"] == "Finger of Death", spells[33]

    out = {"format": "s4-spells/1",
           "source": "FILEDATA.BIN archive 3 entry 0x6AB (duplicate: archive 7 entry 0x6AA)",
           "tableEntryOffset": tab_off,
           "spells": spells}
    dest = HERE / "s4_spells.json"
    dest.write_text(json.dumps(out, indent=1) + "\n")
    print("wrote", dest, "with", len(spells), "actions; table at entry +", tab_off)


if __name__ == "__main__":
    main()
