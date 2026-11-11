import { expect, test, type Page } from '@playwright/test';

/**
 * Phase 3 exit criteria: hover and selection repaint the overlay only, and every keyboard
 * path is covered. Plus pointer selection, column resize and reorder, and copy.
 */

test.use({ viewport: { width: 1000, height: 640 } });

async function open(page: Page, params = '') {
  await page.goto(`/?${params}`);
  await page.waitForFunction(() => window.ready && window.paintLog.length > 0);
  await page.evaluate(() => window.grid.flush());
}

/** Page coordinates of a point inside a cell (fractions of its width and height). */
async function cellPoint(page: Page, row: number, col: number, fx = 0.5, fy = 0.5) {
  return page.evaluate(
    ([row, col, fx, fy]) => {
      const b = window.grid.getCellBounds(row!, col!)!;
      const r = window.grid.element.getBoundingClientRect();
      return { x: r.left + b.x + b.width * fx!, y: r.top + b.y + b.height * fy! };
    },
    [row, col, fx, fy],
  );
}

/** Page coordinates of a column's right edge in the header. */
async function headerEdge(page: Page, col: number) {
  return page.evaluate((col) => {
    const b = window.grid.getCellBounds(0, col)!;
    const r = window.grid.element.getBoundingClientRect();
    return { x: r.left + b.x + b.width, y: r.top + 18 };
  }, col);
}

async function clickCell(page: Page, row: number, col: number, modifiers: ('Shift' | 'Control')[] = []) {
  const p = await cellPoint(page, row, col);
  await clickWith(page, p, modifiers);
}

/** mouse.click has no modifiers option: hold the keys around the click. */
async function clickWith(page: Page, p: { x: number; y: number }, modifiers: ('Shift' | 'Control')[]) {
  for (const m of modifiers) await page.keyboard.down(m);
  await page.mouse.click(p.x, p.y);
  for (const m of modifiers) await page.keyboard.up(m);
}

const state = (page: Page) =>
  page.evaluate(() => {
    const s = window.grid.store.getSnapshot();
    return { selection: s.selection, active: s.activeCell, scrollLeft: s.scrollLeft, scrollTop: s.scrollTop, focused: s.focused };
  });

const range = (top: number, left: number, bottom = top, right = left) => ({ top, left, bottom, right });

/** Whether a cell is fully inside the scrolling body (not hidden under the header). */
const fullyVisible = (page: Page, row: number, col: number) =>
  page.evaluate(
    ([row, col]) => {
      const b = window.grid.getCellBounds(row!, col!)!;
      const s = window.grid.store.getSnapshot();
      return b.x >= 0 && b.y >= s.theme.headerHeight && b.x + b.width <= s.viewportWidth + 0.5 && b.y + b.height <= s.viewportHeight + 0.5;
    },
    [row, col],
  );

test.describe('overlay-only repaints', () => {
  test('hover and selection never repaint the base layer', async ({ page }) => {
    await open(page);
    const p = await cellPoint(page, 3, 2);
    await page.mouse.move(p.x, p.y);
    await page.evaluate(() => window.grid.flush());
    const before = await page.evaluate(() => window.paintLog.length);
    for (let i = 0; i < 6; i++) {
      const q = await cellPoint(page, 2 + i, 1 + (i % 3));
      await page.mouse.move(q.x, q.y);
      await page.evaluate(() => window.grid.flush());
    }
    await clickCell(page, 4, 2);
    await clickCell(page, 6, 3, ['Shift']);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Shift+ArrowRight');
    await page.evaluate(() => window.grid.flush());
    const frames = await page.evaluate((n) => window.paintLog.slice(n), before);
    expect(frames.length).toBeGreaterThan(5);
    for (const f of frames) {
      expect(f.paint).toBe('none');
      expect(f.overlay).toBe(true);
    }
  });
});

test.describe('pointer selection', () => {
  test('click selects a cell, focuses the grid and fires events', async ({ page }) => {
    await open(page);
    await clickCell(page, 2, 3);
    expect(await state(page)).toMatchObject({ selection: [range(2, 3)], active: { row: 2, col: 3 }, focused: true });
    const events = await page.evaluate(() => window.events.map((e) => e[0]));
    expect(events).toEqual(['selectionChange', 'cellClick']);
    expect(await page.evaluate(() => window.events[1]![1])).toMatchObject({ row: 2, col: 3, column: 'c3' });
  });

  test('shift-click extends from the active cell; ctrl-click adds a range', async ({ page }) => {
    await open(page);
    await clickCell(page, 2, 1);
    await clickCell(page, 5, 3, ['Shift']);
    expect(await state(page)).toMatchObject({ selection: [range(2, 1, 5, 3)], active: { row: 2, col: 1 } });
    await clickCell(page, 8, 4, ['Control']);
    expect(await state(page)).toMatchObject({ selection: [range(2, 1, 5, 3), range(8, 4)], active: { row: 8, col: 4 } });
  });

  test('dragging selects a range', async ({ page }) => {
    await open(page);
    const a = await cellPoint(page, 1, 1);
    const b = await cellPoint(page, 4, 3);
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move(b.x, b.y, { steps: 6 });
    await page.mouse.up();
    expect(await state(page)).toMatchObject({ selection: [range(1, 1, 4, 3)], active: { row: 1, col: 1 } });
    // A drag is not a click.
    expect(await page.evaluate(() => window.events.some((e) => e[0] === 'cellClick'))).toBe(false);
  });

  test('clicking a header selects the column; shift-click extends columns', async ({ page }) => {
    await open(page);
    const h = await page.evaluate(() => {
      const b = window.grid.getCellBounds(0, 2)!;
      const r = window.grid.element.getBoundingClientRect();
      return { x: r.left + b.x + b.width / 2, y: r.top + 10 };
    });
    await page.mouse.click(h.x, h.y);
    const rows = await page.evaluate(() => window.grid.store.getSnapshot().rowCount);
    expect((await state(page)).selection).toEqual([range(0, 2, rows - 1, 2)]);
    expect(await page.evaluate(() => window.events.at(-1)![0])).toBe('headerClick');
    const h2 = await page.evaluate(() => {
      const b = window.grid.getCellBounds(0, 4)!;
      const r = window.grid.element.getBoundingClientRect();
      return { x: r.left + b.x + b.width / 2, y: r.top + 10 };
    });
    await clickWith(page, h2, ['Shift']);
    expect((await state(page)).selection).toEqual([range(0, 2, rows - 1, 4)]);
  });

  test('double-click fires onCellDoubleClick', async ({ page }) => {
    await open(page);
    const p = await cellPoint(page, 3, 1);
    await page.mouse.dblclick(p.x, p.y);
    expect(await page.evaluate(() => window.events.filter((e) => e[0] === 'cellDoubleClick').map((e) => e[1]))).toEqual([
      { row: 3, col: 1, column: 'c1' },
    ]);
  });
});

test.describe('keyboard', () => {
  test.beforeEach(async ({ page }) => {
    await open(page, 'cols=40&rows=1000');
    await clickCell(page, 10, 3);
  });

  const press = async (page: Page, key: string) => {
    await page.keyboard.press(key);
    return (await state(page)).active;
  };

  test('arrows move one cell', async ({ page }) => {
    expect(await press(page, 'ArrowDown')).toEqual({ row: 11, col: 3 });
    expect(await press(page, 'ArrowRight')).toEqual({ row: 11, col: 4 });
    expect(await press(page, 'ArrowUp')).toEqual({ row: 10, col: 4 });
    expect(await press(page, 'ArrowLeft')).toEqual({ row: 10, col: 3 });
    expect((await state(page)).selection).toEqual([range(10, 3)]);
  });

  test('ctrl+arrows jump to the edges and scroll there', async ({ page }) => {
    expect(await press(page, 'Control+ArrowDown')).toEqual({ row: 999, col: 3 });
    expect(await fullyVisible(page, 999, 3)).toBe(true);
    expect(await press(page, 'Control+ArrowRight')).toEqual({ row: 999, col: 39 });
    expect(await fullyVisible(page, 999, 39)).toBe(true);
    expect(await press(page, 'Control+ArrowUp')).toEqual({ row: 0, col: 39 });
    expect(await press(page, 'Control+ArrowLeft')).toEqual({ row: 0, col: 0 });
    expect(await state(page)).toMatchObject({ scrollLeft: 0, scrollTop: 0 });
  });

  test('Page Down and Page Up move by a screen and keep the cell visible', async ({ page }) => {
    const down = await press(page, 'PageDown');
    expect(down!.row).toBeGreaterThan(20);
    expect(await fullyVisible(page, down!.row, 3)).toBe(true);
    await press(page, 'PageDown');
    const third = await press(page, 'PageDown');
    expect(await fullyVisible(page, third!.row, 3)).toBe(true);
    expect((await press(page, 'PageUp'))!.row).toBeLessThan(third!.row);
  });

  test('Home and End go to the row ends; with ctrl, to the grid corners', async ({ page }) => {
    expect(await press(page, 'End')).toEqual({ row: 10, col: 39 });
    expect(await press(page, 'Home')).toEqual({ row: 10, col: 0 });
    expect(await press(page, 'Control+End')).toEqual({ row: 999, col: 39 });
    expect(await fullyVisible(page, 999, 39)).toBe(true);
    expect(await press(page, 'Control+Home')).toEqual({ row: 0, col: 0 });
  });

  test('shift extends the selection without moving the active cell', async ({ page }) => {
    await page.keyboard.press('Shift+ArrowDown');
    await page.keyboard.press('Shift+ArrowDown');
    await page.keyboard.press('Shift+ArrowRight');
    expect(await state(page)).toMatchObject({ selection: [range(10, 3, 12, 4)], active: { row: 10, col: 3 } });
    await page.keyboard.press('Shift+ArrowUp');
    expect((await state(page)).selection).toEqual([range(10, 3, 11, 4)]);
    await page.keyboard.press('Shift+Control+ArrowLeft');
    expect((await state(page)).selection).toEqual([range(10, 0, 11, 3)]);
    await page.keyboard.press('Shift+End');
    expect((await state(page)).selection).toEqual([range(10, 3, 11, 39)]);
    await page.keyboard.press('Shift+PageDown');
    expect((await state(page)).selection[0]!.bottom).toBeGreaterThan(20);
  });

  test('Tab and Shift+Tab move along rows and wrap', async ({ page }) => {
    expect(await press(page, 'Tab')).toEqual({ row: 10, col: 4 });
    expect(await press(page, 'Shift+Tab')).toEqual({ row: 10, col: 3 });
    await press(page, 'End');
    expect(await press(page, 'Tab')).toEqual({ row: 11, col: 0 });
    expect(await press(page, 'Shift+Tab')).toEqual({ row: 10, col: 39 });
  });

  test('Tab at the last cell leaves the grid', async ({ page }) => {
    await press(page, 'Control+End');
    await page.keyboard.press('Tab');
    expect(await state(page)).toMatchObject({ active: { row: 999, col: 39 }, focused: false });
  });

  test('Escape collapses the selection to the active cell', async ({ page }) => {
    await page.keyboard.press('Shift+ArrowDown');
    await page.keyboard.press('Escape');
    expect(await state(page)).toMatchObject({ selection: [range(10, 3)], active: { row: 10, col: 3 } });
  });

  test('Ctrl+A selects everything; Ctrl+Space and Shift+Space select columns and rows', async ({ page }) => {
    await page.keyboard.press('Control+a');
    expect((await state(page)).selection).toEqual([range(0, 0, 999, 39)]);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Control+Space');
    expect((await state(page)).selection).toEqual([range(0, 3, 999, 3)]);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Shift+Space');
    expect((await state(page)).selection).toEqual([range(10, 0, 10, 39)]);
    // Extending a whole-row selection adds whole rows.
    await page.keyboard.press('Shift+ArrowDown');
    expect((await state(page)).selection).toEqual([range(10, 0, 11, 39)]);
  });

  test('arrow keys scroll the active cell into view, past frozen panes', async ({ page }) => {
    await page.evaluate(() => window.grid.update({ frozenColumns: 1, frozenRows: 1 }));
    await clickCell(page, 5, 4);
    for (let i = 0; i < 12; i++) await page.keyboard.press('ArrowRight');
    expect(await fullyVisible(page, 5, 16)).toBe(true);
    for (let i = 0; i < 12; i++) await page.keyboard.press('ArrowLeft');
    // Back at column 4, which must be clear of the frozen column, not under it.
    const b = await page.evaluate(() => window.grid.getCellBounds(5, 4)!);
    const frozenWidth = await page.evaluate(() => window.grid.getCellBounds(5, 0)!.width);
    expect(b.x).toBeGreaterThanOrEqual(frozenWidth);
  });

  test('copy writes TSV and HTML to the clipboard', async ({ page }) => {
    await page.keyboard.press('Shift+ArrowDown');
    await page.keyboard.press('Shift+ArrowRight');
    const expected = await page.evaluate(() => {
      const d = window.data;
      return [10, 11].map((r) => [3, 4].map((c) => String(d.get(r, c) ?? '')).join('\t')).join('\n');
    });
    await page.evaluate(() => {
      document.addEventListener('copy', (e) => {
        (window as unknown as { copied: string[] }).copied = [e.clipboardData!.getData('text/plain'), e.clipboardData!.getData('text/html')];
      });
    });
    await page.keyboard.press('Control+c');
    const [text, html] = await page.evaluate(() => (window as unknown as { copied: string[] }).copied);
    expect(text).toBe(expected);
    expect(html).toMatch(/^<table><tr><td>/);
  });
});

test.describe('columns', () => {
  test('dragging a header edge resizes the column, clamped to minWidth', async ({ page }) => {
    await open(page);
    const before = await page.evaluate(() => window.grid.store.getSnapshot().columns[1]!.width);
    const e = await headerEdge(page, 1);
    await page.mouse.move(e.x, e.y);
    expect(await page.evaluate(() => window.grid.element.style.cursor)).toBe('col-resize');
    await page.mouse.down();
    await page.mouse.move(e.x + 40, e.y, { steps: 4 });
    await page.mouse.up();
    expect(await page.evaluate(() => window.grid.store.getSnapshot().columns[1]!.width)).toBe(before + 40);
    const resize = await page.evaluate(() => window.events.filter((e) => e[0] === 'columnResize').at(-1)![1]);
    expect(resize).toMatchObject({ col: 1, width: before + 40, column: 'c1' });

    const e2 = await headerEdge(page, 1);
    await page.mouse.move(e2.x, e2.y);
    await page.mouse.down();
    await page.mouse.move(e2.x - 1000, e2.y, { steps: 4 });
    await page.mouse.up();
    expect(await page.evaluate(() => window.grid.store.getSnapshot().columns[1]!.width)).toBe(32);
  });

  test('Escape cancels a resize drag', async ({ page }) => {
    await open(page);
    await clickCell(page, 1, 1);
    const before = await page.evaluate(() => window.grid.store.getSnapshot().columns[2]!.width);
    const e = await headerEdge(page, 2);
    await page.mouse.move(e.x, e.y);
    await page.mouse.down();
    await page.mouse.move(e.x + 60, e.y, { steps: 3 });
    await page.keyboard.press('Escape');
    await page.mouse.up();
    expect(await page.evaluate(() => window.grid.store.getSnapshot().columns[2]!.width)).toBe(before);
  });

  test('double-clicking a header edge auto-fits the column', async ({ page }) => {
    await open(page);
    // Make the email column (long values) narrow, then fit it.
    await page.evaluate(() => {
      const cols = window.grid.store.getSnapshot().columns.map((c, i) => (i === 2 ? { ...c, width: 60 } : c));
      window.grid.update({ columns: cols });
      window.grid.flush();
    });
    const e = await headerEdge(page, 2);
    await page.mouse.dblclick(e.x, e.y);
    const width = await page.evaluate(() => window.grid.store.getSnapshot().columns[2]!.width);
    expect(width).toBeGreaterThan(150);
    // Every visible value now fits without truncation.
    const fits = await page.evaluate((width) => {
      const s = window.grid.store.getSnapshot();
      const ctx = document.createElement('canvas').getContext('2d')!;
      ctx.font = `${s.theme.fontWeight} ${s.theme.fontSize}px ${s.theme.fontFamily}`;
      const { start, end } = window.grid.visibleRows();
      for (let r = start; r < end; r++) {
        if (ctx.measureText(String(window.data.get(r, 2))).width + 2 * s.theme.cellPaddingX > width) return false;
      }
      return true;
    }, width);
    expect(fits).toBe(true);
  });

  test('dragging a header reorders the column and its data moves with it', async ({ page }) => {
    await open(page);
    const ids = () => page.evaluate(() => window.grid.store.getSnapshot().columns.slice(0, 5).map((c) => c.id));
    /** A cell's value as the grid sees it, via copy. */
    const valueOf = (row: number, col: number) =>
      page.evaluate(([row, col]) => {
        window.grid.setSelection([{ top: row!, left: col!, bottom: row!, right: col! }]);
        return window.grid.copySelection()!.text;
      }, [row, col]);
    const original = await valueOf(3, 1);
    const from = await page.evaluate(() => {
      const b = window.grid.getCellBounds(0, 1)!;
      const r = window.grid.element.getBoundingClientRect();
      return { x: r.left + b.x + b.width / 2, y: r.top + 18 };
    });
    const to = await page.evaluate(() => {
      const b = window.grid.getCellBounds(0, 3)!;
      const r = window.grid.element.getBoundingClientRect();
      return { x: r.left + b.x + b.width - 5, y: r.top + 18 };
    });
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 8 });
    expect(await page.evaluate(() => window.grid.element.style.cursor)).toBe('grabbing');
    await page.mouse.up();
    expect(await ids()).toEqual(['c0', 'c2', 'c3', 'c1', 'c4']);
    expect(await page.evaluate(() => window.events.filter((e) => e[0] === 'columnReorder').map((e) => e[1]))).toEqual([
      { from: 1, to: 3, column: 'c1' },
    ]);
    // No header click after a drag, and the moved column is selected at its new index.
    expect(await page.evaluate(() => window.events.filter((e) => e[0] === 'headerClick').length)).toBe(0);
    expect((await state(page)).selection[0]).toMatchObject({ left: 3, right: 3 });
    // Its values moved with it.
    expect(await valueOf(3, 3)).toBe(original);
  });
});
