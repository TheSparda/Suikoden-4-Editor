#!/usr/bin/env python3
# Save-engine round-trip test for the web editor's Pyodide path.
#
# The web Save Editor runs Editor/s4save.py (+ s4files.py, s4lzari.py) unchanged in the
# browser (read_all_s4_saves / write_save_edits). The repo ships NO game data, so this builds
# a SYNTHETIC 57952-byte S4 "gamedata" payload — wrapped in the simplest single-file container
# the engine accepts (a bare payload it sniffs as "psu") — with planted values, then drives the
# real engine: decode -> edit -> write -> re-decode, asserting the values persist and the
# gamedata checksum (CRC32 + reversed MD5 over the body) stays valid. It also unit-checks the
# memory-card ECC helper and the "unrecognized file" path.
#
# Imports s4save directly (not a JS reimplementation) so offsets + checksum can never drift
# from the engine under test. Run via `node save-roundtrip.mjs` (skips cleanly if python3 is
# absent) or directly: `python3 save_roundtrip.py`.
import os
import sys
import struct
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "..", "Editor"))
import s4save as SV  # noqa: E402

fails = 0


def check(name, cond, extra=""):
    global fails
    print("  %s %s%s" % ("✓" if cond else "✗", name, (" — " + extra) if extra else ""))
    if not cond:
        fails += 1


def build_payload():
    """A valid bare S4 gamedata payload with a few planted, verifiable values."""
    b = bytearray(SV.GD_SIZE)
    struct.pack_into("<I", b, SV.OFF_VERSION, 6)            # version = 6
    struct.pack_into("<H", b, SV.OFF_SLOT, 0)
    struct.pack_into("<I", b, SV.POTCH_OFF, 12345)          # potch
    struct.pack_into("<I", b, SV.GAMETIME_OFF, 3600)        # game time = 1h
    base = SV.CHAR_BASE                                      # roster index 0
    struct.pack_into("<H", b, base + SV.OFF_MAXHP, 181)     # max HP
    struct.pack_into("<H", b, base + SV.OFF_STATS, 58)      # STR = stats[0]
    b[base + SV.OFF_RUNES[0]] = 3                            # rune slot 0
    prog = SV.PROG_BASE                                      # roster 0 progression
    struct.pack_into("<I", b, prog + SV.OFF_PROG_EXP, 500)  # EXP
    b[prog + SV.OFF_PROG_WLVL] = 4                           # weapon level
    for lv in range(4):                                      # rune uses per spell level
        b[prog + SV.OFF_PROG_RUNE_USES + lv] = [3, 8, 0, 6][lv]      # remaining (array B)
        b[prog + SV.OFF_PROG_RUNE_USES_MAX + lv] = [9, 8, 7, 6][lv]  # max (array A)
    b[SV.RECRUIT_BASE] = 10                                  # roster 0 = "Recruited"
    for k, iid in enumerate([1, 1, 1, 26, 90]):              # bag: 3x Medicine, Green Bottle, God Hand
        struct.pack_into("<I", b, SV.INVENTORY_OFF + 4 * k, iid)
    nm = "TESTHERO".encode("latin1")                        # hero name field
    off, n, _ = next((o, nn, lbl) for k, o, nn, lbl in SV.NAME_FIELDS if k == "hero")
    b[off:off + len(nm)] = nm
    return SV.recompute_checksums(bytes(b))


def build_container(payload):
    """Wrap the payload so the engine sniffs it as a writable single-file save.
    A 64-byte header carrying the region folder name + the self-validating payload is
    detected as 'psu' by s4files._find_payload / _folder_of."""
    header = b"BASLUS-20979s400".ljust(64, b"\x00")
    return header + payload


def main():
    print("Save-engine round-trip (synthetic S4 gamedata):")
    tmp = tempfile.mkdtemp(prefix="s4save-test-")
    path = os.path.join(tmp, "save.psu")
    with open(path, "wb") as f:
        f.write(build_container(build_payload()))

    # --- decode ---
    saves = SV.read_all_s4_saves(path)
    check("decodes exactly one save", isinstance(saves, list) and len(saves) == 1, str(type(saves)))
    s = saves[0]
    c0 = next(c for c in s["characters"] if c["rosterIndex"] == 0)
    check("potch decoded", s["potch"] == 12345, str(s["potch"]))
    check("game time decoded", s["gameTimeSec"] == 3600, str(s["gameTimeSec"]))
    check("maxHP decoded", c0["maxHP"] == 181, str(c0["maxHP"]))
    check("STR stat decoded", c0["stats"]["STR"] == 58, str(c0["stats"]["STR"]))
    check("rune slot 0 decoded", c0["runes"][0] == 3, str(c0["runes"][0]))
    check("weapon level decoded", c0["weaponLvl"] == 4, str(c0["weaponLvl"]))
    check("rune uses decoded", c0["runeUses"] == [3, 8, 0, 6] and c0["runeUsesMax"] == [9, 8, 7, 6],
          "%s/%s" % (c0["runeUses"], c0["runeUsesMax"]))
    check("recruitment decoded", c0["recruited"] == 10, str(c0["recruited"]))
    check("hero name decoded", any(n["value"] == "TESTHERO" for n in s.get("names", [])))
    check("inventory decoded", s["inventory"] == [1, 1, 1, 26, 90], str(s["inventory"]))
    check("checksum reported valid", s["checksumValid"] is True)
    check("container is a writable single-file", s["writable"] is True and s["container"] == "psu")

    # --- edit (mirrors the web app's payload shape) ---
    res = SV.write_save_edits(
        path, s["folder"],
        char_edits={0: {"maxHP": 9999, "exp": 5000, "weaponLvl": 9, "recruited": 15,
                        "runeUses": [9, 8, 7, 6],
                        "stats": {"STR": 250}, "runes": {0: 7}, "equip": {"head": 16}}},
        name_edits={"hero": "Zephon", "ship": "Basel"},
        save_edits={"potch": 999999, "gameTime": 7200, "worldMapFull": 1,
                    "inventory": [1, 1, 44]},
        make_backup=False,
    )
    check("write reports ok", res.get("ok") is True, str(res))
    check("write changed multiple fields", res.get("changed", 0) >= 8, "changed=%s" % res.get("changed"))

    # --- re-decode the WRITTEN file (proves it stays a valid, decodable save) ---
    saves2 = SV.read_all_s4_saves(path)
    check("re-decodes after write", isinstance(saves2, list) and len(saves2) == 1)
    s2 = saves2[0]
    c2 = next(c for c in s2["characters"] if c["rosterIndex"] == 0)
    check("potch persisted", s2["potch"] == 999999, str(s2["potch"]))
    check("game time persisted", s2["gameTimeSec"] == 7200, str(s2["gameTimeSec"]))
    check("maxHP persisted", c2["maxHP"] == 9999)
    check("EXP persisted", c2["exp"] == 5000)
    check("weapon level persisted", c2["weaponLvl"] == 9)
    check("STR persisted", c2["stats"]["STR"] == 250)
    check("rune persisted", c2["runes"][0] == 7)
    check("rune uses refilled", c2["runeUses"] == [9, 8, 7, 6] and c2["runeUsesMax"] == [9, 8, 7, 6])
    check("equipment persisted", c2["equip"]["head"] == 16, str(c2["equip"]["head"]))
    check("recruitment persisted", c2["recruited"] == 15)
    check("hero name persisted", any(n["value"] == "Zephon" for n in s2.get("names", [])))
    check("inventory persisted", s2["inventory"] == [1, 1, 44], str(s2["inventory"]))
    check("world map fully explored", s2["worldMapPct"] >= 99.0, str(s2["worldMapPct"]))

    # --- inventory guard rails (refuse, never truncate or half-write) ---
    print("Inventory guard rails:")
    payload = build_payload()
    _, ch = SV.apply_edits_to_gamedata(payload, save_edits={"inventory": [1] * (SV.INVENTORY_SLOTS + 1)})
    check("oversize bag refused", ch == 0)
    _, ch = SV.apply_edits_to_gamedata(payload, save_edits={"inventory": [SV.ITEM_ID_MAX + 1]})
    check("out-of-range item id refused", ch == 0)
    _, ch = SV.apply_edits_to_gamedata(payload, save_edits={"inventory": [1, 1, 1, 26, 90]})
    check("unchanged bag is a no-op", ch == 0)
    out, ch = SV.apply_edits_to_gamedata(payload, save_edits={"inventory": []})
    check("bag can be emptied", ch == 1 and SV.decode_inventory(out) == [])
    check("checksum still valid after write", s2["checksumValid"] is True)

    # --- rejection path (what the web loader turns into a friendly message) ---
    bad = os.path.join(tmp, "junk.bin")
    with open(bad, "wb") as f:
        f.write(bytes(4096))
    rej = SV.read_all_s4_saves(bad)
    check("unrecognized file is rejected", isinstance(rej, dict) and "error" in rej, str(rej)[:60])

    # --- memory-card ECC helper (used when writing .ps2 cards) ---
    print("Memory-card ECC helper:")
    zero = SV.ecc_page(bytes(512))
    check("ecc_page returns 16 bytes", len(zero) == 16)
    check("ecc_page of a zero page is the known constant",
          zero == (bytes([0x77, 0x7F, 0x7F]) * 4) + b"\x00\x00\x00\x00", zero.hex())
    flipped = bytearray(512)
    flipped[0] = 0x01
    check("ecc changes when a byte flips (detects corruption)", SV.ecc_page(bytes(flipped)) != zero)

    print("\n%s" % ("All save round-trip checks passed." if fails == 0 else "%d check(s) FAILED." % fails))
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
