// Interventions (SPEC §12.3.8): a human, a parent, a policy or a hook stepping in. Turn aborts, Cowork permission
// decisions, questions with their wait, external edits (while external-edit@1 ships) and correction-like prompts come
// from events; tool rejections, policy rejections and hook blocks from the `policy` failure rows. `near_episode` is an
// association only: the episode of the newest failure within 3 calls before (a permission decision: also after) the
// intervention.

import type { InterventionActor, InterventionKind, Prov } from '../../model/types.ts';
import { CORRECTION, CORRECTION_RULE, INTERRUPT_ACTOR_RULE } from './episodes.ts';
import type { Action, Derived } from './model.ts';
import { ships } from './precision.ts';
import { USER_REJECTED } from './signature.ts';
import type { Ev } from './tree.ts';

export const EXTERNAL_EDIT_RULE = 'external-edit@1';
/** The near_episode association (the Lens names it in `related`). */
export const NEAR_EPISODE_RULE = 'near-3-calls@1';
export const QUESTION_TOOLS = new Set(['AskUserQuestion', 'request_user_input', 'request_user_input_async']);
/**
 * Codex's async question returns at once (`{"accepted": true}`); the answer arrives later as a user message whose
 * `<send_user_message_question_reply>` names the call id. Without that message the wait is unknown.
 */
const ASYNC_QUESTION = 'request_user_input_async';
const QUESTION_REPLY = '<send_user_message_question_reply>';
const NEAR_CALLS = 3;
const HOOK_BLOCKED = /\bPreToolUse:\S+ hook (?:error|blocked)|Blocked by (?:a )?hook/i;
/** Cowork logs a denial as a permission decision, then the tool result "Permission to use X was denied". */
const COWORK_DENIED = /^Permission to use \S+ (?:was|has been) denied/;

export function deriveInterventions(d: Derived): void {
  for (const s of d.tree.sessions) {
    const acts = d.actions.get(s.id) ?? [];
    const calls = acts.filter((a) => a.kind === 'tool' || a.kind === 'item');
    const byRid = new Map<number, Action>();
    for (const a of acts) for (const e of [a.call, a.result]) if (e) byRid.set(e.rid, a);
    const seen = new Set<number>();
    const add = (e: Ev, kind: InterventionKind, actor: InterventionActor, actorSrc: Prov, nearEpisode: string | null, waitUs: number | null = null) => {
      if (seen.has(e.rid)) return;
      seen.add(e.rid);
      d.interventions.push({
        rid: e.rid, sessionId: s.id, turnId: e.turn, stepId: d.stepOf.get(e.rid)?.id ?? null, ts: e.ts, kind, actor, actorSrc, waitUs, nearEpisode,
      });
    };
    /** The episode of the newest failure among the NEAR_CALLS calls whose evidence is at or before `seq` (or, `after`, the next ones). */
    const near = (seq: number, after = false): string | null => {
      let i = 0;
      for (let hi = calls.length; i < hi;) {
        const mid = (i + hi) >> 1;
        if (calls[mid].seq > seq) hi = mid;
        else i = mid + 1;
      }
      for (let j = i - 1; j >= Math.max(0, i - NEAR_CALLS); j--) if (calls[j].failure?.episodeId) return calls[j].failure!.episodeId;
      if (after) for (let j = i; j < Math.min(calls.length, i + NEAR_CALLS); j++) if (calls[j].failure?.episodeId) return calls[j].failure!.episodeId;
      return null;
    };
    const replies = s.events.filter((e) => e.kind === 'user.prompt' && typeof e.a.text === 'string' && e.a.text.includes(QUESTION_REPLY));
    /** A question's wait: until its result, or for an async question until the reply that names its call id. */
    const waitOf = (a: Action, call: Ev): number | null => {
      if (a.tool !== ASYNC_QUESTION) return a.result ? Math.max(0, a.result.ts - call.ts) : null;
      const id = call.a.tool?.call_id;
      const reply = typeof id === 'string' ? replies.find((r) => r.seq > call.seq && (r.a.text as string).includes(id)) : undefined;
      return reply ? reply.ts - call.ts : null;
    };
    const main = s.role === 'main';
    const deniedTools = new Map<string, boolean>();
    let turns = 0;
    let lastTurn: string | null = null;
    for (const e of s.events) {
      if (e.turn && e.turn !== lastTurn) {
        turns++;
        lastTurn = e.turn;
      }
      switch (e.kind) {
        case 'turn.abort':
          if (main) add(e, 'interrupt', 'human', 'logged:turn.abort', near(e.seq));
          else add(e, 'abort-child', 'parent-or-human', `inferred:${INTERRUPT_ACTOR_RULE}`, near(e.seq));
          break;
        case 'permission.decision': {
          const tool = e.a.permission?.tool;
          const deny = e.a.permission?.decision === 'deny' || e.a.permission?.granted === false;
          if (typeof tool === 'string') deniedTools.set(tool, deny);
          // A question's permission is its answer: the question row covers it.
          if (typeof tool !== 'string' || !QUESTION_TOOLS.has(tool)) add(e, 'permission-decision', 'human', 'logged:permission.decision', near(e.seq, true));
          break;
        }
        case 'context.attachment':
          if (e.proto.endsWith('edited_text_file') && ships(EXTERNAL_EDIT_RULE)) add(e, 'external-edit', 'human', `inferred:${EXTERNAL_EDIT_RULE}`, near(e.seq));
          break;
        case 'user.prompt':
          // A correction answers an earlier turn, so a session's first prompt is none.
          if (main && turns > 1 && typeof e.a.text === 'string' && CORRECTION.test(e.a.text)) add(e, 'correction', 'human', `inferred:${CORRECTION_RULE}`, near(e.seq));
          break;
        case 'tool.call': {
          const a = byRid.get(e.rid);
          if (a && QUESTION_TOOLS.has(a.tool ?? '')) add(e, 'question', 'human', 'logged:tool.result', near(e.seq), waitOf(a, e));
          break;
        }
      }
      // Rejections and blocks: the policy failure row on this event.
      const a = byRid.get(e.rid);
      const f = a?.failure;
      if (!f || f.rid !== e.rid || f.source !== 'policy') continue;
      const out = typeof e.a.tool?.output === 'string' ? e.a.tool.output.slice(0, 400) : '';
      if (e.kind === 'hook.run' || HOOK_BLOCKED.test(out)) add(e, 'hook-blocked', 'hook', e.kind === 'hook.run' ? 'logged:hook.run' : 'logged:tool.result', f.episodeId);
      else if (USER_REJECTED.test(out)) add(e, 'tool-rejected', 'human', 'logged:tool.result', f.episodeId);
      else if (!(COWORK_DENIED.test(out) && deniedTools.get(a!.tool ?? '') === true)) add(e, 'policy-rejected', 'policy', 'logged:tool.result', f.episodeId);
    }
  }
}
