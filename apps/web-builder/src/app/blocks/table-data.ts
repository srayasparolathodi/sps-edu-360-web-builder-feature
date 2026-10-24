import { TableColumn, TableConfig } from '@spsedu360/engine/model'
import { evaluate, isLogic, readPath } from '@spsedu360/engine/logic'

export type Row = Record<string, unknown>

export interface TableState {
  page: number
  pageSize: number
  sort: string
  direction: 'asc' | 'desc'
  search: string
}

export const initialState = (config: TableConfig): TableState => ({
  page: 1,
  pageSize: config.pageSize,
  sort: '',
  direction: 'asc',
  search: '',
})

/** Accepts a list of rows, or { rows, total } from a server-side flow. */
export function readRows(value: unknown): { rows: Row[]; total?: number } {
  if (Array.isArray(value))
    return {
      rows: value.filter((row): row is Row => !!row && typeof row === 'object'),
    }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const rows = Array.isArray(record['rows'])
      ? record['rows']
      : Array.isArray(record['items'])
        ? record['items']
        : null
    if (rows) {
      const total = Number(record['total'] ?? record['count'])
      return {
        rows: rows.filter(
          (row): row is Row => !!row && typeof row === 'object',
        ),
        total: Number.isFinite(total) ? total : undefined,
      }
    }
  }
  return { rows: [] }
}

/** Rows typed in the editor as "header|header" lines. */
export function rowsFromLines(lines: string[]): Row[] {
  const [header, ...body] = lines
  if (!header) return []
  const keys = header.split('|').map((key) => key.trim())
  return body.map((line) => {
    const cells = line.split('|')
    return Object.fromEntries(
      keys.map((key, i) => {
        const cell = (cells[i] ?? '').trim()
        return [
          key,
          cell !== '' && !Number.isNaN(Number(cell)) ? Number(cell) : cell,
        ]
      }),
    )
  })
}

export function cellValue(
  row: Row,
  column: TableColumn,
  context: Record<string, unknown>,
): unknown {
  if (column.cell !== undefined && isLogic(column.cell)) {
    try {
      return evaluate(column.cell, { ...context, row })
    } catch {
      return '—'
    }
  }
  return readPath(row, column.key)
}

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' })
const dateTimeFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
})
const numberFormat = new Intl.NumberFormat()
const currencyFormats = new Map<string, Intl.NumberFormat>()

/** Display text for a cell value in the column's format. */
export function formatCell(value: unknown, column: TableColumn): string {
  if (value === null || value === undefined || value === '') return ''
  switch (column.format) {
    case 'number': {
      const n = Number(value)
      return Number.isFinite(n) ? numberFormat.format(n) : String(value)
    }
    case 'currency': {
      const n = Number(value)
      if (!Number.isFinite(n)) return String(value)
      const code = (column.currency || 'INR').toUpperCase()
      let format = currencyFormats.get(code)
      if (!format) {
        try {
          format = new Intl.NumberFormat(undefined, {
            style: 'currency',
            currency: code,
          })
        } catch {
          format = numberFormat
        }
        currencyFormats.set(code, format)
      }
      return format.format(n)
    }
    case 'date':
    case 'datetime': {
      const date = new Date(String(value))
      return Number.isNaN(date.getTime())
        ? String(value)
        : (column.format === 'date' ? dateFormat : dateTimeFormat).format(date)
    }
    case 'boolean':
      return value === true ||
        value === 1 ||
        value === 'true' ||
        value === 'yes'
        ? 'Yes'
        : 'No'
    default:
      return typeof value === 'object' ? JSON.stringify(value) : String(value)
  }
}

const compare = (a: unknown, b: unknown): number => {
  if (a === b) return 0
  if (a === null || a === undefined || a === '') return 1
  if (b === null || b === undefined || b === '') return -1
  const na = Number(a)
  const nb = Number(b)
  if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb
  return String(a).localeCompare(String(b), undefined, {
    numeric: true,
    sensitivity: 'base',
  })
}

/** Search and sort in the browser; returns all matching rows (paging is applied by the caller). */
export function filterAndSort(
  rows: Row[],
  state: TableState,
  columns: TableColumn[],
  context: Record<string, unknown>,
): Row[] {
  let result = rows
  const term = state.search.trim().toLowerCase()
  if (term) {
    const searchable = columns.filter((column) => column.filterable)
    const targets = searchable.length ? searchable : columns
    result = result.filter((row) =>
      targets.some((column) =>
        formatCell(cellValue(row, column, context), column)
          .toLowerCase()
          .includes(term),
      ),
    )
  }
  const sortColumn = columns.find((column) => column.key === state.sort)
  if (sortColumn) {
    const sign = state.direction === 'desc' ? -1 : 1
    result = result
      .map((row, index) => ({
        row,
        index,
        value: cellValue(row, sortColumn, context),
      }))
      // Stable: equal values keep their original order.
      .sort((a, b) => sign * compare(a.value, b.value) || a.index - b.index)
      .map((entry) => entry.row)
  }
  return result
}

export function pageCount(total: number, pageSize: number): number {
  return Math.max(1, Math.ceil(total / Math.max(1, pageSize)))
}

export interface TreeNode {
  key: string
  row: Row
  depth: number
  children: TreeNode[]
  /** True when children are loaded lazily and haven't been fetched yet. */
  lazy: boolean
}

/** Builds a tree from nested rows (childrenKey) or flat rows (parentKey). */
export function buildTree(
  rows: Row[],
  config: TableConfig,
  loaded: Record<string, Row[]> = {},
): TreeNode[] {
  const keyOf = (row: Row, fallback: string) =>
    String(readPath(row, config.rowKey) ?? fallback)
  const make = (row: Row, depth: number, path: string): TreeNode => {
    const key = keyOf(row, path)
    const nested = config.childrenKey
      ? readPath(row, config.childrenKey)
      : undefined
    const childRows = Array.isArray(nested) ? (nested as Row[]) : loaded[key]
    const lazy = !!config.lazyFlow && !Array.isArray(nested) && !loaded[key]
    return {
      key,
      row,
      depth,
      lazy,
      children: (childRows ?? [])
        .slice(0, 1000)
        .map((child, i) => make(child, depth + 1, `${path}.${i}`)),
    }
  }
  if (config.parentKey) {
    const byParent = new Map<string, Row[]>()
    for (const row of rows) {
      const parent = String(readPath(row, config.parentKey) ?? '')
      byParent.set(parent, [...(byParent.get(parent) ?? []), row])
    }
    const keys = new Set(rows.map((row, i) => keyOf(row, String(i))))
    const attach = (
      row: Row,
      depth: number,
      path: string,
      seen: Set<string>,
    ): TreeNode => {
      const key = keyOf(row, path)
      const children = seen.has(key)
        ? []
        : (byParent.get(key) ?? []).map((child, i) =>
            attach(child, depth + 1, `${path}.${i}`, new Set([...seen, key])),
          )
      return {
        key,
        row,
        depth,
        children: [
          ...children,
          ...(loaded[key] ?? []).map((child, i) =>
            make(child, depth + 1, `${path}.l${i}`),
          ),
        ],
        lazy: !!config.lazyFlow && !children.length && !loaded[key],
      }
    }
    // Roots: rows without a parent, or whose parent isn't in the data.
    return rows
      .map((row, i) => ({ row, i }))
      .filter(({ row }) => {
        const parent = readPath(row, config.parentKey!)
        return (
          parent === null ||
          parent === undefined ||
          parent === '' ||
          !keys.has(String(parent))
        )
      })
      .map(({ row, i }) => attach(row, 0, String(i), new Set()))
  }
  return rows.map((row, i) => make(row, 0, String(i)))
}

/** Visible rows of a tree given which nodes are expanded. */
export function flattenTree(
  nodes: TreeNode[],
  expanded: Set<string>,
): TreeNode[] {
  const out: TreeNode[] = []
  const walk = (list: TreeNode[]) => {
    for (const node of list) {
      out.push(node)
      if (expanded.has(node.key)) walk(node.children)
    }
  }
  walk(nodes)
  return out
}

/** Header row for column groups: consecutive columns with the same group share one cell. */
export function headerGroups(
  columns: TableColumn[],
): { label: string; span: number }[] | null {
  if (!columns.some((column) => column.group)) return null
  const groups: { label: string; span: number }[] = []
  for (const column of columns) {
    const label = column.group ?? ''
    const last = groups.at(-1)
    if (last && last.label === label && label) last.span++
    else groups.push({ label, span: 1 })
  }
  return groups
}

/**
 * Row spans for columns that merge repeated values. Returns, per row index and
 * column key, how many rows the cell covers (0 = hidden because merged above).
 * Merging never crosses the boundary of a merge in a column to its left, so
 * nested groupings (grade → class) stay correct.
 */
export function rowSpans(
  rows: Row[],
  columns: TableColumn[],
  context: Record<string, unknown>,
): Map<number, Record<string, number>> {
  const spans = new Map<number, Record<string, number>>()
  rows.forEach((_, i) => spans.set(i, {}))
  let boundaries = new Set<number>([0])
  for (const column of columns) {
    if (!column.mergeRepeated) continue
    const next = new Set<number>(boundaries)
    let start = 0
    for (let i = 1; i <= rows.length; i++) {
      const same =
        i < rows.length &&
        !boundaries.has(i) &&
        formatCell(cellValue(rows[i], column, context), column) ===
          formatCell(cellValue(rows[start], column, context), column)
      if (same) continue
      spans.get(start)![column.key] = i - start
      for (let j = start + 1; j < i; j++) spans.get(j)![column.key] = 0
      next.add(i)
      start = i
    }
    boundaries = next
  }
  return spans
}

export interface RowGroup {
  label: string
  rows: Row[]
}

/** Groups rows by a field, keeping first-seen order of the groups. */
export function groupRows(rows: Row[], field: string): RowGroup[] {
  const groups = new Map<string, Row[]>()
  for (const row of rows) {
    const label = String(readPath(row, field) ?? '—')
    groups.set(label, [...(groups.get(label) ?? []), row])
  }
  return [...groups].map(([label, items]) => ({ label, rows: items }))
}

export interface StaticCell {
  text: string
  rowspan: number
  colspan: number
}

/**
 * Typed tables: "^^" merges a cell into the one above, "<<" into the one on its left.
 * Returns rows of visible cells with their spans.
 */
export function staticCells(rows: string[][]): StaticCell[][] {
  const grid: (StaticCell | null)[][] = rows.map((row) =>
    row.map((text) => ({ text: text.trim(), rowspan: 1, colspan: 1 })),
  )
  const owner: ([number, number] | null)[][] = rows.map((row) =>
    row.map(() => null),
  )
  for (let r = 0; r < rows.length; r++) {
    for (let c = 0; c < rows[r].length; c++) {
      const text = rows[r][c].trim()
      if (text === '<<' && c > 0) {
        const [orow, ocol] = owner[r][c - 1] ?? [r, c - 1]
        const target = grid[orow][ocol]
        // Only widen a cell when the merge is in its first row (keeps rectangles).
        if (target && orow === r) {
          target.colspan++
          grid[r][c] = null
          owner[r][c] = [orow, ocol]
          continue
        }
      }
      if (text === '^^' && r > 0) {
        const [orow, ocol] = owner[r - 1][c] ?? [r - 1, c]
        const target = grid[orow][ocol]
        if (target && ocol === c) {
          target.rowspan++
          grid[r][c] = null
          owner[r][c] = [orow, ocol]
          continue
        }
        // Inside a wide cell that already grew into this row (a 2×2 block): just covered.
        const left = owner[r][ocol]
        if (
          target &&
          ocol < c &&
          c < ocol + target.colspan &&
          left?.[0] === orow &&
          left?.[1] === ocol
        ) {
          grid[r][c] = null
          owner[r][c] = [orow, ocol]
          continue
        }
      }
      grid[r][c] = grid[r][c] ?? { text, rowspan: 1, colspan: 1 }
    }
  }
  return grid.map((row) =>
    row.filter((cell): cell is StaticCell => cell !== null),
  )
}
