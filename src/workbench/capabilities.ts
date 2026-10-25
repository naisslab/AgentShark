/** Capability Envelope (docs/analyses/CAPABILITIES.md): what a run was allowed to do against what it did. */
import { posix } from 'node:path';
import { splitSegments } from '../index/derive/target.ts';
import { type Action, addGaps, loadRun, ref, refs } from './actions.ts';
import { type Data, type Event, type Row, command, evidence, object, parse, textId } from './data.ts';
import type { EvidenceRef } from './types.ts';

export interface CapabilitiesSpec {
    session: string;
}
interface Grant {
    from: number;
    to: number | null;
    approval: string | null;
    sandbox: string | null;
    writableRoots: string[] | null;
    network: boolean | null;
    reviewer: string | null;
    mode: string | null;
    cwd: string | null;
    evidence: EvidenceRef[];
}
const SHELL_TOOLS = new Set(['Bash', 'exec_command', 'shell_command', 'shell', 'local_shell', 'CommandExecution', 'mcp__workspace__bash']);
const NETWORK_PROGRAMS = /^(?:curl|wget|ssh|scp|rsync|gh|git (?:clone|fetch|pull|push|ls-remote)|docker (?:pull|push|login))\b/;
const URL_HOST = /\b[a-z][a-z0-9+.-]*:\/\/(?:[^@\s/'"]+@)?(\[[0-9a-fA-F:.]+\]|[^/:\s'"?#[\]]+)/gi;
const SCP_HOST = /(?:^|\s)(?:[\w.-]+@)?([\w-]+(?:\.[\w-]+)+):[\w~./-]/g;
/** Credential stores distinctive enough to match anywhere in a command. */
const CREDENTIAL_DIR = /(?<=^|[\s'"=:(/])(?:\.ssh\/|\.aws\/|\.config\/gh\/|\.netrc\b|\.codex\/auth\.json|\.docker\/config\.json)|\bsecurity\s+find-[\w-]*password/;
/** Credential file names, matched against a whole shell word or path, so code such as `a.key` or `process.env` inside a quoted script is no file. */
const CREDENTIAL_FILE = /^(?:.*\/)?(?:[\w.-]+\.(?:pem|key)|id_rsa[\w.-]*|id_ed25519[\w.-]*|\.env(?:\.(?!(?:example|sample|template|dist)$)[\w.-]+)?)$/;
const DESTRUCTIVE: [RegExp, string][] = [
    [/\brm\s+(?:-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)\b/, 'rm -r'],
    [/\bgit\s+push\b[^|;&\n]*\s(?:--force(?:-with-lease)?|-f)\b/, 'git push --force'],
    [/\bgit\s+reset\s+--hard\b/, 'git reset --hard'],
    [/\bgit\s+clean\s+-[a-zA-Z]*f/, 'git clean -f'],
    [/\bgit\s+(?:checkout\s+--|restore)\s+\.(?:\s|$)/, 'git restore .'],
    [/\bgit\s+branch\s+-D\b/, 'git branch -D'],
    [/\bch(?:mod|own)\s+-R\b/, 'chmod -R'],
    [/(?:^|[;&|(]\s*)sudo\b/, 'sudo'],
];
const TEMP = /^(?:\/tmp\/|\/private\/tmp\/|\/var\/folders\/|\/private\/var\/folders\/)/;
const DENIAL_KINDS = new Set(['policy-rejected', 'tool-rejected', 'hook-blocked']);
const BLOCKED = new Set(['sandbox', 'policy', 'network']);
const FULL = new Set(['danger-full-access', 'disabled', 'bypassPermissions']);
/** Search tools that the model provider runs on its own servers: they use no local network. */
const PROVIDER_SIDE = new Set(['web_search', 'web_search_call', 'WebSearch']);
const LOOPBACK = /^(?:localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[::1\])$/;
/** Programs whose URL argument is the host they talk to; only their loopback-only uses stay off the network list. */
const URL_CLIENTS = /^(?:curl|wget|http|https|xh)\b/;
const ESCALATION = /require_escalated|with_escalated_permissions/;

function within(path: string, dir: string | null | undefined): boolean {
    if (!dir) return false;
    const base = dir.endsWith('/') ? dir : dir + '/';
    return path === dir || path.startsWith(base);
}
/** Writable roots of a Codex turn: the sandbox's writable roots and the workspace roots; null when neither is logged. */
function roots(p: Row): string[] | null {
    const list = [p.sandbox_policy?.writable_roots, p.workspace_roots].filter(Array.isArray).flat().filter((r: unknown): r is string => typeof r === 'string');
    return list.length ? [...new Set(list)] : null;
}
/** A Codex call input that asks to run outside the sandbox (after approval). */
function escalatedInput(input: unknown): boolean {
    return !!input && typeof input === 'object' && ((input as Row).sandbox_permissions === 'require_escalated' || (input as Row).with_escalated_permissions === true);
}
function isShell(a: Action): boolean { return a.key.startsWith('sh:') || SHELL_TOOLS.has(a.tool ?? '') || a.call?.tool_kind === 'shell'; }
function text(a: Action): string { return a.call ? command(a.call) : ''; }

export function capabilities(d: Data, spec: CapabilitiesSpec) {
    object(spec, 'capabilities');
    const rootId = textId(spec.session, 'session');
    const run = loadRun(d, rootId);
    const eventsByRid = new Map<number, Event>(run.loaded.events.map(e => [e.rid, e]));
    const turnContexts = run.loaded.events.filter(e => e.proto === 'codex/turn_context');
    const natives = d.natives(turnContexts.map(e => e.rid));
    // A Codex code-mode script runs its commands as `exec` items. Its own key is its first command's, so the script counts only
    // when no item of it has that key: some calls of a script are never logged as items. A command the script asked to escalate
    // is escalated, and a denial an item carries is not counted again on the script.
    const execParent = new Map(d.derived('spans', run.sessionIds).filter(s => s.kind === 'exec' && s.parent_id).map(s => [s.id as string, s.parent_id as string]));
    const scriptOf = (a: Action) => a.call?.kind === 'tool.exec' && a.call.span_id ? execParent.get(a.call.span_id) ?? null : null;
    const itemKeys = new Map<string, Set<string>>();
    for (const a of run.actions) {
        const script = scriptOf(a);
        if (script) (itemKeys.get(script) ?? itemKeys.set(script, new Set()).get(script)!).add(a.key);
    }
    const covered = (a: Action) => a.call?.kind === 'tool.call' && !!a.call.span_id && !!itemKeys.get(a.call.span_id)?.has(a.key);
    const scriptText = (a: Action) => { const input = a.call?.a.tool?.input; return typeof input === 'string' ? input : typeof input?.code === 'string' ? input.code : ''; };
    const escalatedScripts = new Set(run.actions.filter(a => a.call?.kind === 'tool.call' && a.call.span_id && itemKeys.has(a.call.span_id) && ESCALATION.test(scriptText(a))).map(a => a.call!.span_id as string));
    const escalated = (a: Action) => escalatedInput(a.call?.a.tool?.input) || escalatedScripts.has(scriptOf(a) ?? '');
    // Granted (§2): settings in force from one event until the next change.
    const grants = new Map<string, Grant[]>();
    for (const sid of run.sessionIds) {
        const s = run.sessions.get(sid)!, list: Grant[] = [];
        const push = (g: Omit<Grant, 'to'>) => {
            const last = list[list.length - 1];
            const same = last && JSON.stringify({ ...last, from: 0, to: 0, evidence: [] }) === JSON.stringify({ ...g, from: 0, to: 0, evidence: [] });
            if (same) return;
            if (last) last.to = g.from;
            list.push({ ...g, to: null });
        };
        const meta = parse(s.meta);
        if (typeof meta.permissionMode === 'string' && !s.agent?.startsWith('codex')) push({ from: s.start_ts ?? 0, approval: null, sandbox: null, writableRoots: null, network: null, reviewer: null, mode: meta.permissionMode, cwd: s.cwd ?? null, evidence: [] });
        for (const e of run.loaded.events) {
            if (e.session_id !== sid) continue;
            if (e.proto === 'codex/turn_context') {
                const p = natives.get(e.rid)?.payload ?? {};
                const profile = p.permission_profile ?? {};
                const net = typeof p.sandbox_policy?.network_access === 'boolean' ? p.sandbox_policy.network_access : profile.network === 'enabled' ? true : profile.network === 'restricted' ? false : null;
                push({ from: e.ts, approval: p.approval_policy ?? null, sandbox: p.sandbox_policy?.type ?? profile.type ?? null, writableRoots: roots(p), network: net, reviewer: p.approvals_reviewer ?? null, mode: null, cwd: p.cwd ?? s.cwd ?? null, evidence: [evidence(e)] });
            } else if (e.kind === 'session.state' && typeof e.a.permission?.mode === 'string' && e.proto.startsWith('claude/'))
                push({ from: e.ts, approval: null, sandbox: null, writableRoots: null, network: null, reviewer: null, mode: e.a.permission.mode, cwd: s.cwd ?? null, evidence: [evidence(e)] });
        }
        grants.set(sid, list);
    }
    const grantAt = (sid: string, ts: number): Grant | null => [...(grants.get(sid) ?? [])].reverse().find(g => g.from <= ts) ?? grants.get(sid)?.[0] ?? null;
    const grantLabel = (g: Grant | null) => g ? [g.sandbox, g.approval && `approval=${g.approval}`, g.mode && `mode=${g.mode}`, g.network === null ? null : `network=${g.network ? 'on' : 'off'}`].filter(Boolean).join(' ') || null : null;
    // Denials (§4): interventions and blocked failures, by the rid of the result.
    const denied = new Map<number, string>();
    for (const r of d.derived('interventions', run.sessionIds)) {
        const e = eventsByRid.get(r.rid);
        if (DENIAL_KINDS.has(r.kind) || r.kind === 'permission-decision' && ['deny', 'reject'].includes(e?.a.permission?.decision)) denied.set(r.rid, r.kind);
    }
    for (const f of d.derived('failures', run.sessionIds)) if (BLOCKED.has(f.family) && !denied.has(f.rid)) denied.set(f.rid, f.family);
    const isDenied = (a: Action) => (a.result && denied.has(a.result.rid)) || (a.call && denied.has(a.call.rid));
    const scriptsWithDeniedItem = new Set(run.actions.filter(i => scriptOf(i) && isDenied(i)).map(i => scriptOf(i)!));
    // Used (§3).
    const commands = new Map<string, { count: number; ok: number; failed: number; denied: number; actions: Action[] }>();
    const writes = { cwd: 0, writableRoot: 0, temp: 0, outside: 0, uncertain: 0 };
    const outsidePaths = new Map<string, Action[]>();
    const escalations: Action[] = [], providerSide: Action[] = [];
    const network: { action: Action; hosts: string[] }[] = [], sensitive: { action: Action; detail: string }[] = [], destructive: { action: Action; detail: string }[] = [];
    // One finding per kind, session and group (a directory, a command), with a count.
    const grouped = new Map<string, Row>();
    const finding = (name: string, a: Action, detail: string, rule: string | null, group = detail) => {
        const k = `${name}\0${a.sessionId}\0${group}`, f = grouped.get(k);
        if (f) {
            f.count++;
            if (f.evidence.length < 50) f.evidence.push(ref(a, 'candidate'));
        } else grouped.set(k, { finding: name, sessionId: a.sessionId, detail, count: 1, confidence: 'candidate', rule, evidence: [ref(a, 'candidate')] });
    };
    for (const a of run.actions) {
        if (covered(a)) continue;
        if (PROVIDER_SIDE.has(a.tool ?? '')) { providerSide.push(a); continue; }
        const g = grantAt(a.sessionId, a.ts), cwds = [run.sessions.get(a.sessionId)?.cwd, g?.cwd];
        const cmd = text(a), raised = escalated(a);
        if (raised) escalations.push(a);
        if (isShell(a)) {
            const key = a.key.startsWith('sh:') ? a.key : a.object;
            const c = commands.get(key) ?? { count: 0, ok: 0, failed: 0, denied: 0, actions: [] };
            c.count++;
            if (isDenied(a)) c.denied++;
            else if (a.outcome === 'ok') c.ok++;
            else if (a.outcome === 'failed') c.failed++;
            if (c.actions.length < 5) c.actions.push(a);
            commands.set(key, c);
        }
        for (const f of a.files.filter(f => f.access !== 'read')) {
            if (f.access === 'uncertain') writes.uncertain++;
            const where = cwds.some(c => within(f.path, c)) ? 'cwd' : g?.writableRoots?.some(r => within(f.path, r)) ? 'writableRoot' : TEMP.test(f.path) ? 'temp' : 'outside';
            if (f.access === 'write') writes[where]++;
            if (where === 'outside') {
                (outsidePaths.get(f.path) ?? outsidePaths.set(f.path, []).get(f.path)!).push(a);
                if (!raised && g && (g.sandbox === 'workspace-write' || g.sandbox === 'read-only')) finding('write-outside-grant', a, `${run.display(posix.dirname(f.path), a.sessionId)} under ${g.sandbox}`, null);
            }
        }
        // network-use@1: web actions and network programs, with the hosts the input names.
        const program = a.key.startsWith('sh:') ? a.key.slice(3) : '';
        if (a.op === 'web' || a.op === 'install' || NETWORK_PROGRAMS.test(program)) {
            const input = cmd || JSON.stringify(a.call?.a.tool?.input ?? '');
            const hosts = new Set<string>();
            for (const m of input.matchAll(URL_HOST)) hosts.add(m[1].toLowerCase());
            if (/^(?:ssh|scp|rsync|git)\b/.test(program)) for (const m of input.matchAll(SCP_HOST)) hosts.add(m[1].toLowerCase());
            if (a.key.startsWith('web:')) hosts.add(a.key.slice(4));
            // A URL client or web tool that names only this machine (localhost, 127.x, 0.0.0.0, [::1]) uses no network beyond it.
            if (!(URL_CLIENTS.test(program) || a.op === 'web') || !hosts.size || ![...hosts].every(h => LOOPBACK.test(h))) {
                network.push({ action: a, hosts: [...hosts].sort() });
                // A failed attempt is a denial or a failure, not a use; only a use that succeeded escaped the grant.
                if (!raised && g?.network === false && a.outcome === 'ok') finding('network-while-disabled', a, a.object, 'network-use@1');
            }
        }
        // credential-path@2 and destructive@1 read the command text and the paths the action touched.
        const cred = CREDENTIAL_DIR.exec([cmd, ...a.files.map(f => f.path)].join('\n'))?.[0].trim()
            ?? [...splitSegments(cmd).flat(), ...a.files.map(f => f.path)].find(w => CREDENTIAL_FILE.test(w));
        if (cred) {
            sensitive.push({ action: a, detail: cred });
            finding('sensitive-path', a, cred, 'credential-path@2');
        }
        for (const [re, name] of DESTRUCTIVE)
            if (re.test(cmd)) {
                destructive.push({ action: a, detail: name });
                finding('destructive-command', a, name, 'destructive@1');
                break;
            }
    }
    // Fit (§5): grants with no matching use.
    for (const [sid, list] of grants)
        for (const g of list) {
            const inGrant = (a: Action) => a.sessionId === sid && a.ts >= g.from && (g.to === null || a.ts < g.to);
            const acts = run.actions.filter(inGrant);
            if (!acts.length) continue;
            const ev = g.evidence.length ? g.evidence : [ref(acts[0], 'candidate')];
            if (g.network === true && !network.some(n => inGrant(n.action))) grouped.set(`unused-network\0${sid}\0${g.from}`, { finding: 'unused-network', sessionId: sid, detail: grantLabel(g), count: 1, confidence: 'candidate', rule: null, evidence: ev });
            const full = FULL.has(g.sandbox ?? '') || FULL.has(g.mode ?? '');
            const cwds = [run.sessions.get(sid)?.cwd, g.cwd];
            if (full && acts.every(a => a.files.every(f => f.access === 'read' || cwds.some(c => within(f.path, c)) || TEMP.test(f.path)))) grouped.set(`unused-full-access\0${sid}\0${g.from}`, { finding: 'unused-full-access', sessionId: sid, detail: grantLabel(g), count: 1, confidence: 'candidate', rule: null, evidence: ev });
        }
    const findings = [...grouped.values()].sort((a, b) => b.count - a.count);
    // Denial groups (§4), ranked by count and then by how long the run took to get past them.
    const groups = new Map<string, { actions: Action[]; grants: Set<string> }>();
    for (const a of run.actions)
        if (isDenied(a) && !scriptsWithDeniedItem.has(a.call?.span_id ?? '')) {
            const gr = groups.get(a.key) ?? { actions: [], grants: new Set<string>() };
            gr.actions.push(a);
            const label = grantLabel(grantAt(a.sessionId, a.ts));
            if (label) gr.grants.add(label);
            groups.set(a.key, gr);
        }
    const denials = [...groups].map(([key, gr]) => {
        const first = gr.actions[0], last = gr.actions[gr.actions.length - 1];
        const later = run.actions.find(a => a.index > last.index && a.key === key && a.outcome === 'ok' && !isDenied(a));
        return { key: run.actions.find(a => a.key === key)?.object ?? key, count: gr.actions.length, grants: [...gr.grants], laterSucceeded: later ? ref(later) : null, resolvedAfterUs: later && later.ts >= first.ts ? later.ts - first.ts : null, evidence: refs(gr.actions) };
    }).sort((a, b) => b.count - a.count || (b.resolvedAfterUs ?? Infinity) - (a.resolvedAfterUs ?? Infinity));
    // Observed minimum envelope.
    const dirs = [...new Set([...outsidePaths.keys()].map(p => posix.dirname(p)))].sort();
    const writeDirs = dirs.filter(d => !dirs.some(o => o !== d && within(d, o)));
    const hosts = [...new Set(network.flatMap(n => n.hosts))].sort();
    const gaps = ['approvals-not-logged', 'shell-changes-invisible', 'network-use-from-command-text'];
    if (run.loaded.sessions.some(s => String(s.agent).startsWith('claude'))) gaps.push('claude-permission-rules-not-logged');
    if (run.loaded.events.some(e => e.proto === 'codex/world_state')) gaps.push('approved-prefixes-hashed');
    if (commands.size > 200 || outsidePaths.size > 200 || denials.length > 100 || findings.length > 200) gaps.push('capability-list-limit');
    if (run.truncated) gaps.push('action-limit');
    addGaps(run.loaded, ...gaps);
    const commandList = [...commands].sort((a, b) => b[1].count - a[1].count);
    return {
        ...d.envelope(run.loaded.coverage), sessionId: rootId,
        sessions: run.sessionIds.map(sid => ({ sessionId: sid, agent: run.sessions.get(sid)?.agent ?? null, grants: grants.get(sid) ?? [] })),
        used: {
            commands: commandList.slice(0, 200).map(([key, c]) => ({ key, count: c.count, ok: c.ok, failed: c.failed, denied: c.denied, evidence: refs(c.actions) })),
            writes: { ...writes, outsidePaths: [...outsidePaths].slice(0, 200).map(([path, acts]) => ({ path: run.display(path), writes: acts.length, evidence: refs(acts) })) },
            network: network.slice(0, 200).map(n => ({ object: n.action.object, hosts: n.hosts, outcome: n.action.outcome, evidence: [ref(n.action, 'candidate')] })),
            sensitive: sensitive.slice(0, 200).map(s => ({ detail: s.detail, object: s.action.object, evidence: [ref(s.action, 'candidate')] })),
            escalated: { count: escalations.length, evidence: refs(escalations) },
            providerSearches: { count: providerSide.length, evidence: refs(providerSide) },
            destructive: destructive.slice(0, 200).map(s => ({ detail: s.detail, object: s.action.object, outcome: s.action.outcome, evidence: [ref(s.action, 'candidate')] })),
        },
        denials: denials.slice(0, 100),
        findings: findings.slice(0, 200),
        minimal: { writeDirs: writeDirs.map(p => run.display(p)), network: network.length > 0, hosts, commands: commandList.map(([key]) => key).slice(0, 200), src: 'derived' },
        summary: {
            sessions: run.sessionIds.length, grants: [...grants.values()].reduce((n, l) => n + l.length, 0), commands: commands.size, writesOutside: writes.outside, networkUses: network.length, escalated: escalations.length,
            sensitive: sensitive.length, destructive: destructive.length, denials: denials.length, findings: findings.length,
        },
        rules: ['network-use@1', 'credential-path@2', 'destructive@1'],
        caveats: ['The minimum envelope describes these runs only; another task needs another envelope.', 'Rules read command text: a script the command runs is not inspected, and a matched word may sit in a string argument.', 'AgentShark reports; it never writes agent configuration.'],
    };
}
