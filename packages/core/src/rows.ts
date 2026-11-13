/** Vertical row geometry in body coordinates: row 0 starts at 0. */
export interface RowModel {
  readonly count: number;
  /** Sum of all row heights. */
  readonly total: number;
  /** Top of `row`, for row in [0, count]; offsetOf(count) === total. */
  offsetOf(row: number): number;
  heightOf(row: number): number;
  /** The row containing offset `y`, clamped to [0, count - 1]; -1 if there are no rows. */
  rowAt(y: number): number;
  /** Bumped whenever any row's height or position may have changed. */
  readonly version: number;
  /** Whether any row in [from, to) changed height since the last `commit()`. */
  changedIn(from: number, to: number): boolean;
  /** Marks the current heights as painted. */
  commit(): void;
}

/** Every row the same height: plain arithmetic. */
export class FixedRows implements RowModel {
  readonly version = 0;
  constructor(
    readonly count: number,
    readonly height: number,
  ) {}
  get total(): number {
    return this.count * this.height;
  }
  offsetOf(row: number): number {
    return row * this.height;
  }
  heightOf(): number {
    return this.height;
  }
  rowAt(y: number): number {
    if (this.count === 0) return -1;
    if (this.height <= 0) return 0;
    const r = Math.floor(y / this.height);
    return r < 0 ? 0 : r >= this.count ? this.count - 1 : r;
  }
  changedIn(): boolean {
    return false;
  }
  commit(): void {}
}

/**
 * Variable heights without measuring every row. Unmeasured rows count at a shared estimate;
 * measured rows at their real height. Two Fenwick trees over the measured rows (sum of heights
 * and count) give
 *
 *   offsetOf(r) = estimate * (r - measuredBefore(r)) + measuredHeightBefore(r)
 *
 * in O(log n), and `rowAt` by binary lifting in O(log n). Because the estimate is factored out,
 * changing it is O(1): the estimate can learn from measured rows as they arrive.
 */
export class VariableRows implements RowModel {
  private n: number;
  private sum: Float64Array;
  private cnt: Int32Array;
  /** Measured height per row; 0 means unmeasured. */
  private heights: Float32Array;
  private est: number;
  private measuredTotal = 0;
  private measured = 0;
  private topBit: number;
  private changeMin = Infinity;
  private changeMax = -Infinity;
  private estimateChanged = false;
  version = 0;

  constructor(count: number, estimate: number) {
    this.n = count;
    this.est = estimate;
    this.sum = new Float64Array(count + 1);
    this.cnt = new Int32Array(count + 1);
    this.heights = new Float32Array(count);
    this.topBit = highestBit(count);
  }

  get count(): number {
    return this.n;
  }
  get estimate(): number {
    return this.est;
  }
  get measuredCount(): number {
    return this.measured;
  }
  /** Mean height of measured rows, or the estimate if none are measured. */
  get measuredMean(): number {
    return this.measured > 0 ? this.measuredTotal / this.measured : this.est;
  }
  get total(): number {
    return this.est * (this.n - this.measured) + this.measuredTotal;
  }

  set estimate(value: number) {
    if (value === this.est || !(value >= 0)) return;
    this.est = value;
    this.estimateChanged = this.measured < this.n;
    this.version++;
  }

  isMeasured(row: number): boolean {
    return this.heights[row]! > 0;
  }

  heightOf(row: number): number {
    const h = this.heights[row]!;
    return h > 0 ? h : this.est;
  }

  /** Records a measured height (must be > 0). */
  setHeight(row: number, height: number): void {
    const h = Math.fround(Math.max(height, 1e-3));
    const old = this.heights[row]!;
    if (old === h) return;
    this.heights[row] = h;
    if (old > 0) {
      this.add(row, h - old, 0);
      this.measuredTotal += h - old;
    } else {
      this.add(row, h, 1);
      this.measuredTotal += h;
      this.measured++;
    }
    this.noteChange(row);
  }

  /** Forgets a row's measurement, so it counts at the estimate again. */
  unset(row: number): void {
    const old = this.heights[row]!;
    if (old <= 0) return;
    this.heights[row] = 0;
    this.add(row, -old, -1);
    this.measuredTotal -= old;
    this.measured--;
    this.noteChange(row);
  }

  /** Forgets every measurement. */
  clear(): void {
    this.sum.fill(0);
    this.cnt.fill(0);
    this.heights.fill(0);
    this.measuredTotal = 0;
    this.measured = 0;
    this.changeMin = 0;
    this.changeMax = this.n;
    this.version++;
  }

  /** Changes the row count, keeping measurements for rows that remain. O(n). */
  resize(count: number): void {
    if (count === this.n) return;
    const heights = new Float32Array(count);
    heights.set(this.heights.subarray(0, Math.min(count, this.n)));
    this.rebuild(heights);
  }

  /** Inserts `count` unmeasured rows before `index`; measurements move with their rows. O(n). */
  insert(index: number, count: number): void {
    if (count <= 0) return;
    const at = Math.max(0, Math.min(index, this.n));
    const heights = new Float32Array(this.n + count);
    heights.set(this.heights.subarray(0, at));
    heights.set(this.heights.subarray(at), at + count);
    this.rebuild(heights);
  }

  private rebuild(heights: Float32Array): void {
    const count = heights.length;
    this.n = count;
    this.heights = heights;
    this.sum = new Float64Array(count + 1);
    this.cnt = new Int32Array(count + 1);
    this.topBit = highestBit(count);
    this.measuredTotal = 0;
    this.measured = 0;
    // Linear-time Fenwick construction.
    for (let i = 1; i <= count; i++) {
      const h = heights[i - 1]!;
      if (h > 0) {
        this.sum[i]! += h;
        this.cnt[i]! += 1;
        this.measuredTotal += h;
        this.measured++;
      }
      const parent = i + (i & -i);
      if (parent <= count) {
        this.sum[parent]! += this.sum[i]!;
        this.cnt[parent]! += this.cnt[i]!;
      }
    }
    this.changeMin = 0;
    this.changeMax = count;
    this.version++;
  }

  offsetOf(row: number): number {
    let s = 0;
    let c = 0;
    for (let i = row < this.n ? row : this.n; i > 0; i -= i & -i) {
      s += this.sum[i]!;
      c += this.cnt[i]!;
    }
    return this.est * ((row < this.n ? row : this.n) - c) + s;
  }

  rowAt(y: number): number {
    if (this.n === 0) return -1;
    let pos = 0;
    let s = 0;
    let c = 0;
    for (let step = this.topBit; step > 0; step >>= 1) {
      const next = pos + step;
      if (next > this.n) continue;
      const ns = s + this.sum[next]!;
      const nc = c + this.cnt[next]!;
      // offsetOf(next): the top of row `next`.
      if (this.est * (next - nc) + ns <= y) {
        pos = next;
        s = ns;
        c = nc;
      }
    }
    return pos >= this.n ? this.n - 1 : pos;
  }

  changedIn(from: number, to: number): boolean {
    if (from < this.changeMax + 1 && to > this.changeMin) return true;
    if (!this.estimateChanged) return false;
    // A new estimate moves only rows that are still unmeasured.
    for (let r = Math.max(0, from); r < Math.min(to, this.n); r++) if (this.heights[r]! <= 0) return true;
    return false;
  }

  commit(): void {
    this.changeMin = Infinity;
    this.changeMax = -Infinity;
    this.estimateChanged = false;
  }

  private add(row: number, dh: number, dc: number): void {
    for (let i = row + 1; i <= this.n; i += i & -i) {
      this.sum[i]! += dh;
      this.cnt[i]! += dc;
    }
  }

  private noteChange(row: number): void {
    if (row < this.changeMin) this.changeMin = row;
    if (row > this.changeMax) this.changeMax = row;
    this.version++;
  }
}

function highestBit(n: number): number {
  let b = 1;
  while (b * 2 <= n) b *= 2;
  return n > 0 ? b : 0;
}
