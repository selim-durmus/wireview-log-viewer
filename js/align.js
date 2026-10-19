/*
 * Puts real dates on WireView power-ons by matching them to the PC's Windows power history
 * (export-power-events.ps1).
 *
 * The WireView logs 0 V on the 12 V side whenever the PC sleeps or is shut down, so every
 * lasting 0 V <-> 12 V change in its log should line up with a Windows sleep/wake/shutdown/
 * boot/power-loss event. The WireView's clock also drifts (about 0.09% slow on the test unit),
 * so each power-on is fitted as  epoch = c + f * uptime.
 */
(function (root) {
  'use strict';

  const ON_KINDS = { boot: -30, wake: 0 };              // seconds the 12 V change precedes the event
  const OFF_KINDS = { shutdown: 5, sleep: 0, powerloss: 0 };
  const SLACK = 90;                                      // extra seconds allowed beyond the sampling gap
  const MAX_PPM = 3000;

  function parsePowerCSV(text) {
    text = text.replace(/^﻿/, '');
    const lines = text.split(/\r?\n/).filter(l => l.trim());
    const head = lines[0].replace(/"/g, '').split(',').map(s => s.trim().toLowerCase());
    const it = head.indexOf('timeutc'), ik = head.indexOf('kind');
    if (it < 0 || ik < 0) return null;
    const out = [];
    for (let i = 1; i < lines.length; i++) {
      const c = lines[i].replace(/"/g, '').split(',');
      const t = Date.parse(c[it]) / 1000, kind = (c[ik] || '').trim();
      if (!isNaN(t) && (kind in ON_KINDS || kind in OFF_KINDS)) out.push({ t, kind });
    }
    out.sort((a, b) => a.t - b.t);
    return out.filter((e, i) => !out.slice(Math.max(0, i - 4), i).some(p => p.kind === e.kind && e.t - p.t < 90));
  }

  function isPowerCSV(text) {
    const first = text.replace(/^﻿/, '').split(/\r?\n/, 1)[0].toLowerCase();
    return first.includes('timeutc') && first.includes('kind');
  }

  // Lasting 12 V on/off changes of one power-on, in device uptime seconds.
  // One-sample blips are ignored: they show up around sleep/wake without a Windows event.
  function transitions(d, s) {
    const runs = [];
    for (let i = s.i0; i <= s.i1; i++) {
      let mx = -1;
      for (let j = 0; j < 6; j++) { const v = d.V[j][i]; if (v > mx) mx = v; }
      if (mx < 0) continue; // all voltages lost
      const on = mx >= 1, u = d.up[i];
      const r = runs[runs.length - 1];
      if (r && r.on === on) { r.u1 = u; r.n++; } else runs.push({ on, u0: u, u1: u, n: 1 });
    }
    for (let k = 1; k < runs.length - 1; k++) {
      if (runs[k].n >= 2) continue;
      const a = runs[k - 1], b = runs[k + 1];
      a.u1 = b.u1; a.n += runs[k].n + b.n;
      runs.splice(k, 2);
      k = Math.max(0, k - 2);
    }
    const out = [];
    if (runs.length && runs[0].on && runs[0].u0 < 600) out.push({ on: true, u: runs[0].u0 / 2, tol: runs[0].u0 / 2 + SLACK, first: true });
    for (let k = 1; k < runs.length; k++) {
      const gap = runs[k].u0 - runs[k - 1].u1;
      if (gap < 1800) out.push({ on: runs[k].on, u: (runs[k].u0 + runs[k - 1].u1) / 2, tol: gap / 2 + SLACK });
    }
    return out;
  }

  function nearest(times, x) {
    let lo = 0, hi = times.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (times[m] < x) lo = m + 1; else hi = m; }
    let best = null, bd = Infinity;
    for (let k = lo - 2; k <= lo + 1; k++) if (k >= 0 && k < times.length && Math.abs(times[k] - x) < bd) { bd = Math.abs(times[k] - x); best = times[k]; }
    return best;
  }

  function median(a) { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; }

  function pairs(tr, ev, c, f) {
    const out = [];
    for (const t of tr) {
      const x = c + f * t.u, e = nearest(t.on ? ev.on : ev.off, x);
      if (e !== null && Math.abs(e - x) <= t.tol) out.push({ u: t.u, e });
    }
    return out;
  }

  // best offset c for a fixed clock rate f, by voting over all transition/event pairs
  function bestOffset(tr, ev, f, cMin, cMax, keep) {
    const votes = new Map();
    for (const t of tr) {
      const list = t.on ? ev.on : ev.off, fu = f * t.u;
      let last = null;
      for (let k = 0; k < list.length; k++) {
        const c = list[k] - fu;
        if (c < cMin || c > cMax) continue;
        const b = Math.round(c / 60);
        if (b === last) continue;
        last = b;
        votes.set(b, (votes.get(b) || 0) + 1);
      }
    }
    const scored = [];
    votes.forEach((v, b) => scored.push({ b, score: v + (votes.get(b - 1) || 0) + (votes.get(b + 1) || 0) }));
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, keep || 6).map(x => {
      let c = x.b * 60, p = pairs(tr, ev, c, f);
      if (p.length) { c += median(p.map(q => q.e - (c + f * q.u))); p = pairs(tr, ev, c, f); }
      return { c, f, matched: p.length, p };
    }).sort((a, b) => b.matched - a.matched);
  }

  // least-squares epoch = c + f*u over matched pairs
  function fitLine(p, fallbackF) {
    if (p.length < 6) return null;
    const n = p.length, mu = p.reduce((a, q) => a + q.u, 0) / n, me = p.reduce((a, q) => a + q.e, 0) / n;
    let sxx = 0, sxy = 0;
    p.forEach(q => { sxx += (q.u - mu) ** 2; sxy += (q.u - mu) * (q.e - me); });
    if (sxx < (86400 * 2) ** 2 * n / 12) return null; // too short to measure drift
    let f = sxy / sxx;
    if (Math.abs(f - 1) > MAX_PPM / 1e6) f = fallbackF;
    return { f, c: me - f * mu };
  }

  /*
   * d: decoded data; events: parsePowerCSV() output.
   * fixed: { [sessionIndex]: { c, f } } for power-ons whose time is already known (manual).
   * Returns { drift (f), sessions: [null | { c, f, matched, total, confidence, error }] }.
   */
  function alignSessions(d, events, fixed) {
    fixed = fixed || {};
    const ev = {
      on: events.filter(e => e.kind in ON_KINDS).map(e => e.t + ON_KINDS[e.kind]).sort((a, b) => a - b),
      off: events.filter(e => e.kind in OFF_KINDS).map(e => e.t + OFF_KINDS[e.kind]).sort((a, b) => a - b),
    };
    const out = { drift: 1, sessions: d.sessions.map(() => null) };
    if (!events.length) return out;
    const logStart = events[0].t - 86400, logEnd = events[events.length - 1].t + 86400 * 2;
    const S = d.sessions.map(s => ({ s, tr: transitions(d, s) }));

    // 1. clock drift: the rate that lines up the most changes over the long power-ons
    const big = S.filter(x => x.tr.length >= 8);
    let drift = 1;
    if (big.length) {
      const score = f => big.reduce((a, x) => a + (bestOffset(x.tr, ev, f, logStart, logEnd - f * x.s.up1, 3)[0] || { matched: 0 }).matched, 0);
      let best = { f: 1, m: score(1) };
      for (let ppm = -MAX_PPM; ppm <= MAX_PPM; ppm += 100) { const f = 1 + ppm / 1e6, m = score(f); if (m > best.m) best = { f, m }; }
      for (let ppm = -90; ppm <= 90; ppm += 10) { const f = best.f + ppm / 1e6, m = score(f); if (m > best.m) best = { f, m }; }
      drift = best.f;
    }
    out.drift = drift;

    const res = out.sessions;
    const known = k => res[k] || fixed[k];
    const at = k => res[k] || fixed[k];
    const startOf = k => at(k).c, endOf = k => at(k).c + at(k).f * d.sessions[k].up1;

    // 2. power-ons with plenty of changes: fit offset (and their own drift when long enough)
    S.forEach((x, k) => {
      if (fixed[k] || x.tr.length < 3) return;
      const best = bestOffset(x.tr, ev, drift, logStart, logEnd - drift * x.s.up1)[0];
      if (!best || best.matched < 3 || best.matched / x.tr.length < 0.5) return;
      let { c, f } = best, p = best.p;
      const line = fitLine(p, drift);
      if (line) { c = line.c; f = line.f; p = pairs(x.tr, ev, c, f); }
      const err = median(p.map(q => Math.abs(q.e - (c + f * q.u))));
      res[k] = { c, f, matched: p.length, total: x.tr.length, error: err, confidence: p.length / x.tr.length >= 0.8 && p.length >= 5 ? 'high' : 'medium' };
    });

    // drop matches that break the order of power-ons (keep the better supported one)
    for (let pass = 0; pass < 3; pass++) {
      let prev = -1;
      for (let k = 0; k < S.length; k++) {
        if (!known(k)) continue;
        if (prev >= 0 && startOf(k) < endOf(prev) - 300) {
          const loser = fixed[k] ? prev : fixed[prev] ? k : (res[k].matched < res[prev].matched ? k : prev);
          res[loser] = null;
          if (loser === k) continue;
        }
        prev = k;
      }
    }

    // 3. few changes: only accept an offset that fits between known neighbours
    for (let pass = 0; pass < 2; pass++) {
      S.forEach((x, k) => {
        if (known(k) || !x.tr.length) return;
        // leave room for the other unplaced power-ons between this one and its known neighbours
        let lo = logStart, hi = logEnd, bounded = 0, before = 0, after = 0;
        for (let p = k - 1; p >= 0; p--) {
          if (known(p)) { lo = endOf(p) + before - 300; bounded++; break; }
          before += drift * d.sessions[p].up1;
        }
        for (let q = k + 1; q < S.length; q++) {
          if (known(q)) { hi = startOf(q) - after + 300; bounded++; break; }
          after += drift * d.sessions[q].up1;
        }
        const cand = bestOffset(x.tr, ev, drift, lo, hi - drift * x.s.up1, 40)
          .filter(r => r.matched >= 1 && r.c >= lo && r.c + drift * x.s.up1 <= hi);
        if (!cand.length) return;
        const best = cand[0];
        const unique = cand.length === 1 || cand[1].matched < best.matched;
        if (!unique && bounded < 2) return;
        const roomH = (hi - lo - drift * x.s.up1) / 3600;
        const err = median(best.p.map(q => Math.abs(q.e - (best.c + drift * q.u))));
        res[k] = {
          c: best.c, f: drift, matched: best.matched, total: x.tr.length, error: err,
          confidence: bounded === 2 && roomH < 12 && unique ? 'medium' : 'low',
        };
      });
    }
    return out;
  }

  const api = { parsePowerCSV, isPowerCSV, alignSessions, transitions };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.WVAlign = api;
})(typeof self !== 'undefined' ? self : this);
