import { describe, expect, it } from 'vitest';
import { cellText, createDataset, makeColumns } from '../src/index';

describe('datagen', () => {
  it('is deterministic', () => {
    expect(cellText(123, 'long', 5)).toBe(cellText(123, 'long', 5));
    expect(createDataset(10, 10).get(3, 4)).toBe(createDataset(10, 10).get(3, 4));
  });

  it('produces mixed text lengths', () => {
    const lengths = Array.from({ length: 200 }, (_, r) => cellText(r, 'long', 9).length);
    expect(Math.min(...lengths)).toBeLessThan(80);
    expect(Math.max(...lengths)).toBeGreaterThan(100);
  });

  it('makes columns with an id column first', () => {
    const cols = makeColumns(100);
    expect(cols).toHaveLength(100);
    expect(cols[0]!.kind).toBe('id');
    expect(new Set(cols.map((c) => c.id)).size).toBe(100);
  });

  it('applies overrides', () => {
    const d = createDataset(1_000_000, 100);
    d.set(999_999, 99, 'x');
    expect(d.get(999_999, 99)).toBe('x');
    expect(d.overrides).toBe(1);
  });
});
