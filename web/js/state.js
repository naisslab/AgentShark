// The viewer store (WEB-CONTRACT "State keys") plus localStorage-backed preferences.

/**
 * Minimal keyed store. set(patch) notifies subscribers whose keys changed (by identity),
 * synchronously and once per set() call.
 */
export function createStore(initial = {}) {
  const state = { ...initial };
  const subs = new Set();
  return {
    get(key) {
      return state[key];
    },
    set(patch) {
      const changed = [];
      for (const [k, v] of Object.entries(patch)) {
        if (!Object.is(state[k], v)) {
          state[k] = v;
          changed.push(k);
        }
      }
      if (!changed.length) return;
      for (const sub of [...subs]) {
        if (subs.has(sub) && changed.some((k) => sub.keys.has(k))) {
          try {
            sub.fn(state, changed);
          } catch (err) {
            console.error('state subscriber failed', err);
          }
        }
      }
    },
    /** fn(state, changedKeys) runs after any of `keys` changes. Returns an unsubscribe function. */
    subscribe(keys, fn) {
      const sub = { keys: new Set(keys), fn };
      subs.add(sub);
      return () => subs.delete(sub);
    },
  };
}

const PREFIX = 'agentshark.';

/** Read a JSON preference; storage can be unavailable (private mode, blocked site data). */
export function loadPref(name, fallback) {
  try {
    const raw = localStorage.getItem(PREFIX + name);
    return raw == null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function savePref(name, value) {
  try {
    localStorage.setItem(PREFIX + name, JSON.stringify(value));
  } catch {
    // Preferences are a convenience; the viewer works without them.
  }
}
