import { ELLIPSIS, TextMeasurer, defaultTheme, resolveTheme, type CellEnv, type TextOp, type TextWrapper } from '@falcon-grid/core';
import { describe, expect, it, vi } from 'vitest';
import {
  avatar,
  badge,
  booleanColumn,
  button,
  cell,
  checkbox,
  custom,
  dateColumn,
  icon,
  link,
  numberColumn,
  progress,
  row,
  spacer,
  stack,
  tagsColumn,
  text,
  textColumn,
  textOf,
  userColumn,
} from '../src';

/** 7px per character in every font; wraps every 10 characters. */
const wrapper: TextWrapper = {
  lineCount: (t) => Math.max(1, Math.ceil(t.length / 10)),
  lines: (t) => t.match(/.{1,10}/g) ?? [''],
  clear: () => {},
};
const makeEnv = (): CellEnv => ({
  theme: resolveTheme(defaultTheme),
  text: new TextMeasurer((t) => [...t].length * 7),
  wrapper,
  epoch: 0,
});

const compile = (node: Parameters<typeof cell>[0] extends (v: never) => infer R ? R : never, width = 200, env = makeEnv()) =>
  cell(() => node).layout(1, width, env);

const texts = (ops: readonly { k: string }[]) => ops.filter((o): o is TextOp => o.k === 'text').map((o) => [o.text, o.x, o.y]);

describe('layout', () => {
  it('a lone text fills the cell and truncates with an ellipsis', () => {
    const list = compile(text('abcdefghijklmnop'), 70); // 16 chars = 112px, 70px available
    expect(list.ops).toHaveLength(1);
    const op = list.ops[0] as TextOp;
    expect(op.text.endsWith(ELLIPSIS)).toBe(true);
    expect(op.w).toBeLessThanOrEqual(70);
    expect(list.height).toBe(18);
    expect(list.width).toBe(112); // natural width, for auto-fit
  });

  it('right-aligns text within the space it gets', () => {
    const list = compile(text('abc', { align: 'right' }), 100);
    expect(texts(list.ops)).toEqual([['abc', 79, 0]]);
  });

  it('places fixed, natural and flex items with gaps, centred on the cross axis', () => {
    const onClick = () => {};
    const list = compile(
      row({ gap: 8 }, [avatar({ name: 'Ada Lovelace' }), text('Ada', { flex: 1 }), badge('Admin'), button({ icon: 'more', onClick })]),
      300,
    );
    // avatar 20 | 8 | text flex | 8 | badge 5*7+12=47 | 8 | button 24 => text gets 300-20-47-24-24 = 185
    const [circle, initials, name, badgeBg, badgeText, btnBg, btnIcon] = list.ops;
    expect(circle).toMatchObject({ k: 'rect', x: 0, y: 2, w: 20, h: 20 });
    expect(initials).toMatchObject({ k: 'text', text: 'AL' });
    expect(name).toMatchObject({ k: 'text', text: 'Ada', x: 28, y: 3 });
    expect(badgeBg).toMatchObject({ k: 'rect', x: 28 + 185 + 8, w: 47, h: 18, y: 3, alpha: 0.14 });
    expect(badgeText).toMatchObject({ k: 'text', text: 'Admin' });
    expect(btnBg).toMatchObject({ k: 'rect', x: 276, y: 0, w: 24, h: 24, alpha: 0, region: 0, hover: { alpha: 0.08 } });
    expect(btnIcon).toMatchObject({ k: 'path', x: 280, y: 4, region: 0 });
    expect(list.height).toBe(24);
    expect(list.regions).toEqual([{ x: 276, y: 0, w: 24, h: 24, onClick }]);
  });

  it('justifies leftover space', () => {
    const at = (justify: 'start' | 'center' | 'end' | 'between') =>
      compile(row({ justify, gap: 10 }, [text('aa'), text('bb')]), 100).ops.map((o) => o.x);
    expect(at('start')).toEqual([0, 24]);
    expect(at('end')).toEqual([62, 86]);
    expect(at('center')).toEqual([31, 55]);
    expect(at('between')).toEqual([0, 86]);
  });

  it('spacers take leftover space, or a fixed size', () => {
    expect(compile(row([text('a'), spacer(), text('b')]), 100).ops.map((o) => o.x)).toEqual([0, 93]);
    expect(compile(row([text('a'), spacer(10), text('b')]), 100).ops.map((o) => o.x)).toEqual([0, 17]);
  });

  it('shrinks truncatable items in proportion when a row overflows', () => {
    // 20 + 10 chars = 140 + 70 = 210 natural; 105 available; each loses half.
    const list = compile(row([text('a'.repeat(20)), text('b'.repeat(10))]), 105);
    const [a, b] = list.ops as TextOp[];
    expect(a!.text.endsWith(ELLIPSIS)).toBe(true);
    expect(b!.x).toBeCloseTo(70);
    expect(a!.w).toBeLessThanOrEqual(70);
  });

  it("drops what does not fit with overflow 'hide'", () => {
    const list = compile(row({ gap: 4, overflow: 'hide' }, [badge('one'), badge('two'), badge('three')]), 70);
    // badges are 33, 33, 47 wide: two fit in 70
    expect(texts(list.ops).map((t) => t[0])).toEqual(['one', 'two']);
  });

  it('stacks children and wraps text to a line limit', () => {
    const list = compile(stack({ gap: 2 }, [text('title'), text('x'.repeat(35), { wrap: true, maxLines: 3, color: 'muted' })]), 200);
    // 35 chars wrap into 4 lines of 10; the limit is 3 and the last line ends with an ellipsis.
    expect(list.height).toBe(18 + 2 + 3 * 18);
    const lines = texts(list.ops);
    expect(lines.map((l) => l[2])).toEqual([0, 20, 38, 56]);
    expect(String(lines[3]![0]).endsWith(ELLIPSIS)).toBe(true);
    expect((list.ops[1] as TextOp).color).toBe(defaultTheme.mutedForeground);
  });

  it('wrapped text reports its height for the row height model', () => {
    expect(compile(text('x'.repeat(25), { wrap: true }), 200).height).toBe(3 * 18);
    expect(compile(row([avatar({ name: 'A', size: 28 }), text('x')]), 200).height).toBe(28);
  });

  it('creates hit regions for clickable and tooltipped primitives', () => {
    const onClick = vi.fn();
    const list = compile(row({ gap: 4 }, [text('hi', { tooltip: 'hello' }), button({ icon: 'edit', onClick, tooltip: 'Edit' })]), 100);
    expect(list.regions).toHaveLength(2);
    expect(list.regions[0]).toMatchObject({ x: 0, w: 14, tooltip: 'hello' });
    expect(list.regions[1]).toMatchObject({ x: 18, y: 0, w: 24, h: 24, tooltip: 'Edit' });
    expect(list.regions[1]!.onClick).toBe(onClick);
    expect(list.ops.filter((o) => o.region === 1).map((o) => o.k)).toEqual(['rect', 'path']);
  });

  it('links click through to their href', () => {
    const open = vi.fn();
    vi.stubGlobal('open', open);
    const list = compile(link('docs', { href: 'https://example.com' }), 100);
    expect(list.regions[0]).toMatchObject({ x: 0, w: 28 });
    expect(list.ops[0]).toMatchObject({ k: 'text', color: defaultTheme.accent, hover: { underline: true } });
    list.regions[0]!.onClick!({} as never);
    expect(open).toHaveBeenCalledWith('https://example.com', '_blank', 'noopener,noreferrer');
    vi.unstubAllGlobals();
  });

  it('draws progress, checkboxes, icons and custom content', () => {
    expect(compile(progress(0.5, { width: 100 }), 200).ops).toMatchObject([
      { k: 'rect', w: 100, h: 6, color: defaultTheme.mutedForeground },
      { k: 'rect', w: 50, h: 6, color: defaultTheme.accent },
    ]);
    expect(compile(checkbox(true), 100).ops.map((o) => o.k)).toEqual(['rect', 'path']);
    expect(compile(checkbox(false), 100).ops).toMatchObject([{ k: 'rect', line: 1 }]);
    expect(compile(icon('star', { color: 'warning' }), 100).ops).toMatchObject([{ k: 'path', color: defaultTheme.warning }]);
    const draw = vi.fn();
    expect(compile(row([custom({ height: 10, draw })]), 50).ops).toMatchObject([{ k: 'custom', x: 0, w: 50, h: 10, draw }]);
  });

  it('builds the text used for copying', () => {
    expect(textOf(row([avatar({ name: 'Ada' }), text('Ada'), badge('Admin'), link('site'), button({ icon: 'more' })]))).toBe(
      'Ada Admin site',
    );
  });
});

describe('cell()', () => {
  it('caches layouts by value identity and width', () => {
    const build = vi.fn((v: { name: string }) => text(v.name));
    const r = cell(build);
    const env = makeEnv();
    const a = { name: 'a' };
    const first = r.layout(a, 100, env);
    expect(r.layout(a, 100, env)).toBe(first);
    expect(build).toHaveBeenCalledTimes(1);
    expect(r.layout({ name: 'a' }, 100, env)).not.toBe(first); // another object
    const narrow = r.layout(a, 50, env);
    expect(narrow).not.toBe(first);
    expect(r.layout(a, 100, env)).toBe(first); // two widths are kept
    expect(build).toHaveBeenCalledTimes(3);
  });

  it('recompiles after the epoch changes or the value is forgotten', () => {
    const build = vi.fn((v: string) => text(v));
    const r = cell(build);
    const env = makeEnv();
    const first = r.layout('x', 100, env);
    env.epoch++;
    expect(r.layout('x', 100, env)).not.toBe(first);
    const second = r.layout('x', 100, env);
    r.forget!('x');
    expect(r.layout('x', 100, env)).not.toBe(second);
  });

  it('draws nothing for an empty build', () => {
    expect(cell(() => null).layout(1, 100, makeEnv()).ops).toHaveLength(0);
  });
});

describe('built-in column types', () => {
  const env = makeEnv();
  const show = (col: ReturnType<typeof textColumn>, v: unknown, width = 200) =>
    texts(col.cell!.layout(v, width, env).ops).map((t) => t[0]);

  it('formats numbers, right-aligned, accepting strings', () => {
    const col = numberColumn({ id: 'n', format: { style: 'currency', currency: 'USD' }, locale: 'en-US' });
    expect(col.align).toBe('right');
    expect(show(col, 1234.5)).toEqual(['$1,234.50']);
    expect(show(col, '$99.10')).toEqual(['$99.10']);
    expect(show(col, 'n/a')).toEqual(['n/a']);
    expect(col.cell!.text(1234.5)).toBe('$1,234.50');
    const op = col.cell!.layout(5, 100, env).ops[0]!;
    expect(op.x + op.w).toBeCloseTo(100);
  });

  it('formats dates from strings, numbers and Dates', () => {
    const col = dateColumn({ id: 'd', locale: 'en-US' });
    expect(show(col, '2024-03-05')).toEqual(['Mar 5, 2024']);
    expect(show(col, new Date(Date.UTC(2020, 0, 1)))).toEqual(['Jan 1, 2020']);
    expect(show(col, 'soon')).toEqual(['soon']);
  });

  it('booleans are checkboxes that report the toggled value', () => {
    const onChange = vi.fn();
    const col = booleanColumn({ id: 'b', onChange });
    const list = col.cell!.layout(true, 90, env);
    expect(list.ops.map((o) => o.k)).toEqual(['rect', 'path']);
    expect(list.ops[0]!.x).toBe(37); // centred
    list.regions[0]!.onClick!({ row: 1 } as never);
    expect(onChange).toHaveBeenCalledWith(false, { row: 1 });
    expect(col.cell!.text(false)).toBe('false');
  });

  it('tags become badges with tones', () => {
    const col = tagsColumn({ id: 't', tone: (t) => (t === 'urgent' ? 'danger' : 'muted') });
    const list = col.cell!.layout(['urgent', 'ui'], 200, env);
    expect(list.ops.filter((o) => o.k === 'rect').map((o) => (o as { color: string }).color)).toEqual([
      defaultTheme.danger,
      defaultTheme.mutedForeground,
    ]);
    expect(show(col, 'a, b')).toEqual(['a', 'b']);
    expect(col.cell!.text(['a', 'b'])).toBe('a, b');
  });

  it('users show an avatar and a name, with an optional detail line', () => {
    const col = userColumn({ id: 'u' });
    expect(show(col, 'Grace Hopper')).toEqual(['GH', 'Grace Hopper']);
    const two = col.cell!.layout({ name: 'Grace', detail: 'Admiral', avatarUrl: 'g.png' }, 200, env);
    expect(texts(two.ops).map((t) => t[0])).toEqual(['G', 'Grace', 'Admiral']);
    expect(two.ops.some((o) => o.k === 'image')).toBe(true);
    expect(two.height).toBeGreaterThan(18);
    expect(col.cell!.text({ name: 'Grace' })).toBe('Grace');
  });

  it('text columns truncate or wrap', () => {
    expect(String(show(textColumn({ id: 'x' }), 'a'.repeat(40), 100)[0]).endsWith(ELLIPSIS)).toBe(true);
    expect(textColumn({ id: 'x', wrap: true }).cell!.layout('a'.repeat(25), 100, env).height).toBe(54);
  });
});
