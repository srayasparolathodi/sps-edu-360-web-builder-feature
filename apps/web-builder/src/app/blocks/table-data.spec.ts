import { describe, expect, it } from 'vitest'
import { TableColumn, defaultTable } from '@spsedu360/engine/model'
import {
  buildTree,
  filterAndSort,
  flattenTree,
  formatCell,
  groupRows,
  headerGroups,
  initialState,
  readRows,
  rowSpans,
  rowsFromLines,
  staticCells,
} from './table-data'

describe('merging cells', () => {
  const cols: TableColumn[] = [
    {
      key: 'grade',
      label: 'Grade',
      format: 'text',
      sortable: true,
      filterable: false,
      mergeRepeated: true,
      group: 'Class',
    },
    {
      key: 'section',
      label: 'Section',
      format: 'text',
      sortable: true,
      filterable: false,
      mergeRepeated: true,
      group: 'Class',
    },
    {
      key: 'name',
      label: 'Name',
      format: 'text',
      sortable: true,
      filterable: true,
    },
  ]
  const data = [
    { grade: 8, section: 'A', name: 'Asha' },
    { grade: 8, section: 'A', name: 'Ravi' },
    { grade: 8, section: 'B', name: 'Meera' },
    { grade: 9, section: 'B', name: 'Kabir' },
  ]

  it('merges repeated values without crossing a merge to the left', () => {
    const spans = rowSpans(data, cols, {})
    expect([0, 1, 2, 3].map((i) => spans.get(i)!['grade'])).toEqual([
      3, 0, 0, 1,
    ])
    // Section "B" repeats across grades 8 and 9, but must not merge across the grade boundary.
    expect([0, 1, 2, 3].map((i) => spans.get(i)!['section'])).toEqual([
      2, 0, 1, 1,
    ])
  })

  it('builds header groups and row groups', () => {
    expect(headerGroups(cols)).toEqual([
      { label: 'Class', span: 2 },
      { label: '', span: 1 },
    ])
    expect(
      groupRows(data, 'grade').map((g) => [g.label, g.rows.length]),
    ).toEqual([
      ['8', 3],
      ['9', 1],
    ])
  })

  it('merges typed table cells with ^^ and <<', () => {
    const cells = staticCells([
      ['Day', 'Period 1', 'Period 2'],
      ['Mon', 'Maths', '<<'],
      ['^^', 'Science', 'Art'],
      ['Tue', 'Sports', '<<'],
      ['^^', '^^', '^^'],
    ])
    expect(cells[1]).toEqual([
      { text: 'Mon', rowspan: 2, colspan: 1 },
      { text: 'Maths', rowspan: 1, colspan: 2 },
    ])
    expect(cells[2]).toEqual([
      { text: 'Science', rowspan: 1, colspan: 1 },
      { text: 'Art', rowspan: 1, colspan: 1 },
    ])
    // A 2×2 block: "Sports" spans two columns and two rows.
    expect(cells[3]).toEqual([
      { text: 'Tue', rowspan: 2, colspan: 1 },
      { text: 'Sports', rowspan: 2, colspan: 2 },
    ])
    expect(cells[4]).toEqual([])
  })
})

const columns: TableColumn[] = [
  {
    key: 'name',
    label: 'Name',
    format: 'text',
    sortable: true,
    filterable: true,
  },
  {
    key: 'grade',
    label: 'Grade',
    format: 'number',
    sortable: true,
    filterable: false,
  },
  {
    key: 'fee',
    label: 'Fee',
    format: 'currency',
    sortable: true,
    filterable: false,
    currency: 'USD',
    cell: { '*': [{ var: 'row.fee' }, 2] },
  },
]
const rows = [
  { id: 1, name: 'Ravi', grade: 9, fee: 10 },
  { id: 2, name: 'Asha', grade: 10, fee: 30 },
  { id: 3, name: 'Meera', grade: 9, fee: 20 },
]

describe('table data', () => {
  it('reads rows from lists, server results and typed lines', () => {
    expect(readRows(rows).rows).toHaveLength(3)
    expect(readRows({ rows: rows.slice(0, 1), total: 42 })).toEqual({
      rows: [rows[0]],
      total: 42,
    })
    expect(rowsFromLines(['id|name', '1|Asha'])).toEqual([
      { id: 1, name: 'Asha' },
    ])
  })

  it('searches filterable columns and sorts stably, including computed cells', () => {
    const state = { ...initialState(defaultTable()), search: 'a' }
    expect(
      filterAndSort(rows, state, columns, {}).map((row) => row.name),
    ).toEqual(['Ravi', 'Asha', 'Meera'])
    const byGrade = filterAndSort(
      rows,
      { ...state, search: '', sort: 'grade', direction: 'asc' },
      columns,
      {},
    )
    expect(byGrade.map((row) => row.name)).toEqual(['Ravi', 'Meera', 'Asha'])
    const byFeeDesc = filterAndSort(
      rows,
      { ...state, search: '', sort: 'fee', direction: 'desc' },
      columns,
      {},
    )
    expect(byFeeDesc.map((row) => row.name)).toEqual(['Asha', 'Meera', 'Ravi'])
  })

  it('formats cells', () => {
    expect(formatCell(1234.5, columns[1])).toMatch(/1.?234/)
    expect(formatCell(20, columns[2])).toContain('20')
    expect(formatCell(true, { ...columns[0], format: 'boolean' })).toBe('Yes')
    expect(formatCell('2026-03-05', { ...columns[0], format: 'date' })).toMatch(
      /2026/,
    )
  })

  it('builds trees from nested and flat data, and guards against loops', () => {
    const nested = [
      { id: 'a', name: 'Science', children: [{ id: 'b', name: 'Physics' }] },
    ]
    const tree = buildTree(nested, {
      ...defaultTable(true),
      childrenKey: 'children',
    })
    expect(tree[0].children[0].row['name']).toBe('Physics')
    expect(flattenTree(tree, new Set()).map((node) => node.key)).toEqual(['a'])
    expect(flattenTree(tree, new Set(['a'])).map((node) => node.depth)).toEqual(
      [0, 1],
    )

    const flat = [
      { id: 1, parent: null },
      { id: 2, parent: 1 },
      { id: 3, parent: 2 },
      { id: 4, parent: 99 },
    ]
    const flatTree = buildTree(flat, {
      ...defaultTable(true),
      childrenKey: undefined,
      parentKey: 'parent',
    })
    expect(flatTree.map((node) => node.key)).toEqual(['1', '4'])
    expect(flatTree[0].children[0].children[0].key).toBe('3')

    // A row that is its own grandparent must not recurse forever.
    const loop = [
      { id: 1, parent: 2 },
      { id: 2, parent: 1 },
      { id: 3, parent: null },
    ]
    expect(() =>
      buildTree(loop, {
        ...defaultTable(true),
        childrenKey: undefined,
        parentKey: 'parent',
      }),
    ).not.toThrow()
  })
})
