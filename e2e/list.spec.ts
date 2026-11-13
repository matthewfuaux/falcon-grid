import { expect, test, type Page } from '@playwright/test';

/**
 * Phase 7 list mode: auto-height items, stick to bottom, prepending with scroll anchoring,
 * sticky group headers and text selection, through the core `createList` and React `<List>`.
 */

test.use({ viewport: { width: 640, height: 480 } });

async function open(page: Page, params = '') {
  await page.goto(`/list.html?${params}`);
  await page.waitForFunction(() => window.ready);
  // Fonts settle and the first items are measured.
  await page.waitForTimeout(150);
  await frame(page);
}

const frame = (page: Page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null)))));

const grid = (page: Page) => (page.url().includes('react') ? 'window.listHandle.list.grid' : 'window.list.grid');

/** The first item on screen and its top, in the grid's coordinates. */
const topItem = (page: Page) =>
  page.evaluate((g) => {
    const grid = eval(g) as typeof window.grid;
    const row = grid.visibleRows().start;
    return { row, top: grid.getRowBounds(row)!.top };
  }, grid(page));

const atBottom = (page: Page) =>
  page.evaluate((g) => {
    const el = (eval(g) as typeof window.grid).element;
    return el.scrollHeight - el.clientHeight - el.scrollTop;
  }, grid(page));

test('items are as tall as their content, and the mirror is a headerless list of rows', async ({ page }) => {
  await open(page);
  const heights = await page.evaluate(() => {
    const { start, end } = window.list.visibleItems();
    const out: number[] = [];
    for (let i = start; i < end; i++) out.push(window.list.grid.getRowBounds(i)?.height ?? 0);
    return out;
  });
  expect(new Set(heights).size).toBeGreaterThan(2);
  expect(Math.max(...heights)).toBeGreaterThan(70);
  // One column, full width.
  const width = await page.evaluate(() => window.list.grid.getState().columns[0]!.width);
  expect(width).toBe(await page.evaluate(() => window.list.grid.getState().viewportWidth));
  await page.waitForTimeout(250); // the mirror syncs once things settle
  const mirror = page.locator('[data-falcon-mirror]');
  await expect(mirror).toHaveAttribute('aria-rowcount', '2000');
  await expect(mirror.locator('[role="columnheader"]')).toHaveCount(0);
  await expect(mirror.locator('[role="row"][aria-rowindex="1"]').first()).toBeAttached();
});

test('stick to bottom: starts at the end and follows appended items until scrolled up', async ({ page }) => {
  await open(page, 'bottom');
  expect(await atBottom(page)).toBeLessThanOrEqual(1);
  await page.evaluate(() => window.append(5));
  await frame(page);
  expect(await atBottom(page)).toBeLessThanOrEqual(1);
  const last = await page.evaluate(() => window.list.visibleItems().end);
  expect(last).toBe(2005);

  // Scrolled up: appends no longer move the content.
  await page.mouse.move(300, 200);
  await page.mouse.wheel(0, -600);
  await frame(page);
  await page.waitForTimeout(100);
  const before = await topItem(page);
  await page.evaluate(() => window.append(20));
  await frame(page);
  expect(await topItem(page)).toEqual(before);
  expect(await atBottom(page)).toBeGreaterThan(100);

  // Back at the bottom it follows again, including when the last item grows.
  await page.evaluate(() => window.list.scrollToBottom());
  await frame(page);
  await page.evaluate(() => window.append(3));
  await frame(page);
  expect(await atBottom(page)).toBeLessThanOrEqual(1);
});

test('prepending items keeps the content on screen still', async ({ page }) => {
  await open(page);
  await page.evaluate(() => window.list.scrollToItem(500, 'start'));
  await page.waitForTimeout(100);
  await frame(page);
  const before = await topItem(page);
  await page.evaluate(() => window.prepend(100));
  await frame(page);
  const after = await topItem(page);
  expect(after.row).toBe(before.row + 100);
  expect(after.top).toBeCloseTo(before.top, 0);
  // Prepending at the very top keeps the old first item in place too.
  await page.evaluate(() => window.list.scrollToItem(0, 'start'));
  await frame(page);
  await page.evaluate(() => window.prepend(10));
  await frame(page);
  expect((await topItem(page)).row).toBe(10);
});

test('sticky group headers stay at the top and take clicks', async ({ page }) => {
  await open(page, 'groups');
  // Scroll into the middle of group 4 (items 100..124).
  await page.evaluate(() => {
    window.list.scrollToItem(104, 'start');
  });
  await frame(page);
  // The header is painted opaque on the overlay canvas, over the items under it.
  const alpha = await page.evaluate(() => {
    const overlay = window.list.grid.element.querySelectorAll('canvas')[1]!;
    const px = overlay.getContext('2d')!.getImageData(5, 5, 1, 1).data;
    return px[3];
  });
  expect(alpha).toBe(255);
  await page.mouse.click(320, 5);
  const events = await page.evaluate(() => window.events);
  expect(events.at(-1)).toEqual(['click', { index: 100, id: 100 }]);
  // Below the sticky header, clicks reach the items under it.
  const second = await page.evaluate(() => window.list.grid.getRowBounds(window.list.visibleItems().start + 2)!);
  await page.mouse.click(320, second.top + second.height / 2);
  const clicked = (await page.evaluate(() => window.events)).at(-1)![1].index as number;
  expect(clicked).toBeGreaterThan(100);
});

test('drag selects text across items and Ctrl+C copies it', async ({ page }) => {
  await open(page);
  const a = await page.evaluate(() => window.list.grid.getRowBounds(window.list.visibleItems().start)!);
  const b = await page.evaluate(() => window.list.grid.getRowBounds(window.list.visibleItems().start + 2)!);
  await page.mouse.move(12, a.top + 12); // start of the first item's author line
  await page.mouse.down();
  await page.mouse.move(300, b.top + b.height - 6, { steps: 5 });
  await page.mouse.up();
  const selected = await page.evaluate(() => window.list.textSelection!.text());
  // One line per item: whole items copy as their cell text.
  expect(selected.split('\n').length).toBe(3);
  expect(selected.startsWith('User ')).toBe(true);
  // Copy goes through the document copy event.
  const copied = await page.evaluate(() => {
    const data = new DataTransfer();
    document.dispatchEvent(new ClipboardEvent('copy', { clipboardData: data, bubbles: true, cancelable: true }));
    return data.getData('text/plain');
  });
  expect(copied).toBe(selected);
  // Escape clears; a plain click selects nothing.
  await page.keyboard.press('Escape');
  expect(await page.evaluate(() => window.list.textSelection!.range())).toBeNull();
  await page.keyboard.press('Control+a');
  expect(await page.evaluate(() => window.list.textSelection!.range()?.end.row)).toBe(1999);
});

test('React <List>: prepends through itemKey keep the view still, appends stick to the bottom', async ({ page }) => {
  await open(page, 'react&bottom');
  expect(await atBottom(page)).toBeLessThanOrEqual(1);
  await page.evaluate(() => window.append(4));
  await frame(page);
  expect(await atBottom(page)).toBeLessThanOrEqual(1);

  await page.evaluate(() => window.listHandle.scrollToItem(800, 'start'));
  await page.waitForTimeout(100);
  await frame(page);
  const before = await topItem(page);
  await page.evaluate(() => window.prepend(50));
  await frame(page);
  const after = await topItem(page);
  expect(after.row).toBe(before.row + 50);
  expect(after.top).toBeCloseTo(before.top, 0);

  // Scrolling does not render React.
  const commits = await page.evaluate(() => window.commits);
  await page.mouse.move(300, 200);
  for (let i = 0; i < 5; i++) await page.mouse.wheel(0, 200);
  await frame(page);
  expect(await page.evaluate(() => window.commits)).toBe(commits);
});
