// Claude desktop session registries (SPEC §4.3): Code-tab `claude-code-sessions/*/*/local_*.json` and
// Cowork `local-agent-mode-sessions/*/*/local_*.json` (+ the Dispatch agent `agent/local_ditto_*.json`).
// A registry enriches the CLI session it points to. When that transcript is gone, the registry is the
// only surviving record of the session, so it emits the session itself with state `missing-transcript`.

import { glob, readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { SessionRole } from '../model/types.ts';
import { type Adapter, type ParseStats, type SourceFile, compact, emptyStats, fileInfo, msToUs, sha256, truncate } from './adapter.ts';

const REGISTRY_DIRS = [
  ['claude-code-sessions', 'claude-code'],
  ['local-agent-mode-sessions', 'claude-cowork'],
] as const;

export const claudeDesktopAdapter: Adapter = {
  name: 'claude-desktop',

  async discover(env) {
    const out: SourceFile[] = [];
    for (const [dir, agent] of REGISTRY_DIRS) {
      if (env.agents && !env.agents.includes(agent)) continue;
      const base = join(env.appSupport, 'Claude', dir);
      for await (const rel of glob(['*/*/local_*.json', '*/*/agent/local_ditto_*.json'], { cwd: base })) {
        const f = await fileInfo(join(base, rel), agent, 'registry', 'claude-desktop');
        if (f) out.push(f);
      }
    }
    return out;
  },

  async parse(ctx, sink) {
    const { path, agent } = ctx.file;
    const cowork = agent === 'claude-cowork';
    const prefix = cowork ? 'cw' : 'cc';
    const stats: ParseStats = { ...emptyStats(), dialect: cowork ? 'cowork-registry' : 'code-tab-registry' };
    const bytes = await readFile(path);
    const text = bytes.toString('utf8');
    stats.parsedBytes = bytes.length;
    stats.sha256 = sha256(bytes);
    stats.lines = 1;
    const reg = parseObject(text);
    if (!reg) {
      stats.malformed = 1;
      sink.emit({ rec: 'expert', severity: 'warn', group: 'malformed', message: `${basename(path)} is not a JSON object` });
      return stats;
    }

    const dir = dirname(path);
    const localId = str(reg.sessionId) ?? basename(path, '.json');
    const cli = str(reg.cliSessionId);
    // Sessions without a CLI id keep the registry id, so they still get a stable session id.
    const session = `${prefix}:${cli ?? localId}`;
    const parentLocal = str(reg.parentSessionId);
    const parentId = parentLocal ? await registrySessionId(dir, parentLocal, prefix) : undefined;
    const role: SessionRole | undefined = reg.sessionType === 'scheduled' ? 'automation' : parentId ? 'subagent' : undefined;
    const spawned = reg.spawnedFrom && typeof reg.spawnedFrom === 'object' ? reg.spawnedFrom : undefined;

    // Cowork transcripts live in the session's own config dir next to the registry file.
    let transcript: string | undefined;
    if (cli && cowork) transcript = await findTranscript(join(path.slice(0, -'.json'.length), '.claude', 'projects'), cli);
    else if (cli) transcript = await findTranscript(join(claudeConfigDir(path, ctx.env?.home), 'projects'), cli, [reg.cwd, reg.originCwd]);

    if (!transcript) {
      const cwd = str(reg.cwd);
      sink.emit({
        rec: 'session',
        id: session,
        agent,
        nativeId: cli ?? localId,
        role: role ?? 'main',
        state: 'missing-transcript',
        parentId,
        title: str(reg.title),
        cwd,
        project: projectName(str(reg.originCwd) ?? cwd),
        git: str(reg.branch) ? { branch: reg.branch } : undefined,
        models: str(reg.model) ? [reg.model] : undefined,
        version: str(reg.toolSurfaceSnapshot?.cliVersion) ?? str(reg.promptAppendSnapshot?.cliVersion),
        entrypoint: cowork ? 'local-agent' : 'claude-desktop',
        createdTs: msToUs(reg.createdAt),
      });
      const last = typeof reg.lastActivityAt === 'number' ? new Date(reg.lastActivityAt).toISOString() : 'unknown';
      sink.emit({
        rec: 'expert',
        session,
        severity: 'warn',
        group: 'logging-gap',
        message: cli
          ? `Transcript ${cli}.jsonl no longer exists; registry ${localId} (last activity ${last}) is the only record of this session`
          : `Registry ${localId} (last activity ${last}) has no CLI session id, so its transcript cannot be located`,
      });
    }

    sink.emit({
      rec: 'enrich',
      session,
      fields: dropEmpty({ title: str(reg.title), parentId, role }),
      meta: dropEmpty({
        registry: localId,
        registryKind: cowork ? 'cowork' : 'code-tab',
        title: str(reg.title),
        model: str(reg.model),
        effort: str(reg.effort) ?? str(reg.effortOverride),
        permissionMode: str(reg.permissionMode),
        worktree: str(reg.worktreePath) || str(reg.worktreeName)
          ? dropEmpty({ path: str(reg.worktreePath), name: str(reg.worktreeName), originCwd: str(reg.originCwd) })
          : undefined,
        branch: str(reg.branch),
        sourceBranch: str(reg.sourceBranch),
        prs: pullRequests(reg),
        completedTurns: num(reg.completedTurns),
        isArchived: typeof reg.isArchived === 'boolean' ? reg.isArchived : undefined,
        postTurnSummary: reg.postTurnSummary ? compact(reg.postTurnSummary) : undefined,
        createdTs: msToUs(reg.createdAt),
        lastActivityTs: msToUs(reg.lastActivityAt),
        spawnedFrom: spawned
          ? dropEmpty({
              session: str(spawned.sessionId) ? await registrySessionId(dir, spawned.sessionId, prefix) : undefined,
              taskId: str(spawned.taskId),
              title: str(spawned.title),
            })
          : undefined,
        parentSessionId: parentLocal,
        sessionType: str(reg.sessionType),
        scheduledTaskId: str(reg.scheduledTaskId),
        transcriptUnavailable: reg.transcriptUnavailable === true ? true : undefined,
        error: truncate(str(reg.error), 512),
        // Cowork keeps the full system prompt; only its size goes into the index.
        systemPromptChars: typeof reg.systemPrompt === 'string' ? reg.systemPrompt.length : undefined,
      }),
    });
    return stats;
  },
};

// ---------------------------------------------------------------------------
// Helpers shared with cowork-audit.ts

/** Parse a registry file; undefined when it is missing or not a JSON object. */
export async function readRegistry(path: string): Promise<Record<string, any> | undefined> {
  try {
    return parseObject(await readFile(path, 'utf8'));
  } catch {
    return undefined;
  }
}

/**
 * Locate `<sid>.jsonl` under a Claude `projects` dir. The preferred cwds are tried first through
 * Claude Code's encoding (every non-alphanumeric char becomes '-'); long paths are truncated with a
 * hash suffix, so every project dir is scanned as a fallback.
 */
export async function findTranscript(projectsDir: string, sid: string, cwds: unknown[] = []): Promise<string | undefined> {
  const file = `${sid}.jsonl`;
  for (const cwd of cwds) {
    if (typeof cwd !== 'string' || !cwd) continue;
    const p = join(projectsDir, cwd.replace(/[^A-Za-z0-9]/g, '-'), file);
    if (await isFile(p)) return p;
  }
  let dirs: string[];
  try {
    dirs = await readdir(projectsDir);
  } catch {
    return undefined;
  }
  for (const d of dirs) {
    const p = join(projectsDir, d, file);
    if (await isFile(p)) return p;
  }
  return undefined;
}

/**
 * The Claude config dir that holds Code-tab transcripts: <home>/.claude, the same directory the transcript
 * adapter discovers. Without a discovery environment the home is recovered from the registry path
 * (<home>/Library/Application Support/...).
 */
function claudeConfigDir(registryPath: string, home?: string): string {
  if (home) return join(home, '.claude');
  const i = registryPath.indexOf('/Library/Application Support/');
  return join(i > 0 ? registryPath.slice(0, i) : homedir(), '.claude');
}

/** Session id for another registry in the same account dir (`local_<uuid>` or the Dispatch agent). */
async function registrySessionId(dir: string, localId: string, prefix: string): Promise<string> {
  for (const p of [join(dir, `${localId}.json`), join(dir, 'agent', `${localId}.json`)]) {
    const reg = await readRegistry(p);
    if (reg) return `${prefix}:${str(reg.cliSessionId) ?? localId}`;
  }
  return `${prefix}:${localId}`;
}

function pullRequests(reg: Record<string, any>): unknown[] | undefined {
  if (Array.isArray(reg.prs) && reg.prs.length) {
    return reg.prs.map((p: any) =>
      dropEmpty({ number: num(p?.prNumber), url: str(p?.url), repo: str(p?.repo), state: str(p?.state), branch: str(p?.branch), baseRef: str(p?.baseRef) }),
    );
  }
  if (reg.prNumber == null && !reg.prUrl) return undefined;
  return [dropEmpty({ number: num(reg.prNumber), url: str(reg.prUrl), repo: str(reg.prRepository), state: str(reg.prState) })];
}

function parseObject(text: string): Record<string, any> | undefined {
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

async function isFile(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}

function projectName(cwd: string | undefined): string | undefined {
  return cwd ? basename(cwd) || undefined : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function dropEmpty<T extends Record<string, unknown>>(o: T): T {
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
  return o;
}
