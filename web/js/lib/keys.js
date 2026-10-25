// The one keymap of the viewer (WEB-CONTRACT "Keyboard", SPEC §12.7). Global keys run here through a
// single keydown listener; context keys (event list, Lens, Steps, queue, timeline) are handled by their
// views and listed here so the help sheet and the uniqueness test see every binding.
// Keys are inactive while focus is in a text field or a dialog, except entries marked `typing`.

import { isTyping } from './dom.js';

const ws = (n) => ({
  id: `workspace-${n}`,
  keys: [`Alt+${n}`, String(n)],
  display: n === 1 ? 'Alt+1 … Alt+7  (or 1 … 7)' : null,
  label: 'Switch workspace (order of the tabs)',
  when: 'global',
});

/**
 * when: 'global' (anywhere), or the view whose focus owns the key: 'list' (Events list), 'lens', 'steps',
 * 'queue' (Failures queue), 'timeline'. Two entries conflict when they share a key and their `when` is equal
 * or one of them is global. `display` is the help text for the keys (null hides a repeated row).
 */
export const KEYMAP = [
  { id: 'next-failure', keys: ['e'], label: 'Next failure in scope (with nothing selected: the newest)', when: 'global' },
  { id: 'prev-failure', keys: ['E'], label: 'Previous failure in scope', when: 'global' },
  { id: 'next-attention', keys: ['u'], label: 'Next attention item', when: 'global' },
  { id: 'show-in-session', keys: ['Shift+Enter'], label: 'Show in Session (the step of the selected event or failure)', when: 'global' },
  { id: 'show-signature', keys: ['s'], label: 'Show the signature of the selected failure', when: 'global' },
  { id: 'follow', keys: ['f'], label: 'Follow the stream of the selection: its call, delegation, process or file', when: 'global' },
  { id: 'copy-report', keys: ['c'], label: 'Copy a report of the selected failure', when: 'global' },
  { id: 'time-ref', keys: ['t'], label: 'Set or clear the time reference at the selection', when: 'global' },
  ...[1, 2, 3, 4, 5, 6, 7].map(ws),
  { id: 'focus-filter', keys: ['Ctrl+/', 'Meta+/'], display: 'Ctrl + /', label: 'Focus the display filter', when: 'global', typing: true },
  { id: 'toggle-sidebar', keys: ['Ctrl+b'], display: 'Ctrl + B', label: 'Show or hide the sessions sidebar', when: 'global', typing: true },
  { id: 'help', keys: ['?'], label: 'Show this help', when: 'global' },
  { id: 'pane-next', keys: ['F6'], label: 'Move focus to the next pane', when: 'global', typing: true },
  { id: 'pane-prev', keys: ['Shift+F6'], label: 'Move focus to the previous pane', when: 'global', typing: true },

  // Events list (views/events.js)
  { id: 'list-move', keys: ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'], display: '↑ ↓  PgUp PgDn  Home End', label: 'Move through the event list', when: 'list' },
  { id: 'list-detail', keys: ['Enter'], label: 'Move focus to the detail tree; Esc returns to the list', when: 'list' },
  { id: 'list-find', keys: ['Ctrl+f', 'Meta+f'], display: 'Ctrl + F  (⌘F)', label: 'Find text in the event list; Enter and Shift+Enter step through matches', when: 'list' },
  { id: 'list-goto', keys: ['Ctrl+g', 'Meta+g'], display: 'Ctrl + G', label: 'Go to an event by No. or id', when: 'list' },
  { id: 'list-mark', keys: ['m', 'M', 'Ctrl+m'], display: 'Ctrl + M  or  M', label: 'Mark or unmark the selected event', when: 'list' },
  { id: 'list-marks', keys: ['Ctrl+Shift+N', 'Ctrl+Shift+B'], display: 'Ctrl + Shift + N / B', label: 'Next or previous marked event', when: 'list' },
  { id: 'list-partner', keys: ['Ctrl+ArrowRight', 'Meta+ArrowRight'], display: 'Ctrl + →', label: 'Go to the paired event (call ↔ result)', when: 'list' },
  { id: 'list-back', keys: ['Ctrl+ArrowLeft', 'Meta+ArrowLeft'], display: 'Ctrl + ←', label: 'Go back to the previously selected event', when: 'list' },
  { id: 'list-span', keys: ['Ctrl+.', 'Ctrl+,'], display: 'Ctrl + .  /  Ctrl + ,', label: 'Next or previous event in the same span', when: 'list' },

  // Failures queue, Lens and Steps
  { id: 'queue-move', keys: ['ArrowUp', 'ArrowDown'], display: '↑ ↓', label: 'Failures: move through the queue', when: 'queue' },
  { id: 'queue-open', keys: ['Enter'], label: 'Failures: move focus to the Lens', when: 'queue' },
  { id: 'queue-section', keys: ['Alt+ArrowUp', 'Alt+ArrowDown'], display: 'Alt + ↑ / Alt + ↓', label: 'Failures: previous or next section', when: 'queue' },
  { id: 'lens-attempt', keys: ['ArrowUp', 'ArrowDown'], display: '↑ ↓', label: 'Lens: move between attempts', when: 'lens' },
  { id: 'lens-open', keys: ['Enter'], label: 'Lens: show the focused attempt’s event', when: 'lens' },
  { id: 'steps-move', keys: ['ArrowUp', 'ArrowDown'], display: '↑ ↓', label: 'Steps: move through turns and steps', when: 'steps' },
  { id: 'steps-expand', keys: ['ArrowRight', 'ArrowLeft'], display: '→ / ←', label: 'Steps: expand or collapse a turn', when: 'steps' },
  { id: 'steps-turn', keys: ['Alt+ArrowUp', 'Alt+ArrowDown'], display: 'Alt + ↑ / Alt + ↓', label: 'Steps: previous or next turn', when: 'steps' },
  { id: 'steps-open', keys: ['Enter'], label: 'Steps: select the step’s first failing call', when: 'steps' },

  // Timeline canvas (views/timeline.js)
  { id: 'timeline-zoom', keys: ['+', '=', '-', '0'], display: '+  −  0', label: 'Timeline: zoom in, zoom out, fit', when: 'timeline' },
  { id: 'timeline-step', keys: ['n', 'p'], display: 'n  /  p', label: 'Timeline: select the next or previous span', when: 'timeline' },
];

const WHEN_LABEL = { global: 'Anywhere', list: 'Event list', queue: 'Failures queue', lens: 'Failure Lens', steps: 'Session · Steps', timeline: 'Timeline' };

/** Key pairs that collide: the same key in entries whose `when` overlaps (equal, or either is global). */
export function conflicts(keymap = KEYMAP) {
  const out = [];
  for (let i = 0; i < keymap.length; i++) {
    for (let j = i + 1; j < keymap.length; j++) {
      const a = keymap[i];
      const b = keymap[j];
      if (a.when !== b.when && a.when !== 'global' && b.when !== 'global') continue;
      for (const k of a.keys) if (b.keys.includes(k)) out.push({ key: k, a: a.id, b: b.id });
    }
    const own = keymap[i].keys;
    for (const k of new Set(own)) if (own.indexOf(k) !== own.lastIndexOf(k)) out.push({ key: k, a: keymap[i].id, b: keymap[i].id });
  }
  return out;
}

/**
 * Canonical name of a key event: modifiers Ctrl, Meta, Alt, then Shift for non-printable keys, then the key.
 * Alt combinations read `e.code`, because Option changes `e.key` on macOS (Option+1 types "¡").
 */
export function keyId(e) {
  let key = e.key;
  if (e.altKey && /^(Digit|Key)/.test(e.code ?? '')) key = e.code.replace(/^(Digit|Key)/, '').toLowerCase();
  const mods = [];
  if (e.ctrlKey) mods.push('Ctrl');
  if (e.metaKey) mods.push('Meta');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey && (key.length > 1 || mods.length)) mods.push('Shift');
  return [...mods, key].join('+');
}

/** Help sheet rows grouped by context: [{ when, title, rows: [[keys, label]] }]. */
export function helpSections(keymap = KEYMAP) {
  const out = [];
  for (const when of Object.keys(WHEN_LABEL)) {
    const rows = keymap.filter((k) => k.when === when && k.display !== null).map((k) => [k.display ?? k.keys.join('  /  '), k.label]);
    if (rows.length) out.push({ when, title: WHEN_LABEL[when], rows });
  }
  return out;
}

/** What each global entry does; views own the context keys. */
const ACTIONS = {
  'next-failure': (app) => app.nextFailure(1),
  'prev-failure': (app) => app.nextFailure(-1),
  'next-attention': (app) => app.nextAttention(),
  'show-in-session': (app) => app.showInSession(),
  'show-signature': (app) => app.showSignature(),
  follow: (app) => app.openFollow(),
  'copy-report': (app) => app.copyReport(),
  'time-ref': (app) => app.setTimeReference(),
  'focus-filter': (app) => app.focusFilter(),
  'toggle-sidebar': (app) => app.toggleSidebar(),
  help: (app) => app.showShortcuts(),
  'pane-next': (app) => app.focusPane(1),
  'pane-prev': (app) => app.focusPane(-1),
};
for (let n = 1; n <= 7; n++) ACTIONS[`workspace-${n}`] = (app) => app.switchWorkspace(app.workspaceOrder()[n - 1]);

/** One keydown listener for every global key. Views that handle a key first call preventDefault. */
export function installKeys(app) {
  const byKey = new Map();
  for (const entry of KEYMAP) if (entry.when === 'global') for (const k of entry.keys) byKey.set(k, entry);
  const onKey = (e) => {
    if (e.defaultPrevented) return;
    const entry = byKey.get(keyId(e));
    // Holding e or E walks through failures; other keys act once per press.
    if (!entry || (e.repeat && entry.id !== 'next-failure' && entry.id !== 'prev-failure')) return;
    if (!entry.typing && (isTyping(e) || document.querySelector('dialog[open]'))) return;
    e.preventDefault();
    Promise.resolve()
      .then(() => ACTIONS[entry.id](app))
      .catch((err) => app.toast(err?.message ?? String(err), 'error'));
  };
  document.addEventListener('keydown', onKey);
  return () => document.removeEventListener('keydown', onKey);
}
