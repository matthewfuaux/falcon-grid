import { expect, test, type Page } from '@playwright/test';

/**
 * Phase 4: declarative cells. A cell with a button responds to hover and click with no
 * hand-written hit-testing, hover repaints only that cell, images load and repaint their cells,
 * and declarative content feeds auto row heights and copying.
 */

test.use({ viewport: { width: 1000, height: 640 } });

// 4 data columns (ID, Name, Email, Number), then Actions (col 4) and Done (col 5).
const ACTIONS = 4;
const DONE = 5;

async function open(page: Page, params = '') {
  await page.goto(`/?cells&cols=4&${params}`);
  await page.waitForFunction(() => window.ready && window.paintLog.length > 0);
  await page.evaluate(() => window.grid.flush());
}

/** Page coordinates of a point in a cell, `dx` CSS pixels from the content box's left edge. */
async function inCell(page: Page, row: number, col: number, dx: number) {
  return page.evaluate(
    ([row, col, dx]) => {
      const b = window.grid.getCellBounds(row!, col!)!;
      const r = window.grid.element.getBoundingClientRect();
      const pad = window.grid.store.getSnapshot().theme.cellPaddingX;
      return { x: r.left + b.x + pad + dx!, y: r.top + b.y + b.height / 2 };
    },
    [row, col, dx],
  );
}

/** Waits for a painted frame and returns the frames since `from`. */
async function framesSince(page: Page, from: number) {
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  return page.evaluate((from) => window.paintLog.slice(from), from);
}

const target = (page: Page) =>
  page.evaluate(() => {
    const s = window.grid.store.getSnapshot();
    return { hover: s.hoverTarget, pressed: s.pressedTarget, selection: s.selection };
  });

test('hovering a button repaints only its cell, with a pointer cursor and tooltip', async ({ page }) => {
  await open(page);
  // Somewhere with no interactive region: overlay only.
  const plain = await inCell(page, 3, 0, 10);
  await page.mouse.move(plain.x, plain.y);
  await framesSince(page, 0);
  let from = await page.evaluate(() => window.paintLog.length);

  const edit = await inCell(page, 3, ACTIONS, 12); // first button: 0..24
  await page.mouse.move(edit.x, edit.y);
  expect((await target(page)).hover).toEqual({ row: 3, col: ACTIONS, region: 0 });
  let frames = await framesSince(page, from);
  expect(frames.some((f) => f.paint === 'incremental' && f.cells === 1)).toBe(true);
  expect(frames.every((f) => f.paint !== 'full')).toBe(true);
  expect(await page.evaluate(() => window.grid.element.style.cursor)).toBe('pointer');
  expect(await page.evaluate(() => window.grid.element.title)).toBe('Edit');

  // Onto the second button: the same cell repaints again, nothing else.
  from = await page.evaluate(() => window.paintLog.length);
  const del = await inCell(page, 3, ACTIONS, 40); // second button: 28..52
  await page.mouse.move(del.x, del.y);
  expect((await target(page)).hover).toEqual({ row: 3, col: ACTIONS, region: 1 });
  frames = await framesSince(page, from);
  expect(frames.filter((f) => f.paint !== 'none').every((f) => f.paint === 'incremental' && f.cells <= 1)).toBe(true);
  expect(await page.evaluate(() => window.grid.element.title)).toBe('Delete');

  // Off the buttons: hover state and cursor clear.
  await page.mouse.move(plain.x, plain.y);
  expect((await target(page)).hover).toBeNull();
  expect(await page.evaluate(() => window.grid.element.style.cursor)).toBe('');
});

test('the hovered button is drawn differently, and matches a full repaint', async ({ page }) => {
  await open(page);
  const canvas = page.locator('canvas').first();
  const before = await canvas.screenshot();
  const edit = await inCell(page, 2, ACTIONS, 12);
  await page.mouse.move(edit.x, edit.y);
  await framesSince(page, 0);
  const hovered = await canvas.screenshot();
  expect(hovered.equals(before)).toBe(false);
  await page.evaluate(() => window.fullRepaint());
  await framesSince(page, 0);
  expect((await canvas.screenshot()).equals(hovered)).toBe(true);
});

test('clicking a button runs its handler without selecting or firing a cell click', async ({ page }) => {
  await open(page);
  await page.evaluate(() => window.events.splice(0));
  const del = await inCell(page, 5, ACTIONS, 40);
  await page.mouse.move(del.x, del.y);
  await page.mouse.down();
  expect((await target(page)).pressed).toEqual({ row: 5, col: ACTIONS, region: 1 });
  await page.mouse.up();
  expect((await target(page)).pressed).toBeNull();
  const events = await page.evaluate(() => window.events);
  expect(events).toEqual([['delete', { row: 5, col: ACTIONS, column: 'actions' }]]);
  expect((await target(page)).selection).toEqual([]);
});

test('releasing a press away from the button cancels it', async ({ page }) => {
  await open(page);
  await page.evaluate(() => window.events.splice(0));
  const edit = await inCell(page, 1, ACTIONS, 12);
  await page.mouse.move(edit.x, edit.y);
  await page.mouse.down();
  const away = await inCell(page, 1, 0, 10);
  await page.mouse.move(away.x, away.y, { steps: 3 });
  // Still pressed, but no longer shown pressed: the pointer left the region.
  const t = await target(page);
  expect(t.pressed).toEqual({ row: 1, col: ACTIONS, region: 0 });
  expect(t.hover).toBeNull();
  await page.mouse.up();
  expect(await page.evaluate(() => window.events.filter(([n]) => n === 'edit'))).toEqual([]);
});

test('a checkbox toggles through its column callback', async ({ page }) => {
  await open(page);
  const center = await page.evaluate(
    ([row, col]) => {
      const b = window.grid.getCellBounds(row!, col!)!;
      const r = window.grid.element.getBoundingClientRect();
      return { x: r.left + b.x + b.width / 2, y: r.top + b.y + b.height / 2 };
    },
    [2, DONE],
  );
  await page.mouse.click(center.x, center.y);
  await page.evaluate(() => window.grid.flush());
  const copied = async () => {
    await page.evaluate(([c]) => window.grid.setSelection([{ top: 2, left: c!, bottom: 2, right: c! }]), [DONE]);
    return page.evaluate(() => window.grid.copySelection()!.text);
  };
  expect(await copied()).toBe('true');
  await page.mouse.click(center.x, center.y);
  expect(await copied()).toBe('false');
});

test('pixel output after toggling matches a full repaint', async ({ page }) => {
  await open(page);
  const canvas = page.locator('canvas').first();
  const p = await page.evaluate(
    ([col]) => {
      const b = window.grid.getCellBounds(4, col!)!;
      const r = window.grid.element.getBoundingClientRect();
      return { x: r.left + b.x + b.width / 2, y: r.top + b.y + b.height / 2 };
    },
    [DONE],
  );
  await page.mouse.click(p.x, p.y);
  await page.mouse.move(5, 5); // away, so no hover state differs
  await framesSince(page, 0);
  const incremental = await canvas.screenshot();
  await page.evaluate(() => window.fullRepaint());
  await framesSince(page, 0);
  expect((await canvas.screenshot()).equals(incremental)).toBe(true);
});

test('images load once and repaint the cells waiting for them', async ({ page }) => {
  await open(page, 'images');
  // Every visible user cell asked for the same image; when it arrives they repaint, not the grid.
  await page.waitForFunction(() => window.paintLog.some((f, i) => i > 0 && f.paint === 'incremental' && f.cells > 1));
  const frames = await page.evaluate(() => window.paintLog);
  const first = frames.findIndex((f, i) => i > 0 && f.paint === 'incremental' && f.cells > 1);
  expect(frames[first]!.cells).toBeGreaterThan(5);
  // The avatar is drawn: the user column has the image's orange in it.
  const canvas = page.locator('canvas').first();
  const b = await page.evaluate(() => window.grid.getCellBounds(1, 1)!);
  const shot = await canvas.screenshot();
  const url = `data:image/png;base64,${shot.toString('base64')}`;
  const orange = await page.evaluate(
    async ([url, x, y]) => {
      const img = new Image();
      img.src = url as string;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.width;
      c.height = img.height;
      const ctx = c.getContext('2d')!;
      ctx.drawImage(img, 0, 0);
      const [r, g, bl] = ctx.getImageData(x as number, y as number, 1, 1).data;
      return [r, g, bl];
    },
    [url, b.x + 8 + 10, b.y + b.height / 2],
  );
  expect(orange).toEqual([232, 89, 12]);
});

test('declarative content sizes auto-height rows', async ({ page }) => {
  await open(page, 'auto');
  const heights = await page.evaluate(() => [0, 1, 2].map((r) => window.grid.getRowBounds(r)!.height));
  // Buttons (24px) plus vertical padding (2 x 7) need 38px, more than the 32px minimum.
  expect(heights).toEqual([38, 38, 38]);
});

test('copying declarative cells copies their text', async ({ page }) => {
  await open(page);
  await page.evaluate(() => window.grid.setSelection([{ top: 0, left: 0, bottom: 1, right: 3 }]));
  const text = await page.evaluate(() => window.grid.copySelection()!.text);
  const expected = await page.evaluate(() =>
    [0, 1].map((r) => [String(r + 1), window.data.get(r, 1), window.data.get(r, 2), Number(window.data.get(r, 3)).toLocaleString('en-US')].join('\t')).join('\n'),
  );
  expect(text).toBe(expected);
});

test('double-clicking a header edge fits declarative content', async ({ page }) => {
  await open(page);
  const before = await page.evaluate(() => window.grid.store.getSnapshot().columns[1]!.width);
  const edge = await page.evaluate(() => {
    const b = window.grid.getCellBounds(0, 1)!;
    const r = window.grid.element.getBoundingClientRect();
    return { x: r.left + b.x + b.width, y: r.top + 18 };
  });
  await page.mouse.dblclick(edge.x, edge.y);
  const after = await page.evaluate(() => window.grid.store.getSnapshot().columns[1]!.width);
  // Avatar 20 + gap 8 + a name in 500 weight + padding: narrower than the default 160.
  expect(after).not.toBe(before);
  expect(after).toBeGreaterThan(60);
  expect(after).toBeLessThan(200);
});
