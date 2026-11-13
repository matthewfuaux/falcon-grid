import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

/**
 * Phase 6: accessibility. The mirror exposes the grid to assistive technology with real
 * semantics and real focus, every pointer-only action has a keyboard path, search replaces
 * find-in-page, and the grid follows the user's display settings.
 */

test.use({ viewport: { width: 1000, height: 640 } });

async function open(page: Page, params = '') {
  await page.goto(`/?${params}`);
  await page.waitForFunction(() => window.ready && window.paintLog.length > 0);
  await page.evaluate(() => window.grid.flush());
}

/** Waits for the mirror to settle after scrolling or data changes. */
const settle = (page: Page) => page.waitForTimeout(250);

/** A point in a cell, `fx` of the way across (away from controls when near the edge). */
async function cellPoint(page: Page, row: number, col: number, fx = 0.5) {
  return page.evaluate(
    ([row, col, fx]) => {
      const b = window.grid.getCellBounds(row!, col!)!;
      const r = window.grid.element.getBoundingClientRect();
      return { x: r.left + b.x + b.width * fx!, y: r.top + b.y + b.height / 2 };
    },
    [row, col, fx],
  );
}

async function clickCell(page: Page, row: number, col: number, fx = 0.5) {
  const p = await cellPoint(page, row, col, fx);
  await page.mouse.click(p.x, p.y);
}

/** The focused element's grid position, from its ARIA indexes (1-based, header is row 1). */
const focusedCell = (page: Page) =>
  page.evaluate(() => {
    const el = document.activeElement as HTMLElement;
    const row = el.closest('[role="row"]');
    return {
      role: el.getAttribute('role'),
      rowindex: Number(row?.getAttribute('aria-rowindex')),
      colindex: Number(el.getAttribute('aria-colindex')),
    };
  });

const cellText = (page: Page, row: number, col: number) =>
  page.evaluate(
    ([row, col]) => {
      window.grid.setSelection([{ top: row!, left: col!, bottom: row!, right: col! }]);
      return window.grid.copySelection()!.text;
    },
    [row, col],
  );

const events = (page: Page, name: string) =>
  page.evaluate((name) => window.events.filter((e) => e[0] === name).map((e) => e[1]), name);

const liveText = (page: Page) => page.locator('[role="status"]').textContent();

test.describe('mirror', () => {
  test('exposes a named grid with true row and column counts', async ({ page }) => {
    await open(page, 'rows=5000&cols=30');
    const grid = page.getByRole('grid', { name: 'Test grid' });
    await expect(grid).toHaveAttribute('aria-rowcount', '5001');
    await expect(grid).toHaveAttribute('aria-colcount', '30');
    await expect(grid).toHaveAttribute('aria-multiselectable', 'true');
    const title = await page.evaluate(() => window.columns[0]!.title!);
    await expect(grid.getByRole('columnheader').first()).toHaveText(title);
    await expect(grid.getByRole('columnheader').first()).toHaveAttribute('aria-colindex', '1');
    // Only the window is mirrored, not 5000 rows.
    const rows = await grid.getByRole('row').count();
    expect(rows).toBeGreaterThan(10);
    expect(rows).toBeLessThan(40);
    const first = grid.getByRole('row').nth(1);
    await expect(first).toHaveAttribute('aria-rowindex', '2');
    await expect(first.getByRole('gridcell').nth(1)).toHaveText(await cellText(page, 0, 1));
  });

  test('matches the accessibility tree for a small grid', async ({ page }) => {
    await open(page, 'rows=2&cols=2');
    const [a, b] = await page.evaluate(() => window.columns.map((c) => c.title!));
    const cells = [await cellText(page, 0, 0), await cellText(page, 0, 1), await cellText(page, 1, 0), await cellText(page, 1, 1)];
    await page.evaluate(() => window.grid.setSelection([]));
    await settle(page);
    await expect(page.getByRole('grid')).toMatchAriaSnapshot(`
      - grid "Test grid":
        - row "${a} ${b}":
          - columnheader "${a}"
          - columnheader "${b}"
        - row:
          - gridcell "${cells[0]}"
          - gridcell "${cells[1]}"
        - row:
          - gridcell "${cells[2]}"
          - gridcell "${cells[3]}"
    `);
  });

  test('follows scrolling once it settles, and always keeps the active cell', async ({ page }) => {
    await open(page);
    await clickCell(page, 2, 1);
    await page.evaluate(() => window.grid.scrollToRow(50_000));
    await settle(page);
    const indexes = await page.locator('[role="row"]').evaluateAll((rows) => rows.map((r) => Number(r.getAttribute('aria-rowindex'))));
    expect(indexes).toContain(50_002); // row 50000
    expect(indexes).toContain(4); // the active cell's row (2), off screen
    expect(indexes).toEqual([...indexes].sort((x, y) => x - y));
    // Focus stayed on the active cell through the rebuild.
    expect(await focusedCell(page)).toEqual({ role: 'gridcell', rowindex: 4, colindex: 2 });
  });

  test('scrolling does no mirror work until it settles', async ({ page }) => {
    await open(page);
    await settle(page);
    const r = await page.evaluate(async () => {
      let lastScroll = 0;
      const gaps: number[] = [];
      const mo = new MutationObserver(() => gaps.push(performance.now() - lastScroll));
      mo.observe(document.querySelector('[data-falcon-mirror]')!, { subtree: true, childList: true, attributes: true, characterData: true });
      // Scroll every frame for 20 frames.
      for (let i = 0; i < 20; i++) {
        window.grid.scrollTo({ top: (i + 1) * 40 });
        lastScroll = performance.now();
        await new Promise((r) => requestAnimationFrame(r));
      }
      await new Promise((r) => setTimeout(r, 250));
      mo.disconnect();
      return gaps;
    });
    // The mirror changed, and only once scrolling had been quiet for the settle time (100ms).
    expect(r.length).toBeGreaterThan(0);
    expect(Math.min(...r)).toBeGreaterThanOrEqual(95);
  });
});

test.describe('focus', () => {
  test('Tab enters the grid on a cell, and arrows move DOM focus', async ({ page }) => {
    await open(page);
    await page.keyboard.press('Tab');
    expect(await focusedCell(page)).toEqual({ role: 'gridcell', rowindex: 2, colindex: 1 });
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowRight');
    expect(await focusedCell(page)).toEqual({ role: 'gridcell', rowindex: 3, colindex: 2 });
    expect(await page.evaluate(() => window.grid.getState().focused)).toBe(true);
    // Far moves create the target cell at once.
    await page.keyboard.press('Control+End');
    const s = await page.evaluate(() => window.grid.getState());
    expect(await focusedCell(page)).toEqual({ role: 'gridcell', rowindex: s.rowCount + 1, colindex: s.columns.length });
  });

  test('clicking a cell focuses its mirror element; leaving clears focus', async ({ page }) => {
    await open(page);
    await clickCell(page, 4, 3);
    expect(await focusedCell(page)).toEqual({ role: 'gridcell', rowindex: 6, colindex: 4 });
    await page.evaluate(() => (document.activeElement as HTMLElement).blur());
    expect(await page.evaluate(() => window.grid.getState().focused)).toBe(false);
  });

  test('a screen reader click on a mirrored cell selects it', async ({ page }) => {
    await open(page);
    await settle(page);
    await page.locator('[role="row"][aria-rowindex="5"] [role="gridcell"][aria-colindex="3"]').dispatchEvent('click');
    expect(await page.evaluate(() => window.grid.getState().activeCell)).toEqual({ row: 3, col: 2 });
  });

  test('copy works with focus on a cell', async ({ page }) => {
    await open(page);
    await clickCell(page, 1, 1);
    const copied = await page.evaluate(() => {
      const data = new DataTransfer();
      document.activeElement!.dispatchEvent(new ClipboardEvent('copy', { clipboardData: data, bubbles: true }));
      return data.getData('text/plain');
    });
    expect(copied).toBe(await page.evaluate(() => window.grid.copySelection()!.text));
  });
});

test.describe('state', () => {
  test('selection is aria-selected, and large changes are announced', async ({ page }) => {
    await open(page);
    await clickCell(page, 2, 1);
    await page.keyboard.press('Shift+ArrowDown');
    await page.keyboard.press('Shift+ArrowDown');
    await expect(page.locator('[role="status"]')).toHaveText('3 rows by 1 column selected');
    await settle(page);
    const selected = await page
      .locator('[role="gridcell"][aria-selected="true"]')
      .evaluateAll((els) => els.map((e) => [Number(e.closest('[role="row"]')!.getAttribute('aria-rowindex')), Number(e.getAttribute('aria-colindex'))]));
    expect(selected).toEqual([[4, 2], [5, 2], [6, 2]]);
  });

  test('sort state is aria-sort and changes are announced', async ({ page }) => {
    await open(page);
    await settle(page);
    await page.evaluate(() => {
      const columns = window.grid.getState().columns.map((c, i) => (i === 1 ? { ...c, sort: 'asc' as const } : c));
      window.grid.update({ columns });
    });
    await settle(page);
    const header = page.getByRole('columnheader').nth(1);
    await expect(header).toHaveAttribute('aria-sort', 'ascending');
    const title = await page.evaluate(() => window.columns[1]!.title);
    await expect(page.locator('[role="status"]')).toHaveText(`${title} sorted ascending`);
    await expect(page.getByRole('columnheader').first()).not.toHaveAttribute('aria-sort', /./);
  });
});

test.describe('keyboard access to pointer-only actions', () => {
  test('Alt+Shift+arrows resize the active column and announce the width', async ({ page }) => {
    await open(page);
    await clickCell(page, 1, 2);
    const before = await page.evaluate(() => window.grid.getState().columns[2]!.width);
    await page.keyboard.press('Alt+Shift+ArrowRight');
    await page.keyboard.press('Alt+Shift+ArrowRight');
    await page.keyboard.press('Alt+Shift+ArrowLeft');
    expect(await page.evaluate(() => window.grid.getState().columns[2]!.width)).toBe(before + 8);
    expect((await events(page, 'columnResize')).at(-1)).toMatchObject({ col: 2, width: before + 8 });
    const title = await page.evaluate(() => window.grid.getState().columns[2]!.title);
    await expect(page.locator('[role="status"]')).toHaveText(`${title} ${before + 8} pixels wide`);
  });

  test('Alt+Shift+Ctrl+arrows move the column, and the active cell goes with it', async ({ page }) => {
    await open(page);
    await clickCell(page, 1, 2);
    const ids = await page.evaluate(() => window.grid.getState().columns.map((c) => c.id));
    await page.keyboard.press('Alt+Shift+Control+ArrowRight');
    const after = await page.evaluate(() => window.grid.getState().columns.map((c) => c.id));
    expect(after.slice(0, 4)).toEqual([ids[0], ids[1], ids[3], ids[2]]);
    expect(await page.evaluate(() => window.grid.getState().activeCell)).toEqual({ row: 1, col: 3 });
    expect(await focusedCell(page)).toEqual({ role: 'gridcell', rowindex: 3, colindex: 4 });
    expect(await events(page, 'columnReorder')).toEqual([{ from: 2, to: 3, column: ids[2] }]);
    await expect(page.locator('[role="status"]')).toContainText('moved to column 4 of');
  });

  test('Alt+Shift+S activates the column header', async ({ page }) => {
    await open(page);
    await clickCell(page, 1, 3);
    await page.keyboard.press('Alt+Shift+S');
    expect(await events(page, 'headerClick')).toEqual([{ col: 3, column: (await page.evaluate(() => window.grid.getState().columns[3]!.id)) }]);
  });

  test('Shift+F10 and the ContextMenu key open the context menu on the active cell', async ({ page }) => {
    await open(page);
    await clickCell(page, 3, 1);
    await page.keyboard.press('Shift+F10');
    await page.keyboard.press('ContextMenu');
    const id = await page.evaluate(() => window.grid.getState().columns[1]!.id);
    expect(await events(page, 'cellContextMenu')).toEqual([
      { row: 3, col: 1, column: id },
      { row: 3, col: 1, column: id },
    ]);
  });
});

test.describe('in-cell controls', () => {
  // ?cells&cols=4: Actions (col 4) has Edit and Delete buttons; Done (col 5) a checkbox.
  const ACTIONS = 4;
  const DONE = 5;

  test('are real buttons: Enter reaches them, arrows move between, Escape leaves', async ({ page }) => {
    await open(page, 'cells&cols=4');
    await clickCell(page, 3, ACTIONS, 0.95);
    await settle(page);
    const cell = page.locator(`[role="row"][aria-rowindex="5"] [role="gridcell"][aria-colindex="${ACTIONS + 1}"]`);
    await expect(cell.getByRole('button', { name: 'Edit' })).toHaveCount(1);
    await expect(cell.getByRole('button', { name: 'Delete' })).toHaveCount(1);

    await page.keyboard.press('Enter');
    await expect(cell.getByRole('button', { name: 'Edit' })).toBeFocused();
    expect(await page.evaluate(() => window.grid.getState().focusTarget)).toEqual({ row: 3, col: ACTIONS, region: 0 });
    // Grid navigation keys stay inside the cell.
    await page.keyboard.press('ArrowRight');
    await expect(cell.getByRole('button', { name: 'Delete' })).toBeFocused();
    expect(await page.evaluate(() => window.grid.getState().activeCell)).toEqual({ row: 3, col: ACTIONS });
    await page.keyboard.press('Enter');
    expect(await events(page, 'delete')).toEqual([{ row: 3, col: ACTIONS, column: 'actions' }]);
    await page.keyboard.press('Escape');
    await expect(cell).toBeFocused();
    expect(await page.evaluate(() => window.grid.getState().focusTarget)).toBeNull();
  });

  test('a focused control gets a visible ring on the canvas', async ({ page }) => {
    await open(page, 'cells&cols=4');
    await clickCell(page, 3, ACTIONS, 0.95);
    const canvas = page.locator('canvas').nth(1);
    const before = await canvas.screenshot();
    await page.keyboard.press('Enter');
    await page.evaluate(() => window.grid.flush());
    const after = await canvas.screenshot();
    expect(after.equals(before)).toBe(false);
  });

  test('checkboxes: Space toggles from the cell, and state is exposed', async ({ page }) => {
    await open(page, 'cells&cols=4');
    await clickCell(page, 2, DONE, 0.05);
    await settle(page);
    const box = page.locator(`[role="row"][aria-rowindex="4"] [role="checkbox"]`);
    await expect(box).toHaveAttribute('aria-checked', 'false');
    await expect(box).toHaveAccessibleName('Done');
    await page.keyboard.press(' ');
    await settle(page);
    await expect(box).toHaveAttribute('aria-checked', 'true');
    // Inside the cell, Space on the checkbox itself toggles back.
    await page.keyboard.press('Enter');
    await expect(box).toBeFocused();
    await page.keyboard.press(' ');
    await settle(page);
    await expect(box).toHaveAttribute('aria-checked', 'false');
  });

  test('cell text leaves out control labels', async ({ page }) => {
    await open(page, 'cells&cols=4');
    await settle(page);
    const text = await page
      .locator(`[role="row"][aria-rowindex="3"] [role="gridcell"][aria-colindex="${ACTIONS + 1}"] > span`)
      .first()
      .textContent();
    expect(text).toBe('');
  });
});

test.describe('search', () => {
  test('findNext moves to the next match; matches are highlighted', async ({ page }) => {
    await open(page, 'rows=2000&cols=8');
    const target = (await cellText(page, 700, 3)).slice(0, 12);
    await page.evaluate(() => window.grid.setSelection([], { row: 0, col: 0 }));
    await page.evaluate((q) => window.grid.setSearch(q), target);
    const found = await page.evaluate(() => window.grid.findNext());
    expect(found).not.toBeNull();
    expect((await cellText(page, found!.row, found!.col)).toLowerCase()).toContain(target.toLowerCase());
    expect(found!.row).toBeLessThanOrEqual(700);
    await page.evaluate(() => window.grid.setSelection([], null));
    // The match is on screen and tinted: the overlay differs with search on and off.
    await page.evaluate(() => window.grid.flush());
    const canvas = page.locator('canvas').nth(1);
    const on = await canvas.screenshot();
    await page.evaluate(() => {
      window.grid.setSearch(null);
      window.grid.flush();
    });
    expect((await canvas.screenshot()).equals(on)).toBe(false);
  });

  test('findNext wraps, goes backwards, and resolves null without a match', async ({ page }) => {
    await open(page, 'rows=300&cols=4');
    const q = await cellText(page, 5, 1);
    await page.evaluate(() => window.grid.setSelection([], { row: 200, col: 0 }));
    await page.evaluate((q) => window.grid.setSearch(q, { caseSensitive: true }), q);
    const back = await page.evaluate(() => window.grid.findNext({ backwards: true }));
    expect(back!.row).toBeLessThan(200);
    await page.evaluate(() => window.grid.setSearch('\u0000 no such text'));
    expect(await page.evaluate(() => window.grid.findNext())).toBeNull();
  });
});

test.describe('display settings', () => {
  test('forced colours paint with system colours', async ({ page }) => {
    await page.emulateMedia({ forcedColors: 'active' });
    await open(page);
    const { theme, canvas } = await page.evaluate(() => {
      const probe = document.createElement('span');
      document.body.append(probe);
      probe.style.color = 'Canvas';
      const canvas = getComputedStyle(probe).color;
      probe.remove();
      return { theme: window.grid.getState().theme, canvas };
    });
    expect(theme.background).toBe(canvas);
    expect(theme.hoverBackground).toBe('transparent');
    await page.emulateMedia({ forcedColors: 'none' });
    await page.waitForFunction(() => window.grid.getState().theme.background === '#ffffff');
  });

  test('prefers-contrast: more applies the high-contrast theme', async ({ page }) => {
    await open(page);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-contrast', value: 'more' }] });
    await page.waitForFunction(() => window.grid.getState().theme.gridLine === '#59636e');
    await cdp.send('Emulation.setEmulatedMedia', { features: [] });
    await page.waitForFunction(() => window.grid.getState().theme.gridLine !== '#59636e');
  });

  test('sizes follow the root font size (browser text size)', async ({ page }) => {
    await open(page);
    expect(await page.evaluate(() => window.grid.getState().theme.rowHeight)).toBe(32);
    await page.evaluate(() => (document.documentElement.style.fontSize = '20px'));
    await page.waitForFunction(() => window.grid.getState().theme.rowHeight === 40);
    const t = await page.evaluate(() => window.grid.getState().theme);
    expect(t.fontSize).toBe(16.25);
    expect(t.headerHeight).toBe(45);
  });
});

test.describe('axe', () => {
  for (const params of ['', 'cells&cols=4', 'frozenColumns=2&frozenRows=1']) {
    test(`no violations in the mirror (${params || 'plain'})`, async ({ page }) => {
      await open(page, params);
      await clickCell(page, 2, 1);
      await page.keyboard.press('Shift+ArrowDown');
      await settle(page);
      const results = await new AxeBuilder({ page }).include('#root').analyze();
      expect(results.violations.map((v) => `${v.id}: ${v.nodes.length} ${v.help}`)).toEqual([]);
    });
  }
});
