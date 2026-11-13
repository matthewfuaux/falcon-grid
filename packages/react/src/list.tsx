import { defaultTheme, type CellRenderer, type FrameInfo, type TextWrapper, type Theme } from '@falcon-grid/core';
import { createList, type List as CoreList, type ListItemEvent, type ListOptions } from '@falcon-grid/list';
import {
  forwardRef,
  useImperativeHandle,
  useRef,
  useState,
  type CSSProperties,
  type ForwardedRef,
  type ReactElement,
  type Ref,
} from 'react';
import { useIsoLayoutEffect } from './handle';

export interface ListProps<T> {
  itemCount: number;
  /**
   * The item at an index, called only for items on screen. A new function repaints and
   * re-measures the items on screen, so wrap it in `useCallback` over your items.
   */
  getItem: (index: number) => T | undefined;
  /** How an item is drawn: a renderer from `cell()`. Without one, items are drawn as text. */
  item?: CellRenderer<T>;
  /**
   * A stable key per item. With it, items added at the start (older messages loaded above) are
   * recognised as a prepend and the content on screen stays still.
   */
  itemKey?: (index: number) => string | number;
  /** 'auto' (default): each item is as tall as its content. A number: every item that tall. */
  itemHeight?: 'auto' | number;
  /** Wrapping engine for wrapped text, e.g. `createPretextWrapper()` from `@falcon-grid/text`. */
  textWrapper?: TextWrapper;
  /** Follow the bottom while scrolled to it (chat, logs). Starts at the bottom. */
  stickToBottom?: boolean;
  /** Sticky group headers: the index of the header item of `index`'s group, or -1. */
  groupOf?: (index: number) => number;
  /** Select and copy text with the pointer (default true). Fixed at mount. */
  textSelection?: boolean;
  /** Lines between items (default false). */
  dividers?: boolean;
  /** Merged over the default theme. Compared shallowly, so an inline object is fine. */
  theme?: Partial<Theme>;
  onItemClick?: (e: ListItemEvent<T>) => void;
  onItemDoubleClick?: (e: ListItemEvent<T>) => void;
  onItemContextMenu?: (e: ListItemEvent<T>) => void;
  onTextSelectionChange?: (selected: boolean) => void;
  /** Scrolled; `atBottom` says whether the view is at the end. */
  onScroll?: (e: { top: number; atBottom: boolean }) => void;
  onFrame?: (info: Readonly<FrameInfo>) => void;
  'aria-label'?: string;
  'aria-labelledby'?: string;
  respectUserPreferences?: boolean;
  scaleWithRootFont?: boolean;
  /** Size of the list (default 100% of its parent). Also the size of the server placeholder. */
  width?: number | string;
  height?: number | string;
  className?: string;
  style?: CSSProperties;
}

/** Imperative access to a mounted `<List>`. Calls before mount or after unmount do nothing. */
export interface ListHandle {
  /** The core list, or null while not mounted. */
  readonly list: CoreList<unknown> | null;
  scrollToItem(index: number, align?: 'start' | 'nearest'): void;
  scrollToBottom(): void;
  isAtBottom(): boolean;
  /** `count` items were inserted before `index` (when you don't pass `itemKey`). */
  insertItems(index: number, count: number): void;
  /** Repaint and re-measure items [start, end) after they changed in place. */
  invalidateItems(start: number, end: number): void;
  invalidate(): void;
  /** The selected text, as Ctrl+C copies it. */
  getSelectedText(): string;
  clearTextSelection(): void;
  focus(): void;
}

const shallowEqual = (a: object | undefined, b: object | undefined) => {
  if (a === b) return true;
  if (!a || !b) return false;
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => Object.is((a as never)[k], (b as never)[k]));
};

type Options<T> = Omit<ListOptions<T>, 'frameSource'>;

function ListImpl<T>(props: ListProps<T>, ref: ForwardedRef<ListHandle>): ReactElement {
  const propsRef = useRef(props);
  propsRef.current = props;
  const hostRef = useRef<HTMLDivElement>(null);
  const self = useState(() => ({
    list: null as CoreList<T> | null,
    pushed: null as Options<T> | null,
    count: 0,
    firstKey: undefined as string | number | undefined,
    theme: undefined as Partial<Theme> | undefined,
  }))[0];

  useImperativeHandle(
    ref,
    (): ListHandle => ({
      get list() {
        return self.list as CoreList<unknown> | null;
      },
      scrollToItem: (i, a) => self.list?.scrollToItem(i, a),
      scrollToBottom: () => self.list?.scrollToBottom(),
      isAtBottom: () => self.list?.isAtBottom() ?? false,
      insertItems(index, count) {
        const l = self.list;
        if (!l) return;
        l.insertItems(index, count);
        self.count += count;
        if (self.pushed) self.pushed.itemCount = self.count;
      },
      invalidateItems: (s, e) => self.list?.invalidateItems(s, e),
      invalidate: () => self.list?.invalidate(),
      getSelectedText: () => self.list?.textSelection?.text() ?? '',
      clearTextSelection: () => self.list?.textSelection?.clear(),
      focus: () => self.list?.focus(),
    }),
    [self],
  );

  /** Props as list options; callbacks go through the latest props. */
  const resolve = (): Options<T> => {
    const p = propsRef.current;
    if (!shallowEqual(p.theme, self.theme)) self.theme = p.theme;
    const o: Options<T> = {
      itemCount: p.itemCount,
      getItem: p.getItem,
      onItemClick: (e) => propsRef.current.onItemClick?.(e),
      onItemDoubleClick: (e) => propsRef.current.onItemDoubleClick?.(e),
      onItemContextMenu: (e) => propsRef.current.onItemContextMenu?.(e),
      onTextSelectionChange: (v) => propsRef.current.onTextSelectionChange?.(v),
    };
    if (p.item) o.item = p.item;
    if (p.itemHeight !== undefined) o.itemHeight = p.itemHeight;
    if (p.textWrapper) o.textWrapper = p.textWrapper;
    if (p.stickToBottom !== undefined) o.stickToBottom = p.stickToBottom;
    if (p.groupOf) o.groupOf = p.groupOf;
    if (p.textSelection !== undefined) o.textSelection = p.textSelection;
    if (p.dividers !== undefined) o.dividers = p.dividers;
    if (self.theme) o.theme = self.theme;
    if (p.onFrame) o.onFrame = p.onFrame;
    if (p['aria-label']) o.ariaLabel = p['aria-label'];
    if (p['aria-labelledby']) o.ariaLabelledBy = p['aria-labelledby'];
    if (p.respectUserPreferences !== undefined) o.respectUserPreferences = p.respectUserPreferences;
    if (p.scaleWithRootFont !== undefined) o.scaleWithRootFont = p.scaleWithRootFont;
    return o;
  };

  const rememberFirst = () => {
    const p = propsRef.current;
    self.count = p.itemCount;
    self.firstKey = p.itemKey && p.itemCount > 0 ? p.itemKey(0) : undefined;
  };

  useIsoLayoutEffect(() => {
    const o = resolve();
    const list = createList<T>(hostRef.current!, o);
    self.list = list;
    self.pushed = o;
    rememberFirst();
    const el = list.element;
    const onScroll = () => propsRef.current.onScroll?.({ top: list.grid.getState().scrollTop, atBottom: list.isAtBottom() });
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      el.removeEventListener('scroll', onScroll);
      list.destroy();
      self.list = null;
      self.pushed = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Push changed props after every render; unchanged ones cost a comparison each.
  useIsoLayoutEffect(() => {
    const list = self.list;
    const last = self.pushed;
    if (!list || !last) return;
    const p = propsRef.current;
    const next = resolve();
    // Items added at the start: the old first item now sits `added` places down.
    const added = p.itemCount - self.count;
    if (added > 0 && p.itemKey && self.firstKey !== undefined && p.itemKey(added) === self.firstKey) {
      list.insertItems(0, added);
      last.itemCount = p.itemCount;
    }
    const patch: Partial<Record<keyof Options<T>, unknown>> = {};
    const keys = [
      'itemCount', 'getItem', 'item', 'itemHeight', 'textWrapper', 'stickToBottom', 'groupOf', 'dividers', 'theme',
      'onFrame', 'ariaLabel', 'ariaLabelledBy', 'respectUserPreferences', 'scaleWithRootFont',
    ] as const;
    for (const k of keys) if (next[k] !== last[k]) patch[k] = next[k];
    if (Object.keys(patch).length > 0) list.update(patch as Partial<Options<T>>);
    self.pushed = { ...next, itemCount: p.itemCount };
    rememberFirst();
  });

  const { width = '100%', height = '100%', className, style } = props;
  const background = props.theme?.background ?? defaultTheme.background;
  return (
    <div className={className} data-falcon-list-root="" style={{ position: 'relative', overflow: 'hidden', width, height, background, ...style }}>
      <div ref={hostRef} style={{ position: 'absolute', inset: 0 }} />
    </div>
  );
}

/**
 * A canvas list: items of any height (declarative cells or text), measured only as they come
 * into view, with stick to bottom, sticky group headers and text selection.
 *
 * ```tsx
 * <List itemCount={messages.length} getItem={(i) => messages[i]} item={messageCell} stickToBottom />
 * ```
 */
export const List = forwardRef(ListImpl) as <T>(props: ListProps<T> & { ref?: Ref<ListHandle> }) => ReactElement;
