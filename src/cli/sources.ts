// `agentshark sources`: the logging-health report (SPEC §8) for the terminal.

import type { CapabilityLevel, ExpertSeverity, HealthReport } from '../model/types.ts';
import { openQueries } from './inspect.ts';
import { type Args, fmtBytes, fmtNum, fmtTime, out, table, tildify } from './util.ts';

// Presentation names (SPEC §7.8): Error, Warning, Note and Info; the API keeps severity 'chat' for Info.
const SEVERITY_MARK: Record<ExpertSeverity, string> = {
  error: out.red('[error]  '),
  warn: out.yellow('[warning]'),
  note: out.cyan('[note]   '),
  chat: out.dim('[info]   '),
};

const LEVEL_PAINT: Record<CapabilityLevel, (s: string) => string> = {
  logged: out.green,
  derived: out.cyan,
  partial: out.yellow,
  absent: out.red,
};

export async function sources(a: Args): Promise<number> {
  const { queries, close } = openQueries(a);
  try {
    const report = await queries.sources();
    if (a.values.json) {
      console.log(JSON.stringify(report, null, 2));
      return 0;
    }
    console.log(out.dim(`Logging health of ${report.host ?? 'this machine'} (${report.scope === 'captured' ? 'captured sources' : 'local sources and index'})`) + '\n');
    console.log(report.agents.map(renderAgent).join('\n\n'));
    const failed = report.sources.filter((s) => s.status === 'error');
    const gone = report.sources.filter((s) => !s.existsNow);
    console.log(
      '\n' +
        out.bold('Sources') +
        `  ${fmtNum(report.sources.length)} indexed, ${fmtNum(failed.length)} failed to parse, ${fmtNum(gone.length)} no longer on disk`,
    );
    for (const s of failed.slice(0, 10)) console.log(`  ${SEVERITY_MARK.error} ${tildify(s.path)}: ${s.error ?? 'parse failed'}`);
    return 0;
  } finally {
    close();
  }
}

function renderAgent(h: HealthReport): string {
  const state = h.parsed ? out.green('parsed') : h.detected ? out.yellow('detected, not parseable') : out.dim('not found');
  const lines = [`${out.bold(h.label)}  ${out.dim(h.agent)}  ${state}`];
  if (!h.detected) return lines[0];
  const range = h.firstTs === null ? '' : `, ${fmtTime(h.firstTs).slice(0, 10)} → ${fmtTime(h.lastTs).slice(0, 10)}`;
  const p = h.parse;
  lines.push(
    table([
      ['  roots', h.roots.map(tildify).join(', ')],
      ['  files', `${fmtNum(h.files)} (${fmtBytes(h.bytes)})${range}`],
      ...(h.versions.length ? [['  versions', h.versions.slice(0, 8).join(', ') + (h.versions.length > 8 ? ', …' : '')]] : []),
      ['  parse', `${fmtNum(p.lines)} lines, ${fmtNum(p.malformed)} malformed, ${fmtNum(p.unknown)} unknown, ${fmtNum(p.skipped)} skipped, ${fmtNum(p.inherited)} inherited`],
    ]),
  );
  if (h.capabilities.length) {
    lines.push(out.bold('  Capabilities'));
    lines.push(table(h.capabilities.map((c) => [`    ${c.capability}`, LEVEL_PAINT[c.level](c.level), out.dim(c.note)])));
  }
  if (h.findings.length) {
    lines.push(out.bold('  Findings'));
    for (const f of h.findings) {
      lines.push(`    ${SEVERITY_MARK[f.severity]} ${f.title}`);
      if (f.detail) lines.push(`              ${f.detail}`);
      const r = f.recommendation;
      if (r) {
        lines.push(`              ${out.cyan('→')} ${r.text}`);
        if (r.code) for (const code of r.code.snippet.split('\n')) lines.push(`                ${out.bold(code)}`);
        if (r.effect) lines.push(`              ${out.dim(`Effect: ${r.effect}`)}`);
      }
    }
  }
  return lines.join('\n');
}
