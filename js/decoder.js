/*
 * WireView Pro II history decoders.
 *
 * .wvl  ("Save file..." in WireView2): raw 8 MiB dump of the device's log flash.
 *   - 4096-byte sectors, used as a ring buffer; each sector holds 195 records of 21 bytes.
 *   - record: u32 LE uptime ms | tIn | tOut | ext1 | ext2 (°C) | V1..V6 (0.1 V) | I1..I6 (0.1 A) | flag
 *   - firmware quirk: a record crossing a 256-byte page boundary loses the 4 bytes that
 *     should follow the boundary; the rest is shifted down and 4 bytes stay erased (0xFF).
 *   - some records are corrupted (tiny uptime, zeroed values). WireView2 treats each of them
 *     as a new "power cycle"; here they are detected and dropped.
 * .csv  ("Export CSV..." / monitoring export): fallback, header-based.
 *
 * Output (both): { n, up, P, It, Tin, Tout, E1, E2, V[6], I[6], sessions, interval, source, notes }
 * Timestamps are device uptime in seconds; the device has no real-time clock.
 */
(function (root) {
  'use strict';

  const SECTOR = 4096, REC = 21, PER_SECTOR = 195, PAGE = 256;
  const MAX_STEP_S = 30 * 60; // max gap between consecutive samples of one power-on

  // byte position -> field, for marking values lost at page boundaries
  const BYTE_FIELD = ['ts', 'ts', 'ts', 'ts', 'tin', 'tout', 'e1', 'e2',
    'V0', 'V1', 'V2', 'V3', 'V4', 'V5', 'I0', 'I1', 'I2', 'I3', 'I4', 'I5', 'flag'];

  function isErased(u8, from, len) {
    for (let i = from; i < from + len; i++) if (u8[i] !== 0xff) return false;
    return true;
  }

  function readRecord(u8, s) {
    const rec = new Uint8Array(REC);
    const lost = new Set();
    const boundary = (Math.floor(s / PAGE) + 1) * PAGE;
    if (boundary < s + REC) {
      const k = boundary - s;
      rec.set(u8.subarray(s, boundary), 0);
      const tailLen = REC - k - 4;
      if (tailLen > 0) rec.set(u8.subarray(boundary, boundary + tailLen), k + 4);
      for (let b = k; b < Math.min(REC, k + 4); b++) lost.add(BYTE_FIELD[b]);
    } else {
      rec.set(u8.subarray(s, s + REC), 0);
    }
    // 0xFF is erased flash (e.g. a sample still being written when the history was read)
    for (let b = 4; b < 20; b++) if (rec[b] === 0xff) lost.add(BYTE_FIELD[b]);
    return {
      ts: lost.has('ts') ? NaN : (rec[0] | (rec[1] << 8) | (rec[2] << 16)) + rec[3] * 16777216,
      tin: lost.has('tin') ? NaN : rec[4],
      tout: lost.has('tout') ? NaN : rec[5],
      e1: lost.has('e1') ? NaN : rec[6],
      e2: lost.has('e2') ? NaN : rec[7],
      V: [0, 1, 2, 3, 4, 5].map(j => lost.has('V' + j) ? NaN : rec[8 + j] / 10),
      I: [0, 1, 2, 3, 4, 5].map(j => lost.has('I' + j) ? NaN : rec[14 + j] / 10),
      lostAny: lost.size > 0,
      type: lost.has('ts') ? 0 : rec[0] & 3, // 0 measurement, 2 power-on marker
      off: s,
    };
  }

  // Ring-buffer order: start right after the longest run of erased sectors.
  function sectorOrder(u8) {
    const nSec = Math.floor(u8.length / SECTOR);
    const erased = new Array(nSec);
    for (let s = 0; s < nSec; s++) erased[s] = isErased(u8, s * SECTOR, SECTOR);
    let bestLen = 0, bestEnd = -1;
    for (let s = 0; s < nSec; s++) {
      if (!erased[s]) continue;
      let len = 0;
      while (len < nSec && erased[(s + len) % nSec]) len++;
      if (len > bestLen) { bestLen = len; bestEnd = (s + len - 1) % nSec; }
      if (len === nSec) break;
      s += len - 1;
    }
    const start = bestLen > 0 ? (bestEnd + 1) % nSec : 0;
    const order = [];
    for (let i = 0; i < nSec; i++) {
      const s = (start + i) % nSec;
      if (!erased[s]) order.push(s);
    }
    return { order, nSec, usedSectors: order.length };
  }

  function decodeWVL(buffer) {
    const u8 = new Uint8Array(buffer);
    if (u8.length < SECTOR || u8.length % SECTOR !== 0) throw new Error('Not a WireView .wvl history file (unexpected size).');
    const { order, nSec, usedSectors } = sectorOrder(u8);
    const raw = [];
    let markers = 0;
    for (const sec of order) {
      for (let k = 0; k < PER_SECTOR; k++) {
        const s = sec * SECTOR + k * REC;
        if (isErased(u8, s, REC)) continue;
        const r = readRecord(u8, s);
        if (r.type === 2) { markers++; continue; } // power-on marker: no measurement payload
        if (r.type !== 0) continue;
        raw.push(r);
      }
    }
    const cleaned = cleanSequence(raw);
    const out = assemble(cleaned.rows, cleaned.sessionStarts);
    out.source = 'wvl';
    out.notes = {
      flashUsedPct: 100 * usedSectors / nSec,
      rawRecords: raw.length,
      powerOnMarkers: markers,
      dropped: cleaned.dropped,
      repaired: raw.filter(r => r.lostAny).length,
    };
    return out;
  }

  // Drop corrupted records, interpolate lost timestamps, split into power-ons.
  function cleanSequence(raw) {
    let dropped = 0;
    const cand = [];
    for (const r of raw) {
      if (r.tin === 0 && r.tout === 0) { dropped++; continue; } // zeroed / corrupted record
      cand.push(r);
    }
    const rows = [], sessionStarts = [];
    let prevTs = NaN, wrap = 0;
    const WRAP = 4294967296; // the device's millisecond counter is 32-bit (wraps after ~49.7 days)
    const continues = (a, b) => b >= a && b - a <= MAX_STEP_S * 1000;
    for (let i = 0; i < cand.length; i++) {
      const r = cand[i];
      if (isNaN(r.ts)) { rows.push(r); continue; }
      if (isNaN(prevTs)) { sessionStarts.push(rows.length); rows.push(r); prevTs = r.ts; continue; }
      const rawTs = r.ts;
      if (wrap && continues(prevTs, rawTs + wrap)) r.ts = rawTs + wrap;
      else if (continues(prevTs, rawTs + wrap + WRAP)) { wrap += WRAP; r.ts = rawTs + wrap; }
      if (continues(prevTs, r.ts)) { rows.push(r); prevTs = r.ts; continue; }
      r.ts = rawTs;
      // Out of sequence: an isolated bad record if the following ones continue from prevTs.
      let verdict = r.ts < prevTs ? 'new' : 'gap';
      for (let j = 1, seen = 0; i + j < cand.length && seen < 4; j++) {
        const q = cand[i + j];
        if (isNaN(q.ts)) continue;
        seen++;
        if (continues(prevTs, q.ts)) { verdict = 'junk'; break; }
        if (continues(r.ts, q.ts)) break;
      }
      if (verdict === 'junk') { dropped++; continue; }
      if (verdict === 'new') { sessionStarts.push(rows.length); wrap = 0; }
      rows.push(r);
      prevTs = r.ts;
    }
    // interpolate lost timestamps inside a session; drop the ones we cannot place
    const startSet = new Set(sessionStarts);
    const keep = [], keepStarts = [];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (startSet.has(i)) keepStarts.push(keep.length);
      if (isNaN(r.ts)) {
        const a = i > 0 && !startSet.has(i) ? rows[i - 1].ts : NaN;
        let b = NaN;
        if (i + 1 < rows.length && !startSet.has(i + 1)) b = rows[i + 1].ts;
        if (!isNaN(a) && !isNaN(b) && continues(a, b)) r.ts = (a + b) / 2;
        else { dropped++; continue; }
      }
      keep.push(r);
    }
    return { rows: keep, sessionStarts: keepStarts, dropped };
  }

  function median(arr) {
    if (!arr.length) return 60;
    const a = Array.from(arr).sort((x, y) => x - y);
    return a[Math.floor(a.length / 2)];
  }

  // rows: [{ts(ms) | up(s), tin, tout, e1, e2, V[6], I[6], epoch?}], sessionStarts: row indices
  function assemble(rows, sessionStarts, opts) {
    opts = opts || {};
    const n = rows.length;
    const f32 = () => new Float32Array(n);
    const d = {
      n, up: new Float64Array(n), P: f32(), It: f32(), Tin: f32(), Tout: f32(), E1: f32(), E2: f32(),
      V: [f32(), f32(), f32(), f32(), f32(), f32()], I: [f32(), f32(), f32(), f32(), f32(), f32()],
      epoch: opts.epoch ? new Float64Array(n) : null,
    };
    for (let i = 0; i < n; i++) {
      const r = rows[i];
      d.up[i] = r.up !== undefined ? r.up : r.ts / 1000;
      d.Tin[i] = r.tin; d.Tout[i] = r.tout; d.E1[i] = r.e1; d.E2[i] = r.e2;
      let p = 0, it = 0, pOk = true, iOk = true;
      for (let j = 0; j < 6; j++) {
        d.V[j][i] = r.V[j]; d.I[j][i] = r.I[j];
        if (isNaN(r.I[j])) iOk = false; else it += r.I[j];
        if (isNaN(r.V[j]) || isNaN(r.I[j])) pOk = false; else p += r.V[j] * r.I[j];
      }
      d.P[i] = r.P !== undefined && !isNaN(r.P) ? r.P : (pOk ? p : NaN);
      d.It[i] = r.It !== undefined && !isNaN(r.It) ? r.It : (iOk ? it : NaN);
      if (d.epoch) d.epoch[i] = r.epoch;
    }
    const steps = [];
    const sessions = [];
    for (let s = 0; s < sessionStarts.length; s++) {
      const i0 = sessionStarts[s];
      const i1 = (s + 1 < sessionStarts.length ? sessionStarts[s + 1] : n) - 1;
      if (i1 - i0 + 1 < 3) continue; // ignore boot noise
      for (let i = i0 + 1; i <= i1; i++) steps.push(d.up[i] - d.up[i - 1]);
      // key: flash position + uptime of the first sample, stable across downloads of the same device
      const key = rows[i0].off !== undefined ? rows[i0].off + ':' + Math.round(rows[i0].ts) : null;
      sessions.push({ i0, i1, up0: d.up[i0], up1: d.up[i1], key });
    }
    d.interval = median(steps);
    // drop rows belonging to ignored sessions by keeping only session ranges
    if (sessions.length && (sessions[0].i0 !== 0 || sessions.reduce((a, s) => a + s.i1 - s.i0 + 1, 0) !== n)) {
      const idx = [];
      for (const s of sessions) for (let i = s.i0; i <= s.i1; i++) idx.push(i);
      return assemble(idx.map(i => rows[i]), (() => { let o = 0; return sessions.map(s => { const r = o; o += s.i1 - s.i0 + 1; return r; }); })(), opts);
    }
    d.sessions = sessions;
    return d;
  }

  // ---------- CSV fallback ----------

  function splitCSVLine(line) {
    // exports contain no quoted fields, but handle simple quotes defensively
    const out = []; let cur = '', q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') { q = !q; continue; }
      if (c === ',' && !q) { out.push(cur); cur = ''; continue; }
      cur += c;
    }
    out.push(cur);
    return out;
  }

  function mapHeader(cols) {
    const m = { V: [-1, -1, -1, -1, -1, -1], I: [-1, -1, -1, -1, -1, -1] };
    cols.forEach((raw, idx) => {
      const c = raw.trim().toLowerCase().replace(/\s+/g, '');
      if (c === 'timestamp') m.ts = idx;
      else if (c === 'timelocal') m.local = idx;
      else if (c === 'seconds') m.sec = idx;
      else if (/^(sumpowerw|totalpower)/.test(c)) m.P = idx;
      else if (/^(sumcurrenta|totalcurrent)/.test(c)) m.It = idx;
      else if (/^onboardin/.test(c)) m.tin = idx;
      else if (/^onboardout/.test(c)) m.tout = idx;
      else if (/^ext1/.test(c)) m.e1 = idx;
      else if (/^ext2/.test(c)) m.e2 = idx;
      else {
        const v = /^v([1-6])(\(v\))?$/.exec(c); if (v) m.V[+v[1] - 1] = idx;
        const a = /^i([1-6])(\(a\))?$/.exec(c); if (a) m.I[+a[1] - 1] = idx;
      }
    });
    return m;
  }

  const DEVICE_EPOCH = Date.UTC(2026, 0, 1);

  function parseCSVText(text, name) {
    text = text.replace(/^﻿/, '');
    const lines = text.split(/\r?\n/).filter(l => l.trim().length);
    if (lines.length < 2) throw new Error(name + ': no data rows.');
    const m = mapHeader(splitCSVLine(lines[0]));
    if (m.ts === undefined && m.local === undefined) throw new Error(name + ': no Timestamp or TimeLocal column - not a WireView export?');
    const num = (cells, idx) => idx === undefined || idx < 0 || cells[idx] === undefined || cells[idx] === '' ? NaN : parseFloat(cells[idx]);
    const rows = [];
    for (let li = 1; li < lines.length; li++) {
      const c = splitCSVLine(lines[li]);
      const r = {
        tin: num(c, m.tin), tout: num(c, m.tout), e1: num(c, m.e1), e2: num(c, m.e2),
        V: m.V.map(i => num(c, i)), I: m.I.map(i => num(c, i)), P: num(c, m.P), It: num(c, m.It),
      };
      if (m.local !== undefined) {
        r.epoch = Date.parse(c[m.local]) / 1000;
        if (isNaN(r.epoch)) continue;
      } else {
        const t = c[m.ts];
        r.rawTs = t;
        r.raw = (Date.parse(t.slice(0, 23) + 'Z') - DEVICE_EPOCH) / 1000; // uptime for WireView2 1.0.8
        r.tod = r.raw - Math.floor(r.raw / 86400) * 86400;
        if (isNaN(r.raw)) continue;
      }
      rows.push(r);
    }
    return { rows, kind: m.local !== undefined ? 'monitoring' : 'device', name };
  }

  function decodeCSVs(files) {
    // files: [{name, text}]
    const parsed = files.map(f => parseCSVText(f.text, f.name));
    const monitoring = parsed.filter(p => p.kind === 'monitoring');
    const device = parsed.filter(p => p.kind === 'device');
    let notes = { files: files.length, dropped: 0, style: '' };
    if (monitoring.length && !device.length) {
      let rows = [].concat(...monitoring.map(p => p.rows)).sort((a, b) => a.epoch - b.epoch);
      const before = rows.length;
      rows = rows.filter((r, i) => i === 0 || r.epoch !== rows[i - 1].epoch);
      notes.dropped = before - rows.length;
      const e0 = rows[0].epoch;
      rows.forEach(r => { r.up = r.epoch - e0; });
      const out = assemble(rows, [0], { epoch: true });
      out.source = 'csv-monitoring'; notes.style = 'live monitoring recording'; out.notes = notes;
      return out;
    }
    let all = [];
    let oldStyle = false;
    for (const p of device) {
      const rs = p.rows;
      // drop block-header junk rows: stamped exactly 00:00:00.000 and not followed ~1-5 min later
      const kept = rs.filter((r, i) => {
        if (!/T00:00:00\.0+$/.test(r.rawTs)) return true;
        const nx = rs[i + 1];
        const ok = nx && nx.raw - r.raw > 0 && nx.raw - r.raw < 600 && r.tin > 0;
        if (!ok) notes.dropped++;
        return ok;
      });
      // WireView2 <= 1.0.6 garbled the date part; the time of day is still continuous.
      let weird = 0;
      for (let i = 1; i < kept.length; i++) {
        const dr = kept[i].raw - kept[i - 1].raw;
        const dt = ((kept[i].tod - kept[i - 1].tod) % 86400 + 86400) % 86400;
        if (Math.abs(dr - dt) > 3600) weird++;
      }
      if (weird >= 2) oldStyle = true;
      all.push(kept);
    }
    const rows = [], starts = [];
    if (oldStyle) {
      notes.style = 'WireView2 1.0.6 export (dates rebuilt from time of day)';
      for (const kept of all) {
        let up = 0;
        kept.forEach((r, i) => {
          if (i === 0) { starts.push(rows.length); up = r.tod; }
          else {
            const dt = ((r.tod - kept[i - 1].tod) % 86400 + 86400) % 86400;
            if (dt > 6 * 3600) { starts.push(rows.length); up = r.tod; } // reboot: uptime restarted
            else up += dt;
          }
          r.up = up; rows.push(r);
        });
      }
    } else {
      notes.style = 'WireView2 1.0.8 export (per-cycle files merged by uptime)';
      let merged = [].concat(...all).sort((a, b) => a.raw - b.raw);
      merged = merged.filter((r, i) => i === 0 || r.raw !== merged[i - 1].raw);
      merged.forEach((r, i) => {
        r.up = r.raw;
        if (i === 0 || r.raw - merged[i - 1].raw > MAX_STEP_S) starts.push(rows.length);
        rows.push(r);
      });
    }
    if (!rows.length) throw new Error('No usable rows in the CSV file(s).');
    const out = assemble(rows, starts);
    out.source = 'csv'; out.notes = notes;
    return out;
  }

  const api = { decodeWVL, decodeCSVs, parseCSVText };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.WVDecoder = api;
})(typeof self !== 'undefined' ? self : this);
