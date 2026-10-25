// Numbers in the DESIGN.md §9 forms, shared by the adapters' event summaries and the CLI, so a figure reads the same
// in the Summary column, in the terminal and in both clients.

const MS = 1_000;
const SEC = 1_000_000;

/** Three significant digits without trailing zeros: 7.14, 2.4, 820, 0.85. */
function sig3(v: number): number {
  return Number(v.toPrecision(3));
}

/**
 * µs as §9 durations: "0ms" (a measured zero), "0.85ms", "2.4ms", "820ms", "7.14s", "7m 09s", "1h 04m", "1d 08h".
 * Below a minute three significant digits; every unit after the first has two digits.
 */
export function fmtDur(us: number | null | undefined): string {
  if (us == null || !Number.isFinite(us)) return '';
  if (us < 0) return `−${fmtDur(-us)}`;
  const pad = (n: number) => String(n).padStart(2, '0');
  if (us < SEC) {
    const ms = sig3(us / MS);
    if (ms < 1000) return `${ms}ms`;
  }
  if (us < 60 * SEC) {
    const s = sig3(us / SEC);
    if (s < 60) return `${s}s`;
  }
  const secs = Math.round(us / SEC);
  if (secs < 3600) return `${Math.floor(secs / 60)}m ${pad(secs % 60)}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 24 * 60) return `${Math.floor(mins / 60)}h ${pad(mins % 60)}m`;
  return `${Math.floor(mins / 1440)}d ${pad(Math.floor((mins % 1440) / 60))}h`;
}

/** Bytes as §9 sizes: "11 B", "8.4 KB", "12 KB", "1.5 MB". */
export function fmtBytes(n: number | null | undefined): string {
  if (n == null) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return i === 0 ? `${v} B` : `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}
