import { createChart } from '../lib/chart.js';
import { h, placeholder } from '../lib/dom.js';
import { formatBytes, formatDuration } from '../lib/format.js';

export const RESOURCE_WINDOW = 600;
/** Merge cursor pages without duplicating samples; the browser keeps a bounded rolling window. */
export function mergeResourceTail(before, tail, limit = RESOURCE_WINDOW) {
  const byId = new Map(before.map((s) => [s.id, s]));
  for (const s of tail) byId.set(s.id, s);
  return [...byId.values()].sort((a, b) => a.ts - b.ts || a.id.localeCompare(b.id)).slice(-limit);
}
export function resourceSeries(samples, metric) {
  const series = [];
  let previous;
  for (const s of samples) {
    // Sparse probes retain their observation times, rather than filling 100 ms bins with stale values.
    if (metric.key && s.observed && s.observed[metric.key] === undefined) continue;
    const t = s.observed?.[metric.key] ?? s.ts;
    const ms = Math.max(1, s.intervalMs ?? 100);
    if (previous && (previous.recording !== s.recording || t - previous.t > Math.max(ms, metric.cadence ?? ms) * 2500)) series.push({ t: previous.t + 1, v: null });
    series.push({ t, v: metric.value(s) });
    previous = { t, recording: s.recording };
  }
  return series;
}
const sum = (xs, key) => xs?.length && xs.every((x) => x[key] != null) ? xs.reduce((n, x) => n + x[key], 0) : null;
const number = (v) => v == null ? 'Unknown' : Number(v.toFixed(2)).toString();

/** Persistent canvases, visible-chart paints only, and tables generated only when opened. */
export function createResourcesView(el, app, { sortableTable, formatTime }) {
  let data = {}, samples = [], lastId, detailPaint = 0;
  const latest = new Map(), charts = new Map();
  const status = h('p', { class: 'st-hint' });
  const freshness = h('p', { class: 'st-hint' });
  const chartHost = h('div');
  const empty = placeholder('empty', 'No resource samples in this scope', 'Collection starts when enabled; historical traces have no resource measurements.');
  const contextBody = h('div'), detailBody = h('div'), rawBody = h('div');
  const context = h('details', null, h('summary', null, 'Recording context and collection health'), contextBody);
  const details = h('details', null, h('summary', null, 'Disk, memory pressure, capacity and tracked processes'), detailBody);
  const raw = h('details', null, h('summary', null, 'Inspect latest 50 samples'), rawBody);
  const note = h('p', { class: 'st-hint' });
  el.append(status, freshness, h('p', { class: 'st-hint' }, 'Whole-host measurements include other applications. RAM used includes OS caches. Slow counters show their actual observation times. GPU readings require NVIDIA nvidia-smi.'), context, empty, chartHost, details, raw, note);
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const item = [...charts.values()].find((c) => c.host === entry.target);
      if (item) { item.visible = entry.isIntersecting; if (item.visible) paintChart(item); }
    }
  });
  function paintChart(item) {
    const series = resourceSeries(samples, item.metric);
    const deltas = series.slice(1).map((p, i) => p.t - series[i].t).filter((n) => n > 1);
    const binUs = item.metric.key ? deltas.at(-1) ?? 1_000_000 : Math.max(1, samples.at(-1)?.intervalMs ?? 100) * 1000;
    item.chart.setData({ series, binUs, unit: item.metric.unit, label: item.metric.label });
  }
  function ensureCharts() {
    const metrics = [
      { label: 'CPU busy (%)', value: (s) => s.cpu.busyPercent },
      { label: 'RAM used', unit: 'bytes', value: (s) => s.memory.usedBytes },
      { label: 'Network receive (bytes/s)', key: 'network', cadence: samples.at(-1)?.platform === 'linux' ? 100 : 1000, value: (s) => sum(s.network?.interfaces, 'rxBytesPerSecond') },
      { label: 'Network transmit (bytes/s)', key: 'network', cadence: samples.at(-1)?.platform === 'linux' ? 100 : 1000, value: (s) => sum(s.network?.interfaces, 'txBytesPerSecond') },
      ...[...new Set(samples.flatMap((s) => s.gpu?.map((g) => g.index) ?? []))].flatMap((index) => [
        { label: `GPU ${index} busy (%)`, key: 'gpu', cadence: 1000, value: (s) => s.gpu?.find((g) => g.index === index)?.utilizationPercent ?? null },
        { label: `GPU ${index} memory used`, key: 'gpu', cadence: 1000, unit: 'bytes', value: (s) => s.gpu?.find((g) => g.index === index)?.memoryUsedBytes ?? null },
      ]),
    ];
    for (const metric of metrics) if (!charts.has(metric.label)) {
      const host = h('div', { class: 'st-chart' });
      chartHost.append(h('h3', null, metric.label), host);
      const chart = createChart(host, { height: 180, onClick: (p, width) => app.setTimeRange(p.t, p.t + width) });
      const item = { host, chart, metric, visible: false };
      charts.set(metric.label, item); observer.observe(host); paintChart(item);
    }
  }
  function paintContext() {
    contextBody.replaceChildren(...(data.recordings ?? []).map((r) => h('p', { class: 'st-hint' },
      `${r.context.hostname} · ${r.context.platform} ${r.context.osRelease} · ${r.context.cpuModel}. ` +
      `Started ${formatTime(r.startedTs)}; ${r.stoppedTs === null ? 'open or interrupted' : `stopped ${formatTime(r.stoppedTs)}`}. ` +
      `${r.health.samples} stored, ${r.health.skipped} skipped at ${formatTime(r.health.updatedTs)}. ` +
      `Collector limits: CPU ${r.context.cpuLimitCores ?? 'unknown'} cores, memory ${r.context.memoryLimitBytes == null ? 'unknown' : formatBytes(r.context.memoryLimitBytes)}. ${r.health.lastError ?? ''}`)));
  }
  const sampled = (key, s) => formatTime(s.observed?.[key] ?? s.ts);
  function paintDetails() {
    detailBody.replaceChildren();
    const pressure = latest.get('pressure'), disk = latest.get('disk'), space = latest.get('filesystems'), processes = latest.get('processes');
    if (!pressure && !disk && !space && !processes) detailBody.append(h('p', { class: 'st-hint' }, 'Waiting for additional counters in this scope.'));
    if (pressure) {
      const p = pressure.pressure;
      detailBody.append(h('p', { class: 'st-hint' }, `Memory pressure observed ${sampled('pressure', pressure)}: ` + (p
        ? `level ${p.level ?? 'unavailable'}; available ${p.availableBytes == null ? 'unknown' : formatBytes(p.availableBytes)}; compressed ${p.compressedBytes == null ? 'unknown' : formatBytes(p.compressedBytes)}; swap used ${p.swapUsedBytes == null ? 'unknown' : formatBytes(p.swapUsedBytes)}; swap in/out ${number(p.swapInPagesPerSecond)} / ${number(p.swapOutPagesPerSecond)} pages/s; memory/I/O stalls ${number(p.memoryStallSomeUs)} / ${number(p.ioStallSomeUs)} µs since boot.` : 'unavailable')));
    }
    if (disk) {
      detailBody.append(h('p', { class: 'st-hint' }, `Disk counters observed ${sampled('disk', disk)}. Devices are separate; stacked devices can overlap. macOS reports combined transfers.`));
      if (disk.disk) detailBody.append(sortableTable([
        { key: 'name', label: 'Device', value: (x) => x.name },
        { key: 'bytes', label: 'Transferred bytes', value: (x) => x.transferredBytes, render: (x) => formatBytes(x.transferredBytes) },
        { key: 'rate', label: 'Bytes/s', value: (x) => x.bytesPerSecond, render: (x) => number(x.bytesPerSecond) },
        { key: 'read', label: 'Read bytes/s', value: (x) => x.readBytesPerSecond, render: (x) => number(x.readBytesPerSecond) },
        { key: 'write', label: 'Write bytes/s', value: (x) => x.writeBytesPerSecond, render: (x) => number(x.writeBytesPerSecond) },
      ], disk.disk.devices));
    }
    if (space) detailBody.append(h('p', { class: 'st-hint' }, `Capacity observed ${sampled('filesystems', space)}: ` + (space.filesystems
      ? space.filesystems.volumes.map((v) => `${v.path}: ${formatBytes(v.availableBytes)} available of ${formatBytes(v.totalBytes)}`).join('; ') : 'unavailable')));
    if (processes) {
      const p = processes.processes;
      detailBody.append(h('p', { class: 'st-hint' }, `Explicit process tracking observed ${sampled('processes', processes)}. ` + (p
        ? `Descendants: ${p.descendants}. ${p.truncated ? 'Process limit reached. ' : ''}${p.unavailablePids?.length ?? 0} exited or inaccessible PIDs. Shared memory can overlap.` : 'unavailable')));
      if (p) detailBody.append(sortableTable([
        { key: 'pid', label: 'PID', value: (x) => x.pid },
        { key: 'cpu', label: 'CPU time', value: (x) => x.cpuTimeUs, render: (x) => formatDuration(x.cpuTimeUs) },
        { key: 'rss', label: 'Resident memory', value: (x) => x.residentBytes, render: (x) => formatBytes(x.residentBytes) },
        { key: 'read', label: 'Read bytes', value: (x) => x.readBytes, render: (x) => x.readBytes == null ? 'Unknown' : formatBytes(x.readBytes) },
        { key: 'write', label: 'Write bytes', value: (x) => x.writeBytes, render: (x) => x.writeBytes == null ? 'Unknown' : formatBytes(x.writeBytes) },
      ], p.entries));
    }
  }
  // A table is an explicit snapshot: keep rows and sorting stable during live recording.
  function paintRaw() {
    rawBody.replaceChildren(h('button', { class: 'btn', onclick: paintRaw }, 'Refresh sample snapshot'), sortableTable([
      { key: 'ts', label: 'Sample time', value: (s) => s.ts, render: (s) => formatTime(s.ts) },
      { key: 'cpu', label: 'CPU %', value: (s) => s.cpu.busyPercent, render: (s) => number(s.cpu.busyPercent) },
      { key: 'ram', label: 'RAM used', value: (s) => s.memory.usedBytes, render: (s) => formatBytes(s.memory.usedBytes) },
      { key: 'rx', label: 'Receive bytes/s', value: (s) => sum(s.network?.interfaces, 'rxBytesPerSecond'), render: (s) => number(sum(s.network?.interfaces, 'rxBytesPerSecond')) },
      { key: 'tx', label: 'Transmit bytes/s', value: (s) => sum(s.network?.interfaces, 'txBytesPerSecond'), render: (s) => number(sum(s.network?.interfaces, 'txBytesPerSecond')) },
    ], samples.slice(-50), { sortKey: 'ts', desc: true }));
  }
  context.addEventListener('toggle', () => { if (context.open) paintContext(); });
  details.addEventListener('toggle', () => { if (details.open) paintDetails(); });
  raw.addEventListener('toggle', () => { if (raw.open) paintRaw(); });
  return {
    update(next) {
      data = next; samples = next.samples ?? [];
      const state = data.recording, current = samples.at(-1);
      status.textContent = state?.enabled
        ? `Live · ${number(1000 / state.intervalMs)} Hz requested · ${(1000 / (state.observedIntervalMs ?? state.effectiveIntervalMs)).toFixed(1)} Hz effective · ${state.samples} stored · ${state.buffered ?? 0} pending. ${state.lastError ?? ''}`
        : 'This server is not recording resources. Start agentshark serve --record-resources to collect new measurements.';
      empty.hidden = !!samples.length;
      for (const key of ['network', 'gpu', 'pressure', 'disk', 'filesystems', 'processes']) {
        const s = samples.findLast((s) => s.observed ? s.observed[key] !== undefined : s[key] !== undefined && s[key] !== null || s.unavailable.some((u) => u.metric === key));
        if (s) latest.set(key, s);
      }
      const age = (s, key) => `${number(Math.max(0, ((state?.lastTs ?? current?.ts ?? s.ts) - (s.observed?.[key] ?? s.ts)) / 1e6))} s old`;
      freshness.textContent = ['network', 'gpu'].map((key) => {
        const s = latest.get(key), missing = s?.unavailable.find((u) => u.metric === key)?.reason;
        return `${key === 'gpu' ? 'GPU' : 'Network'}: ${s ? missing ?? age(s, key) : 'waiting'}`;
      }).join(' · ') + (current?.platform === 'linux' ? ' · Native kernel counters follow the recording cadence.' : ' · macOS network: at most 1 Hz; disk/pressure: 10 s.') + ' GPU: at most 1 Hz; capacity: 60 s.';
      if (lastId !== current?.id) {
        ensureCharts();
        for (const item of charts.values()) if (item.visible) paintChart(item);
        lastId = current?.id;
      }
      if (performance.now() - detailPaint >= 1000) {
        if (context.open) paintContext();
        if (details.open) paintDetails();
        detailPaint = performance.now();
      }
      note.textContent = `Latest ${samples.length} samples shown. Charts update while visible; expanded details update once per second. Click a chart to select its time interval. Unknown readings appear as gaps.`;
    },
    connectionError() { status.textContent = 'Live connection interrupted. Showing the last readings; retrying in 2 seconds.'; },
    destroy() { observer.disconnect(); for (const { chart } of charts.values()) chart.destroy(); },
  };
}
