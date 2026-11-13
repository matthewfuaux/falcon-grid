import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { GridColumn } from './columns';
import { columnIndex, useGridContext, useIsoLayoutEffect, type ColumnKey, type HandleImpl } from './handle';

export interface CellOverlayProps {
  row: number;
  col: ColumnKey;
  children?: ReactNode;
  /**
   * Clip to the cell's visible part, so it slides under the header and frozen panes like the
   * cell does (default true). Turn off for content that extends past the cell, like a menu.
   */
  clip?: boolean;
  className?: string;
  style?: CSSProperties;
}

/**
 * DOM content positioned over a cell: editors, menus, tooltips. Render it inside `<Grid>`. It
 * follows the cell as the grid scrolls and resizes by writing styles directly, so scrolling
 * never re-renders it.
 */
export function CellOverlay({ row, col, children, clip = true, className, style }: CellOverlayProps) {
  const { handle, layer } = useGridContext();
  const ref = useRef<HTMLDivElement>(null);

  useIsoLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const place = () => placeOverCell(el, handle, row, col, clip);
    place();
    return handle.subscribe(place);
  }, [handle, layer, row, col, clip]);

  if (!layer) return null;
  return createPortal(
    <div
      ref={ref}
      className={className}
      data-falcon-overlay=""
      style={{ position: 'absolute', left: 0, top: 0, boxSizing: 'border-box', pointerEvents: 'auto', visibility: 'hidden', ...style }}
    >
      {children}
    </div>,
    layer,
  );
}

function placeOverCell(el: HTMLElement, handle: HandleImpl, row: number, col: ColumnKey, clip: boolean): void {
  const g = handle.grid;
  const c = g ? columnIndex(g, col) : -1;
  const b = g && c >= 0 ? g.getCellBounds(row, c) : null;
  if (!g || !b) {
    el.style.visibility = 'hidden';
    return;
  }
  const s = g.getState();
  const body = g.getBodyRect();
  const frozenRow = row < s.frozenRows;
  const frozenCol = c < s.frozenColumns;
  // Visible part of the cell: scrolling cells disappear under the header and frozen panes.
  const minX = frozenCol ? 0 : body.x;
  const minY = frozenRow ? s.theme.headerHeight : body.y;
  const left = Math.max(0, minX - b.x);
  const top = Math.max(0, minY - b.y);
  const right = Math.max(0, b.x + b.width - (body.x + body.width));
  const bottom = Math.max(0, b.y + b.height - (body.y + body.height));
  const hidden = left >= b.width || top >= b.height || right >= b.width || bottom >= b.height;
  el.style.visibility = hidden ? 'hidden' : 'visible';
  el.style.transform = `translate(${b.x}px, ${b.y}px)`;
  el.style.width = `${b.width}px`;
  el.style.height = `${b.height}px`;
  el.style.clipPath = clip && (left || top || right || bottom) ? `inset(${top}px ${right}px ${bottom}px ${left}px)` : '';
}

/** Where focus goes after a commit: the next cell in that direction, or nowhere. */
export type EditMove = 'up' | 'down' | 'left' | 'right' | null;

export interface EditorProps<TRow> {
  rowIndex: number;
  row: TRow;
  column: GridColumn<TRow>;
  /** Text to start with: the cell's text, or the key that started editing. */
  initialValue: string;
  /** True when editing started by typing: keep the caret at the end instead of selecting all. */
  typed: boolean;
  commit(value: string, move?: EditMove): void;
  cancel(): void;
}

/**
 * The reference editor: a text input over the cell. Enter commits and moves down (Shift: up),
 * Tab commits and moves right (Shift: left), Escape cancels, and leaving the input commits.
 */
export function TextEditor<TRow>({ initialValue, typed, commit, cancel }: EditorProps<TRow>) {
  const [value, setValue] = useState(initialValue);
  const done = useRef(false);
  const { handle } = useGridContext();
  const theme = handle.getState().theme;
  const input = useRef<HTMLInputElement>(null);

  // Not `autoFocus`: that runs before the overlay is placed, while it is still hidden.
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    el.focus({ preventScroll: true });
    if (typed) el.setSelectionRange(el.value.length, el.value.length);
    else el.select();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const finish = (fn: () => void) => {
    if (done.current) return;
    done.current = true;
    fn();
  };

  return (
    <input
      ref={input}
      value={value}
      aria-label="Edit cell"
      onChange={(e) => setValue(e.currentTarget.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          finish(() => commit(value, e.shiftKey ? 'up' : 'down'));
        } else if (e.key === 'Tab') {
          e.preventDefault();
          finish(() => commit(value, e.shiftKey ? 'left' : 'right'));
        } else if (e.key === 'Escape') {
          e.preventDefault();
          finish(cancel);
        }
      }}
      onBlur={() => finish(() => commit(value, null))}
      style={{
        width: '100%',
        height: '100%',
        boxSizing: 'border-box',
        margin: 0,
        padding: `0 ${theme.cellPaddingX - 2}px`,
        border: `2px solid ${theme.focusRing}`,
        borderRadius: 0,
        outline: 'none',
        font: `${theme.fontWeight} ${theme.fontSize}px ${theme.fontFamily}`,
        color: theme.foreground,
        background: theme.background,
      }}
    />
  );
}
