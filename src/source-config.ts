// Shared, explicit source locations for the desktop app and CLI. Never changes HOME.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';

export interface SourceConfig {
  version: 1;
  autoDiscover: boolean;
  /** Agent data directories containing projects/ (Claude) or sessions/ (Codex). */
  claudeRoots: string[];
  codexRoots: string[];
}

export function sourceConfigPath(): string {
  return process.env.AGENTSHARK_SOURCE_CONFIG || join(process.env.AGENTSHARK_HOME || join(homedir(), '.agentshark'), 'sources.json');
}

export function validateSourceConfig(value: unknown): SourceConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Source configuration must be an object.');
  const v = value as Record<string, unknown>;
  if (v.version !== 1) throw new Error('Unsupported source configuration version; expected 1.');
  if (typeof v.autoDiscover !== 'boolean') throw new Error('autoDiscover must be true or false.');
  const roots = (key: string): string[] => {
    const a = v[key];
    if (!Array.isArray(a) || a.some((p) => typeof p !== 'string' || !p.trim())) throw new Error(`${key} must be an array of directory paths.`);
    return [...new Set((a as string[]).map((p) => {
      const expanded = p.startsWith('~/') || p.startsWith('~\\') ? join(homedir(), p.slice(2)) : p;
      if (!isAbsolute(expanded)) throw new Error(`${key} paths must be absolute (or start with ~/).`);
      return resolve(expanded);
    }))];
  };
  return { version: 1, autoDiscover: v.autoDiscover, claudeRoots: roots('claudeRoots'), codexRoots: roots('codexRoots') };
}

export function readSourceConfig(path = sourceConfigPath()): SourceConfig {
  if (!existsSync(path)) return { version: 1, autoDiscover: true, claudeRoots: [], codexRoots: [] };
  try { return validateSourceConfig(JSON.parse(readFileSync(path, 'utf8'))); }
  catch (error) { throw new Error(`Cannot read source configuration ${path}: ${(error as Error).message}`); }
}

export function writeSourceConfig(value: SourceConfig, path = sourceConfigPath()): SourceConfig {
  const config = validateSourceConfig(value);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  renameSync(temp, path);
  return config;
}

export function platformAppSupport(home: string, platform = process.platform, env = process.env): string {
  if (platform === 'darwin') return join(home, 'Library', 'Application Support');
  if (platform === 'win32') return env.APPDATA || join(home, 'AppData', 'Roaming');
  return env.XDG_CONFIG_HOME || join(home, '.config');
}
