import { expect, test, type Page } from '@playwright/test';

/**
 * Phase 5: the React component and the TanStack adapter. React stays out of the frame loop
 * (no commits while scrolling or hovering), the grid survives Strict Mode, inline props don't
 * reset it, controlled and uncontrolled state both work, and a TanStack Table example renders
 * on canvas by swapping only the render layer.
 */

test.use({ viewport: { width: 1000, height: 640 } });

async function open(page: Page, params = '') {
  await page.goto(`/react.html?${params}`);
  await page.waitForFunction(() => window.ready && window.paintLog.length > 0);
  await page.evaluate(() => window.grid.flush());
}

async function frames(page: Page, n = 2) {
  for (let i = 0; i < n; i++) await page.evaluate(() => new Promise((r) => requestAnimationFrame(r)));
}

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

async function headerPoint(page: Page, col: number, fx: number) {
  return page.evaluate(
    ([col, fx]) => {
      const b = window.grid.getCellBounds(0, col!)!;
      const r = window.grid.element.getBoundingClientRect();
      return { x: r.left + b.x + b.width * fx!, y: r.top + 18 };
    },
    [col, fx],
  );
}

async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 8 });
  await page.mouse.up();
}

const state = (page: Page) =>
  page.evaluate(() => {
    const s = window.grid.getState();
    return {
      selection: s.selection,
      activeCell: s.activeCell,
      ids: s.columns.map((c) => c.id),
      widths: s.columns.map((c) => c.width),
      scrollTop: s.scrollTop,
    };
  });

test('scrolling and hovering cause no React commits', async ({ page }) => {
  await open(page);
  const commits = await page.evaluate(() => window.commits);
  const painted = await page.evaluate(() => window.paintLog.length);

  for (let i = 0; i < 6; i++) {
    const p = await cellPoint(page, 2 + i, 1 + (i % 3));
    await page.mouse.move(p.x, p.y);
  }
  await page.mouse.wheel(0, 600);
  await page.mouse.wheel(300, 0);
  await page.mouse.wheel(0, 2000);
  await frames(page, 4);

  const s = await state(page);
  expect(s.scrollTop).toBeGreaterThan(0);
  expect(await page.evaluate(() => window.paintLog.length)).toBeGreaterThan(painted);
  expect(await page.evaluate(() => window.commits)).toBe(commits);
});

test('Strict Mode mounts exactly one working grid', async ({ page }) => {
  await open(page, 'strict');
  await expect(page.locator('[data-falcon-grid]')).toHaveCount(1);
  await expect(page.locator('canvas')).toHaveCount(2);
  const p = await cellPoint(page, 3, 2);
  await page.mouse.click(p.x, p.y);
  expect((await state(page)).activeCell).toEqual({ row: 3, col: 2 });
  await expect(page.locator('#active')).toHaveText('3,2');
  expect(await page.evaluate(() => window.consoleErrors)).toEqual([]);
});

test('useGridState re-renders on its slice only', async ({ page }) => {
  await open(page);
  const p = await cellPoint(page, 4, 1);
  await page.mouse.click(p.x, p.y);
  await expect(page.locator('#active')).toHaveText('4,1');
  const commits = await page.evaluate(() => window.commits);
  await page.mouse.wheel(0, 500);
  await frames(page, 3);
  expect(await page.evaluate(() => window.commits)).toBe(commits);
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('#active')).toHaveText('5,1');
});

test('an inline columns array keeps resized widths and order across re-renders', async ({ page }) => {
  await open(page);
  const before = await state(page);
  // Resize column 1 by 40px, then move column 1 after column 3.
  const edge = await headerPoint(page, 1, 1);
  await drag(page, edge, { x: edge.x + 40, y: edge.y });
  await drag(page, await headerPoint(page, 1, 0.5), await headerPoint(page, 3, 0.95));
  const after = await state(page);
  expect(after.ids.slice(0, 4)).toEqual([before.ids[0], before.ids[2], before.ids[3], before.ids[1]]);
  expect(after.widths[3]).toBe(before.widths[1]! + 40);

  await page.evaluate(() => {
    (window as unknown as { cols: unknown }).cols = window.grid.getState().columns;
  });
  const from = await page.evaluate(() => window.paintLog.length);
  await page.evaluate(() => window.rerender());
  await frames(page, 2);
  // Same column definitions: nothing pushed, nothing repainted.
  expect(await page.evaluate(() => (window as unknown as { cols: unknown }).cols === window.grid.getState().columns)).toBe(true);
  expect(await page.evaluate((from) => window.paintLog.slice(from).filter((f) => f.paint !== 'none').length, from)).toBe(0);
  expect(await state(page)).toMatchObject({ ids: after.ids, widths: after.widths });
});

test('controlled selection follows the owner', async ({ page }) => {
  await open(page, 'controlled');
  let p = await cellPoint(page, 2, 2);
  await page.mouse.click(p.x, p.y);
  expect((await state(page)).activeCell).toEqual({ row: 2, col: 2 });

  // The owner ignores changes: the event fires, the selection stays.
  await page.evaluate(() => (window.rejectSelection = true));
  const changes = await page.evaluate(() => window.selectionChanges);
  p = await cellPoint(page, 5, 1);
  await page.mouse.click(p.x, p.y);
  await page.keyboard.press('ArrowRight');
  expect(await page.evaluate(() => window.selectionChanges)).toBe(changes + 2);
  expect((await state(page)).activeCell).toEqual({ row: 2, col: 2 });
  expect((await state(page)).selection).toEqual([{ top: 2, left: 2, bottom: 2, right: 2 }]);
});

test('double-click edits a cell; Enter commits and moves down', async ({ page }) => {
  await open(page);
  const p = await cellPoint(page, 3, 1);
  await page.mouse.dblclick(p.x, p.y);
  const input = page.getByLabel('Edit cell');
  await expect(input).toBeFocused();
  // The editor sits over the cell.
  const box = (await input.boundingBox())!;
  expect(Math.abs(box.x + box.width / 2 - p.x)).toBeLessThan(2);
  expect(Math.abs(box.y + box.height / 2 - p.y)).toBeLessThan(2);
  await input.fill('hello');
  await page.keyboard.press('Enter');
  await expect(input).toHaveCount(0);
  const id = (await state(page)).ids[1]!;
  expect(await page.evaluate(() => window.edits)).toEqual([[3, id, 'hello']]);
  expect((await state(page)).activeCell).toEqual({ row: 4, col: 1 });
  expect(await page.evaluate(() => document.activeElement === window.grid.element)).toBe(true);
  // The grid shows the new value.
  const text = await page.evaluate(() => {
    window.grid.setSelection([{ top: 3, left: 1, bottom: 3, right: 1 }]);
    return window.grid.copySelection()!.text;
  });
  expect(text).toBe('hello');
});

test('typing starts editing with that key; Escape cancels and returns focus', async ({ page }) => {
  await open(page);
  const p = await cellPoint(page, 2, 0);
  await page.mouse.click(p.x, p.y);
  await page.keyboard.press('x');
  const input = page.getByLabel('Edit cell');
  await expect(input).toHaveValue('x');
  await page.keyboard.type('yz');
  await expect(input).toHaveValue('xyz');
  // Arrow keys inside the editor move the caret, not the active cell.
  await page.keyboard.press('ArrowLeft');
  expect((await state(page)).activeCell).toEqual({ row: 2, col: 0 });
  await page.keyboard.press('Escape');
  await expect(input).toHaveCount(0);
  expect(await page.evaluate(() => window.edits)).toEqual([]);
  expect(await page.evaluate(() => document.activeElement === window.grid.element)).toBe(true);
});

test('an open editor follows its cell while scrolling, without commits', async ({ page }) => {
  await open(page);
  const p = await cellPoint(page, 6, 2);
  await page.mouse.click(p.x, p.y);
  await page.keyboard.press('F2');
  const input = page.getByLabel('Edit cell');
  await expect(input).toBeFocused();
  const before = (await input.boundingBox())!;
  const commits = await page.evaluate(() => window.commits);
  await page.evaluate(() => window.handle.scrollTo({ top: 64 }));
  await frames(page, 2);
  const after = (await input.boundingBox())!;
  expect(after.y).toBeCloseTo(before.y - 64, 0);
  expect(await page.evaluate(() => window.commits)).toBe(commits);
});

test('the imperative handle scrolls, measures and invalidates by column id', async ({ page }) => {
  await open(page);
  const id = (await state(page)).ids[12]!;
  await page.evaluate((id) => window.handle.scrollToCell(5000, id), id);
  await frames(page, 2);
  const rows = await page.evaluate(() => window.grid.visibleRows());
  expect(rows.start).toBeLessThanOrEqual(5000);
  expect(rows.end).toBeGreaterThan(5000);
  const b = await page.evaluate((id) => window.handle.getCellBounds(5000, id), id);
  expect(b).not.toBeNull();
  expect(b!.x + b!.width).toBeLessThanOrEqual(1000);

  // A streaming tick: only the changed rows repaint.
  const from = await page.evaluate(() => window.paintLog.length);
  await page.evaluate(() => window.handle.invalidateRows(5001, 5003));
  await frames(page, 2);
  const painted = await page.evaluate((from) => window.paintLog.slice(from).filter((f) => f.paint !== 'none'), from);
  expect(painted.length).toBeGreaterThan(0);
  expect(painted.every((f) => f.paint === 'incremental')).toBe(true);
});

test('defaultScrollPosition applies on mount', async ({ page }) => {
  await open(page, 'top=3200');
  expect((await state(page)).scrollTop).toBe(3200);
  expect(await page.evaluate(() => window.grid.element.scrollTop)).toBeGreaterThan(0);
});

test('server HTML hydrates without warnings', async ({ page }) => {
  await open(page, 'ssr');
  const html = await page.evaluate(() => (window as unknown as { serverHTML: string }).serverHTML);
  expect(html).toContain('data-falcon-grid-root');
  expect(html).not.toContain('canvas');
  await expect(page.locator('canvas')).toHaveCount(2);
  expect(await page.evaluate(() => window.consoleErrors)).toEqual([]);
});

test.describe('TanStack adapter', () => {
  test('renders the table, sorts on header click and writes resizing back', async ({ page }) => {
    await open(page, 'tanstack&rows=2000&cols=8');
    const ids = await page.evaluate(() => window.table.getVisibleLeafColumns().map((c) => c.id));
    expect((await state(page)).ids).toEqual(ids);

    // Header click: TanStack sorts, the grid shows the arrow and the sorted rows.
    const h = await headerPoint(page, 1, 0.3);
    await page.mouse.click(h.x, h.y);
    expect(await page.evaluate(() => window.table.getState().sorting)).toEqual([{ id: ids[1], desc: false }]);
    await frames(page, 2);
    expect(await page.evaluate(() => window.grid.getState().columns[1]!.sort)).toBe('asc');
    const first = await page.evaluate(() => {
      window.grid.setSelection([{ top: 0, left: 1, bottom: 2, right: 1 }]);
      return window.grid.copySelection()!.text.split('\n');
    });
    const expected = await page.evaluate(
      (id) => window.table.getRowModel().rows.slice(0, 3).map((r) => String(r.getValue(id))),
      ids[1]!,
    );
    expect(first).toEqual(expected);
    expect([...first].sort()).toEqual(first);

    // Resize: the table's sizing state is the source of truth.
    const width = await page.evaluate(() => window.grid.getState().columns[2]!.width);
    const edge = await headerPoint(page, 2, 1);
    await drag(page, edge, { x: edge.x + 30, y: edge.y });
    expect(await page.evaluate((id) => window.table.getState().columnSizing[id], ids[2]!)).toBe(width + 30);
    expect(await page.evaluate(() => window.grid.getState().columns[2]!.width)).toBe(width + 30);

    // Reorder writes the table's column order.
    await drag(page, await headerPoint(page, 0, 0.5), await headerPoint(page, 2, 0.95));
    const order = await page.evaluate(() => window.table.getVisibleLeafColumns().map((c) => c.id));
    expect(order.slice(0, 3)).toEqual([ids[1], ids[2], ids[0]]);
    expect((await state(page)).ids).toEqual(order);
  });

  test('scrolling a TanStack table causes no React commits', async ({ page }) => {
    await open(page, 'tanstack&rows=2000&cols=8');
    const commits = await page.evaluate(() => window.commits);
    await page.mouse.move(400, 300);
    await page.mouse.wheel(0, 1500);
    await page.mouse.move(500, 320);
    await frames(page, 4);
    expect((await state(page)).scrollTop).toBeGreaterThan(0);
    expect(await page.evaluate(() => window.commits)).toBe(commits);
  });

  test('left-pinned columns are frozen', async ({ page }) => {
    await open(page, 'tanstack&rows=200&cols=8');
    const ids = await page.evaluate(() => window.table.getVisibleLeafColumns().map((c) => c.id));
    await page.evaluate((id) => window.table.getColumn(id)!.pin('left'), ids[3]!);
    await page.waitForFunction(() => window.grid.getState().frozenColumns === 1);
    expect((await state(page)).ids[0]).toBe(ids[3]);
  });
});
