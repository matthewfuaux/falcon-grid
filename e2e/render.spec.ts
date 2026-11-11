import { expect, test, type Page } from '@playwright/test';

/**
 * Incremental painting (scroll blits, exposed strips, dirty cells) must produce exactly the
 * pixels a full repaint would. Each case drives the incremental paths, then compares the canvas
 * with a fresh full repaint.
 */

async function open(page: Page, params: string) {
  await page.goto(`/?${params}`);
  await page.waitForFunction(() => window.ready && window.paintLog.length > 0);
  await page.evaluate(() => window.grid.flush());
}

/** Scrolls by virtual offsets and paints synchronously, frame by frame. */
async function scrollSteps(page: Page, steps: [number, number][]) {
  await page.evaluate((steps) => {
    for (const [dx, dy] of steps) {
      const s = window.grid.store.getSnapshot();
      window.grid.scrollTo({ left: s.scrollLeft + dx, top: s.scrollTop + dy });
      window.grid.flush();
    }
  }, steps);
}

async function expectMatchesFullRepaint(page: Page, label: string) {
  // Let the compositor present the incremental frame, then capture it.
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const canvas = page.locator('canvas').first();
  const incremental = await canvas.screenshot();
  await page.evaluate(() => window.fullRepaint());
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const full = await canvas.screenshot();
  if (incremental.equals(full)) return;
  const url = (b: Buffer) => `data:image/png;base64,${b.toString('base64')}`;
  const r = await page.evaluate(([a, b]) => window.diffImages(a!, b!), [url(incremental), url(full)]);
  expect(r.diff, `${label}: first mismatch at ${JSON.stringify(r.first)} (${r.colors}), box ${JSON.stringify(r.box)}`).toBe(0);
}

const layouts = [
  { name: 'plain', params: '' },
  { name: 'frozen panes', params: 'frozenColumns=2&frozenRows=3' },
  { name: 'frozen + striped, odd row height', params: 'frozenColumns=1&frozenRows=1&zebra' },
  { name: 'wrapped text, auto height', params: 'wrap&frozenColumns=1&frozenRows=1&zebra' },
];

for (const dpr of [1, 1.5, 2]) {
  test.describe(`dpr ${dpr}`, () => {
    test.use({ deviceScaleFactor: dpr, viewport: { width: 1000, height: 640 } });

    for (const layout of layouts) {
      test(`${layout.name}: scroll blits match a full repaint`, async ({ page }) => {
        await open(page, layout.params);
        const sequences: [number, number][][] = [
          Array.from({ length: 12 }, () => [0, 40]),     // down
          Array.from({ length: 6 }, () => [0, -14]),     // up, small steps
          Array.from({ length: 8 }, () => [60, 0]),      // right
          Array.from({ length: 8 }, () => [-26, 18]),    // diagonal
          [[0, 20_000], [300, 0], [0, 2]],               // jumps larger than the viewport
        ];
        for (const [i, seq] of sequences.entries()) {
          await scrollSteps(page, seq);
          await expectMatchesFullRepaint(page, `sequence ${i}`);
        }
        const modes = await page.evaluate(() => window.paintLog.map((f) => f.paint));
        expect(modes).toContain('incremental');
      });

      test(`${layout.name}: dirty cells match a full repaint`, async ({ page }) => {
        await open(page, layout.params);
        await scrollSteps(page, [[130, 900]]);
        await page.evaluate(() => {
          const s = window.grid.store.getSnapshot();
          const top = Math.floor(s.scrollTop / s.theme.rowHeight);
          for (let i = 0; i < 40; i++) {
            const row = i % 3 === 0 ? i % 4 : top + (i * 7) % 20; // some in frozen rows
            const col = (i * 5) % 12;
            window.data.set(row, col, `updated ${i} with a longer value that overflows`);
            window.grid.invalidateCell(row, col);
          }
          window.grid.invalidateRows(top + 3, top + 5);
          window.grid.flush();
        });
        const last = await page.evaluate(() => window.paintLog.at(-1)!.paint);
        // With wrapping, new values change row heights on screen, which needs a full repaint.
        if (!layout.params.includes('wrap')) expect(last).toBe('incremental');
        await expectMatchesFullRepaint(page, 'dirty cells');
      });
    }

    test('real wheel input stays pixel-exact', async ({ page }) => {
      await open(page, 'frozenColumns=1&frozenRows=2');
      await page.mouse.move(500, 320);
      for (let i = 0; i < 20; i++) await page.mouse.wheel(i % 5 === 0 ? 37 : 0, 53);
      await page.waitForTimeout(200);
      await expectMatchesFullRepaint(page, 'wheel');
    });
  });
}
