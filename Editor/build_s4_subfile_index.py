#!/usr/bin/env python3
"""Build the Suikoden IV FILEDATA sub-file index (issue #44).

FILEDATA.BI1 / FILEDATA.BI2 on the game disc are not single archives: each
is a run of back-to-back, self-describing archives. This script walks the
archive chain of both files inside the ISO (no magic scan needed - the
chain tiles perfectly), and emits s4_subfile_index.json: per archive its
offset/total/entry count, per entry its id, flags, offset and size.

FILEDATA.BIN is covered too: it was long recorded as "unrelated" because
it starts with a SYSTEM.CNF copy, but it holds the same archives in six
runs separated by other data (1,520 archives, 52,461 entries) - the runs
are found by a sector-aligned header scan and chain-walked the same way,
with the non-archive gaps recorded in the index.

Archive layout (verified against the pristine NTSC-U disc):
    +0x00  u32  magic 0x82734927
    +0x04  u32  0
    +0x08  u32  total archive size in bytes (before 2048-byte padding)
    +0x0C  u32  0
    +0x10  entry rows, 16 bytes each: (id u32, flags u32, offset u32, size u32)
           row[0] is a sentinel: its id field is the row count including
           itself, flags=32, offset=0, size=0. Real entries follow.
           Entry offsets are relative to the archive start and are always
           16-byte aligned.

The next archive starts at align2048(total). BI2 has 259 archives tiling
258/258 pairs; its last archive ends one sector short of the file size,
and that final sector is not padding - it holds a copy of the SYSTEM.CNF
text (the same quirk FILEDATA.BIN shows). BI1 has 1,066 archives tiling
1065/1065, and its last archive ends on the file's exact final byte.
(1,325 archives total; issue #44 said 1,326 - the chain walk shows the
extra "archive" was that SYSTEM.CNF tail sector.)

Usage:
    python3 build_s4_subfile_index.py [path-to.iso] [--out index.json]

Defaults: the ISO at ../Base ISO/Suikoden IV (USA).iso relative to this
script, output s4_subfile_index.json next to this script. Output is
deterministic: running twice on the same disc gives a byte-identical file.
Exit status is non-zero if any format invariant fails.
"""

import json
import os
import struct
import sys

MAGIC = 0x82734927
SECTOR = 2048


def align2048(n):
    return (n + SECTOR - 1) // SECTOR * SECTOR


# ---------------------------------------------------------------- ISO 9660 --
def parse_dir_records(buf):
    """Yield (name, extent_lba, size, is_dir) from a directory record run."""
    off = 0
    while off < len(buf):
        ln = buf[off]
        if ln == 0:
            # pad to the end of the current sector
            off = (off // SECTOR + 1) * SECTOR
            if off >= len(buf):
                break
            continue
        rec = buf[off:off + ln]
        if len(rec) < 34:
            break
        extent = struct.unpack_from("<I", rec, 2)[0]
        size = struct.unpack_from("<I", rec, 10)[0]
        flags = rec[25]
        nlen = rec[32]
        name = rec[33:33 + nlen]
        if name not in (b"\x00", b"\x01"):
            yield name.decode("ascii", "replace"), extent, size, bool(flags & 2)
        off += ln


def find_files(iso, wanted):
    """Walk the ISO9660 tree; return {NAME: (lba, size)} for wanted names."""
    iso.seek(16 * SECTOR)
    pvd = iso.read(SECTOR)
    if pvd[1:6] != b"CD001":
        raise SystemExit("not an ISO9660 image (no CD001 at sector 16)")
    root = pvd[156:156 + 34]
    root_lba, root_size = struct.unpack_from("<I", root, 2)[0], struct.unpack_from("<I", root, 10)[0]
    found = {}
    stack = [(root_lba, root_size)]
    while stack:
        lba, size = stack.pop()
        iso.seek(lba * SECTOR)
        buf = iso.read(size)
        for name, extent, fsize, is_dir in parse_dir_records(buf):
            base = name.split(";")[0].upper()
            if is_dir:
                stack.append((extent, fsize))
            elif base in wanted:
                found[base] = (extent, fsize)
    return found


# ------------------------------------------------------------- archive walk --
def walk_chain_at(iso, base, start, file_size, label, problems):
    """Walk one archive chain starting at a known header offset.
    Returns (archives, stats, end_pos)."""
    archives = []
    stats = {"flags": {}, "plus16_ok": 0, "plus16_bad": 0,
             "unaligned": 0, "tail_sector": None}
    pos = start
    while pos < file_size:
        iso.seek(base + pos)
        head = iso.read(16)
        if len(head) < 16:
            problems.append(f"{label}@{pos}: short header")
            break
        magic, z1, total, z2 = struct.unpack("<4I", head)
        if magic != MAGIC:
            if file_size - pos == SECTOR:
                # one trailing sector after the last archive (BI2: a
                # SYSTEM.CNF copy, not an archive and not zero padding)
                stats["tail_sector"] = head[:4]
                break
            break
        if z1 or z2:
            problems.append(f"{label}@{pos}: header zero fields are {z1},{z2}")
        if total <= 0 or pos + total > file_size:
            problems.append(f"{label}@{pos}: total {total} overruns file size {file_size}")
            break
        iso.seek(base + pos + 16)
        sentinel = struct.unpack("<4I", iso.read(16))
        rows, sflags, soff, ssize = sentinel
        if sflags != 32 or soff != 0 or ssize != 0:
            problems.append(f"{label}@{pos}: sentinel is {sentinel}, expected flags=32,off=0,size=0")
            break
        raw = iso.read(16 * (rows - 1)) if rows >= 1 else b""
        entries = []
        for i in range(rows - 1):
            eid, flags, eoff, esize = struct.unpack_from("<4I", raw, 16 * i)
            entries.append({"id": eid, "flags": flags, "offset": eoff, "size": esize})
            stats["flags"][flags] = stats["flags"].get(flags, 0) + 1
            if eoff % 16:
                stats["unaligned"] += 1
            if eoff + esize > total:
                problems.append(f"{label}@{pos} entry {i}: offset+size {eoff + esize} > archive total {total}")
        # the +16 rule (#45): for flags=2 entries with a successor (offset order)
        ordered = sorted(entries, key=lambda e: e["offset"])
        for cur, nxt in zip(ordered, ordered[1:]):
            if cur["flags"] == 2:
                if cur["size"] - (nxt["offset"] - cur["offset"]) == 16:
                    stats["plus16_ok"] += 1
                else:
                    stats["plus16_bad"] += 1
        archives.append({"offset": pos, "total": total, "entries": entries})
        nxt = pos + align2048(total)
        if nxt <= pos:
            problems.append(f"{label}@{pos}: chain does not advance")
            break
        pos = nxt
    return archives, stats, pos


def merge_stats(dst, src):
    for k, v in src["flags"].items():
        dst["flags"][k] = dst["flags"].get(k, 0) + v
    for k in ("plus16_ok", "plus16_bad", "unaligned"):
        dst[k] += src[k]
    if src.get("tail_sector") is not None:
        dst["tail_sector"] = src["tail_sector"]


def walk_archives(iso, file_lba, file_size, label, problems):
    """Walk one FILEDATA file's archive chain from offset 0 (BI1/BI2)."""
    archives, stats, _ = walk_chain_at(iso, file_lba * SECTOR, 0, file_size, label, problems)
    return archives, stats


def walk_runs(iso, file_lba, file_size, label, problems):
    """FILEDATA.BIN: archives live in runs separated by other data.
    Find every sector-aligned header, chain-walk each run once, and
    record the gaps. Returns (archives, stats, gaps)."""
    base = file_lba * SECTOR
    magic_bytes = struct.pack("<I", MAGIC)
    starts = []
    for s in range(file_size // SECTOR):
        iso.seek(base + s * SECTOR)
        if iso.read(4) == magic_bytes:
            starts.append(s * SECTOR)
    archives = []
    stats = {"flags": {}, "plus16_ok": 0, "plus16_bad": 0,
             "unaligned": 0, "tail_sector": None}
    covered = []
    for start in starts:
        if any(a <= start < b for a, b in covered):
            continue
        run, run_stats, end = walk_chain_at(iso, base, start, file_size, label, problems)
        if run:
            archives.extend(run)
            merge_stats(stats, run_stats)
            covered.append((start, end))
    gaps = []
    prev = 0
    for a, b in sorted(covered):
        if a > prev:
            iso.seek(base + prev)
            gaps.append({"offset": prev, "size": a - prev,
                         "head": iso.read(16).decode("latin-1")})
        prev = max(prev, b)
    if prev < file_size:
        iso.seek(base + prev)
        gaps.append({"offset": prev, "size": file_size - prev,
                     "head": iso.read(16).decode("latin-1")})
    return archives, stats, gaps


def main(argv):
    here = os.path.dirname(os.path.abspath(__file__))
    iso_path = os.path.join(here, "..", "Base ISO", "Suikoden IV (USA).iso")
    out_path = os.path.join(here, "s4_subfile_index.json")
    rest = argv[1:]
    if "--out" in rest:
        i = rest.index("--out")
        out_path = rest[i + 1]
        rest = rest[:i] + rest[i + 2:]
    if rest:
        iso_path = rest[0]

    problems = []
    index = {"format": "s4-subfile-index/1", "files": {}}
    with open(iso_path, "rb") as iso:
        found = find_files(iso, {"FILEDATA.BI1", "FILEDATA.BI2", "FILEDATA.BIN"})
        for name in ("FILEDATA.BI2", "FILEDATA.BI1", "FILEDATA.BIN"):
            if name not in found:
                problems.append(f"{name} not found in ISO")
                continue
            lba, size = found[name]
            if name == "FILEDATA.BIN":
                archives, stats, gaps = walk_runs(iso, lba, size, name, problems)
            else:
                archives, stats = walk_archives(iso, lba, size, name, problems)
                gaps = []
            n_entries = sum(len(a["entries"]) for a in archives)
            last_end = archives[-1]["offset"] + archives[-1]["total"] if archives else 0
            record = {"lba": lba, "size": size, "archives": archives}
            if gaps:
                record["gaps"] = gaps
            index["files"][name] = record
            print(f"{name}: LBA {lba}, {size} bytes, {len(archives)} archives, {n_entries} entries")
            print(f"  flags distribution: {dict(sorted(stats['flags'].items()))}")
            print(f"  last archive ends at {last_end} of {size} (delta {size - last_end})")
            if gaps:
                print(f"  non-archive gaps: {len(gaps)} totalling {sum(g['size'] for g in gaps)} bytes")
            if stats["tail_sector"] is not None:
                print(f"  trailing sector after last archive: starts {stats['tail_sector']!r} "
                      f"(SYSTEM.CNF copy on this disc)")
            print(f"  entry offsets 16-byte aligned: {n_entries - stats['unaligned']}/{n_entries}")
            print(f"  +16 rule (flags=2 with successor): {stats['plus16_ok']} ok, {stats['plus16_bad']} bad")

    with open(out_path, "w", encoding="utf-8") as fh:
        json.dump(index, fh, separators=(",", ":"), sort_keys=False)
        fh.write("\n")
    print(f"wrote {out_path} ({os.path.getsize(out_path)} bytes)")

    if problems:
        print(f"\n{len(problems)} PROBLEM(S):")
        for p in problems[:20]:
            print("  " + p)
        return 1
    print("\nall invariants hold")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
