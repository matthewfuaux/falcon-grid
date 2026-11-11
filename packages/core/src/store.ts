export type Listener<T> = (next: T, prev: T) => void;

export interface Store<T extends object> {
  getSnapshot(): T;
  /** Shallow-merges the patch. Listeners run only if at least one value changed (Object.is). */
  setState(patch: Partial<T> | ((state: T) => Partial<T>)): void;
  subscribe(listener: Listener<T>): () => void;
}

export function createStore<T extends object>(initial: T): Store<T> {
  let state = initial;
  const listeners = new Set<Listener<T>>();

  return {
    getSnapshot: () => state,
    setState(patch) {
      const p = typeof patch === 'function' ? patch(state) : patch;
      let changed = false;
      for (const key in p) {
        if (!Object.is(p[key], state[key])) {
          changed = true;
          break;
        }
      }
      if (!changed) return;
      const prev = state;
      state = { ...state, ...p };
      for (const l of listeners) l(state, prev);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
