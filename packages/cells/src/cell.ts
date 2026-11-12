import { EMPTY_LIST, LRU, type CellEnv, type CellRenderer, type DisplayList } from '@falcon-grid/core';
import { Compiler, textOf } from './compile';
import type { Child } from './nodes';

export interface CellOptions<T> {
  /** Text for copying (default: the tree's text, labels and custom text). */
  text?: (value: T) => string;
  /** Values whose layouts are kept (default 2000). */
  cacheSize?: number;
}

interface Slot {
  width: number;
  list: DisplayList;
  /** A second width, for a renderer shared by columns of different widths. */
  width2: number;
  list2: DisplayList | null;
}

/**
 * Makes a column's cell renderer from a function that describes a cell as primitives:
 *
 * ```ts
 * const userCell = cell<User>((user) =>
 *   row({ gap: 8 }, [avatar({ name: user.name, src: user.avatarUrl }), text(user.name, { flex: 1 })]),
 * );
 * columns: [{ id: 'user', width: 200, cell: userCell }]
 * ```
 *
 * The function gets what `getCell` returns for the cell; null and undefined draw nothing. It must
 * depend only on that value: compiled layouts are cached by value identity and width. If a value
 * changes in place, `invalidateCell` drops its cached layout.
 */
export function cell<T>(build: (value: T) => Child, options: CellOptions<T> = {}): CellRenderer {
  const cache = new LRU<unknown, Slot>(options.cacheSize ?? 2000);
  const compiler = new Compiler();
  let env: CellEnv | null = null;
  let epoch = -1;

  const compile = (value: unknown, width: number, e: CellEnv): DisplayList => {
    const node = build(value as T);
    return node ? compiler.compile(node, width, e) : EMPTY_LIST;
  };

  return {
    layout(value, width, e) {
      if (e !== env || e.epoch !== epoch) {
        cache.clear();
        env = e;
        epoch = e.epoch;
      }
      const s = cache.get(value);
      if (s) {
        if (s.width === width) return s.list;
        if (s.width2 === width && s.list2) return s.list2;
        const list = compile(value, width, e);
        s.width2 = s.width;
        s.list2 = s.list;
        s.width = width;
        s.list = list;
        return list;
      }
      const list = compile(value, width, e);
      cache.set(value, { width, list, width2: -1, list2: null });
      return list;
    },
    text(value) {
      return options.text ? options.text(value as T) : textOf(build(value as T));
    },
    forget(value) {
      cache.delete(value);
    },
  };
}
