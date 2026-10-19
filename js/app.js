/* WireView Log Viewer - UI. Data comes from WVDecoder (decoder.js). */
(function () {
  'use strict';

  const $ = sel => document.querySelector(sel);
  const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const COLORS = {};
  ['--s1', '--s2', '--s3', '--s4', '--s5', '--s6', '--ink', '--ink-2', '--muted', '--grid', '--axis', '--surface',
    '--surface-2', '--accent', '--warning', '--serious', '--critical', '--good', '--off'].forEach(k => { COLORS[k.slice(2)] = css(k); });
  const PIN_COLORS = ['s1', 's2', 's3', 's4', 's5', 's6'].map(k => COLORS[k]);

  const DEFAULT_RULES = { imbOn: true, imbPct: 40, imbMinA: 6, imbBase: 'max', wireOn: true, wireA: 10.5, powOn: true, powW: 660, tempOn: true, tempC: 80 };
  const EVENT_TYPES = {
    imb: { label: 'Current imbalance', color: COLORS.warning, unit: '%' },
    wire: { label: 'Pin over-current', color: COLORS.critical, unit: 'A' },
    pow: { label: 'Over-power', color: COLORS.serious, unit: 'W' },
    temp: { label: 'Over-temperature', color: COLORS.critical, unit: '°C' },
  };

  const S = {
    D: null, fileName: '', vt: null, brk: null, sleep: [], full: { x0: 0, x1: 1 }, view: { x0: 0, x1: 1 },
    rules: loadJSON('wvlv:rules', DEFAULT_RULES), events: [], selEvent: null, hoverIdx: -1, charts: [], dev: null,
    curMode: 'abs',
  };

  function loadJSON(key, fallback) {
    try { const v = JSON.parse(localStorage.getItem(key)); return v ? Object.assign({}, fallback, v) : Object.assign({}, fallback); }
    catch (e) { return Object.assign({}, fallback); }
  }
  function saveJSON(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) { /* storage unavailable */ } }

  // ---------------- formatting ----------------
  const fmtDT = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const fmtDay = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  const fmtHM = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
  const pad2 = n => String(n).padStart(2, '0');
  function fmtUptime(sec) {
    sec = Math.max(0, Math.round(sec));
    const d = Math.floor(sec / 86400), h = Math.floor(sec % 86400 / 3600), m = Math.floor(sec % 3600 / 60);
    return (d ? d + 'd ' : '') + pad2(h) + ':' + pad2(m);
  }
  function fmtDuration(sec) {
    if (sec < 90) return Math.round(sec) + ' s';
    if (sec < 5400) return Math.round(sec / 60) + ' min';
    if (sec < 172800) return (sec / 3600).toFixed(sec < 36000 ? 1 : 0) + ' h';
    return (sec / 86400).toFixed(sec < 864000 ? 1 : 0) + ' days';
  }
  const fmt = (v, d) => isNaN(v) ? '–' : v.toFixed(d);

  // ---------------- loading ----------------
  async function loadFiles(list) {
    const files = Array.from(list);
    if (!files.length) return;
    $('#loadError').textContent = '';
    try {
      // Windows power history (export-power-events.ps1) can come alone or with the log
      const csvTexts = await Promise.all(files.filter(f => /\.csv$/i.test(f.name)).map(async f => ({ f, text: await f.text() })));
      const power = csvTexts.filter(x => WVAlign.isPowerCSV(x.text));
      if (power.length) {
        let evs = [];
        power.forEach(x => { evs = evs.concat(WVAlign.parsePowerCSV(x.text) || []); });
        evs.sort((a, b) => a.t - b.t);
        setPowerLog(evs, power.map(x => x.f.name).join(', '));
        files.splice(0, files.length, ...files.filter(f => !power.some(x => x.f === f)));
        if (!files.length) {
          if (S.D) runAlign(); else $('#loadError').textContent = 'Power history loaded. Now drop your .wvl file.';
          return;
        }
      }
      const wvl = files.find(f => /\.wvl$/i.test(f.name));
      let data, label;
      if (wvl) {
        data = WVDecoder.decodeWVL(await wvl.arrayBuffer());
        label = wvl.name; S.fileName = wvl.name;
      } else {
        const csvs = files.filter(f => /\.csv$/i.test(f.name));
        if (!csvs.length) throw new Error('Pick a .wvl history file (Save file… in WireView2) or CSV exports.');
        data = WVDecoder.decodeCSVs(await Promise.all(csvs.map(async f => ({ name: f.name, text: await f.text() }))));
        label = csvs.length === 1 ? csvs[0].name : csvs.length + ' CSV files';
        S.fileName = csvs.map(f => f.name).sort().join('|');
      }
      if (!data.n || !data.sessions.length) throw new Error('The file has no usable samples.');
      setup(data, label);
    } catch (err) {
      console.error(err);
      const msg = 'Could not read that file: ' + err.message;
      if ($('#app').classList.contains('hidden')) $('#loadError').textContent = msg; else alert(msg);
    }
  }

  function setup(D, label) {
    S.D = D;
    const n = D.n;
    const sess = D.sessions;
    const total = sess.reduce((a, s) => a + (s.up1 - s.up0), 0);
    S.GAP = Math.max(total * 0.012, 600);
    sess.forEach((s, k) => { s.k = k; s.c = null; });
    S.vt = new Float64Array(n);
    S.brk = new Uint8Array(n);
    S.sessOf = new Int32Array(n);
    const gapLimit = Math.max(3 * D.interval, D.interval + 120);
    sess.forEach(s => {
      for (let i = s.i0; i <= s.i1; i++) {
        S.sessOf[i] = s.k;
        S.brk[i] = (i === s.i0 || D.up[i] - D.up[i - 1] > gapLimit) ? 1 : 0;
      }
    });
    layoutSessions();
    S.view = Object.assign({}, S.full);

    // PC off / sleep: logging continued but the 12 V side read 0 V
    S.sleep = [];
    let st = -1;
    const close = end => { if (st >= 0 && end > st) S.sleep.push([st, end]); };
    for (let i = 0; i < n; i++) {
      let mx = 0;
      for (let j = 0; j < 6; j++) { const x = D.V[j][i]; if (x > mx) mx = x; }
      if (mx < 1) {
        if (st < 0 || S.brk[i]) { close(i - 1); st = i; }
      } else { close(i - 1); st = -1; }
    }
    close(n - 1);

    // per-sample deviation from the average pin current (%), only under meaningful load
    S.dev = [0, 1, 2, 3, 4, 5].map(() => new Float32Array(n));
    for (let i = 0; i < n; i++) {
      const it = D.It[i], m = it / 6;
      for (let j = 0; j < 6; j++) S.dev[j][i] = it >= 6 && !isNaN(D.I[j][i]) ? (D.I[j][i] - m) / m * 100 : NaN;
    }

    // real-time anchors: epoch = c + f * uptime (f = device clock rate)
    S.anchorKey = 'wvlv:anchors2:' + S.fileName + ':' + n;
    S.drift = null;
    sess.forEach(s => clearAnchor(s));
    const last = sess[sess.length - 1];
    if (D.source === 'csv-monitoring' && D.epoch) {
      sess.forEach(s => setAnchor(s, D.epoch[s.i1] - D.up[s.i1], 1, 'clock', false));
    } else if (D.source === 'wvl') {
      const m = /(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/.exec(S.fileName);
      if (m) {
        const saveT = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime() / 1000;
        setAnchor(last, saveT - last.up1, 1, 'file', true);
      }
    }
    sess.forEach(s => applyDeviceAnchor(s));
    const saved = loadJSON(S.anchorKey, {});
    Object.keys(saved).forEach(k => {
      const s = sess[+k], a = saved[k];
      if (s && a && isFinite(a.c)) setAnchor(s, a.c, a.f || 1, a.src || 'manual', !!a.approx);
    });

    $('#empty').classList.add('hidden');
    $('#app').classList.remove('hidden');
    $('#btnExportRange').classList.remove('hidden');
    $('#btnExportEvents').classList.remove('hidden');
    const srcText = D.source === 'wvl'
      ? `${label} · ${n.toLocaleString()} samples · ${sess.length} power-ons · ${D.notes.dropped.toLocaleString()} corrupted records removed`
      : `${label} · ${n.toLocaleString()} samples · ${D.notes.style}`;
    $('#fileInfo').textContent = srcText;

    buildCharts();
    syncRulesUI();
    computeEvents();
    renderAll();
    // reopen with the range picked last time (handy when checking an alert)
    let q = null;
    try { q = localStorage.getItem('wvlv:quick'); } catch (e) { /* ignore */ }
    S.quick = null;
    quickRange(q != null ? +q : 0);
    if (S.power && S.power.length) runAlign();
  }

  // Lay power-ons out on one axis. The gap between two dated power-ons is their real power-off time
  // (at least 2 min so it stays visible); otherwise a fixed placeholder gap.
  function layoutSessions() {
    const D = S.D, sess = D.sessions;
    let v = 0;
    sess.forEach((s, k) => {
      s.vstart = v; s.vend = v + (s.up1 - s.up0);
      const nx = sess[k + 1];
      let gap = S.GAP;
      if (nx && s.c != null && nx.c != null) {
        const real = (nx.c + nx.f * nx.up0) - (s.c + s.f * s.up1);
        if (real > -600) gap = Math.min(S.GAP, Math.max(120, real));
      }
      v = s.vend + gap;
    });
    sess.forEach(s => { for (let i = s.i0; i <= s.i1; i++) S.vt[i] = s.vstart + (D.up[i] - s.up0); });
    S.full = { x0: 0, x1: sess[sess.length - 1].vend };
  }
  // re-layout after dates change, keeping the same samples in view
  function relayout() {
    if (!S.D) return;
    const i0 = nearestIdx(S.view.x0), i1 = nearestIdx(S.view.x1);
    const wasFull = S.view.x0 <= S.full.x0 && S.view.x1 >= S.full.x1;
    layoutSessions();
    S.view = wasFull ? Object.assign({}, S.full) : { x0: S.vt[i0], x1: Math.max(S.vt[i1], S.vt[i0] + 300) };
  }

  // ---------------- anchors ----------------
  function clearAnchor(s) { s.c = null; s.f = 1; s.src = null; s.approx = false; s.match = null; }
  function setAnchor(s, c, f, src, approx, match) { s.c = c; s.f = f; s.src = src; s.approx = !!approx; s.match = match || null; }
  const isManual = s => s.src === 'manual' || s.src === 'next';

  // Clock sync from the desktop app: a device tick seen at a known PC time (stored per power-on)
  function devicePair(s) {
    if (!s.key) return null;
    try { return JSON.parse(localStorage.getItem('wvlv:dev:' + s.key)); } catch (e) { return null; }
  }
  function applyDeviceAnchor(s) {
    const p = devicePair(s);
    if (!p || isManual(s)) return false;
    const f = S.drift || 1;
    setAnchor(s, p.epoch - f * p.tick / 1000, f, 'device', !p.precise);
    return true;
  }

  function setPowerLog(evs, name) {
    S.power = evs;
    S.powerName = name;
    try { localStorage.setItem('wvlv:powerlog', JSON.stringify({ name, evs: evs.map(e => [Math.round(e.t), e.kind]) })); }
    catch (e) { /* storage full or unavailable: keep it for this visit only */ }
  }
  function loadPowerLog() {
    try {
      const v = JSON.parse(localStorage.getItem('wvlv:powerlog'));
      if (v && v.evs) { S.power = v.evs.map(([t, kind]) => ({ t, kind })); S.powerName = v.name; }
    } catch (e) { /* none saved */ }
  }

  function runAlign() {
    if (!S.D || !S.power || !S.power.length || typeof WVAlign === 'undefined') { renderPowerLog(); return; }
    S.aligning = true;
    renderPowerLog();
    setTimeout(() => {
      const sess = S.D.sessions, fixed = {};
      sess.forEach((s, k) => { if (s.c != null && s.src !== 'windows') fixed[k] = { c: s.c, f: s.f }; });
      let res;
      try { res = WVAlign.alignSessions(S.D, S.power, fixed); }
      catch (err) { console.error(err); S.aligning = false; renderPowerLog(); return; }
      S.drift = res.drift;
      sess.forEach((s, k) => {
        const r = res.sessions[k];
        if (s.src === 'windows') clearAnchor(s);
        if (s.src === 'device') { applyDeviceAnchor(s); return; } // re-fit with the measured drift
        if (!r || isManual(s)) return;
        setAnchor(s, r.c, r.f, 'windows', r.confidence === 'low', r);
      });
      S.aligning = false;
      renderAll();
      if (S.quick) quickRange(S.quick); // real dates changed what "last 24 h" covers
    }, 30);
  }

  function renderPowerLog() {
    const box = $('#powerLog');
    if (!box) return;
    box.textContent = '';
    const st = document.createElement('span'); st.className = 'status';
    const dot = document.createElement('i'); st.appendChild(dot);
    if (S.power && S.power.length) {
      st.classList.add('ok');
      const a = new Date(S.power[0].t * 1000), b = new Date(S.power[S.power.length - 1].t * 1000);
      let txt = `Windows power history: ${S.power.length.toLocaleString()} events, ${fmtDay.format(a)} ${a.getFullYear()} – ${fmtDay.format(b)} ${b.getFullYear()}`;
      if (S.aligning) txt += ' · matching…';
      else if (S.D) {
        const dated = S.D.sessions.filter(s => s.src === 'windows').length;
        txt += ` · dated ${dated} of ${S.D.sessions.length} power-ons`;
        if (S.drift) {
          const ppm = (S.drift - 1) * 1e6;
          txt += ` · WireView clock runs ${Math.abs(ppm / 1e4).toFixed(2)}% ${ppm > 0 ? 'slow' : 'fast'} (${Math.abs(ppm * 86400 / 1e6 / 60).toFixed(1)} min/day)`;
        }
      }
      st.appendChild(document.createTextNode(txt));
      box.appendChild(st);
      if (S.powerAuto) {
        const n = document.createElement('span'); n.className = 'muted';
        n.textContent = 'Read from Windows automatically; older events are kept in the app\'s archive.';
        box.appendChild(n);
        return;
      }
      const b1 = document.createElement('button'); b1.className = 'link'; b1.textContent = 'Load a newer one';
      b1.addEventListener('click', () => $('#fileInput').click());
      const b2 = document.createElement('button'); b2.className = 'link'; b2.textContent = 'Remove';
      b2.addEventListener('click', () => {
        S.power = null; try { localStorage.removeItem('wvlv:powerlog'); } catch (e) { /* ignore */ }
        if (S.D) { S.D.sessions.forEach(s => { if (s.src === 'windows') clearAnchor(s); }); S.drift = null; renderAll(); } else renderPowerLog();
      });
      box.append(b1, b2);
    } else {
      st.appendChild(document.createTextNode('No Windows power history loaded, so most power-ons have no dates.'));
      box.appendChild(st);
      const how = document.createElement('span'); how.className = 'muted';
      how.textContent = 'Double-click export-power-events.cmd in the viewer folder, then drop the power-events CSV it saves to Downloads here.';
      const b1 = document.createElement('button'); b1.textContent = 'Add power history…';
      b1.addEventListener('click', () => $('#fileInput').click());
      box.append(how, b1);
    }
  }

  // ---------------- time helpers ----------------
  function sessionAtV(v) {
    const sess = S.D.sessions;
    let lo = 0, hi = sess.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (sess[mid].vstart <= v) lo = mid; else hi = mid - 1; }
    return sess[lo];
  }
  function epochOf(i) {
    const s = S.D.sessions[S.sessOf[i]];
    return s.c == null ? null : s.c + s.f * S.D.up[i];
  }
  // what the PC was doing at a moment when the 12 V side read 0 V
  function pcState(epoch) {
    if (epoch == null || !S.power || !S.power.length) return 'PC off or asleep';
    const p = S.power;
    let lo = 0, hi = p.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (p[m].t <= epoch + 120) lo = m + 1; else hi = m; }
    for (let k = lo - 1; k >= 0 && k >= lo - 6; k--) {
      const kind = p[k].kind;
      if (kind === 'sleep') return 'PC asleep';
      if (kind === 'shutdown') return 'PC shut down';
      if (kind === 'powerloss') return 'PC lost power or crashed';
      if (kind === 'wake' || kind === 'boot') break;
    }
    return 'PC off or asleep';
  }
  function labelSample(i, short) {
    const s = S.D.sessions[S.sessOf[i]];
    const e = epochOf(i);
    const up = 'uptime ' + fmtUptime(S.D.up[i]);
    if (e != null) return (s.approx ? '≈ ' : '') + fmtDT.format(new Date(e * 1000)) + (short ? '' : ` · power-on ${s.k + 1}, ${up}`);
    return `Power-on ${s.k + 1} · ${up}`;
  }
  function lowerBound(arr, x, lo, hi) {
    lo = lo || 0; hi = hi === undefined ? arr.length : hi;
    while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < x) lo = m + 1; else hi = m; }
    return lo;
  }
  function nearestIdx(v) {
    const vt = S.vt, n = vt.length;
    let i = lowerBound(vt, v);
    if (i >= n) i = n - 1;
    if (i > 0 && Math.abs(vt[i - 1] - v) < Math.abs(vt[i] - v)) i--;
    return i;
  }

  // ---------------- x ticks ----------------
  const STEPS = [60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400, 172800, 345600, 604800, 1209600, 2419200];
  function makeTicks(x0, x1, widthPx) {
    const span = x1 - x0;
    const target = Math.max(2, widthPx / 120);
    let step = STEPS[STEPS.length - 1];
    for (const st of STEPS) if (span / st <= target) { step = st; break; }
    const ticks = [];
    for (const s of S.D.sessions) {
      if (s.vend < x0 || s.vstart > x1) continue;
      const a = Math.max(x0, s.vstart), b = Math.min(x1, s.vend);
      let prevDay = null;
      if (s.c != null) {
        const eOf = v => s.c + s.f * (s.up0 + v - s.vstart), vOf = e => s.vstart + (e - s.c) / s.f - s.up0;
        const eA = eOf(a), eB = eOf(b);
        const off = -new Date(eA * 1000).getTimezoneOffset() * 60;
        for (let t = Math.ceil((eA + off) / step) * step - off; t <= eB; t += step) {
          const d = new Date(t * 1000);
          const day = fmtDay.format(d);
          ticks.push({ v: vOf(t), l1: step >= 86400 ? day : fmtHM.format(d), l2: step < 86400 && day !== prevDay ? (s.approx ? '≈ ' : '') + day : '' });
          prevDay = day;
        }
      } else {
        const uA = s.up0 + (a - s.vstart), uB = s.up0 + (b - s.vstart);
        let first = true;
        for (let u = Math.ceil(uA / step) * step; u <= uB; u += step) {
          ticks.push({ v: s.vstart + (u - s.up0), l1: step >= 86400 ? 'day ' + (Math.round(u / 86400) + 1) : fmtUptime(u), l2: first ? 'power-on ' + (s.k + 1) : '' });
          first = false;
        }
      }
    }
    return ticks;
  }

  function niceTicks(min, max, count) {
    const span = max - min || 1;
    const raw = span / count;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const norm = raw / mag;
    const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
    const out = [];
    for (let t = Math.ceil(min / step) * step; t <= max + step * 1e-6; t += step) out.push(+t.toFixed(10));
    return { ticks: out, step };
  }

  // ---------------- charts ----------------
  function chartDefs() {
    const D = S.D;
    const hasExt = [D.E1, D.E2].map(a => { for (let i = 0; i < a.length; i += 7) if (a[i] > 0) return true; return false; });
    const hasData = arr => { for (let i = 0; i < arr.length; i += 11) if (!isNaN(arr[i])) return true; return false; };
    const defs = [];
    if (hasData(D.P)) defs.push({ id: 'power', title: 'Power', unit: 'W', height: 150, min0: true, dec: 0, series: [{ label: 'Total power', color: COLORS.s1, data: D.P }], threshold: () => S.rules.powOn ? S.rules.powW : null });
    defs.push({
      id: 'current', title: 'Pin current', unit: 'A', height: 240, min0: true, dec: 1,
      series: D.I.map((a, j) => ({ label: 'Pin ' + (j + 1), color: PIN_COLORS[j], data: a })),
      threshold: () => S.rules.wireOn ? S.rules.wireA : null, modes: true,
    });
    if (hasData(D.V[0])) defs.push({ id: 'voltage', title: 'Pin voltage', unit: 'V', height: 150, ignoreBelow: 1, dec: 2, series: D.V.map((a, j) => ({ label: 'Pin ' + (j + 1), color: PIN_COLORS[j], data: a })) });
    if (hasData(D.Tin)) {
      const ser = [{ label: 'Onboard in', color: COLORS.s1, data: D.Tin }, { label: 'Onboard out', color: COLORS.s2, data: D.Tout }];
      if (hasExt[0]) ser.push({ label: 'External 1', color: COLORS.s3, data: D.E1 });
      if (hasExt[1]) ser.push({ label: 'External 2', color: COLORS.s4, data: D.E2 });
      defs.push({ id: 'temp', title: 'Temperature', unit: '°C', height: 150, dec: 0, series: ser, threshold: () => S.rules.tempOn ? S.rules.tempC : null });
    }
    return defs;
  }

  function buildCharts() {
    const host = $('#charts');
    host.innerHTML = '';
    S.charts = chartDefs().map(def => {
      def.series.forEach(s => { s.visible = true; });
      const card = document.createElement('div');
      card.className = 'card chart';
      const head = document.createElement('div');
      head.className = 'card-head';
      const h = document.createElement('h3');
      h.textContent = def.title + ' (' + def.unit + ')';
      head.appendChild(h);
      const legend = document.createElement('div');
      legend.className = 'legend';
      def.series.forEach(s => {
        const lab = document.createElement('label');
        const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = true;
        const key = document.createElement('span'); key.className = 'key'; key.style.background = s.color;
        lab.append(cb, key, document.createTextNode(s.label));
        cb.addEventListener('change', () => { s.visible = cb.checked; lab.classList.toggle('off', !cb.checked); drawChart(def); drawOverlays(); });
        lab.addEventListener('mouseenter', () => { def.focus = s; drawChart(def); });
        lab.addEventListener('mouseleave', () => { def.focus = null; drawChart(def); });
        legend.appendChild(lab);
      });
      head.appendChild(legend);
      if (def.modes) {
        const tools = document.createElement('div'); tools.className = 'chart-tools';
        const sel = document.createElement('select');
        sel.innerHTML = '<option value="abs">Amps per pin</option><option value="dev">Deviation from average (%)</option>';
        sel.value = S.curMode;
        sel.addEventListener('change', () => { S.curMode = sel.value; drawChart(def); drawOverlays(); });
        tools.appendChild(sel);
        head.appendChild(tools);
      }
      const wrap = document.createElement('div');
      wrap.style.position = 'relative';
      const base = document.createElement('canvas');
      const over = document.createElement('canvas');
      over.style.position = 'absolute'; over.style.left = '0'; over.style.top = '0';
      base.style.height = over.style.height = def.height + 'px';
      wrap.append(base, over);
      card.append(head, wrap);
      host.appendChild(card);
      Object.assign(def, { card, base, over, pad: { l: 52, r: 16, t: 14, b: 30 } });
      attachChartEvents(def);
      return def;
    });
    resizeAll();
  }

  function sizeCanvas(c, cssH) {
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth || c.parentElement.clientWidth;
    c.width = Math.round(w * dpr); c.height = Math.round(cssH * dpr);
    return { w, h: cssH, dpr };
  }
  function resizeAll() {
    if (!S.D) return;
    S.charts.forEach(def => {
      def.dim = sizeCanvas(def.base, def.height);
      sizeCanvas(def.over, def.height);
    });
    S.navDim = sizeCanvas($('#navCanvas'), 56);
    renderCharts();
  }

  function seriesData(def, s, j) {
    return def.modes && S.curMode === 'dev' ? S.dev[j] : s.data;
  }

  function xOfFn(def) {
    const { w } = def.dim, p = def.pad, v = S.view;
    const k = (w - p.l - p.r) / (v.x1 - v.x0);
    return x => p.l + (x - v.x0) * k;
  }

  function computeYRange(def, i0, i1) {
    let mn = Infinity, mx = -Infinity;
    const stride = Math.max(1, Math.floor((i1 - i0) / 40000));
    def.series.forEach((s, j) => {
      if (!s.visible) return;
      const a = seriesData(def, s, j);
      for (let i = i0; i <= i1; i += stride) {
        const x = a[i];
        if (isNaN(x) || (def.ignoreBelow && !(def.modes && S.curMode === 'dev') && x < def.ignoreBelow)) continue;
        if (x < mn) mn = x; if (x > mx) mx = x;
      }
    });
    if (mn === Infinity) { mn = 0; mx = 1; }
    const devMode = def.modes && S.curMode === 'dev';
    const thr = !devMode && def.threshold ? def.threshold() : null;
    if (thr != null && mx >= thr * 0.6) mx = Math.max(mx, thr);
    if (def.min0 && !devMode) mn = Math.min(0, mn);
    if (devMode) { const m = Math.max(Math.abs(mn), Math.abs(mx), 10); mn = -m; mx = m; }
    const span = mx - mn || Math.max(1, Math.abs(mx) * 0.1);
    if (!(def.min0 && !devMode && mn === 0)) mn -= span * 0.08;
    mx += span * 0.1;
    return { mn, mx, thr };
  }

  function drawChart(def) {
    const D = S.D, { w, h, dpr } = def.dim, p = def.pad;
    const ctx = def.base.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const v = S.view, vt = S.vt;
    const X = xOfFn(def);
    const plotW = w - p.l - p.r, plotH = h - p.t - p.b;
    const i0 = Math.max(0, lowerBound(vt, v.x0) - 1), i1 = Math.min(D.n - 1, lowerBound(vt, v.x1));
    const yr = computeYRange(def, i0, i1);
    def.yr = yr;
    const Y = y => p.t + plotH - (y - yr.mn) / (yr.mx - yr.mn) * plotH;
    def.Y = Y;

    ctx.save();
    ctx.beginPath(); ctx.rect(p.l, p.t, plotW, plotH); ctx.clip();
    // power-off gaps between power-ons
    D.sessions.forEach((s, k) => {
      if (k === 0) return;
      const a = X(D.sessions[k - 1].vend), b = X(s.vstart);
      if (b < p.l || a > w - p.r) return;
      ctx.fillStyle = '#121211'; ctx.fillRect(a, p.t, b - a, plotH);
      ctx.strokeStyle = COLORS.grid; ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = a - plotH; x < b; x += 8) { ctx.moveTo(Math.max(x, a), p.t + plotH - (Math.max(x, a) - x)); ctx.lineTo(Math.min(x + plotH, b), p.t + plotH - (Math.min(x + plotH, b) - x)); }
      ctx.stroke();
      if (b - a > 34) { ctx.fillStyle = COLORS.muted; ctx.font = '11px system-ui'; ctx.textAlign = 'center'; ctx.fillText('off', (a + b) / 2, p.t + 12); }
    });
    // PC off / sleep periods (device logging, 12 V side at 0 V)
    ctx.fillStyle = 'rgba(255,255,255,0.035)';
    S.sleep.forEach(([a, b]) => {
      if (vt[b] < v.x0 || vt[a] > v.x1) return;
      const xa = X(vt[a]), xb = X(vt[b]);
      ctx.fillRect(xa, p.t, Math.max(1, xb - xa), plotH);
      if (xb - xa > 90 && def.id === S.charts[0].id) { ctx.fillStyle = COLORS.muted; ctx.font = '11px system-ui'; ctx.textAlign = 'center'; ctx.fillText('PC off / asleep', (xa + xb) / 2, p.t + 12); ctx.fillStyle = 'rgba(255,255,255,0.035)'; }
    });
    ctx.restore();

    // grid + y labels
    const yt = niceTicks(yr.mn, yr.mx, Math.max(2, Math.floor(plotH / 34)));
    ctx.font = '11px system-ui'; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    yt.ticks.forEach(t => {
      const y = Math.round(Y(t)) + 0.5;
      ctx.strokeStyle = t === 0 ? COLORS.axis : COLORS.grid; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(p.l, y); ctx.lineTo(w - p.r, y); ctx.stroke();
      ctx.fillStyle = COLORS.muted;
      const dec = yt.step < 1 ? (yt.step < 0.1 ? 2 : 1) : 0;
      ctx.fillText(t.toFixed(dec) + (def.modes && S.curMode === 'dev' ? '%' : ''), p.l - 6, y);
    });
    // x ticks
    const ticks = makeTicks(v.x0, v.x1, plotW);
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    let lastX = -1e9;
    ticks.forEach(t => {
      const x = Math.round(X(t.v)) + 0.5;
      if (x < p.l || x > w - p.r || x - lastX < 56) return;
      lastX = x;
      ctx.strokeStyle = COLORS.axis; ctx.beginPath(); ctx.moveTo(x, p.t + plotH); ctx.lineTo(x, p.t + plotH + 4); ctx.stroke();
      ctx.fillStyle = COLORS.muted; ctx.fillText(t.l1, x, p.t + plotH + 6);
      if (t.l2) { ctx.fillStyle = COLORS['ink-2']; ctx.fillText(t.l2, x, p.t + plotH + 18); }
    });

    // threshold
    if (yr.thr != null && yr.thr <= yr.mx) {
      const y = Math.round(Y(yr.thr)) + 0.5;
      ctx.save(); ctx.setLineDash([5, 4]); ctx.strokeStyle = COLORS.warning; ctx.globalAlpha = 0.8;
      ctx.beginPath(); ctx.moveTo(p.l, y); ctx.lineTo(w - p.r, y); ctx.stroke(); ctx.restore();
      ctx.fillStyle = COLORS['ink-2']; ctx.textAlign = 'right'; ctx.textBaseline = 'bottom';
      ctx.fillText('limit ' + yr.thr + ' ' + def.unit, w - p.r - 4, y - 2);
    }

    // series
    ctx.save();
    ctx.beginPath(); ctx.rect(p.l, p.t - 2, plotW, plotH + 4); ctx.clip();
    ctx.lineJoin = 'round';
    def.series.forEach((s, j) => {
      if (!s.visible) return;
      const a = seriesData(def, s, j);
      ctx.strokeStyle = s.color;
      ctx.lineWidth = def.focus === s ? 2.2 : 1.4;
      ctx.globalAlpha = def.focus && def.focus !== s ? 0.18 : 1;
      drawSeries(ctx, a, i0, i1, X, Y, dpr);
    });
    ctx.restore();

    // event markers
    S.events.forEach(ev => {
      const vx = vt[ev.peak];
      if (vx < v.x0 || vx > v.x1) return;
      const x = X(vx);
      ctx.fillStyle = EVENT_TYPES[ev.type].color;
      ctx.beginPath(); ctx.moveTo(x - 4, p.t - 9); ctx.lineTo(x + 4, p.t - 9); ctx.lineTo(x, p.t - 3); ctx.closePath(); ctx.fill();
    });
  }

  // Min/max per device pixel column keeps short spikes visible at any zoom.
  function drawSeries(ctx, a, i0, i1, X, Y, dpr) {
    const vt = S.vt, brk = S.brk;
    let col = null, mn = 0, mx = 0, first = 0, last = 0, pen = false;
    ctx.beginPath();
    const flush = () => {
      if (col === null) return;
      const x = col / dpr;
      if (!pen) { ctx.moveTo(x, Y(first)); pen = true; } else ctx.lineTo(x, Y(first));
      if (mn !== mx) { ctx.lineTo(x, Y(mn)); ctx.lineTo(x, Y(mx)); }
      ctx.lineTo(x, Y(last));
      col = null;
    };
    for (let i = i0; i <= i1; i++) {
      const y = a[i];
      if (brk[i]) { flush(); pen = false; }
      if (isNaN(y)) { flush(); pen = false; continue; }
      const c = Math.round(X(vt[i]) * dpr);
      if (c !== col) { flush(); col = c; mn = mx = first = last = y; }
      else { if (y < mn) mn = y; if (y > mx) mx = y; last = y; }
    }
    flush();
    ctx.stroke();
  }

  function drawOverlays() {
    S.charts.forEach(drawOverlay);
    drawNavOverlay();
  }
  function drawOverlay(def) {
    const { w, h, dpr } = def.dim, p = def.pad;
    const ctx = def.over.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const X = xOfFn(def);
    const plotH = h - p.t - p.b;
    if (S.selEvent) {
      const ev = S.selEvent;
      const a = X(S.vt[ev.i0]) - 3, b = X(S.vt[ev.i1]) + 3;
      ctx.fillStyle = 'rgba(250,178,25,0.10)';
      ctx.fillRect(a, p.t, Math.max(6, b - a), plotH);
    }
    if (def.drag) {
      const a = Math.min(def.drag.x0, def.drag.x1), b = Math.max(def.drag.x0, def.drag.x1);
      ctx.fillStyle = 'rgba(57,135,229,0.16)'; ctx.fillRect(a, p.t, b - a, plotH);
      ctx.strokeStyle = COLORS.accent; ctx.strokeRect(a + 0.5, p.t + 0.5, b - a, plotH);
    }
    const i = S.hoverIdx;
    if (i < 0) return;
    const x = Math.round(X(S.vt[i])) + 0.5;
    if (x < p.l || x > w - p.r) return;
    ctx.strokeStyle = 'rgba(240,239,236,0.45)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, p.t); ctx.lineTo(x, p.t + plotH); ctx.stroke();
    if (!def.Y) return;
    def.series.forEach((s, j) => {
      if (!s.visible) return;
      const y = seriesData(def, s, j)[i];
      if (isNaN(y)) return;
      const yy = def.Y(y);
      if (yy < p.t - 2 || yy > p.t + plotH + 2) return;
      ctx.beginPath(); ctx.arc(x, yy, 4, 0, Math.PI * 2); ctx.fillStyle = COLORS.surface; ctx.fill();
      ctx.beginPath(); ctx.arc(x, yy, 2.6, 0, Math.PI * 2); ctx.fillStyle = s.color; ctx.fill();
    });
  }

  function renderCharts() {
    if (!S.D) return;
    S.charts.forEach(drawChart);
    drawOverlays();
    updateRangeLabel();
  }

  // ---------------- navigator ----------------
  function navX(v) { const { w } = S.navDim; return 4 + (v - S.full.x0) / (S.full.x1 - S.full.x0) * (w - 8); }
  function navV(x) { const { w } = S.navDim; return S.full.x0 + (x - 4) / (w - 8) * (S.full.x1 - S.full.x0); }
  function drawNav() {
    const c = $('#navCanvas'), { w, h, dpr } = S.navDim, D = S.D;
    const ctx = c.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = COLORS.surface; ctx.fillRect(0, 0, w, h);
    let max = 1;
    for (let i = 0; i < D.n; i++) if (D.P[i] > max) max = D.P[i];
    const cols = new Float32Array(Math.ceil(w) + 2).fill(-1);
    for (let i = 0; i < D.n; i++) {
      const p = D.P[i]; if (isNaN(p)) continue;
      const cx = Math.round(navX(S.vt[i]));
      if (p > cols[cx]) cols[cx] = p;
    }
    ctx.fillStyle = 'rgba(57,135,229,0.55)';
    for (let x = 0; x < cols.length; x++) {
      if (cols[x] < 0) continue;
      const bh = Math.max(1, cols[x] / max * (h - 16));
      ctx.fillRect(x, h - 4 - bh, 1, bh);
    }
    D.sessions.forEach((s, k) => {
      const a = navX(s.vstart);
      ctx.fillStyle = COLORS.muted; ctx.font = '10px system-ui'; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      const next = k + 1 < D.sessions.length ? navX(D.sessions[k + 1].vstart) : w;
      if (next - a > 26) ctx.fillText('#' + (k + 1), a + 2, 2);
      if (k > 0) { ctx.fillStyle = COLORS.axis; ctx.fillRect(navX(D.sessions[k - 1].vend), 0, Math.max(1, a - navX(D.sessions[k - 1].vend)), h); }
    });
    S.events.forEach(ev => {
      ctx.fillStyle = EVENT_TYPES[ev.type].color;
      ctx.fillRect(Math.round(navX(S.vt[ev.peak])) - 1, h - 4, 2, 4);
    });
  }
  function drawNavOverlay() {
    // the brush is drawn on the nav canvas itself (cheap enough), so redraw base + brush
    const c = $('#navCanvas'), { w, h, dpr } = S.navDim;
    if (!S._navSnap || S._navSnapW !== c.width) { drawNav(); S._navSnap = c.getContext('2d').getImageData(0, 0, c.width, c.height); S._navSnapW = c.width; }
    const ctx = c.getContext('2d');
    ctx.putImageData(S._navSnap, 0, 0);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const a = navX(S.view.x0), b = navX(S.view.x1);
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fillRect(0, 0, a, h); ctx.fillRect(b, 0, w - b, h);
    ctx.strokeStyle = COLORS['ink-2']; ctx.lineWidth = 1;
    ctx.strokeRect(Math.round(a) + 0.5, 0.5, Math.max(2, b - a - 1), h - 1);
    if (S.hoverIdx >= 0) { ctx.fillStyle = COLORS.ink; ctx.fillRect(Math.round(navX(S.vt[S.hoverIdx])), 0, 1, h); }
  }

  // ---------------- view changes ----------------
  // "Last N hours" ends at the newest sample. Dated stretches count real time (including power-offs
  // between dated power-ons); undated ones count device uptime.
  function rangeStartIdx(sec) {
    const D = S.D;
    let acc = 0;
    for (let i = D.n - 1; i > 0; i--) {
      const a = epochOf(i - 1), b = epochOf(i);
      if (a != null && b != null) acc += b - a;
      else if (S.sessOf[i] === S.sessOf[i - 1]) acc += D.up[i] - D.up[i - 1];
      if (acc > sec) return i;
    }
    return 0;
  }
  function quickRange(hours) {
    if (!S.D) return;
    if (hours) setView(S.vt[rangeStartIdx(hours * 3600)], S.full.x1, true);
    else setView(S.full.x0, S.full.x1, true);
    S.quick = hours;
    try { localStorage.setItem('wvlv:quick', String(hours)); } catch (e) { /* ignore */ }
    markQuick();
  }
  function markQuick() {
    document.querySelectorAll('#quickRange button').forEach(b => b.classList.toggle('on', S.quick != null && +b.dataset.h === S.quick));
  }

  function setView(x0, x1, keepQuick) {
    if (!keepQuick && S.quick != null) { S.quick = null; markQuick(); }
    const f = S.full;
    const minW = Math.max(S.D.interval * 8, 300);
    let w = Math.max(minW, Math.min(x1 - x0, f.x1 - f.x0));
    if (x0 < f.x0) x0 = f.x0;
    x1 = x0 + w;
    if (x1 > f.x1) { x1 = f.x1; x0 = x1 - w; }
    S.view = { x0, x1 };
    scheduleRender();
  }
  let rafPending = false;
  function scheduleRender() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => { rafPending = false; renderCharts(); renderPinHealth(); });
  }
  function updateRangeLabel() {
    const i0 = nearestIdx(S.view.x0), i1 = nearestIdx(S.view.x1);
    const full = S.view.x0 <= S.full.x0 && S.view.x1 >= S.full.x1;
    $('#rangeLabel').textContent = full ? 'Whole history' : labelSample(i0, true) + '  →  ' + labelSample(i1, true);
  }

  function attachChartEvents(def) {
    const el = def.over;
    const localX = e => e.clientX - el.getBoundingClientRect().left;
    const vAt = x => { const p = def.pad, { w } = def.dim; return S.view.x0 + (x - p.l) / (w - p.l - p.r) * (S.view.x1 - S.view.x0); };
    el.addEventListener('mousedown', e => {
      if (e.button !== 0) return;
      def.drag = { x0: localX(e), x1: localX(e) };
      e.preventDefault();
    });
    window.addEventListener('mousemove', e => {
      if (!def.drag) return;
      def.drag.x1 = Math.max(def.pad.l, Math.min(def.dim.w - def.pad.r, localX(e)));
      drawOverlay(def);
    });
    window.addEventListener('mouseup', () => {
      if (!def.drag) return;
      const d = def.drag; def.drag = null;
      if (Math.abs(d.x1 - d.x0) > 6) setView(vAt(Math.min(d.x0, d.x1)), vAt(Math.max(d.x0, d.x1)));
      else drawOverlay(def);
    });
    el.addEventListener('mousemove', e => {
      const x = localX(e);
      const p = def.pad;
      if (x < p.l || x > def.dim.w - p.r) { hideTip(); return; }
      S.hoverIdx = nearestIdx(vAt(x));
      drawOverlays();
      showTip(def, e);
    });
    el.addEventListener('mouseleave', () => { S.hoverIdx = -1; hideTip(); drawOverlays(); });
    el.addEventListener('dblclick', () => setView(S.full.x0, S.full.x1));
    el.addEventListener('wheel', e => {
      e.preventDefault();
      const v = S.view, w = v.x1 - v.x0;
      if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        const d = (Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY) / 600 * w;
        setView(v.x0 + d, v.x1 + d);
      } else {
        const at = vAt(localX(e));
        const f = Math.exp(e.deltaY * 0.0015);
        setView(at - (at - v.x0) * f, at + (v.x1 - at) * f);
      }
    }, { passive: false });
  }

  function attachNavEvents() {
    const c = $('#navCanvas');
    let mode = null, start = 0, v0 = null;
    const lx = e => e.clientX - c.getBoundingClientRect().left;
    c.addEventListener('mousedown', e => {
      const x = lx(e), a = navX(S.view.x0), b = navX(S.view.x1);
      v0 = Object.assign({}, S.view); start = x;
      if (Math.abs(x - a) < 6) mode = 'l';
      else if (Math.abs(x - b) < 6) mode = 'r';
      else if (x > a && x < b) mode = 'move';
      else { mode = 'new'; }
      e.preventDefault();
    });
    window.addEventListener('mousemove', e => {
      if (!mode) {
        const x = lx(e), a = navX(S.view.x0), b = navX(S.view.x1);
        c.style.cursor = Math.abs(x - a) < 6 || Math.abs(x - b) < 6 ? 'ew-resize' : (x > a && x < b ? 'grab' : 'crosshair');
        return;
      }
      const x = lx(e), dv = navV(x) - navV(start);
      if (mode === 'move') setView(v0.x0 + dv, v0.x1 + dv);
      else if (mode === 'l') setView(Math.min(v0.x0 + dv, v0.x1 - 1), v0.x1);
      else if (mode === 'r') setView(v0.x0, Math.max(v0.x1 + dv, v0.x0 + 1));
      else if (mode === 'new' && Math.abs(x - start) > 4) setView(navV(Math.min(x, start)), navV(Math.max(x, start)));
    });
    window.addEventListener('mouseup', e => {
      if (mode === 'new' && Math.abs(lx(e) - start) <= 4) {
        const w = S.view.x1 - S.view.x0, at = navV(start);
        setView(at - w / 2, at + w / 2);
      }
      mode = null;
    });
  }

  // ---------------- tooltip ----------------
  function showTip(def, e) {
    const tip = $('#tooltip'), i = S.hoverIdx, D = S.D;
    tip.textContent = '';
    const t = document.createElement('div'); t.className = 't'; t.textContent = labelSample(i);
    tip.appendChild(t);
    const dev = def.modes && S.curMode === 'dev';
    def.series.forEach((s, j) => {
      if (!s.visible) return;
      const val = seriesData(def, s, j)[i];
      const row = document.createElement('div'); row.className = 'row';
      const key = document.createElement('span'); key.className = 'key'; key.style.background = s.color;
      const b = document.createElement('b'); b.textContent = isNaN(val) ? '–' : (dev ? (val > 0 ? '+' : '') + val.toFixed(0) + '%' : val.toFixed(def.dec) + ' ' + def.unit);
      const nm = document.createElement('span'); nm.className = 'n'; nm.textContent = s.label;
      row.append(key, b, nm); tip.appendChild(row);
    });
    const extra = [];
    if (def.id === 'current' || def.id === 'power') {
      const I = D.I.map(a => a[i]);
      if (!I.some(isNaN)) {
        const mx = Math.max(...I), mn = Math.min(...I);
        extra.push('Total ' + D.It[i].toFixed(1) + ' A · ' + fmt(D.P[i], 0) + ' W');
        if (mx > 0.5) extra.push('Spread ' + ((mx - mn) / (S.rules.imbBase === 'max' ? mx : D.It[i] / 6) * 100).toFixed(0) + '% · pin ' + (I.indexOf(mx) + 1) + ' high, pin ' + (I.indexOf(mn) + 1) + ' low');
      }
    }
    if (S.sleep.length && Math.max(...D.V.map(a => a[i])) < 1) extra.push(pcState(epochOf(i)) + ' (0 V on the 12 V side)');
    extra.forEach(x => { const d = document.createElement('div'); d.className = 't'; d.style.margin = '4px 0 0'; d.textContent = x; tip.appendChild(d); });
    tip.style.display = 'block';
    const r = tip.getBoundingClientRect();
    let left = e.clientX + 16, top = e.clientY + 14;
    if (left + r.width > window.innerWidth - 8) left = e.clientX - r.width - 16;
    if (top + r.height > window.innerHeight - 8) top = e.clientY - r.height - 14;
    tip.style.left = Math.max(8, left) + 'px'; tip.style.top = Math.max(8, top) + 'px';
  }
  function hideTip() { $('#tooltip').style.display = 'none'; }

  // ---------------- events ----------------
  function computeEvents() {
    const D = S.D, R = S.rules, n = D.n, vt = S.vt;
    const evs = [];
    const open = {};
    const push = (type, i, val) => {
      const cur = open[type];
      if (cur && S.sessOf[cur.i1] === S.sessOf[i] && vt[i] - vt[cur.i1] <= 300) {
        cur.i1 = i; cur.n++;
        if (val > cur.val) { cur.val = val; cur.peak = i; }
      } else {
        open[type] = { type, i0: i, i1: i, n: 1, val, peak: i };
        evs.push(open[type]);
      }
    };
    for (let i = 0; i < n; i++) {
      let okI = true, mx = -1, mn = 1e9;
      for (let j = 0; j < 6; j++) { const x = D.I[j][i]; if (isNaN(x)) { okI = false; break; } if (x > mx) mx = x; if (x < mn) mn = x; }
      if (okI) {
        if (R.imbOn && mx > R.imbMinA) {
          const base = R.imbBase === 'max' ? mx : D.It[i] / 6;
          const pct = (mx - mn) / base * 100;
          if (pct > R.imbPct) push('imb', i, pct);
        }
        if (R.wireOn && mx > R.wireA) push('wire', i, mx);
      }
      if (R.powOn && D.P[i] > R.powW) push('pow', i, D.P[i]);
      const tm = Math.max(D.Tin[i], D.Tout[i]);
      if (R.tempOn && tm > R.tempC) push('temp', i, tm);
    }
    evs.sort((a, b) => vt[b.peak] - vt[a.peak]);
    S.events = evs;
    S.selEvent = null;
  }

  function renderEvents() {
    const tbl = $('#evTable'), D = S.D;
    tbl.textContent = '';
    const counts = {};
    S.events.forEach(e => { counts[e.type] = (counts[e.type] || 0) + 1; });
    $('#evCount').textContent = S.events.length
      ? S.events.length + ' found · ' + Object.keys(counts).map(k => counts[k] + ' ' + EVENT_TYPES[k].label.toLowerCase()).join(', ')
      : '';
    const head = document.createElement('tr');
    ['When', 'Event', 'Peak', 'Pins at peak (A)', 'Samples'].forEach((h, k) => { const th = document.createElement('th'); th.textContent = h; if (k === 4) th.className = 'r'; head.appendChild(th); });
    tbl.appendChild(head);
    if (!S.events.length) {
      const tr = document.createElement('tr'); const td = document.createElement('td'); td.colSpan = 5; td.className = 'muted';
      td.textContent = 'No events with these rules.'; tr.appendChild(td); tbl.appendChild(tr);
    }
    S.events.slice(0, 1000).forEach(ev => {
      const tr = document.createElement('tr');
      if (ev === S.selEvent) tr.className = 'sel';
      const t = EVENT_TYPES[ev.type];
      const c1 = document.createElement('td'); c1.textContent = labelSample(ev.peak, true); c1.className = 'num';
      const c2 = document.createElement('td'); const chip = document.createElement('span'); chip.className = 'chip';
      const dot = document.createElement('i'); dot.style.background = t.color; chip.append(dot, document.createTextNode(t.label)); c2.appendChild(chip);
      const c3 = document.createElement('td'); c3.className = 'num';
      c3.textContent = ev.type === 'imb' ? ev.val.toFixed(0) + '%' : ev.val.toFixed(ev.type === 'wire' ? 1 : 0) + ' ' + t.unit;
      const c4 = document.createElement('td'); c4.className = 'num ink2';
      c4.textContent = D.I.map(a => fmt(a[ev.peak], 1)).join('  ');
      const c5 = document.createElement('td'); c5.className = 'num r'; c5.textContent = ev.n;
      tr.append(c1, c2, c3, c4, c5);
      tr.addEventListener('click', () => selectEvent(ev));
      tbl.appendChild(tr);
    });
    const iv = Math.round(D.interval);
    $('#evNote').textContent = `The log has one sample every ${iv >= 60 ? Math.round(iv / 60) + ' min' : iv + ' s'} (each one a ~1.4 s average). The device checks continuously, so a spike that falls between samples can trigger a warning without showing up here. Defaults match your device settings: 40% at 6 A, 10.5 A per pin, 660 W, 80 °C.`;
  }

  function selectEvent(ev) {
    S.selEvent = ev;
    const pad = Math.max(1800, (S.vt[ev.i1] - S.vt[ev.i0]) * 0.6);
    setView(S.vt[ev.i0] - pad, S.vt[ev.i1] + pad);
    renderEvents();
    renderDetail();
  }

  function renderDetail() {
    const box = $('#evDetail'), ev = S.selEvent, D = S.D;
    if (!ev) { box.classList.add('hidden'); return; }
    box.classList.remove('hidden');
    box.textContent = '';
    const t = EVENT_TYPES[ev.type];
    const h = document.createElement('div');
    h.style.cssText = 'font-weight:600;margin-bottom:6px';
    h.textContent = t.label + ' · ' + labelSample(ev.peak);
    box.appendChild(h);
    const s = D.sessions[S.sessOf[ev.peak]];
    const idx = [ev.peak - 1, ev.peak, ev.peak + 1].filter(i => i >= s.i0 && i <= s.i1);
    const tbl = document.createElement('table');
    const hr = document.createElement('tr');
    const th0 = document.createElement('th'); th0.textContent = ''; hr.appendChild(th0);
    idx.forEach(i => {
      const th = document.createElement('th'); th.className = 'r';
      const dt = Math.round((D.up[i] - D.up[ev.peak]) / 60);
      th.textContent = i === ev.peak ? 'At peak' : (dt > 0 ? '+' : '') + dt + ' min';
      hr.appendChild(th);
    });
    tbl.appendChild(hr);
    const addRow = (label, vals, cls) => {
      const tr = document.createElement('tr');
      const td0 = document.createElement('td'); td0.textContent = label; tr.appendChild(td0);
      vals.forEach((v, k) => { const td = document.createElement('td'); td.className = 'r num ' + (cls ? cls[k] || '' : ''); td.textContent = v; tr.appendChild(td); });
      tbl.appendChild(tr);
    };
    for (let j = 0; j < 6; j++) {
      const cls = idx.map(i => {
        const m = D.It[i] / 6, x = D.I[j][i];
        if (!(m > 1) || isNaN(x)) return '';
        return x > m * 1.15 ? 'hi' : x < m * 0.85 ? 'lo' : '';
      });
      addRow('Pin ' + (j + 1), idx.map(i => fmt(D.I[j][i], 1) + ' A'), cls);
    }
    addRow('Average', idx.map(i => fmt(D.It[i] / 6, 2) + ' A'));
    addRow('Spread', idx.map(i => {
      const I = D.I.map(a => a[i]); if (I.some(isNaN)) return '–';
      const mx = Math.max(...I), mn = Math.min(...I);
      return mx > 0 ? ((mx - mn) / (S.rules.imbBase === 'max' ? mx : D.It[i] / 6) * 100).toFixed(0) + '%' : '–';
    }));
    addRow('Total', idx.map(i => fmt(D.It[i], 1) + ' A · ' + fmt(D.P[i], 0) + ' W'));
    addRow('Temp in / out', idx.map(i => fmt(D.Tin[i], 0) + ' / ' + fmt(D.Tout[i], 0) + ' °C'));
    box.appendChild(tbl);
    const note = document.createElement('div'); note.className = 'note';
    note.textContent = 'Orange: more than 15% above the average pin. Blue: more than 15% below it.';
    box.appendChild(note);
  }

  function syncRulesUI() {
    document.querySelectorAll('[data-rule]').forEach(el => {
      const k = el.dataset.rule;
      if (el.type === 'checkbox') el.checked = !!S.rules[k]; else el.value = S.rules[k];
    });
  }
  function onRuleChange() {
    document.querySelectorAll('[data-rule]').forEach(el => {
      const k = el.dataset.rule;
      if (el.type === 'checkbox') S.rules[k] = el.checked;
      else if (el.tagName === 'SELECT') S.rules[k] = el.value;
      else { const v = parseFloat(el.value); if (!isNaN(v)) S.rules[k] = v; }
    });
    saveJSON('wvlv:rules', S.rules);
    try { localStorage.setItem('wvlv:rules:custom', '1'); } catch (e) { /* ignore */ }
    computeEvents();
    renderAll();
  }

  // ---------------- pin health ----------------
  function renderPinHealth() {
    const box = $('#pinHealth'), D = S.D;
    if (!D) return;
    const minA = parseFloat($('#loadMin').value) || 30;
    const i0 = Math.max(0, lowerBound(S.vt, S.view.x0)), i1 = Math.min(D.n - 1, lowerBound(S.vt, S.view.x1));
    const sum = [0, 0, 0, 0, 0, 0], share = [0, 0, 0, 0, 0, 0], mx = [0, 0, 0, 0, 0, 0], hi = [0, 0, 0, 0, 0, 0], lo = [0, 0, 0, 0, 0, 0];
    let n = 0;
    for (let i = i0; i <= i1; i++) {
      const it = D.It[i];
      if (!(it >= minA)) continue;
      let ok = true;
      for (let j = 0; j < 6; j++) if (isNaN(D.I[j][i])) { ok = false; break; }
      if (!ok) continue;
      n++;
      const m = it / 6;
      for (let j = 0; j < 6; j++) {
        const x = D.I[j][i];
        sum[j] += x; share[j] += x / it; if (x > mx[j]) mx[j] = x;
        if (x > m * 1.15) hi[j]++; else if (x < m * 0.85) lo[j]++;
      }
    }
    box.textContent = '';
    if (!n) { const p = document.createElement('div'); p.className = 'muted'; p.textContent = `No samples above ${minA} A in the visible range.`; box.appendChild(p); return; }
    const info = document.createElement('div'); info.className = 'muted'; info.style.cssText = 'font-size:12px;margin-bottom:6px';
    info.textContent = `${n.toLocaleString()} loaded samples (about ${fmtDuration(n * D.interval)})`;
    box.appendChild(info);
    const tbl = document.createElement('table');
    const hr = document.createElement('tr');
    ['Pin', 'Share of current', '', 'Avg', 'Max', 'Runs high', 'Runs low'].forEach((h, k) => { const th = document.createElement('th'); th.textContent = h; if (k >= 2) th.className = 'r'; hr.appendChild(th); });
    tbl.appendChild(hr);
    const lo0 = 10, hi0 = 23;
    for (let j = 0; j < 6; j++) {
      const sh = share[j] / n * 100;
      const tr = document.createElement('tr');
      const c0 = document.createElement('td');
      const key = document.createElement('span'); key.className = 'key'; key.style.cssText = `background:${PIN_COLORS[j]};margin-right:6px;vertical-align:middle`;
      c0.append(key, document.createTextNode('Pin ' + (j + 1)));
      const c1 = document.createElement('td');
      const bar = document.createElement('div'); bar.className = 'bar';
      const b = document.createElement('div'); b.className = 'b';
      const pos = v => Math.max(0, Math.min(100, (v - lo0) / (hi0 - lo0) * 100));
      const a = pos(100 / 6), z = pos(sh);
      b.style.left = Math.min(a, z) + '%'; b.style.width = Math.max(1, Math.abs(z - a)) + '%';
      if (sh > 100 / 6 * 1.08) b.style.background = COLORS.serious; else if (sh < 100 / 6 * 0.92) b.style.background = COLORS.accent;
      const ideal = document.createElement('div'); ideal.className = 'ideal'; ideal.style.left = a + '%';
      bar.append(b, ideal); c1.appendChild(bar);
      const c2 = document.createElement('td'); c2.className = 'r num'; c2.textContent = sh.toFixed(1) + '%';
      const c3 = document.createElement('td'); c3.className = 'r num'; c3.textContent = (sum[j] / n).toFixed(2) + ' A';
      const c4 = document.createElement('td'); c4.className = 'r num'; c4.textContent = mx[j].toFixed(1) + ' A';
      const c5 = document.createElement('td'); c5.className = 'r num'; c5.textContent = (hi[j] / n * 100).toFixed(1) + '%';
      const c6 = document.createElement('td'); c6.className = 'r num'; c6.textContent = (lo[j] / n * 100).toFixed(1) + '%';
      tr.append(c0, c1, c2, c3, c4, c5, c6);
      tbl.appendChild(tr);
    }
    box.appendChild(tbl);
    const nt = document.createElement('div'); nt.className = 'note';
    nt.textContent = '"Runs high/low": share of loaded samples where that pin was more than 15% above or below the average pin.';
    box.appendChild(nt);
  }

  // ---------------- tiles & sessions ----------------
  function renderTiles() {
    const D = S.D, box = $('#tiles');
    box.textContent = '';
    let logged = 0, active = 0, pk = -1, pkI = 0, pinPk = -1, pinI = 0, pinJ = 0, tPk = -1, tI = 0;
    D.sessions.forEach(s => { logged += s.up1 - s.up0; });
    const cap = 3 * D.interval;
    for (let i = 0; i < D.n; i++) {
      if (D.It[i] >= 1 && i + 1 < D.n && S.sessOf[i + 1] === S.sessOf[i]) active += Math.min(cap, D.up[i + 1] - D.up[i]);
      if (D.P[i] > pk) { pk = D.P[i]; pkI = i; }
      for (let j = 0; j < 6; j++) if (D.I[j][i] > pinPk) { pinPk = D.I[j][i]; pinI = i; pinJ = j; }
      const tm = Math.max(D.Tin[i], D.Tout[i]); if (tm > tPk) { tPk = tm; tI = i; }
    }
    const counts = {};
    S.events.forEach(e => { counts[e.type] = (counts[e.type] || 0) + 1; });
    const tiles = [
      { label: 'Logged time', value: fmtDuration(logged), sub: D.sessions.length + ' power-on' + (D.sessions.length > 1 ? 's' : '') },
      { label: 'GPU powered', value: fmtDuration(active), sub: Math.round(active / logged * 100) + '% of logged time' },
      { label: 'Peak power', value: fmt(pk, 0) + ' W', sub: labelSample(pkI, true), i: pkI },
      { label: 'Peak pin current', value: fmt(pinPk, 1) + ' A', sub: 'pin ' + (pinJ + 1) + ' · ' + labelSample(pinI, true), i: pinI },
      { label: 'Max temperature', value: fmt(tPk, 0) + ' °C', sub: labelSample(tI, true), i: tI },
      { label: 'Imbalance events', value: String(counts.imb || 0), sub: S.events.length ? S.events.length + ' events in total' : 'with current rules', ev: S.events.find(e => e.type === 'imb') },
    ];
    tiles.forEach(t => {
      const el = document.createElement('div'); el.className = 'card tile';
      const a = document.createElement('div'); a.className = 'label'; a.textContent = t.label;
      const b = document.createElement('div'); b.className = 'value'; b.textContent = t.value;
      const c = document.createElement('div'); c.className = 'sub'; c.textContent = t.sub;
      el.append(a, b, c);
      if (t.i !== undefined || t.ev) {
        el.style.cursor = 'pointer'; el.title = t.ev ? 'Show the latest one' : 'Zoom to this moment';
        el.addEventListener('click', () => {
          if (t.ev) { selectEvent(t.ev); $('#evTable').scrollIntoView({ behavior: 'smooth', block: 'center' }); }
          else setView(S.vt[t.i] - 3600, S.vt[t.i] + 3600);
        });
      }
      box.appendChild(el);
    });
  }

  function sessionStats(s) {
    const D = S.D;
    let active = 0, pk = 0;
    for (let i = s.i0; i <= s.i1; i++) {
      if (D.It[i] >= 1 && i < s.i1) active += Math.min(3 * D.interval, D.up[i + 1] - D.up[i]);
      if (D.P[i] > pk) pk = D.P[i];
    }
    const ev = S.events.filter(e => S.sessOf[e.peak] === s.k).length;
    return { active, pk, ev };
  }

  function toLocalInput(epoch) {
    const d = new Date(epoch * 1000);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + 'T' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  function saveAnchors() {
    const out = {};
    S.D.sessions.forEach((s, k) => { if (s.c != null && isManual(s)) out[k] = { c: s.c, f: s.f, src: s.src, approx: s.approx }; });
    saveJSON(S.anchorKey, out);
  }
  function srcText(s) {
    if (s.c == null) return 'No date yet';
    if (s.src === 'windows') {
      const m = s.match;
      const conf = { high: 'matched', medium: 'matched', low: 'best guess from' }[m.confidence];
      return `${conf === 'matched' ? 'Windows log' : 'Best guess from Windows log'} · ${m.matched} of ${m.total} on/off changes line up · ±${Math.max(1, Math.round((m.error + 30) / 60))} min`;
    }
    if (s.src === 'device') return s.approx ? 'WireView clock sync · ±1 min' : 'WireView clock sync · ±2 s';
    return { file: 'From the file name (when it was saved)', manual: 'Entered by you', next: 'Assumed: ended just before the next one', clock: 'From the export\'s own clock' }[s.src] || '';
  }

  function renderSessions() {
    const D = S.D, strip = $('#strip'), tbl = $('#sessTable');
    strip.textContent = '';
    tbl.textContent = '';
    const hr = document.createElement('tr');
    ['#', 'Length', 'GPU powered', 'Peak', 'Events', 'Started', 'Ended', 'Dated by', ''].forEach((h, k) => { const th = document.createElement('th'); th.textContent = h; if (k >= 1 && k <= 4) th.className = 'r'; hr.appendChild(th); });
    tbl.appendChild(hr);
    D.sessions.forEach((s, k) => {
      const st = sessionStats(s);
      const len = s.up1 - s.up0;
      const seg = document.createElement('div'); seg.className = 'seg';
      seg.style.flexGrow = Math.max(len, 1);
      seg.textContent = '#' + (k + 1) + ' · ' + fmtDuration(len);
      const fill = document.createElement('div'); fill.className = 'fill'; fill.style.width = Math.min(100, st.active / len * 100) + '%';
      seg.appendChild(fill);
      if (st.ev) { const d = document.createElement('div'); d.className = 'ev'; seg.appendChild(d); }
      seg.title = `Power-on ${k + 1}: ${fmtDuration(len)} logged, GPU powered ${fmtDuration(st.active)}, peak ${st.pk.toFixed(0)} W, ${st.ev} events`;
      seg.addEventListener('click', () => setView(s.vstart - len * 0.01, s.vend + len * 0.01));
      strip.appendChild(seg);

      const tr = document.createElement('tr');
      const cells = ['#' + (k + 1), fmtDuration(len), fmtDuration(st.active), st.pk.toFixed(0) + ' W', String(st.ev)];
      cells.forEach((c, ci) => { const td = document.createElement('td'); td.textContent = c; if (ci >= 1) td.className = 'r num'; tr.appendChild(td); });
      const f = s.c != null ? s.f : (S.drift || 1);
      const tdS = document.createElement('td'); tdS.className = 'num';
      tdS.textContent = s.c != null ? (s.approx ? '≈ ' : '') + fmtDT.format(new Date(s.c * 1000)) : '–';
      const tdE = document.createElement('td');
      const inp = document.createElement('input'); inp.type = 'datetime-local';
      if (s.c != null) inp.value = toLocalInput(s.c + s.f * s.up1);
      inp.addEventListener('change', () => {
        const t = new Date(inp.value).getTime() / 1000;
        if (isNaN(t)) clearAnchor(s); else setAnchor(s, t - f * s.up1, f, 'manual', false);
        saveAnchors(); if (S.power) runAlign(); else renderAll();
      });
      tdE.appendChild(inp);
      const tdD = document.createElement('td');
      const src = document.createElement('span'); src.className = 'src' + (s.approx ? ' low' : '');
      src.textContent = srcText(s);
      tdD.appendChild(src);
      const tdA = document.createElement('td');
      const next = D.sessions[k + 1];
      if (next && s.src !== 'windows') {
        const b = document.createElement('button'); b.textContent = 'Ended just before next';
        b.disabled = next.c == null;
        b.title = next.c == null ? 'The next power-on needs a date first' : 'Assumes the device was off for about a minute';
        b.addEventListener('click', () => {
          setAnchor(s, next.c - 60 - f * s.up1, f, 'next', true);
          saveAnchors(); if (S.power) runAlign(); else renderAll();
        });
        tdA.appendChild(b);
      }
      if (isManual(s)) {
        const c = document.createElement('button'); c.className = 'link'; c.style.marginLeft = '10px'; c.textContent = 'Clear';
        c.addEventListener('click', () => { clearAnchor(s); saveAnchors(); if (S.power) runAlign(); else renderAll(); });
        tdA.appendChild(c);
      }
      tr.append(tdS, tdE, tdD, tdA);
      tbl.appendChild(tr);
    });
  }

  function renderAll() {
    relayout();
    S._navSnap = null;
    renderTiles();
    renderSessions();
    renderPowerLog();
    renderEvents();
    renderDetail();
    renderCharts();
    renderPinHealth();
  }

  // ---------------- export ----------------
  function download(name, text) {
    const blob = new Blob([text], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  function isoLocal(epoch) {
    if (epoch == null) return '';
    const d = new Date(epoch * 1000);
    return toLocalInput(epoch) + ':' + pad2(d.getSeconds());
  }
  function exportRange() {
    const D = S.D;
    const i0 = Math.max(0, lowerBound(S.vt, S.view.x0)), i1 = Math.min(D.n - 1, lowerBound(S.vt, S.view.x1));
    const lines = ['power_on,uptime_s,local_time,power_w,current_a,temp_in_c,temp_out_c,v1,v2,v3,v4,v5,v6,i1,i2,i3,i4,i5,i6'];
    for (let i = i0; i <= i1; i++) {
      lines.push([S.sessOf[i] + 1, D.up[i].toFixed(1), isoLocal(epochOf(i)), fmt(D.P[i], 2), fmt(D.It[i], 1), fmt(D.Tin[i], 0), fmt(D.Tout[i], 0)]
        .concat(D.V.map(a => fmt(a[i], 1)), D.I.map(a => fmt(a[i], 1))).join(','));
    }
    download('wireview-range.csv', lines.join('\n'));
  }
  function exportEvents() {
    const D = S.D;
    const lines = ['power_on,uptime_s,local_time,event,peak,unit,samples,i1,i2,i3,i4,i5,i6,total_a,power_w'];
    S.events.forEach(ev => {
      const i = ev.peak, t = EVENT_TYPES[ev.type];
      lines.push([S.sessOf[i] + 1, D.up[i].toFixed(1), isoLocal(epochOf(i)), t.label, ev.val.toFixed(2), t.unit, ev.n]
        .concat(D.I.map(a => fmt(a[i], 1)), [fmt(D.It[i], 1), fmt(D.P[i], 1)]).join(','));
    });
    download('wireview-events.csv', lines.join('\n'));
  }

  // ---------------- desktop app (WebView2 host) ----------------
  const HOST = window.chrome && window.chrome.webview ? window.chrome.webview : null;
  const RPC = { n: 0, pending: new Map(), handlers: {} };
  function call(method, params) {
    return new Promise((resolve, reject) => {
      const id = ++RPC.n;
      RPC.pending.set(id, { resolve, reject });
      HOST.postMessage(JSON.stringify({ id, method, params: params || {} }));
    });
  }
  function onHost(evt, fn) { (RPC.handlers[evt] = RPC.handlers[evt] || []).push(fn); }

  const DEV = { info: null, live: [], busy: false, lastSync: null };

  function devMsg(text, isErr) { const m = $('#devMsg'); m.textContent = text || ''; m.classList.toggle('err', !!isErr); }
  function devStatus() {
    const st = $('#devStatus'), on = !!DEV.info;
    st.className = 'dev-status' + (on ? ' on' : '');
    st.textContent = '';
    st.appendChild(document.createElement('i'));
    const t = document.createElement('span'); t.textContent = on ? 'WireView connected' : 'WireView not connected';
    st.appendChild(t);
    if (on) {
      const sub = document.createElement('span'); sub.className = 'sub';
      sub.textContent = `firmware v${pad2(DEV.info.firmwareVersion)} · ${DEV.info.buildInfo} · ${DEV.info.port}`;
      st.appendChild(sub);
    }
    $('#devConnect').textContent = on ? 'Disconnect' : 'Connect';
    $('#devDownload').disabled = !on || DEV.busy;
    $('#devLive').classList.toggle('hidden', !on);
    renderDevSettings();
  }

  async function devConnect() {
    devMsg('Connecting…');
    try {
      DEV.info = await call('device.connect');
      DEV.live = [];
      devMsg('');
      applyDeviceRules();
    } catch (err) { DEV.info = null; devMsg(err.message || String(err), true); }
    devStatus();
    if (DEV.info && $('#devAuto').checked) devDownload(false);
  }

  // the device's own alarm settings become the event rules
  function applyDeviceRules() {
    const c = DEV.info && DEV.info.config;
    if (!c) return;
    Object.assign(DEFAULT_RULES, { imbPct: c.imbalanceLimitPct, imbMinA: c.imbalanceMinA, wireA: c.wireLimitA, powW: c.powerLimitW, tempC: c.tempLimitC });
    if (!localStorage.getItem('wvlv:rules:custom')) {
      S.rules = Object.assign({}, S.rules, { imbPct: c.imbalanceLimitPct, imbMinA: c.imbalanceMinA, wireA: c.wireLimitA, powW: c.powerLimitW, tempC: c.tempLimitC });
      if (S.D) { syncRulesUI(); computeEvents(); renderAll(); }
    }
  }

  function renderDevSettings() {
    const box = $('#devSettings'), c = DEV.info && DEV.info.config;
    box.textContent = '';
    if (!c) return;
    const parts = [
      ['Imbalance alarm', `${c.imbalanceLimitPct}% when a pin is over ${c.imbalanceMinA} A`], ['Pin limit', c.wireLimitA + ' A'],
      ['Total', c.currentLimitA + ' A / ' + c.powerLimitW + ' W'], ['Temperature', c.tempLimitC + ' °C'],
      ['Logging', 'every ' + c.loggingIntervalS + ' s'], ['Averaging', c.averagingMs + ' ms'],
    ];
    box.appendChild(document.createTextNode('Device settings: '));
    parts.forEach(([k, v], i) => {
      if (i) box.appendChild(document.createTextNode(' · '));
      box.appendChild(document.createTextNode(k + ' '));
      const b = document.createElement('b'); b.textContent = v; box.appendChild(b);
    });
    if (c.loggingIntervalS > 60) box.appendChild(document.createTextNode(` · Logging every ${c.loggingIntervalS} s misses short spikes; 60 s or less is better (change it in WireView2).`));
  }

  function renderLive(r) {
    const pins = r.pins, I = pins.map(p => p.a), tot = I.reduce((a, b) => a + b, 0);
    const P = pins.reduce((a, p) => a + p.v * p.a, 0), mx = Math.max(...I), mn = Math.min(...I);
    const c = DEV.info && DEV.info.config;
    const wire = c ? c.wireLimitA : S.rules.wireA, imbLim = c ? c.imbalanceLimitPct : S.rules.imbPct, imbMin = c ? c.imbalanceMinA : S.rules.imbMinA;
    const imb = mx > 0 ? (mx - mn) / mx * 100 : 0;
    const faults = ['chip temp', 'sensor temp', 'over-current', 'pin over-current', 'over-power', 'imbalance'];
    const active = faults.filter((f, k) => r.faultStatus >> k & 1), logged = faults.filter((f, k) => r.faultLog >> k & 1);
    const nums = [
      ['Power', P.toFixed(0) + ' W'], ['Current', tot.toFixed(1) + ' A'], ['Voltage', r.avgV.toFixed(2) + ' V'],
      ['Temp in / out', r.tempIn.toFixed(0) + ' / ' + r.tempOut.toFixed(0) + ' °C'], ['Fan', r.fanPct + ' %'],
      ['Cable', r.cableCapabilityW ? r.cableCapabilityW + ' W' : '–'],
      ['Faults', active.length ? active.join(', ') : (logged.length ? 'logged: ' + logged.join(', ') : 'none'), active.length > 0],
    ];
    const box = $('#devNums'); box.textContent = '';
    nums.forEach(([l, v, warn]) => {
      const d = document.createElement('div'); d.className = 'n';
      const a = document.createElement('div'); a.className = 'l'; a.textContent = l;
      const b = document.createElement('div'); b.className = 'v' + (warn ? ' warn' : ''); b.textContent = v;
      if (l === 'Faults') b.style.fontSize = '14px';
      d.append(a, b); box.appendChild(d);
    });
    const pb = $('#devPins'); pb.textContent = '';
    const scale = Math.max(wire * 1.1, mx * 1.05, 1);
    pins.forEach((p, j) => {
      const row = document.createElement('div'); row.className = 'dev-pin';
      const name = document.createElement('span'); name.textContent = 'Pin ' + (j + 1);
      const track = document.createElement('div'); track.className = 'track';
      const fill = document.createElement('div'); fill.className = 'fillp';
      fill.style.width = (p.a / scale * 100) + '%';
      fill.style.background = p.a > wire ? COLORS.critical : PIN_COLORS[j];
      const lim = document.createElement('div'); lim.className = 'lim'; lim.style.left = (wire / scale * 100) + '%'; lim.title = 'Pin limit ' + wire + ' A';
      track.append(fill, lim);
      const a = document.createElement('span'); a.className = 'a'; a.textContent = p.a.toFixed(2) + ' A';
      const s = document.createElement('span'); s.className = 's'; s.textContent = tot > 0.5 ? (p.a / tot * 100).toFixed(1) + '%' : '';
      row.append(name, track, a, s); pb.appendChild(row);
    });
    const im = document.createElement('div'); im.className = 'imb';
    im.textContent = mx > imbMin
      ? `Imbalance now ${imb.toFixed(0)}% (alarm at ${imbLim}%) · pin ${I.indexOf(mx) + 1} highest, pin ${I.indexOf(mn) + 1} lowest`
      : `Imbalance is only checked when a pin is over ${imbMin} A (highest now ${mx.toFixed(1)} A)`;
    pb.appendChild(im);
    DEV.live.push({ t: Date.now(), I });
    if (DEV.live.length > 300) DEV.live.shift();
    drawLiveChart(wire);
  }

  function drawLiveChart(wire) {
    const c = $('#devChart');
    const dpr = window.devicePixelRatio || 1, w = c.clientWidth, h = 120;
    if (!w) return;
    c.width = Math.round(w * dpr); c.height = h * dpr;
    const ctx = c.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const pts = DEV.live, pad = { l: 40, r: 8, t: 8, b: 18 };
    let mx = 1;
    pts.forEach(p => p.I.forEach(x => { if (x > mx) mx = x; }));
    mx = Math.max(mx * 1.15, 1);
    const X = k => pad.l + (k + 300 - pts.length) / 299 * (w - pad.l - pad.r), Y = v => pad.t + (1 - v / mx) * (h - pad.t - pad.b);
    ctx.font = '11px system-ui'; ctx.fillStyle = COLORS.muted; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    niceTicks(0, mx, 3).ticks.forEach(t => {
      ctx.strokeStyle = COLORS.grid; ctx.beginPath(); ctx.moveTo(pad.l, Math.round(Y(t)) + 0.5); ctx.lineTo(w - pad.r, Math.round(Y(t)) + 0.5); ctx.stroke();
      ctx.fillText(t + ' A', pad.l - 6, Y(t));
    });
    if (wire < mx) { ctx.save(); ctx.setLineDash([5, 4]); ctx.strokeStyle = COLORS.warning; ctx.beginPath(); ctx.moveTo(pad.l, Y(wire)); ctx.lineTo(w - pad.r, Y(wire)); ctx.stroke(); ctx.restore(); }
    ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.fillText('last 5 minutes, per pin', pad.l, h - 14);
    for (let j = 0; j < 6; j++) {
      ctx.strokeStyle = PIN_COLORS[j]; ctx.lineWidth = 1.4; ctx.beginPath();
      pts.forEach((p, k) => { const x = X(k), y = Y(p.I[j]); if (k) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
      ctx.stroke();
    }
  }

  async function devDownload(full) {
    if (DEV.busy || !DEV.info) return;
    DEV.busy = true; devStatus();
    $('#devProgress').classList.remove('hidden');
    $('#devProgressBar').style.width = '0';
    $('#devProgressText').textContent = 'Checking what\'s new…';
    devMsg('');
    try {
      const r = await call('device.download', { full: !!full });
      $('#devProgressText').textContent = 'Opening…';
      await openUrl(r.url, r.fileName);
      const how = r.incremental
        ? `Updated in ${r.seconds} s: read only the new data (${r.pagesRead} pages) and kept the rest from the last download.`
        : `Read the whole history in ${r.seconds} s (${r.usedSectors} of 2048 memory blocks in use).`;
      DEV.updateMsg = how;
      devMsg(`${how} Syncing the device clock: waiting for its next sample (up to ${r.intervalS} s)…`);
      refreshHistoryList(r.fileName);
    } catch (err) { devMsg('Update failed: ' + (err.message || err), true); }
    DEV.busy = false;
    $('#devProgress').classList.add('hidden');
    devStatus();
  }

  function onClockSync(d) {
    if (!S.D) return;
    // the synced tick belongs to the newest power-on in the loaded file
    const s = S.D.sessions[S.D.sessions.length - 1];
    if (!s.key || d.tick / 1000 < s.up1 - 3600 || d.tick / 1000 > s.up1 + 3 * 3600) return;
    try { localStorage.setItem('wvlv:dev:' + s.key, JSON.stringify({ tick: d.tick, epoch: d.epoch, precise: d.precise })); } catch (e) { /* storage unavailable */ }
    applyDeviceAnchor(s);
    devMsg((DEV.updateMsg ? DEV.updateMsg + ' ' : '') + (d.precise
      ? 'Device clock synced to this PC (±2 s).'
      : 'Clock sync timed out, so this power-on is dated from the download time (±1 min).'));
    if (S.power) runAlign(); else renderAll();
  }

  async function openUrl(url, name) {
    const blob = await (await fetch(url)).blob();
    await loadFiles([new File([blob], name)]);
  }

  async function refreshHistoryList(select) {
    const sel = $('#devHistory');
    let list = [];
    try { list = await call('history.list'); } catch (e) { /* none */ }
    sel.textContent = '';
    const first = document.createElement('option'); first.value = ''; first.textContent = list.length ? 'Earlier downloads (' + list.length + ')' : 'No downloads yet';
    sel.appendChild(first);
    list.forEach(f => { const o = document.createElement('option'); o.value = f.url; o.textContent = f.name; o.dataset.name = f.name; sel.appendChild(o); });
    sel.value = '';
    return list;
  }

  async function initHost() {
    if (!HOST) return;
    document.body.classList.add('in-app');
    HOST.addEventListener('message', e => {
      const m = e.data;
      if (m && m.id && RPC.pending.has(m.id)) {
        const p = RPC.pending.get(m.id); RPC.pending.delete(m.id);
        if (m.error) p.reject(new Error(m.error)); else p.resolve(m.result);
      } else if (m && m.event) (RPC.handlers[m.event] || []).forEach(fn => fn(m.data));
    });
    onHost('device.live', renderLive);
    onHost('device.status', d => { if (!d.connected) { DEV.info = null; devStatus(); devMsg(d.error || '', true); } });
    onHost('download.progress', d => {
      $('#devProgressBar').style.width = (d.done / Math.max(1, d.total) * 100) + '%';
      $('#devProgressText').textContent = `${d.phase} · ${Math.round(d.done / Math.max(1, d.total) * 100)}%`;
    });
    onHost('clock.sync', onClockSync);
    $('#device').classList.remove('hidden');
    $('#devConnect').addEventListener('click', async () => {
      if (DEV.info) { await call('device.disconnect'); DEV.info = null; devStatus(); devMsg(''); } else devConnect();
    });
    $('#devDownload').addEventListener('click', () => devDownload(false));
    $('#devFull').addEventListener('click', () => devDownload(true));
    try { $('#devAuto').checked = localStorage.getItem('wvlv:autoUpdate') !== '0'; } catch (e) { /* default on */ }
    $('#devAuto').addEventListener('change', e => { try { localStorage.setItem('wvlv:autoUpdate', e.target.checked ? '1' : '0'); } catch (x) { /* ignore */ } });
    $('#devReveal').addEventListener('click', () => call('history.reveal', {}));
    $('#devHistory').addEventListener('change', e => { const o = e.target.selectedOptions[0]; if (o && o.value) openUrl(o.value, o.dataset.name); });
    devStatus();

    const info = await call('app.info');
    // Windows power history is read directly; no export script needed
    call('power.events').then(r => {
      S.power = r.events.map(e => ({ t: e.t, kind: e.kind }));
      S.powerName = 'Windows';
      S.powerAuto = true;
      if (S.D) runAlign(); else renderPowerLog();
    }).catch(err => console.error(err));
    const list = await refreshHistoryList();
    if (info.startUrl) await openUrl(info.startUrl, info.startName);
    else if (list.length) await openUrl(list[0].url, list[0].name);
    const ports = await call('device.ports');
    if (ports.length) devConnect(); else devMsg('Plug in the WireView by USB, then click Connect. Close WireView2 first; only one app can use the device at a time.');
  }

  // ---------------- wiring ----------------
  function init() {
    $('#btnOpen').addEventListener('click', () => $('#fileInput').click());
    $('#fileInput').addEventListener('change', e => { loadFiles(e.target.files); e.target.value = ''; });
    document.querySelectorAll('#quickRange button').forEach(b => b.addEventListener('click', () => quickRange(+b.dataset.h)));
    $('#btnExportRange').addEventListener('click', exportRange);
    $('#btnExportEvents').addEventListener('click', exportEvents);
    $('#btnRulesReset').addEventListener('click', () => {
      try { localStorage.removeItem('wvlv:rules:custom'); } catch (e) { /* ignore */ }
      S.rules = Object.assign({}, DEFAULT_RULES); saveJSON('wvlv:rules', S.rules); syncRulesUI(); computeEvents(); renderAll(); });
    document.querySelectorAll('[data-rule]').forEach(el => el.addEventListener('change', onRuleChange));
    $('#loadMin').addEventListener('change', renderPinHealth);
    const drop = $('#empty');
    ['dragenter', 'dragover'].forEach(t => window.addEventListener(t, e => { e.preventDefault(); drop.classList.add('over'); }));
    ['dragleave', 'drop'].forEach(t => window.addEventListener(t, e => { e.preventDefault(); if (t === 'drop' || e.target === drop) drop.classList.remove('over'); }));
    window.addEventListener('drop', e => { if (e.dataTransfer && e.dataTransfer.files.length) loadFiles(e.dataTransfer.files); });
    let rt = null;
    window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => { S._navSnap = null; resizeAll(); }, 120); });
    attachNavEvents();
    if (HOST) initHost().catch(err => { console.error(err); devMsg(String(err.message || err), true); });
    else loadPowerLog();

    // local testing: ?file=samples/x.wvl when served over http
    const qs = new URLSearchParams(location.search).getAll('file');
    if (qs.length && location.protocol.startsWith('http')) {
      Promise.all(qs.map(q => fetch(q).then(r => r.blob()).then(b => new File([b], q.split('/').pop()))))
        .then(loadFiles).catch(err => { $('#loadError').textContent = String(err); });
    }
  }
  init();
})();
