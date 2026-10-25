// Redaction and excerpts for trace text that leaves AgentShark through MCP, the CLI mirrors and copied reports
// (SPEC §12.6 privacy): home → `~`, user name → `<user>`, secret-shaped strings → `<secret:class:len>`. Credential
// files are never read; this only rewrites text that is already in the index.

import { homedir, userInfo } from 'node:os';
import type { Redaction, RedactionClass } from '../index/api.ts';
import { MCP_LIMITS, type McpEnvelope } from './schemas.ts';

export interface RedactContext {
  home: string;
  user: string;
}

let defaultContext: RedactContext | undefined;

/** This user's home folder and login name. */
export function defaultRedactContext(): RedactContext {
  if (!defaultContext) {
    let user = process.env.USER ?? '';
    try {
      user = userInfo().username;
    } catch {
      // No passwd entry (containers): keep $USER.
    }
    defaultContext = { home: homedir(), user };
  }
  return defaultContext;
}

/**
 * Secret shapes, applied in this order. Each match is replaced by `<secret:class:len>`, len being the replaced
 * length. A PEM block without its END line (text the index cut) is redacted to the end of its base64 body.
 */
const SECRETS: [RedactionClass, RegExp][] = [
  ['pem', /-----BEGIN ([A-Z0-9 ]{1,40})-----(?:[\s\S]*?-----END \1-----|[A-Za-z0-9+/=\s:,.-]*)/g],
  ['jwt', /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g],
  ['github_pat', /\bgithub_pat_[A-Za-z0-9_]{20,}/g],
  ['ghp', /\bgh[pousr]_[A-Za-z0-9]{20,}/g],
  // At least one digit, so words such as `sk-loading-spinner-class` stay.
  ['sk', /(?<![A-Za-z0-9_-])sk-(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{16,}/g],
  ['slack', /\bxox[a-z]-[A-Za-z0-9-]{6,}/g],
  ['aws', /(?<![A-Za-z0-9])(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Za-z0-9])/g],
  // The token only: `Authorization: Bearer <secret:bearer:16>`.
  ['bearer', /(?<=\b(?:[Bb]earer|BEARER)\s+)[A-Za-z0-9._~+/=-]{8,}/g],
];

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Compiled home and user patterns, per context. */
const personal = new WeakMap<RedactContext, { home: RegExp | null; dashed: RegExp | null; user: RegExp | null }>();

function personalPatterns(ctx: RedactContext) {
  let p = personal.get(ctx);
  if (!p) {
    const home = ctx.home.replace(/\/+$/, '');
    const user = ctx.user;
    p = {
      // `/Users/me` but not `/Users/meg`; a home of `/` would match every path, so it is skipped.
      home: home.length > 1 ? new RegExp(`${escapeRe(home)}(?![A-Za-z0-9_.-])`, 'g') : null,
      // The home as a folder name with '/' turned into '-' (Claude's `projects/-Users-me-repo`, humanize caches).
      dashed: home.length > 1 ? new RegExp(`${escapeRe(home.replace(/\//g, '-'))}(?![A-Za-z0-9_.])`, 'g') : null,
      // A short name (`me`) only as a path segment or before `@`, so ordinary words survive.
      user: !user
        ? null
        : user.length >= 3
          ? new RegExp(`(?<![A-Za-z0-9_.-])${escapeRe(user)}(?![A-Za-z0-9_-])`, 'g')
          : new RegExp(`(?<=/)${escapeRe(user)}(?=/|@|$|\\s)|(?<![A-Za-z0-9_.-])${escapeRe(user)}(?=@)`, 'g'),
    };
    personal.set(ctx, p);
  }
  return p;
}

/** Replace secrets, the home folder and the user name; report what was replaced, per class. */
export function redactText(text: string, ctx: RedactContext = defaultRedactContext()): { text: string; redactions: Redaction[] } {
  const counts = new Map<RedactionClass, number>();
  const bump = (c: RedactionClass) => counts.set(c, (counts.get(c) ?? 0) + 1);
  let out = text;
  for (const [cls, re] of SECRETS) {
    out = out.replace(re, (m) => {
      bump(cls);
      return `<secret:${cls}:${m.length}>`;
    });
  }
  const { home, dashed, user } = personalPatterns(ctx);
  if (home) out = out.replace(home, () => (bump('home'), '~'));
  if (dashed) out = out.replace(dashed, () => (bump('home'), '-~'));
  if (user) out = out.replace(user, () => (bump('user'), '<user>'));
  return { text: out, redactions: [...counts].map(([cls, count]) => ({ class: cls, count })) };
}

/**
 * Terminal escapes, C0 controls other than tab and newline, and bidirectional overrides are dropped: trace text is
 * untrusted, and these change how text displays without being visible. CR and CRLF become LF.
 */
export function sanitize(text: string): string {
  return text
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[@-_]?/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\x00-\x08\x0b-\x1f\x7f‪-‮⁦-⁩]/g, '');
}

/** Cut to at most `max` code points, ending in `…` when cut. */
function head(s: string, max: number): string {
  if (s.length <= max) return s;
  if (max <= 0) return '';
  let cut = s.slice(0, max - 1);
  if (/[\ud800-\udbff]$/.test(cut)) cut = cut.slice(0, -1);
  return cut + '…';
}

/** Keep the last `max` code points, starting with `…` when cut. */
function tail(s: string, max: number): string {
  if (s.length <= max) return s;
  if (max <= 0) return '';
  let cut = s.slice(s.length - (max - 1));
  if (/^[\udc00-\udfff]/.test(cut)) cut = cut.slice(1);
  return '…' + cut;
}

/** Trace text as an `_excerpt`: sanitized, redacted (before cutting, so no secret is half kept), at most `max` characters. */
export function excerpt(text: string | null | undefined, max: number = MCP_LIMITS.excerptChars, ctx?: RedactContext): string | null {
  if (text == null) return null;
  return head(redactText(sanitize(String(text)), ctx).text, max);
}

/** Like excerpt, but keeps the end: output tails, where the error usually is. */
export function excerptTail(text: string | null | undefined, max: number = MCP_LIMITS.excerptChars, ctx?: RedactContext): string | null {
  if (text == null) return null;
  return tail(redactText(sanitize(String(text)), ctx).text, max);
}

type Cut = McpEnvelope['cut'][number];

/** Envelope keys (McpEnvelope): fitBytes never shortens them. */
const ENVELOPE_KEYS = new Set(['index_age_s', 'indexer', 'analysis_version', 'gaps', 'cut', 'scope']);
const isTailKey = (key: string) => key === 'tail_excerpt' || key.endsWith('_tail_excerpt');

interface Slot {
  path: string;
  parent: Record<string, unknown> | unknown[];
  key: string | number;
}

/** Every array and every `_excerpt` string under the tool's own keys, with a readable path (`report.attention`). */
function slots(content: Record<string, unknown>): { arrays: Slot[]; excerpts: Slot[] } {
  const arrays: Slot[] = [];
  const excerpts: Slot[] = [];
  const visit = (parent: Record<string, unknown> | unknown[], key: string | number, path: string) => {
    const v = (parent as any)[key];
    if (Array.isArray(v)) {
      arrays.push({ path, parent, key });
      v.forEach((_, i) => visit(v, i, `${path}[${i}]`));
    } else if (v && typeof v === 'object') {
      for (const k of Object.keys(v)) visit(v as Record<string, unknown>, k, `${path}.${k}`);
    } else if (typeof v === 'string' && typeof key === 'string' && key.endsWith('_excerpt')) {
      excerpts.push({ path, parent, key });
    }
  };
  for (const k of Object.keys(content)) if (!ENVELOPE_KEYS.has(k)) visit(content, k, k);
  return { arrays, excerpts };
}

/**
 * Keep the serialized content under `maxBytes` (UTF-8). First long excerpts (output heads and tails, attrs) are
 * halved down to MCP_LIMITS.excerptChars, then trailing elements of the largest arrays are dropped. Every cut is
 * listed in `cut` (merged with the content's own `cut` entries) and the returned content carries the same list.
 */
export function fitBytes(content: Record<string, unknown>, maxBytes: number): { content: Record<string, unknown>; cut: Cut[] } {
  const cut: Cut[] = Array.isArray(content.cut) ? [...(content.cut as Cut[])] : [];
  const out = { ...content, cut };
  const size = () => Buffer.byteLength(JSON.stringify(out));
  if (size() <= maxBytes) return { content: out, cut };

  const note = (path: string, omitted: number) => {
    const c = cut.find((x) => x.path === path && x.reason === 'max-bytes');
    if (c) c.omitted += omitted;
    else cut.push({ path, reason: 'max-bytes', omitted });
  };

  for (;;) {
    const long = slots(out).excerpts
      .map((s) => ({ s, text: (s.parent as any)[s.key] as string }))
      .filter((x) => x.text.length > MCP_LIMITS.excerptChars)
      .sort((a, b) => b.text.length - a.text.length)[0];
    if (!long) break;
    const keep = Math.max(MCP_LIMITS.excerptChars, Math.floor(long.text.length / 2));
    const shorter = isTailKey(String(long.s.key)) ? tail(long.text, keep) : head(long.text, keep);
    (long.s.parent as any)[long.s.key] = shorter;
    note(long.s.path, long.text.length - shorter.length);
    if (size() <= maxBytes) return { content: out, cut };
  }

  for (;;) {
    const arrays = slots(out).arrays.filter((s) => ((s.parent as any)[s.key] as unknown[]).length > 0);
    if (!arrays.length) break;
    const bytes = (s: Slot) => Buffer.byteLength(JSON.stringify((s.parent as any)[s.key]));
    const largest = arrays.reduce((a, b) => (bytes(b) > bytes(a) ? b : a));
    ((largest.parent as any)[largest.key] as unknown[]).pop();
    note(largest.path.replace(/\[\d+\]/g, '[]'), 1);
    if (size() <= maxBytes) break;
  }
  return { content: out, cut };
}
