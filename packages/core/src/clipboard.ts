import { coveredSpans, selectionContains } from './selection';
import type { CellRange, CellValue, ColumnDef, GetCell } from './types';

const str = (v: CellValue) => (v == null ? '' : String(v));

/** TSV quoting as spreadsheets expect: quote fields with tabs, newlines or quotes; double quotes. */
const tsvField = (s: string) => (/[\t\n\r"]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

const htmlEscape = (s: string) =>
  s.replace(/[&<>"]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;'));

/**
 * Serialises a selection as TSV and an HTML table. With several ranges, only the rows and
 * columns some range covers are included, and cells outside every range are left blank, so
 * selecting columns A and C copies two adjacent columns.
 */
export function selectionToClipboard(
  ranges: readonly CellRange[],
  getCell: GetCell,
  columns: readonly ColumnDef[],
): { text: string; html: string } {
  const rowSpans = coveredSpans(ranges, 'rows');
  const colSpans = coveredSpans(ranges, 'cols');
  const multi = ranges.length > 1;
  const tsv: string[] = [];
  const html: string[] = ['<table>'];
  for (const [r0, r1] of rowSpans) {
    for (let r = r0; r <= r1; r++) {
      const cells: string[] = [];
      html.push('<tr>');
      for (const [c0, c1] of colSpans) {
        for (let c = c0; c <= c1; c++) {
          const v = !multi || selectionContains(ranges, r, c) ? str(getCell(r, c, columns[c]!)) : '';
          cells.push(tsvField(v));
          html.push(`<td>${htmlEscape(v)}</td>`);
        }
      }
      html.push('</tr>');
      tsv.push(cells.join('\t'));
    }
  }
  html.push('</table>');
  return { text: tsv.join('\n'), html: html.join('') };
}
