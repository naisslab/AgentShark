import { createChart } from '../lib/chart.js';
import { h, placeholder } from '../lib/dom.js';
import { formatBytes, formatDuration } from '../lib/format.js';
const sum = (rows, key) => rows?.length && rows.every((p) => p[key] != null) ? rows.reduce((n, p) => n + p[key], 0) : null;
const fmt = (v) => v == null ? 'Unknown' : Number(v.toFixed(2)).toString();
const reasons = { disabled: 'Disabled', 'unsupported-platform': 'Unavailable on this platform', 'per-process-network-unavailable': 'Per-process accounting unavailable', 'no-process-counters': 'No process counters reported', 'gpu-asleep': 'GPU asleep', 'gpu-power-state-unknown': 'GPU power state unavailable', 'collector-not-installed': 'Collector not installed', 'collector-timeout': 'Collector timed out', 'collector-unavailable': 'Collector unavailable' };

/** Each process appears once even when selected session trees overlap. */
export function sessionValues(sample, sessions = []) {
  const frame = sample.sessionResources;
  if (!frame) return null;
  const entries = frame.entries.filter((p) => !sessions.length || p.sessions.some((s) => sessions.includes(s)));
  const identities = new Set(entries.map((p) => `${p.pid}:${p.startId}`));
  const network = frame.network?.entries.filter((p) => identities.has(`${p.pid}:${p.startId}`));
  const gpu = frame.gpu?.entries.filter((p) => identities.has(`${p.pid}:${p.startId}`));
  const missing = frame.unavailableProcesses?.filter((p) => !sessions.length || p.sessions.some((s) => sessions.includes(s))) ?? frame.unavailablePids;
  const partial = frame.truncated || frame.descendants !== 'tracked' || missing.length > 0;
  return { frame, entries, partial, cpu: partial ? null : sum(entries, 'cpuPercent'), rss: partial ? null : sum(entries, 'residentBytes'), read: partial ? null : sum(entries, 'readBytesPerSecond'), write: partial ? null : sum(entries, 'writeBytesPerSecond'),
    rx: frame.network ? sum(network, 'rxBytesPerSecond') : undefined, tx: frame.network ? sum(network, 'txBytesPerSecond') : undefined, gpu };
}
export function createSessionResourcesView(el, app, { sortableTable, formatTime }) {
  let data = {}, samples = [], lastId, lastDetails = 0, lastRecording, initialized = false;
  const projections = new WeakMap(), slow = new Map();
  const status = h('p', { class: 'st-hint' }), coverage = h('p', { class: 'st-hint' }), availability = h('p', { class: 'st-hint' });
  const sessionInput = h('input', { class: 'pn-input', placeholder: 'Session ID (e.g. cx:...)', 'aria-label': 'Resource session ID', value: app.state.get('scope').sessions?.length === 1 ? app.state.get('scope').sessions[0] : '' });
  const pidInput = h('input', { class: 'pn-input', type: 'number', min: 1, placeholder: 'Agent root PID', 'aria-label': 'Agent root PID' });
  const bindingMessage = h('span', { class: 'st-hint', role: 'status' });
  const configured = h('p', { class: 'st-hint' });
  const bind = async (detach = false) => {
    const session = sessionInput.value.trim(), pid = Number(pidInput.value);
    if (!session || !detach && (!Number.isSafeInteger(pid) || pid < 1)) { bindingMessage.textContent = 'Enter a session ID and a positive OS PID.'; return; }
    attach.disabled = true;
    try { await app.api.bindResourceSession(session, detach ? [] : [pid]); bindingMessage.textContent = detach ? 'Detached. Stored samples remain.' : 'Tracking this process tree. Waiting for the first measurement...'; if (!detach) setup.open = false; }
    catch (e) { bindingMessage.textContent = e.message; }
    finally { attach.disabled = false; }
  };
  const attach = h('button', { class: 'btn', onclick: () => bind() }, 'Track session');
  const detach = h('button', { class: 'btn', onclick: () => bind(true) }, 'Detach');
  const setup = h('details', { open: false }, h('summary', null, 'Advanced: attach a process manually'),
    h('p', { class: 'st-hint' }, 'Use a dedicated agent process. Its threads and child processes are included. Shared app/server PIDs cannot separate concurrent sessions. Tool process IDs in traces are not OS PIDs.'),
    h('div', { class: 'st-io-controls' }, sessionInput, pidInput, attach, detach), bindingMessage, configured);
  const empty = placeholder('empty', 'No attributed session measurements', 'Start recording and attach a dedicated process, or use --resource-session SESSION=PID. Earlier host samples remain in Host context.');
  const host = h('div'), detailBody = h('div');
  const detail = h('details', null, h('summary', null, 'Session processes and GPU counters'), detailBody);
  el.append(status, coverage, availability, setup, empty, host, detail);
  const charts = new Map();
  const observer = new IntersectionObserver((entries) => {
    for (const e of entries) { const c = [...charts.values()].find((c) => c.host === e.target); if (c) { c.visible = e.isIntersecting; if (c.visible) paint(c); } }
  });
  const selected = () => app.state.get('scope').sessions ?? [];
  const projected = (s) => { if (!projections.has(s)) projections.set(s, sessionValues(s, selected())); return projections.get(s); };
  function paint(c) {
    const series = [];
    let prev;
    for (const s of samples) {
      const value = projected(s); if (!value) continue;
      const v = c.metric.value(value); if (v === undefined) continue;
      const t = c.metric.time?.(value) ?? s.observed?.sessions ?? s.ts;
      if (prev && (prev.recording !== s.recording || t - prev.t > (c.metric.slow ? 3e6 : Math.max(s.intervalMs ?? 100, 100) * 2500))) series.push({ t: prev.t + 1, v: null });
      series.push({ t, v }); prev = { t, recording: s.recording };
    }
    c.chart.setData({ series, binUs: c.metric.slow ? 1e6 : (data.recording?.intervalMs ?? 100) * 1000, label: c.metric.label, unit: c.metric.unit });
  }
  const metrics = [
    { label: 'Session CPU (% of one core)', value: (v) => v.cpu },
    { label: 'Session resident memory (RSS sum)', unit: 'bytes', value: (v) => v.rss },
    { label: 'Session disk read (bytes/s)', value: (v) => v.read },
    { label: 'Session disk write (bytes/s)', value: (v) => v.write },
    { label: 'Observed session network receive (bytes/s)', slow: true, time: (v) => v.frame.network?.ts, value: (v) => v.rx },
    { label: 'Observed session network transmit (bytes/s)', slow: true, time: (v) => v.frame.network?.ts, value: (v) => v.tx },
    { label: 'Observed session GPU memory (VRAM sum)', unit: 'bytes', slow: true, time: (v) => v.frame.gpu?.ts, value: (v) => v.gpu === undefined ? undefined : sum(v.gpu, 'memoryUsedBytes') },
  ];
  function ensureCharts() {
    for (const metric of metrics) if (!charts.has(metric.label)) {
      const container = h('div', { class: 'st-chart' }); host.append(h('h3', null, metric.label), container);
      const chart = createChart(container, { height: 160, onClick: (p, width) => app.setTimeRange(p.t, p.t + width) });
      const c = { host: container, chart, metric, visible: false }; charts.set(metric.label, c); observer.observe(container); paint(c);
    }
  }
  function paintDetails() {
    const sample = samples.at(-1), value = sample && projected(sample); detailBody.replaceChildren();
    if (!value) return;
    detailBody.append(h('p', { class: 'st-hint' }, `Observed ${formatTime(sample.observed?.sessions ?? sample.ts)}. CPU includes all threads; 100% means one logical core, so totals can exceed 100%. RSS can count shared pages more than once. Exited or very short-lived children can be missed.`));
    detailBody.append(sortableTable([
      { key: 'pid', label: 'PID', value: (p) => p.pid },
      { key: 'sessions', label: 'Sessions', value: (p) => p.sessions.join(', ') },
      { key: 'cpu', label: 'CPU %', value: (p) => p.cpuPercent, render: (p) => fmt(p.cpuPercent) },
      { key: 'time', label: 'CPU time', value: (p) => p.cpuTimeUs, render: (p) => formatDuration(p.cpuTimeUs) },
      { key: 'rss', label: 'RSS', value: (p) => p.residentBytes, render: (p) => formatBytes(p.residentBytes) },
      { key: 'read', label: 'Read bytes/s', value: (p) => p.readBytesPerSecond, render: (p) => fmt(p.readBytesPerSecond) },
      { key: 'write', label: 'Write bytes/s', value: (p) => p.writeBytesPerSecond, render: (p) => fmt(p.writeBytesPerSecond) },
    ], value.entries));
    const g = slow.get('gpu');
    if (g) detailBody.append(h('p', { class: 'st-hint' }, `GPU process readings at ${formatTime(g.ts)}: ${reasons[g.reason] ?? 'per-process driver counters; SM percentages remain separate because they may overlap.'}`), sortableTable([
      { key: 'pid', label: 'PID', value: (p) => p.pid }, { key: 'gpu', label: 'GPU', value: (p) => p.index },
      { key: 'sm', label: 'SM %', value: (p) => p.smPercent, render: (p) => fmt(p.smPercent) },
      { key: 'vram', label: 'VRAM', value: (p) => p.memoryUsedBytes, render: (p) => p.memoryUsedBytes == null ? 'Unknown' : formatBytes(p.memoryUsedBytes) },
    ], g.entries));
  }
  detail.addEventListener('toggle', () => { if (detail.open) paintDetails(); });
  return {
    update(next) {
      data = next; samples = next.samples ?? [];
      const state = next.recording, last = samples.at(-1), value = last && projected(last);
      if (!initialized) { setup.open = false; initialized = true; }
      const bindings = state?.bindings ?? value?.frame.bindings ?? [];
      const bindingsText = bindings.map((b) => `${b.session}: PID ${b.roots.join(', ')}`).join('; ');
      if (configured.textContent !== bindingsText) configured.textContent = bindingsText;
      if (last?.recording !== lastRecording) { slow.clear(); lastRecording = last?.recording; }
      for (const key of ['gpu', 'network']) { const v = samples.findLast((s) => s.recording === lastRecording && s.sessionResources?.[key])?.sessionResources[key]; if (v) slow.set(key, v); }
      setup.hidden = !state?.enabled;
      const times = samples.slice(-11).filter((s) => !s.unavailable.some((u) => u.metric === 'sessions')).map((s) => s.observed?.sessions ?? s.ts), hz = times.length > 1 ? (times.length - 1) * 1e6 / (times.at(-1) - times[0]) : null;
      const count = state?.enabled ? bindings.filter((b) => !selected().length || selected().includes(b.session)).length : value?.frame.bindings.length ?? 0;
      const liveText = state?.enabled && count ? `${fmt(1000 / state.intervalMs)} Hz requested; ${hz === null ? 'waiting for samples' : `${hz.toFixed(1)} Hz observed`}` : 'Idle; attach a session process';
      status.textContent = `Session resources · ${state?.enabled ? liveText : app.state.get('info')?.mode === 'capture' ? 'Recorded capture' : 'Recording off; start with --record-resources'} · ${count} tracked session${count === 1 ? '' : 's'}. ${reasons[state?.sessionError] ?? state?.lastError ?? ''}`;
      coverage.textContent = value ? `Observed ${formatTime(last.observed?.sessions ?? last.ts)} · ${value.entries.length} unique processes${value.entries.some(p => p.shared) ? ' · Shared process totals include other sessions; counted once' : ''} · ${value.partial ? 'Partial coverage; totals unknown' : 'bounded process tree'} · ${value.frame.unavailablePids.length} exited or inaccessible PIDs. Child discovery: 1 s; shorter-lived children can be missed. CPU 100% = one core; RSS can overlap shared pages.` : 'Whole-host CPU and RAM are excluded from this view.';
      availability.textContent = ['gpu', 'network'].map((key) => {
        const v = slow.get(key);
        return `${key === 'gpu' ? 'GPU' : 'Network'}: ${v ? reasons[v.reason] ?? `${fmt(Math.max(0, ((state?.lastTs ?? last.ts) - v.ts) / 1e6))} s old` : 'waiting for process counters'}`;
      }).join(' · ') + ' · Temperature, power, memory pressure and free space belong to Host context.';
      empty.hidden = !!samples.length;
      if (last && last.id !== lastId) { ensureCharts(); for (const c of charts.values()) if (c.visible) paint(c); lastId = last.id; }
      if (detail.open && performance.now() - lastDetails >= 1000) { paintDetails(); lastDetails = performance.now(); }
    },
    connectionError() { status.textContent = 'Live connection interrupted. Showing the last session readings; retrying.'; },
    destroy() { observer.disconnect(); for (const c of charts.values()) c.chart.destroy(); },
  };
}
