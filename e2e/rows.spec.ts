import { expect, test, type Page } from '@playwright/test';

/**
 * Phase 2 exit criteria for auto-height rows with wrapped text:
 * rows grow to fit, content never jumps while rows are measured, the scrollbar thumb does not
 * jump, and resizing a wrapped column keeps the top visible row in place.
 */

test.use({ viewport: { width: 1000, height: 640 } });

async function open(page: Page, params = '') {
  await page.goto(`/?wrap&rows=1000000&${params}`);
  await page.waitForFunction(() => window.ready && window.paintLog.length > 0);
  await page.evaluate(() => window.grid.flush());
}

const frame = (page: Page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));

/** The scroll anchor: the first scrolling row on screen (possibly partly under the header) and its top. */
const topRow = (page: Page) =>
  page.evaluate(() => {
    const row = window.grid.visibleRows().start;
    return { row, top: window.grid.getRowBounds(row)!.top };
  });

/** Thumb position in px along a track the height of the viewport. */
const thumb = (page: Page) =>
  page.evaluate(() => {
    const el = window.grid.element;
    const range = el.scrollHeight - el.clientHeight;
    return range > 0 ? (el.scrollTop / range) * el.clientHeight : 0;
  });

test('wrapped rows grow to fit their text', async ({ page }) => {
  await open(page);
  const heights = await page.evaluate(() => {
    const { start, end } = window.grid.visibleRows();
    const out: number[] = [];
    for (let r = start; r < end; r++) out.push(window.grid.getRowBounds(r)?.height ?? 0);
    return out;
  });
  expect(Math.min(...heights)).toBeGreaterThanOrEqual(32);
  // Long text columns wrap to several 18px lines.
  expect(Math.max(...heights)).toBeGreaterThanOrEqual(3 * 18 + 14);
  expect(new Set(heights).size).toBeGreaterThan(1);
});

test('content does not jump while rows above are measured (scroll anchoring)', async ({ page }) => {
  await open(page);
  // Jump deep into unmeasured rows, as a scrollbar drag would.
  await page.evaluate(() => {
    window.grid.scrollToRow(600_000);
    window.grid.flush();
  });
  const before = await topRow(page);
  // Idle measurement fills in rows above and below; the anchor row must not move.
  await page.waitForTimeout(800);
  await frame(page);
  const settled = await page.evaluate(
    (row) => window.grid.getRowBounds(row)?.top ?? null,
    before.row,
  );
  expect(settled).toBe(before.top);

  // Scroll up by wheel into rows that were still unmeasured: the row moves by exactly the
  // scrolled distance, even though measuring the newly exposed rows moves scrollTop around.
  await page.mouse.move(500, 320);
  let scrolled = 0;
  for (let i = 0; i < 30; i++) {
    await page.mouse.wheel(0, -40);
    await frame(page);
    await frame(page);
    scrolled += 40;
    const top = await page.evaluate((row) => window.grid.getRowBounds(row)?.top ?? null, before.row);
    if (top === null) break;
    expect(top).toBeCloseTo(before.top + scrolled, 0);
  }
  const measured = await page.evaluate(() => window.paintLog.reduce((n, f) => n + f.rowsMeasured, 0));
  expect(measured).toBeGreaterThan(0);
});

test('the scrollbar thumb does not jump', async ({ page }) => {
  await open(page);
  await page.mouse.move(500, 320);
  let last = await thumb(page);
  let maxStep = 0;
  for (let i = 0; i < 80; i++) {
    await page.mouse.wheel(0, 120);
    await frame(page);
    await frame(page);
    const t = await thumb(page);
    // Scrolling down never moves the thumb up, and never more than a pixel or two at a time.
    expect(t).toBeGreaterThanOrEqual(last - 0.5);
    maxStep = Math.max(maxStep, t - last);
    last = t;
  }
  expect(maxStep).toBeLessThan(2);

  // After a jump, idle measurement and estimate learning must not move the thumb visibly.
  await page.evaluate(() => {
    window.grid.scrollToRow(400_000);
    window.grid.flush();
  });
  const afterJump = await thumb(page);
  await page.waitForTimeout(1000);
  await frame(page);
  expect(Math.abs((await thumb(page)) - afterJump)).toBeLessThan(2);
});

test('resizing a wrapped column keeps the top visible row in place', async ({ page }) => {
  await open(page);
  await page.evaluate(() => {
    window.grid.scrollToRow(30_000);
    window.grid.flush();
  });
  await page.waitForTimeout(300);
  await frame(page);
  const before = await topRow(page);
  for (const factor of [0.5, 1.6, 0.8]) {
    await page.evaluate((factor) => {
      window.columns = window.columns.map((c) => (c.wrap ? { ...c, width: Math.round(c.width * factor) } : c));
      window.grid.update({ columns: window.columns });
      window.grid.flush();
    }, factor);
    const top = await page.evaluate((row) => window.grid.getRowBounds(row)?.top ?? null, before.row);
    expect(top, `after resizing by ${factor}`).toBe(before.top);
  }
});
