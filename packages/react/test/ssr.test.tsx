import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CellOverlay, Grid, useGridState, type GridColumn } from '../src';

interface Row {
  name: string;
}

const columns: GridColumn<Row>[] = [{ id: 'name', title: 'Name' }];
const getRow = (i: number): Row => ({ name: `Row ${i}` });

function ActiveCell() {
  const active = useGridState((s) => s.activeCell);
  return <span>{active ? `${active.row},${active.col}` : 'none'}</span>;
}

describe('server rendering', () => {
  afterEach(() => vi.restoreAllMocks());

  it('renders a sized placeholder and nothing else, without warnings', () => {
    const error = vi.spyOn(console, 'error');
    const warn = vi.spyOn(console, 'warn');
    const html = renderToString(
      <Grid rowCount={1000} columns={columns} getRow={getRow} width={640} height={480} theme={{ background: '#101010' }}>
        <CellOverlay row={0} col="name">
          <button>Menu</button>
        </CellOverlay>
      </Grid>,
    );
    expect(html).toContain('data-falcon-grid-root');
    expect(html).toContain('width:640px');
    expect(html).toContain('height:480px');
    expect(html).toContain('background:#101010');
    // Overlays are portals into the DOM layer, which only exists on the client.
    expect(html).not.toContain('Menu');
    expect(html).not.toContain('<canvas');
    expect(error).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('gives useGridState the initial state before the grid exists', () => {
    const html = renderToString(
      <Grid rowCount={10} columns={columns} getRow={getRow}>
        <ActiveCell />
      </Grid>,
    );
    expect(html).toContain('none');
  });
});
