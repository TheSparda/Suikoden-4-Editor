// Suikoden 4 ISO Editor — client-side, in-place, no upload.
//
// The save editor edits a tiny save wholesale in Pyodide; the ISO is ~4.36 GB and can't live
// in memory. But the only edits we expose are a handful of 4-byte code patches in the boot ELF.
// So we read just those tiny windows via ranged Blob.slice(), edit in memory, and on save either
//   • overwrite the changed bytes in place via the File System Access API (desktop Chromium), or
//   • stream a patched copy of the whole disc to downloads through our own service worker
//     (Android/Firefox — no in-place API for a 4 GB file, nothing uploaded).
//
// Reuses app.js's shared helpers ($, $$, esc, openConfirm, modalA11y, idbGet/idbSet/idbDel).
// Extend by adding entries to FIELDS — each is either a "percent"/"num" value or a "bool" code
// patch (on/off byte runs). Every offset here was verified against the real USA ISO.
(function () {
  "use strict";

  const ISO_ELF_START = 367 * 2048;          // boot ELF SLUS_209.79;1 at LBA 367 (0xB7800)

  // ---- editable fields (absolute ISO byte offsets; verified on the USA disc) ----
  // percent: rate = 100/N of default; N=round(10000/percent) is the rand range immediate.
  // bool:    a code patch — onBytes when checked, offBytes (the stock instruction) when not.
  const FIELDS = [
    {
      key: "encounterRate", group: "Random encounters", type: "percent",
      label: "Encounter rate", off: 0x10E43C, len: 4, def: 100, min: 1, max: 1000,
      unit: "% of normal",
      presets: [["¼", 25], ["Half", 50], ["Stock", 100], ["Double", 200], ["Triple", 300]],
      slider: [5, 300, 5],
      hint: "How often random battles happen, as a percent of the stock rate. The game rolls the " +
            "encounter threshold as rand(0..N-1); this sets N = round(10000 / percent). Lower = fewer.",
      sig: (b) => b[2] === 0x04 && b[3] === 0x24,     // addiu a0, zero, imm
      read: (dv) => { const N = dv.getUint16(0, true); return N ? Math.round(10000 / N) : 100; },
      write: (dv, pct) => {
        const N = Math.max(1, Math.min(0x7FFF, Math.round(10000 / Math.max(1, pct))));
        dv.setUint32(0, (0x24040000 | N) >>> 0, true);
      },
    },
    {
      key: "championAlways", group: "Random encounters", type: "bool",
      label: "Champion's Rune effect — always on",
      sub: "Skip battles against enemies weaker than your party, for the whole party, without " +
           "equipping the rune. Strong parties get near-total peace; weaker parties still fight. " +
           "This is the game's own Champion's Rune behaviour — softer than turning battles off.",
      off: 0x10E610, len: 4,
      onBytes: [0x00, 0x00, 0x00, 0x00],             // nop the "does anyone have the Champion's Rune?" branch
      offBytes: [0x09, 0x00, 0x80, 0x12],            // beqz s4, 0x2D5E38 (stock)
      sig: (b) => (b[0] === 0x09 && b[1] === 0x00 && b[2] === 0x80 && b[3] === 0x12) ||
                  (b[0] === 0x00 && b[1] === 0x00 && b[2] === 0x00 && b[3] === 0x00),
      read: (dv) => dv.getUint32(0, true) === 0 ? 1 : 0,
      write: (dv, on) => { (on ? [0, 0, 0, 0] : [0x09, 0x00, 0x80, 0x12]).forEach((v, i) => dv.setUint8(i, v)); },
    },
    {
      key: "noBattles", group: "Random encounters", type: "bool",
      label: "Turn off random battles completely",
      sub: "No random encounters anywhere — stronger than the Champion's Rune, which only stops " +
           "battles with weaker enemies. For fewer (not zero) battles, lower the rate instead; for " +
           "the Champion's Rune's selective effect, equip it in the Save Editor. Scripted story " +
           "fights still happen.",
      off: 0x10E484, len: 4,
      onBytes: [0x00, 0x00, 0x02, 0x24],              // li v0, 0  (force gate = no encounter)
      offBytes: [0x5C, 0x57, 0x0B, 0x0C],             // jal 0x2D5D70 (stock)
      sig: (b) => (b[0] === 0x5C && b[1] === 0x57 && b[2] === 0x0B && b[3] === 0x0C) ||
                  (b[0] === 0x00 && b[1] === 0x00 && b[2] === 0x02 && b[3] === 0x24),
      read: (dv) => dv.getUint8(3) === 0x24 && dv.getUint8(0) === 0x00 ? 1 : 0,
      write: (dv, on) => { (on ? [0x00, 0x00, 0x02, 0x24] : [0x5C, 0x57, 0x0B, 0x0C]).forEach((v, i) => dv.setUint8(i, v)); },
    },
    {
      key: "infItems", group: "Items", type: "bool",
      label: "Infinite item use",
      sub: "Items are not consumed when used — a Medicine heals and stays in the bag. " +
           "This is the community trainer tables' patch: it NOPs the instruction that loads " +
           "an item's remaining count on the use path (verified unique on the NTSC-U disc).",
      off: 0xFB878, len: 4,
      onBytes: [0x00, 0x00, 0x00, 0x00],             // nop the count load (patched)
      offBytes: [0x04, 0x00, 0x22, 0x92],            // lbu v0, 4(s1) (stock)
      sig: (b) => (b[0] === 0x04 && b[1] === 0x00 && b[2] === 0x22 && b[3] === 0x92) ||
                  (b[0] === 0x00 && b[1] === 0x00 && b[2] === 0x00 && b[3] === 0x00),
      read: (dv) => dv.getUint32(0, true) === 0 ? 1 : 0,
      write: (dv, on) => { (on ? [0, 0, 0, 0] : [0x04, 0x00, 0x22, 0x92]).forEach((v, i) => dv.setUint8(i, v)); },
    },
    {
      key: "freeCasting", group: "Battle", type: "bool",
      label: "Free rune casting",
      sub: "Casting never spends a rune use. The cast path ends by calling the use-count " +
           "deduction (jal at 0x45F26C); NOP-ing that call leaves the per-level counts " +
           "untouched. Located by static RE of the game's own code (lab reward_sites.md) " +
           "and verified against the NTSC-U disc; covers the main cast path.",
      off: 0x297A6C, len: 4,
      onBytes: [0x00, 0x00, 0x00, 0x00],             // nop (patched)
      offBytes: [0x96, 0xEE, 0x0A, 0x0C],            // jal 0x2BBA58 (stock)
      sig: (b) => (b[0] === 0x96 && b[1] === 0xEE && b[2] === 0x0A && b[3] === 0x0C) ||
                  (b[0] === 0x00 && b[1] === 0x00 && b[2] === 0x00 && b[3] === 0x00),
      read: (dv) => dv.getUint32(0, true) === 0 ? 1 : 0,
      write: (dv, on) => { (on ? [0, 0, 0, 0] : [0x96, 0xEE, 0x0A, 0x0C]).forEach((v, i) => dv.setUint8(i, v)); },
    },
  ];

  // ---- spell targeting table (issue #50) ---------------------------------------
  // The action/spell definition table (205 records x 48 bytes) lives inside
  // FILEDATA.BIN's database entries: archive 3 entry 0x6AB (table at entry +660)
  // and a byte-identical duplicate in archive 7 entry 0x6AA (table at +52).
  // Both copies are read as edit windows and always written together.
  // A spell's LOGICAL record starts 12 bytes into its grid record:
  //   +0/+2 text indices, +4 element, +6 target-scope code, clause words at
  //   +8/+16/+28 (high byte: 0x10 = one target, 0x04 = all targets, other bits
  //   are flags like 0x80 drain / 0x40 self), power at +44.
  // Full analysis: lab spell_table.md; per-spell data in Editor/s4_spells.json.
  const SPELL_TABS = [
    { key: "spellTabA", at: 0x7867E274, len: 9840 },
    { key: "spellTabB", at: 0x7874D774, len: 9840 },
  ];
  const SPELL_FIRST = 1, SPELL_LAST = 45;      // rune spells + unites
  // Target-scope codes (record +6 low byte), paired within each spell kind.
  const SCOPE_PAIRS = {
    0x0A: { one: 0x0A, all: 0x22, oneLabel: "One enemy", allLabel: "All enemies" },
    0x22: { one: 0x0A, all: 0x22, oneLabel: "One enemy", allLabel: "All enemies" },
    0x07: { one: 0x07, all: 0x13, oneLabel: "One ally", allLabel: "All allies" },
    0x13: { one: 0x07, all: 0x13, oneLabel: "One ally", allLabel: "All allies" },
    0x06: { one: 0x06, all: 0x12, oneLabel: "One ally", allLabel: "All allies" },
    0x12: { one: 0x06, all: 0x12, oneLabel: "One ally", allLabel: "All allies" },
  };
  const SCOPE_FIXED = { 0x42: "Special (mixed targets)", 0x87: "One ally (revive)" };
  const CLAUSE_OFFS = [8, 16, 28];
  const spellRecOff = (id) => 48 * id + 12;
  function spellSig(b) {
    const dv = new DataView(b.buffer, b.byteOffset, b.length);
    return dv.getUint16(12, true) === 0 && dv.getUint16(14, true) === 1 &&
           dv.getUint16(60, true) === 2 && dv.getUint16(62, true) === 3 &&
           dv.getUint16(spellRecOff(22), true) === 44 && dv.getUint16(spellRecOff(22) + 44, true) === 300;
  }
  function scopeLabel(code) {
    const p = SCOPE_PAIRS[code];
    if (p) return code === p.all ? p.allLabel : p.oneLabel;
    return SCOPE_FIXED[code] || `Fixed (0x${code.toString(16).toUpperCase()})`;
  }
  // Flip a clause word's scope bit (0x10 one <-> 0x04 all), preserving flag bits.
  function scopeFlipWord(w, toAll) {
    const hi = w >> 8, lo = w & 0xFF;
    if (toAll && (hi & 0x10) && !(hi & 0x04)) return (((hi & ~0x10) | 0x04) << 8) | lo;
    if (!toAll && (hi & 0x04) && !(hi & 0x10)) return (((hi & ~0x04) | 0x10) << 8) | lo;
    return w;
  }
  // Read one spell's scope-relevant values from a table window's bytes.
  function spellVals(buf, id) {
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.length);
    const base = spellRecOff(id);
    return { code: dv.getUint8(base + 6), clauses: CLAUSE_OFFS.map((o) => dv.getUint16(base + o, true)) };
  }
  function spellDirty(id) {
    const w = win("spellTabA"); if (!w || !SPELLS || SPELLS.error) return false;
    const s = SPELLS.spells[id]; if (!s) return false;
    const cur = spellVals(w.buf, id);
    return cur.code !== s.code || cur.clauses.some((c, i) => c !== s.clauses[i]);
  }
  function anySpellDirty() {
    if (!win("spellTabA") || !SPELLS || SPELLS.error) return false;
    for (let id = SPELL_FIRST; id <= SPELL_LAST; id++) if (spellDirty(id)) return true;
    return false;
  }
  function writeSpell(id, code, clauses) {
    for (const t of SPELL_TABS) {
      const w = win(t.key); if (!w) continue;
      const base = spellRecOff(id);
      w.dv.setUint8(base + 6, code);
      CLAUSE_OFFS.forEach((o, i) => w.dv.setUint16(base + o, clauses[i], true));
    }
  }
  function applySpellScope(id, newCode) {
    const pair = SCOPE_PAIRS[newCode]; if (!pair) return;
    const w = win("spellTabA"); if (!w) return;
    const cur = spellVals(w.buf, id);
    const toAll = newCode === pair.all;
    writeSpell(id, newCode, cur.clauses.map((c) => scopeFlipWord(c, toAll)));
  }
  function restoreSpell(id) {
    const s = SPELLS && SPELLS.spells[id]; if (!s) return;
    writeSpell(id, s.code, s.clauses.slice());
  }

  // ---- capability detection ---------------------------------------------------
  const SUPPORTS_FS = typeof window !== "undefined" && typeof window.showOpenFilePicker === "function";
  const CAN_TRANSFER_STREAM = (() => {
    try { const rs = new ReadableStream(); new MessageChannel().port1.postMessage(rs, [rs]); return true; }
    catch (e) { return false; }
  })();
  const CAN_STREAM_SAVE = typeof navigator !== "undefined" && "serviceWorker" in navigator && CAN_TRANSFER_STREAM;

  // ---- state ------------------------------------------------------------------
  let isoHandle = null, isoName = "", isoFile = null;
  let WINDOWS = {};        // key -> {off, len, buf, orig, dv, odv}
  let inited = false, saveNudged = false;
  // Tab shell: Patches (the FIELDS editors) / Spells (spell targeting, #50) /
  // Files (the FILEDATA sub-file browser over Editor/s4_subfile_index.json).
  let VIEW = "patches";
  let IDX = null, IDX_C = "FILEDATA.BI2", IDX_A = 0, IDX_Q = "";
  let SPELLS = null;         // Editor/s4_spells.json, fetched lazily

  const win = (k) => WINDOWS[k];
  const fmtSize = (n) => n >= 1e9 ? (n / 1e9).toFixed(2) + " GB" : n >= 1e6 ? (n / 1e6).toFixed(1) + " MB" : Math.round(n / 1e3) + " KB";
  const fmtDur = (ms) => ms >= 60000 ? `${Math.floor(ms / 60000)}m${String(Math.round((ms % 60000) / 1000)).padStart(2, "0")}s` : `${(ms / 1000).toFixed(1)}s`;
  const setStatus = (m, k) => { const el = $("#isoStatus"); if (el) { el.textContent = m; el.className = "status" + (k ? " " + k : ""); } };
  const setBoot = (m, err) => { const el = $("#isoBoot"); if (el) el.innerHTML = (err ? "⚠ " : "") + esc(m); };

  function fieldValue(f, from) { return f.read(new DataView(from.buffer, from.byteOffset, from.length)); }
  function isDirty(k) { const w = win(k); return w && w.buf.some((b, i) => b !== w.orig[i]); }
  function anyDirty() { return Object.keys(WINDOWS).some(isDirty); }
  // absolute-offset changed runs across all windows
  function allRuns() {
    const out = [];
    for (const k in WINDOWS) {
      const w = WINDOWS[k]; let i = 0;
      while (i < w.len) {
        if (w.buf[i] !== w.orig[i]) { const s = i; while (i < w.len && w.buf[i] !== w.orig[i]) i++; out.push({ off: w.off + s, bytes: w.buf.slice(s, i) }); }
        else i++;
      }
    }
    return out;
  }

  // ---- load -------------------------------------------------------------------
  async function openViaPicker() {
    let handle;
    try { [handle] = await window.showOpenFilePicker({ multiple: false }); }
    catch (e) { if (e && e.name !== "AbortError") setStatus("Could not open ISO: " + e.message, "err"); return; }
    try { await commitIso(await handle.getFile(), handle); }
    catch (e) { setStatus("Could not read that file: " + e.message, "err"); }
  }
  async function loadInput(file) { return commitIso(file, null); }

  async function commitIso(file, handle) {
    setStatus("Reading disc region…", "");
    const maxOff = Math.max(
      FIELDS.reduce((a, f) => Math.max(a, f.off + f.len), 0),
      SPELL_TABS.reduce((a, t) => Math.max(a, t.at + t.len), 0));
    if (file.size < maxOff) return setStatus(`That file is only ${fmtSize(file.size)} — not a full Suikoden IV ISO.`, "err");
    const wins = {};
    for (const f of FIELDS) {
      let bytes;
      try { bytes = new Uint8Array(await file.slice(f.off, f.off + f.len).arrayBuffer()); }
      catch (e) { return setStatus("Read failed: " + e.message, "err"); }
      if (bytes.length !== f.len) return setStatus("Could not read the disc region (file too short).", "err");
      if (f.sig && !f.sig(bytes)) {
        return setStatus(`This doesn't look like the NTSC-U (SLUS-209.79) Suikoden IV ISO ` +
          `(unexpected bytes at 0x${f.off.toString(16).toUpperCase()}). PAL/other builds aren't supported here.`, "err");
      }
      wins[f.key] = { off: f.off, len: f.len, buf: bytes, orig: bytes.slice(), dv: new DataView(bytes.buffer), odv: new DataView(bytes.slice().buffer) };
    }
    for (const t of SPELL_TABS) {
      let bytes;
      try { bytes = new Uint8Array(await file.slice(t.at, t.at + t.len).arrayBuffer()); }
      catch (e) { return setStatus("Read failed: " + e.message, "err"); }
      if (bytes.length !== t.len || !spellSig(bytes)) {
        return setStatus(`This doesn't look like the NTSC-U (SLUS-209.79) Suikoden IV ISO ` +
          `(the spell table at 0x${t.at.toString(16).toUpperCase()} didn't match). PAL/other builds aren't supported here.`, "err");
      }
      wins[t.key] = { off: t.at, len: t.len, buf: bytes, orig: bytes.slice(), dv: new DataView(bytes.buffer), odv: new DataView(bytes.slice().buffer) };
    }
    WINDOWS = wins; isoHandle = handle; isoFile = file; isoName = file.name || "Suikoden IV.iso";
    saveNudged = false;
    if (handle) idbSet("lastIso", { name: isoName, handle, at: Date.now() }).catch(() => {});
    render();
    setStatus(`Loaded ${isoName} — NTSC-U verified.`, "ok");
  }

  function saveMode() {
    if (SUPPORTS_FS && isoHandle) return "inplace";
    if (CAN_STREAM_SAVE && isoFile) return "stream";
    return "none";
  }

  // ---- last-opened (persist the HANDLE only; never the 4 GB bytes) ------------
  async function showRecent() {
    const el = $("#isoRecent"); if (!el) return;
    let rec; try { rec = await idbGet("lastIso"); } catch (e) { return; }
    if (!rec || !rec.handle) { el.innerHTML = ""; return; }
    el.innerHTML = `<div class="recent">Last opened:
        <button class="chip" id="isoReopen">↻ ${esc(rec.name)}</button>
        <button class="chip mini" id="isoForget" title="forget">✕</button></div>`;
    $("#isoReopen").onclick = async () => {
      try {
        const opts = { mode: "readwrite" };
        if ((await rec.handle.queryPermission(opts)) !== "granted" && (await rec.handle.requestPermission(opts)) !== "granted")
          return setStatus("Reopen cancelled — permission denied.", "warn");
        await commitIso(await rec.handle.getFile(), rec.handle);
      } catch (e) { setStatus("Could not reopen — pick the file again.", "err"); }
    };
    $("#isoForget").onclick = async () => { await idbDel("lastIso").catch(() => {}); el.innerHTML = ""; };
  }

  // ---- render -----------------------------------------------------------------
  function init() {
    if (inited) return;
    inited = true;
    const root = $("#isoRoot");
    root.innerHTML = `
      <div class="card" id="isoLoader">
        <h2>1 · Open ISO</h2>
        ${SUPPORTS_FS || CAN_STREAM_SAVE ? "" :
          `<div class="warnbox">This browser can't write a 4 GB ISO. Use desktop Chrome/Edge/Brave/Opera
            (edit in place) or Android Chrome/Firefox (streams a patched copy). You can still open an ISO
            here to read values, and copy the pnach line below.</div>`}
        <div class="drop" id="isoDrop">
          <div><b>Drop your Suikoden IV ISO here</b> or</div>
          <label class="file"><button type="button" id="isoPick">Choose ISO…</button>
            <input type="file" id="isoFileInput"></label>
          <div class="muted" id="isoBoot" style="margin-top:8px">NTSC-U (SLUS-209.79) only. Nothing is uploaded — the disc is read on your device.</div>
        </div>
        <div id="isoRecent"></div>
      </div>
      <div id="isoEditor"></div>`;
    $("#isoPick").onclick = () => (SUPPORTS_FS ? openViaPicker() : $("#isoFileInput").click());
    $("#isoFileInput").onchange = (e) => { if (e.target.files[0]) loadInput(e.target.files[0]); };
    const drop = $("#isoDrop");
    ["dragenter", "dragover"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("hot"); }));
    ["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("hot"); }));
    drop.addEventListener("drop", async (e) => {
      const item = e.dataTransfer.items && e.dataTransfer.items[0];
      if (SUPPORTS_FS && item && item.getAsFileSystemHandle) {
        try { const h = await item.getAsFileSystemHandle(); if (h && h.kind === "file") return commitIso(await h.getFile(), h); } catch (err) {}
      }
      const f = e.dataTransfer.files[0]; if (f) loadInput(f);
    });
    showRecent();
  }

  function tabsHtml() {
    return `<div class="subtabs" style="margin-bottom:10px">
      <button class="chip${VIEW === "patches" ? " on" : ""}" data-isoview="patches">Patches</button>
      <button class="chip${VIEW === "spells" ? " on" : ""}" data-isoview="spells">Spells</button>
      <button class="chip${VIEW === "files" ? " on" : ""}" data-isoview="files">Files</button>
    </div>`;
  }
  function wireTabs() {
    $$("[data-isoview]").forEach((b) => (b.onclick = () => { VIEW = b.dataset.isoview; render(); }));
  }

  // ---- Files view (FILEDATA sub-file browser) ----------------------------------
  async function loadIdx() {
    try { IDX = await (await fetch(`${EDITOR_DIR}/s4_subfile_index.json`)).json(); }
    catch (e) { IDX = { error: String(e) }; }
    if (VIEW === "files") render();
  }
  function filesHtml() {
    if (!IDX) { loadIdx(); return `<div class="card"><span class="muted">Loading the FILEDATA index (5.9 MB, once)…</span></div>`; }
    if (IDX.error) return `<div class="card"><span class="status err">Index failed to load: ${esc(IDX.error)}</span></div>`;
    const names = Object.keys(IDX.files);
    const cont = IDX.files[IDX_C] || IDX.files[names[0]];
    IDX_A = Math.max(0, Math.min(IDX_A, cont.archives.length - 1));
    const arch = cont.archives[IDX_A];
    const totalEntries = cont.archives.reduce((n, a) => n + a.entries.length, 0);
    const q = IDX_Q.trim().toLowerCase();
    const rows = arch.entries.filter((e) => !q || String(e.id) === q || e.id.toString(16) === q.replace(/^0x/, ""));
    return `<div class="card">
      <div class="row" style="gap:8px;flex-wrap:wrap;align-items:center">
        <select id="idxC">${names.map((n) => `<option${n === IDX_C ? " selected" : ""}>${n}</option>`).join("")}</select>
        <span class="muted">${cont.archives.length} archives · ${totalEntries} entries · LBA ${cont.lba}</span>
      </div>
      <div class="row" style="gap:8px;flex-wrap:wrap;align-items:center;margin-top:8px">
        <button type="button" class="chip mini" id="idxPrev">← Prev archive</button>
        <span>Archive <input type="number" id="idxA" min="0" max="${cont.archives.length - 1}" value="${IDX_A}" style="width:80px"> of ${cont.archives.length - 1}</span>
        <button type="button" class="chip mini" id="idxNext">Next archive →</button>
        <span class="muted">disc offset ${arch.offset} · total size ${arch.total}</span>
      </div>
      <input class="search" id="idxQ" placeholder="filter entries by id (decimal or hex)…" value="${esc(IDX_Q)}" style="margin-top:8px">
      <table class="invtbl" style="margin-top:8px"><thead><tr><th>Entry id</th><th>Flags</th><th>Offset</th><th>Size</th></tr></thead>
      <tbody>${rows.slice(0, 1000).map((e) => `<tr><td class="sl">${e.id} (0x${e.id.toString(16).toUpperCase()})</td><td>${e.flags}</td><td>${e.offset}</td><td>${e.size}</td></tr>`).join("") || `<tr><td colspan="4" class="muted">no matching entries</td></tr>`}</tbody></table>
      ${rows.length > 1000 ? `<div class="fnote">Showing the first 1000 of ${rows.length} entries.</div>` : ""}
    </div>`;
  }
  function wireFiles() {
    const c = $("#idxC"); if (c) c.onchange = () => { IDX_C = c.value; IDX_A = 0; render(); };
    const a = $("#idxA"); if (a) a.onchange = () => { IDX_A = Math.max(0, +a.value || 0); render(); };
    const p = $("#idxPrev"); if (p) p.onclick = () => { IDX_A = Math.max(0, IDX_A - 1); render(); };
    const n = $("#idxNext"); if (n) n.onclick = () => { IDX_A = IDX_A + 1; render(); };
    const q = $("#idxQ");
    if (q) q.oninput = () => { IDX_Q = q.value; const pos = q.selectionStart; render(); const nq = $("#idxQ"); if (nq) { nq.focus(); nq.setSelectionRange(pos, pos); } };
  }

  // ---- Spells view (spell targeting / shape, issue #50) ------------------------
  async function loadSpells() {
    try { SPELLS = await (await fetch(`${EDITOR_DIR}/s4_spells.json`)).json(); }
    catch (e) { SPELLS = { error: String(e) }; }
    if (VIEW === "spells" || VIEW === "patches") render();
  }
  function spellRowHtml(s) {
    const w = win("spellTabA");
    const cur = spellVals(w.buf, s.id);
    const pair = SCOPE_PAIRS[cur.code];
    const dirty = spellDirty(s.id);
    const ctl = pair
      ? `<select data-spell="${s.id}">
           <option value="${pair.one}"${cur.code === pair.one ? " selected" : ""}>${esc(pair.oneLabel)}</option>
           <option value="${pair.all}"${cur.code === pair.all ? " selected" : ""}>${esc(pair.allLabel)}</option>
         </select>`
      : `<span class="muted">${esc(scopeLabel(cur.code))}</span>`;
    return `<div class="invrow"><span class="invname"><b>${esc(s.name)}</b>
        <span class="muted">${esc(s.desc)}</span></span>
      <span class="invctl">${s.power ? `<span class="muted">PWR ${s.power}</span>` : ""}${ctl}
      ${dirty ? `<span class="pill">changed</span> <button type="button" class="chip mini" data-spellrestore="${s.id}" title="stage the stock targeting">↺ restore</button>` : `<span class="pill on">stock</span>`}</span></div>`;
  }
  function spellsHtml() {
    if (!SPELLS) { loadSpells(); return `<div class="card"><span class="muted">Loading spell data…</span></div>`; }
    if (SPELLS.error) return `<div class="card"><span class="status err">Spell data failed to load: ${esc(SPELLS.error)}</span></div>`;
    const list = SPELLS.spells.slice(SPELL_FIRST, SPELL_LAST + 1);
    let html = `<div class="card"><h3 class="sec">Spell targeting</h3>
      <div class="fnote">Change which targets a spell hits: make a single-target spell hit every
      enemy or every ally, or narrow an all-target spell back to one. The scope code in each
      spell's definition record is switched within its own kind (damage, heal or buff), and the
      target bits of its effect clauses follow, mirroring how the game's own spells are built.
      Both copies of the table on the disc are patched together. Spells marked “Special” or
      “revive” have no verified single/all pair and stay fixed.</div>
      ${anySpellDirty() ? `<div class="toolbar"><button id="isoSpellRestoreAll">Restore all spell targeting to stock</button></div>` : ""}`;
    let lastElem = null;
    for (const s of list) {
      if (s.element !== lastElem) {
        if (lastElem !== null) html += `</div>`;
        html += `<div class="card"><h3 class="sec">${esc(s.elementName)}</h3>`;
        lastElem = s.element;
      }
      html += spellRowHtml(s);
    }
    if (lastElem !== null) html += `</div>`;
    return html;
  }
  function wireSpells() {
    $$("[data-spell]").forEach((sel) => (sel.onchange = () => { applySpellScope(+sel.dataset.spell, +sel.value); render(); }));
    $$("[data-spellrestore]").forEach((b) => (b.onclick = () => { restoreSpell(+b.dataset.spellrestore); render(); }));
    const ra = $("#isoSpellRestoreAll");
    if (ra) ra.onclick = () => { for (let id = SPELL_FIRST; id <= SPELL_LAST; id++) restoreSpell(id); render(); };
  }

  function saveCardHtml() {
    const mode = saveMode();
    const modeNote = mode === "inplace" ? "edits write in place to your ISO"
      : mode === "stream" ? "saving streams a patched copy to your downloads"
      : "this browser can't write the ISO — copy the pnach line instead";
    return `
      <div class="card">
        <div class="row" style="justify-content:space-between;flex-wrap:wrap;gap:8px">
          <button class="chip" id="isoPnach">⧉ Copy pnach line</button>
          <span class="muted">${esc(isoName)} · ${esc(modeNote)}</span>
        </div>
        <div class="row" style="flex-wrap:wrap;gap:8px;margin-top:8px">
          <button class="chip" id="isoRecipe">⤓ Export .s4mod</button>
          <button class="chip" id="isoXdelta">⤓ Export .xdelta</button>
          <button class="chip" id="isoPatchBtn">⤒ Apply patch…</button>
          <input type="file" id="isoPatchFile" accept=".s4mod,.xdelta,.json" style="display:none">
        </div>
        <div class="toolbar">
          ${mode === "none"
            ? `<span class="status warn">Open on desktop Chromium or Android Chrome to write the ISO. Meanwhile, use “Copy pnach line”.</span>`
            : `<button class="primary" id="isoSave">${mode === "stream" ? "Save patched copy" : "Save to ISO"}</button>
               <button id="isoReset">Reset</button>
               <span class="status" id="isoStatus"></span>`}
        </div>
      </div>`;
  }
  function wireSaveCard() {
    const sv = $("#isoSave"); if (sv) sv.onclick = save;
    const rs = $("#isoReset"); if (rs) rs.onclick = () => { for (const k in WINDOWS) WINDOWS[k].buf.set(WINDOWS[k].orig); render(); };
    const pn = $("#isoPnach"); if (pn) pn.onclick = copyPnach;
    const er = $("#isoRecipe"); if (er) er.onclick = exportRecipe;
    const ex = $("#isoXdelta"); if (ex) ex.onclick = exportXdelta;
    const pb = $("#isoPatchBtn"), pf = $("#isoPatchFile");
    if (pb && pf) { pb.onclick = () => pf.click(); pf.onchange = () => { if (pf.files[0]) applyPatchFile(pf.files[0]); pf.value = ""; }; }
    $$("[data-restore]").forEach((b) => (b.onclick = () => {
      const f = FIELDS.find((x) => x.key === b.dataset.restore);
      const w = f && win(f.key); if (!w) return;
      w.buf.set(stockBytes(f)); render();
    }));
    const ra = $("#isoRestoreAll");
    if (ra) ra.onclick = () => { FIELDS.forEach((f) => { const w = win(f.key); if (w) w.buf.set(stockBytes(f)); }); render(); };
  }

  function render() {
    if (!Object.keys(WINDOWS).length) return;
    if (VIEW === "files") { $("#isoEditor").innerHTML = tabsHtml() + filesHtml(); wireTabs(); wireFiles(); return; }
    if (VIEW === "spells") { $("#isoEditor").innerHTML = tabsHtml() + spellsHtml() + saveCardHtml(); wireTabs(); wireSpells(); wireSaveCard(); return; }
    const groups = {};
    FIELDS.forEach((f) => (groups[f.group] = groups[f.group] || []).push(f));
    const groupHtml = Object.entries(groups).map(([g, fs]) => {
      const vals = fs.filter((f) => f.type !== "bool"), bools = fs.filter((f) => f.type === "bool");
      return `<div class="card"><h3 class="sec">${esc(g)}</h3>
        ${vals.length ? `<div class="isovals">${vals.map(fieldHtml).join("")}</div>` : ""}
        ${bools.length ? `<div class="isotoggles">${bools.map(fieldHtml).join("")}</div>` : ""}
      </div>`;
    }).join("");

    $("#isoEditor").innerHTML = tabsHtml() + groupHtml + changesHtml() + saveCardHtml();

    FIELDS.forEach(wireField);
    syncEnable();
    wireSaveCard();
    wireTabs();
  }

  function fieldHtml(f) {
    const w = win(f.key); const cur = f.read(w.dv);
    if (f.type === "bool") {
      return `<label class="isotoggle"><input type="checkbox" data-iso="${f.key}" ${cur ? "checked" : ""}>
          <span class="isotxt"><b>${esc(f.label)}</b>${f.sub ? `<span class="isosub">${esc(f.sub)}</span>` : ""}</span></label>`;
    }
    const presets = (f.presets || []).map(([lbl, v]) =>
      `<button type="button" class="chip mini" data-preset="${f.key}" data-pv="${v}"${v === cur ? ' aria-pressed="true"' : ""}>${esc(lbl)}</button>`).join("");
    const sl = f.slider;
    const sliderHtml = sl
      ? `<input type="range" class="rateslider" data-rateslider="${f.key}" min="${sl[0]}" max="${sl[1]}" step="${sl[2] || 1}" value="${Math.min(sl[1], Math.max(sl[0], cur))}" aria-label="${esc(f.label)}">` : "";
    return `<div class="field ratefield" data-fieldwrap="${f.key}"><span>${esc(f.label)} <span class="muted">(${esc(f.unit || "")})</span></span>
        ${presets ? `<div class="presetrow">${presets}</div>` : ""}
        <div class="raterow">
          ${sliderHtml}
          <input type="number" min="${f.min || 0}" max="${f.max || 999999}" value="${cur}" data-iso="${f.key}" data-def="${cur}" class="rateinput">
          <span class="ratetag" data-ratetag="${f.key}">${esc(rateTag(cur))}</span>
        </div>
        ${f.hint ? `<div class="fnote ratefnote">${esc(f.hint)}</div>` : ""}</div>`;
  }
  // friendly readout of a percent, e.g. 50 -> "≈ ½× the battles", 200 -> "≈ 2× the battles"
  function rateTag(p) {
    p = +p || 0; if (!p) return "";
    if (p === 100) return "= the game's normal rate";
    const FR = { 50: "½", 25: "¼", 20: "⅕", 10: "1/10" };
    const s = p < 100 ? (FR[p] || "1/" + Math.round(100 / p)) : (Number.isInteger(p / 100) ? p / 100 : (p / 100).toFixed(1)) + "×";
    return `≈ ${s} the battles`;
  }

  function wireField(f) {
    const el = document.querySelector(`[data-iso="${f.key}"]`); if (!el) return;
    const w = win(f.key);
    const sliders = () => document.querySelectorAll(`[data-rateslider="${f.key}"]`);
    // light up the preset chip that matches the current value (if any)
    const highlight = () => document.querySelectorAll(`[data-preset="${f.key}"]`).forEach((b) => {
      if (+b.dataset.pv === (+el.value || 0)) b.setAttribute("aria-pressed", "true"); else b.removeAttribute("aria-pressed");
    });
    // slider, number box, and presets all funnel through this one commit
    const commit = () => {
      if (f.type === "bool") f.write(w.dv, el.checked ? 1 : 0);
      else f.write(w.dv, +el.value || f.def);
      el.classList && el.classList.toggle("dirty", isDirty(f.key));
      const tag = document.querySelector(`[data-ratetag="${f.key}"]`);
      if (tag) tag.textContent = rateTag(el.value);
      sliders().forEach((sl) => { const v = Math.min(+sl.max, Math.max(+sl.min, +el.value || 0)); if (+sl.value !== v) sl.value = v; });
      if (f.type !== "bool") highlight();
      syncEnable();
    };
    el.onchange = el.oninput = commit;
    sliders().forEach((sl) => (sl.oninput = () => { el.value = sl.value; commit(); }));
    document.querySelectorAll(`[data-preset="${f.key}"]`).forEach((b) => (b.onclick = () => { el.value = b.dataset.pv; commit(); }));
  }

  // When "turn off random battles" is on, the rate and the Champion toggle are moot — grey them.
  function syncEnable() {
    const cb = document.querySelector('[data-iso="noBattles"]');
    const off = !!(cb && cb.checked);
    const wrap = document.querySelector('[data-fieldwrap="encounterRate"]');
    if (wrap) {
      wrap.classList.toggle("disabled", off);
      wrap.querySelectorAll("input,button").forEach((el) => (el.disabled = off));
      let note = wrap.querySelector(".isonote");
      if (off && !note) { note = document.createElement("div"); note.className = "fnote isonote"; note.textContent = "Ignored — all random battles are off."; wrap.appendChild(note); }
      else if (!off && note) note.remove();
    }
    const champ = document.querySelector('[data-iso="championAlways"]');
    if (champ) { const row = champ.closest(".isotoggle"); if (row) row.classList.toggle("disabled", off); champ.disabled = off; }
  }

  // ---- review + save ----------------------------------------------------------
  // ISO file offset → EE RAM virtual address (for pnach codes): the boot ELF's PT_LOAD segment
  // maps file 0x1000 → vaddr 0x280000, so vaddr = 0x280000 + (isoOff - ELF_START - 0x1000).
  const isoToVaddr = (off) => 0x280000 + (off - ISO_ELF_START - 0x1000);

  function reviewRows() {
    const rows = [];
    for (const f of FIELDS) {
      if (!isDirty(f.key)) continue;
      const w = win(f.key);
      const ov = f.read(new DataView(w.orig.buffer)), nv = f.read(w.dv);
      const fmt = (x) => f.type === "bool" ? (x ? "on" : "off") : `${x}${f.type === "percent" ? "%" : ""}`;
      rows.push({ g: f.group, t: `${f.label}: ${fmt(ov)} → ${fmt(nv)}` });
    }
    const tw = win("spellTabA");
    if (tw && isDirty("spellTabA")) {
      for (let id = SPELL_FIRST; id <= SPELL_LAST; id++) {
        const before = spellVals(tw.orig, id), now = spellVals(tw.buf, id);
        if (before.code === now.code && before.clauses.every((c, i) => c === now.clauses[i])) continue;
        const nm = (SPELLS && SPELLS.spells && SPELLS.spells[id]) ? SPELLS.spells[id].name : `Spell ${id}`;
        rows.push({ g: "Spell targeting", t: `${nm}: ${scopeLabel(before.code)} → ${scopeLabel(now.code)}` });
      }
    }
    return rows;
  }

  function save() {
    if (!anyDirty()) return setStatus("No changes to save.", "warn");
    if (saveMode() === "none") return setStatus("This browser can't write the ISO — use “Copy pnach line”.", "warn");
    const rows = reviewRows();
    const label = saveMode() === "stream" ? `Save patched copy (~${fmtSize(isoFile.size)} download)` : `Write to ${isoName}`;
    openConfirm(rows, () => (saveMode() === "stream" ? doStreamSave() : doInPlace()), label);
  }

  async function doInPlace() {
    const runs = allRuns();
    const pg = progressModal();
    try {
      pg.phase("Preparing", `Making a safe copy of ${isoName} before writing… nothing is uploaded, and the original stays intact until this finishes.`, { indet: true });
      const w = await isoHandle.createWritable({ keepExistingData: true });
      let done = 0;
      pg.phase("Writing", `Applying ${runs.length} change(s) in place…`, { pct: 0 });
      for (const r of runs) {
        await w.write({ type: "write", position: r.off, data: r.bytes });
        done++; pg.phase("Writing", `Applying change ${done} of ${runs.length}…`, { pct: (done / runs.length) * 100 });
      }
      pg.phase("Finalizing", "Committing changes to the disc…", { indet: true });
      await w.close();
      markSaved(); render();
      pg.done(`Wrote ${runs.reduce((a, r) => a + r.bytes.length, 0)} byte(s) in place to ${isoName}.`, false);
      setStatus(`Saved — written in place to ${isoName}.`, "ok");
    } catch (e) {
      pg.done("Write failed: " + e.message + ". Your edits are still staged.", true);
      setStatus("Write failed: " + e.message, "err");
    }
  }

  async function doStreamSave() {
    if (!isoFile) return setStatus("The original ISO isn't available — reopen it and try again.", "err");
    if (!navigator.serviceWorker || !navigator.serviceWorker.controller)
      return setStatus("Saving needs the offline helper active — reload the page once, then reopen the ISO and save.", "warn");
    const m = isoName.match(/\.[^.]+$/);
    const outName = (m ? isoName.slice(0, -m[0].length) : isoName) + ".patched" + (m ? m[0] : ".iso");
    const total = isoFile.size;
    const snap = allRuns();      // snapshot so mid-save edits can't corrupt the copy
    const pg = progressModal();
    try {
      pg.phase("Preparing", `Building a patched copy of ${isoName} (~${fmtSize(total)}). This can take a few minutes — keep this tab open and the screen awake. It streams straight to your downloads; nothing is uploaded.`, { indet: true });
      let pos = 0, finished, failed;
      const done = new Promise((res, rej) => { finished = res; failed = rej; });
      const reader = isoFile.stream().getReader();
      const stream = new ReadableStream({
        async pull(controller) {
          let r; try { r = await reader.read(); } catch (e) { controller.error(e); failed(e); return; }
          if (r.done) { controller.close(); finished(); return; }
          let chunk = r.value; const start = pos, end = pos + chunk.length;
          for (const run of snap) {
            const re = run.off + run.bytes.length;
            if (re > start && run.off < end) {
              chunk = chunk.slice();
              const a = Math.max(start, run.off), b = Math.min(end, re);
              for (let i = a; i < b; i++) chunk[i - start] = run.bytes[i - run.off];
            }
          }
          controller.enqueue(chunk); pos = end;
          pg.phase("Writing", `Streaming patched ISO to your downloads… ${fmtSize(pos)} / ${fmtSize(total)}`, { pct: total ? (pos / total) * 100 : 0 });
        },
        cancel(reason) { try { reader.cancel(reason); } catch (e) {} failed(new Error("download cancelled")); },
      });
      const id = "iso-" + Date.now() + "-" + Math.random().toString(36).slice(2);
      const sw = navigator.serviceWorker.controller;
      await new Promise((res, rej) => {
        const ch = new MessageChannel();
        const to = setTimeout(() => rej(new Error("the offline helper didn't respond")), 5000);
        ch.port1.onmessage = () => { clearTimeout(to); res(); };
        try { sw.postMessage({ type: "dl-register", id, filename: outName, size: total, stream }, [stream, ch.port2]); }
        catch (e) { clearTimeout(to); rej(e); }
      });
      const ifr = document.createElement("iframe"); ifr.style.display = "none"; ifr.src = "_dl/" + id;
      document.body.appendChild(ifr);
      await done;
      markSaved(); render(); setTimeout(() => ifr.remove(), 1000);
      pg.done(`Streamed a patched copy — check your downloads for “${outName}”. Replace your ISO with it to play the edits.`, false, { bytes: total });
      setStatus(`Saved a patched copy (${fmtSize(total)}): ${outName}.`, "ok");
    } catch (e) {
      pg.done("Save failed: " + e.message + ". Your edits are still staged.", true);
      setStatus("Save failed: " + e.message, "err");
    }
  }

  function markSaved() { for (const k in WINDOWS) { WINDOWS[k].orig = WINDOWS[k].buf.slice(); } }

  // ---- pnach export (universal fallback — works even where the ISO can't be written) ----
  function copyPnach() {
    const lines = ["// Suikoden IV (NTSC-U) — from the web ISO editor"];
    let n = 0;
    for (const f of FIELDS) {
      if (!isDirty(f.key)) continue;
      const w = win(f.key);
      // emit a constant 32-bit EE write for each changed 4-byte word (EE RAM address, not ISO offset)
      for (let i = 0; i + 4 <= f.len; i += 4) {
        const word = w.dv.getUint32(i, true);
        const addr = (0x20000000 | (isoToVaddr(f.off + i) & 0x0FFFFFFF)) >>> 0;
        lines.push(`patch=1,EE,${addr.toString(16).toUpperCase().padStart(8, "0")},extended,${word.toString(16).toUpperCase().padStart(8, "0")}   // ${f.label}`);
        n++;
      }
    }
    if (!n && (isDirty("spellTabA") || isDirty("spellTabB")))
      return setStatus("Spell targeting edits can't be expressed as a pnach: the table loads from FILEDATA, not the boot ELF. Save the ISO, or export a .s4mod / .xdelta instead.", "warn");
    if (!n) return setStatus("No changes to copy — edit a value first.", "warn");
    const text = lines.join("\n");
    (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject())
      .then(() => setStatus("Copied a pnach snippet for your current values to the clipboard.", "ok"))
      .catch(() => { prompt("Copy these pnach lines:", text); });
  }

  // ---- mod recipes (.s4mod) + .xdelta import/export ---------------------------
  // A recipe is a tiny, reversible, version-checked JSON of the exact byte changes.
  // An .xdelta is the standard VCDIFF form of the same changes, synthesized by
  // vcdiff.js from the staged runs (never by diffing the 4 GB disc).
  const bytesHex = (bs) => [...bs].map((b) => b.toString(16).padStart(2, "0")).join("");
  const hexBytes = (h) => { const o = new Uint8Array(h.length / 2); for (let i = 0; i < o.length; i++) o[i] = parseInt(h.substr(i * 2, 2), 16); return o; };
  function winFor(off, len) {
    for (const k in WINDOWS) { const w = WINDOWS[k]; if (off >= w.off && off + len <= w.off + w.len) return w; }
    return null;
  }
  function runsWithOld() {
    return allRuns().map((r) => {
      const w = winFor(r.off, r.bytes.length);
      return { off: r.off, bytes: r.bytes, old: w ? w.orig.slice(r.off - w.off, r.off - w.off + r.bytes.length) : null };
    });
  }
  function download(name, blob) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }
  const modBase = () => (isoName.replace(/\.[^.]+$/, "") || "s4");

  function exportRecipe() {
    if (!anyDirty()) return setStatus("No changes to export — edit a value first.", "warn");
    const patches = runsWithOld().map((r) => ({ off: r.off, old: bytesHex(r.old || []), new: bytesHex(r.bytes) }));
    const mod = { format: "s4mod", version: 1, game: "SLUS-209.79",
      note: "made with the web ISO editor", patchCount: patches.length, patches };
    download(modBase() + ".s4mod", new Blob([JSON.stringify(mod, null, 1)], { type: "application/json" }));
    setStatus(`Exported ${patches.length} patch run(s) as a .s4mod recipe.`, "ok");
  }

  function exportXdelta() {
    if (!anyDirty()) return setStatus("No changes to export — edit a value first.", "warn");
    if (!isoFile) return setStatus("The original ISO isn't available — reopen it and try again.", "err");
    if (typeof Vcdiff === "undefined") return setStatus("VCDIFF module didn't load — reload the page.", "err");
    const edits = allRuns().map((r) => ({ off: r.off, data: r.bytes }));
    let patch;
    try { patch = Vcdiff.buildXdelta(isoFile.size, edits); }
    catch (e) { return setStatus("Couldn't build the xdelta patch: " + e.message, "err"); }
    download(modBase() + ".xdelta", new Blob([patch], { type: "application/octet-stream" }));
    const nb = edits.reduce((s, e) => s + e.data.length, 0);
    setStatus(`Exported an .xdelta patch (${fmtSize(patch.length)}, ${nb} byte(s) changed). ` +
      `Apply ONLY to a pristine NTSC-U SLUS-209.79 ISO — this patch has no integrity check, so a wrong or ` +
      `already-modified source corrupts silently (use the .s4mod recipe for source-verified edits). ` +
      `Apply with: xdelta3 -d -s "<pristine ISO>" file.xdelta out.iso`, "warn");
  }

  async function importRecipe(file) {
    let mod;
    try { mod = JSON.parse(await file.text()); } catch (e) { return setStatus("Not a valid recipe file.", "err"); }
    if (mod.format !== "s4mod") return setStatus("Not an s4mod recipe.", "err");
    if (mod.game && mod.game !== "SLUS-209.79") return setStatus("Recipe is for a different game/region.", "err");
    const parsed = (mod.patches || []).map((p) => ({ off: +p.off, nb: hexBytes(p.new || ""), ob: p.old ? hexBytes(p.old) : null }));
    if (parsed.some((p) => !winFor(p.off, p.nb.length)))
      return setStatus(`This recipe changes byte(s) outside the region this editor can edit — nothing was applied.`, "err");
    let applied = 0, mism = 0;
    for (const p of parsed) {
      const w = winFor(p.off, p.nb.length);
      if (p.ob) for (let i = 0; i < p.ob.length; i++) if (w.buf[p.off - w.off + i] !== p.ob[i]) { mism++; break; }
      w.buf.set(p.nb, p.off - w.off);
      applied += p.nb.length;
    }
    render();
    setStatus(`Applied recipe — ${applied} byte(s)${mism ? `, ${mism} run(s) didn't match the expected originals` : ""}. Review, then Save to write.`, mism ? "warn" : "ok");
  }

  // Apply an .xdelta: decode only the windows the patch touches (reading just their
  // source segments from the disc), stage the exact changed bytes like any other edit.
  // A patch changing bytes outside the editable windows is refused whole.
  async function applyXdelta(file) {
    if (!isoFile) return setStatus("Load an ISO first.", "err");
    setStatus("Reading patch…", "");
    try {
      const patch = new Uint8Array(await file.arrayBuffer());
      const wins = [];
      const total = Vcdiff.eachWindow(patch, (w) => wins.push(w));
      if (total !== isoFile.size)
        return setStatus(`This patch builds a ${fmtSize(total)} file, but the loaded disc is ${fmtSize(isoFile.size)} — it was made for a different image.`, "err");
      if (wins.some((w) => w.fromTarget))
        return setStatus("This patch uses VCD_TARGET windows, which this editor can't apply. Apply it with xdelta3 instead.", "err");
      const edits = [];
      for (const w of wins) {
        if (!w.plan().length) continue;
        const src = new Uint8Array(await isoFile.slice(w.sourceStart, w.sourceStart + w.sourceLen).arrayBuffer());
        const out = w.decode(src);
        const cur = new Uint8Array(await isoFile.slice(w.targetStart, w.targetStart + w.targetLen).arrayBuffer());
        for (let i = 0; i < out.length;) {
          if (out[i] === cur[i]) { i++; continue; }
          const from = i;
          while (i < out.length && out[i] !== cur[i]) i++;
          edits.push({ off: w.targetStart + from, bytes: out.subarray(from, i) });
        }
      }
      if (!edits.length) return setStatus("This patch changes nothing on this disc — it may already be applied.", "warn");
      const bad = edits.filter((e) => !winFor(e.off, e.bytes.length));
      if (bad.length) {
        const n = bad.reduce((a, e) => a + e.bytes.length, 0);
        return setStatus(`This patch changes ${n} byte(s) outside the region this editor can edit ` +
          `(first at 0x${bad[0].off.toString(16).toUpperCase()}) — nothing was applied. Apply it with xdelta3 instead: ` +
          `xdelta3 -d -s "<pristine ISO>" patch.xdelta out.iso`, "err");
      }
      edits.forEach((e) => { const w = winFor(e.off, e.bytes.length); w.buf.set(e.bytes, e.off - w.off); });
      const n = edits.reduce((a, e) => a + e.bytes.length, 0);
      render();
      setStatus(`Applied patch — ${n} byte(s) in ${edits.length} run(s), checksum-verified. Review, then Save to write.`, "ok");
    } catch (e) {
      setStatus(e.message || String(e), "err");
    }
  }

  async function applyPatchFile(file) {
    const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
    if (head[0] === 0xD6 && head[1] === 0xC3 && head[2] === 0xC4) return applyXdelta(file);
    return importRecipe(file);
  }

  // ---- Changes: stock audit + restore-to-stock --------------------------------
  function stockBytes(f) {
    const b = new Uint8Array(f.len);
    const dv = new DataView(b.buffer);
    if (f.type === "bool") (f.offBytes || []).forEach((v, i) => dv.setUint8(i, v));
    else f.write(dv, f.def);
    return b;
  }
  function changesHtml() {
    const rows = FIELDS.map((f) => {
      const w = win(f.key); if (!w) return "";
      const stock = stockBytes(f);
      const isStock = stock.every((v, i) => v === w.buf[i]);
      const cur = f.read(w.dv);
      const state = isStock ? `<span class="pill on">stock</span>`
        : `<span class="pill">patched: ${f.type === "bool" ? (cur ? "on" : "off") : cur + (f.type === "percent" ? "%" : "")}</span>`;
      return `<div class="invrow"><span class="invname">${esc(f.label)}</span>
        <span class="invctl">${state}
        ${isStock ? "" : `<button type="button" class="chip mini" data-restore="${f.key}" title="stage the stock bytes">↺ restore</button>`}</span></div>`;
    }).join("") + (() => {
      if (!SPELLS) { loadSpells(); return ""; }
      if (SPELLS.error || !win("spellTabA")) return "";
      let n = 0;
      for (let id = SPELL_FIRST; id <= SPELL_LAST; id++) if (spellDirty(id)) n++;
      return `<div class="invrow"><span class="invname">Spell targeting</span>
        <span class="invctl">${n ? `<span class="pill">${n} spell(s) changed</span>` : `<span class="pill on">stock</span>`}</span></div>`;
    })();
    const anyPatched = FIELDS.some((f) => { const w = win(f.key); return w && !stockBytes(f).every((v, i) => v === w.buf[i]); });
    return `<div class="card"><h3 class="sec">Changes on this disc</h3>
      <div class="fnote">What is already patched on the loaded disc, checked against the stock bytes at each site.</div>
      ${rows}
      ${anyPatched ? `<div class="toolbar"><button id="isoRestoreAll">Restore all to stock</button></div>`
                   : `<div class="fnote">This disc matches stock at every patch site.</div>`}
    </div>`;
  }

  // ---- progress modal (ported from the S3 ISO editor) -------------------------
  function progressModal() {
    const ov = document.createElement("div"); ov.className = "modal-ov";
    ov.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-label="Saving to ISO" style="max-width:460px">
        <div class="modal-h"><b id="pgTitle">Saving to ISO</b></div>
        <div class="pg-body" aria-live="polite">
          <div class="muted" id="pgMsg" style="margin-bottom:12px"></div>
          <div class="bar indet"><div class="bar-fill" id="pgFill" style="width:35%"></div></div>
          <div class="muted pg-meta" id="pgMeta" style="margin-top:8px"></div>
        </div>
        <div class="modal-f" id="pgFoot" style="display:none"><button class="primary" id="pgClose">Done</button></div>
      </div>`;
    document.body.appendChild(ov);
    const el = (id) => ov.querySelector("#" + id), bar = ov.querySelector(".bar"), fill = el("pgFill");
    const t0 = performance.now(); const tick = () => (el("pgMeta").textContent = `elapsed ${((performance.now() - t0) / 1000).toFixed(1)}s`);
    const timer = setInterval(tick, 100); tick();
    return {
      phase(title, msg, { indet = false, pct = null } = {}) {
        el("pgTitle").textContent = title; el("pgMsg").textContent = msg;
        bar.classList.toggle("indet", indet);
        if (!indet) fill.style.width = Math.max(2, Math.min(100, pct == null ? 100 : pct)) + "%";
      },
      done(msg, isErr, extra) {
        clearInterval(timer); const ms = performance.now() - t0;
        el("pgTitle").textContent = isErr ? "Save failed" : "Done"; el("pgMsg").textContent = msg;
        bar.classList.remove("indet"); fill.style.width = "100%"; fill.classList.toggle("err", !!isErr);
        const parts = [`⏱ ${fmtDur(ms)}`];
        if (!isErr && extra && extra.bytes) { parts.push(fmtSize(extra.bytes)); const s = ms / 1000; if (s > 0.2) parts.push(`${fmtSize(extra.bytes / s)}/s`); }
        el("pgMeta").textContent = parts.join("  ·  ");
        el("pgFoot").style.display = "flex"; el("pgClose").onclick = () => ov.remove();
        setTimeout(() => el("pgClose").focus(), 20);
      },
    };
  }

  // exposed for app.js's mode switcher
  window.ISO = { init };
})();
