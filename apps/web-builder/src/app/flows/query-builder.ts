import { Component, computed, input, output, signal } from '@angular/core'
import { FormsModule } from '@angular/forms'
import { MatButtonModule } from '@angular/material/button'
import { MatIconModule } from '@angular/material/icon'
import { MatFormFieldModule } from '@angular/material/form-field'
import { MatInputModule } from '@angular/material/input'
import { MatSelectModule } from '@angular/material/select'
import { MatButtonToggleModule } from '@angular/material/button-toggle'
import { MatSlideToggleModule } from '@angular/material/slide-toggle'
import { MatTooltipModule } from '@angular/material/tooltip'
import { DataSource } from '@spsedu360/engine/model'
import { Logic } from '@spsedu360/engine/logic'
import {
  CompareOp,
  Condition,
  Expr,
  QueryDef,
  SQL_FUNCTIONS,
  SqlFunction,
  compileQuery,
  previewSql,
} from '@spsedu360/engine/query'
import { LogicField } from '../logic/logic-editor'

/** Plain-language filter operators shown to authors, and how each maps to the query engine. */
export const FILTER_OPERATORS = [
  { op: 'eq', label: 'is' },
  { op: 'ne', label: 'is not' },
  { op: 'gt', label: 'is more than' },
  { op: 'gte', label: 'is at least' },
  { op: 'lt', label: 'is less than' },
  { op: 'lte', label: 'is at most' },
  { op: 'contains', label: 'contains' },
  { op: 'starts', label: 'starts with' },
  { op: 'in', label: 'is one of (list)' },
  { op: 'between', label: 'is between' },
  { op: 'empty', label: 'is empty' },
  { op: 'filled', label: 'is not empty' },
] as const
type FilterOp = (typeof FILTER_OPERATORS)[number]['op']

/** A simple filter row the visual editor can show; anything else is "advanced". */
export interface FilterRule {
  column: string
  op: FilterOp
  value?: Logic
  value2?: Logic
  /** Optional filter: only applied when this logic is true. */
  when?: Logic
}
export interface FilterGroup {
  mode: 'and' | 'or'
  rules: FilterRule[]
  /** Conditions the visual editor can't show; kept as-is. */
  advanced: Condition[]
}

const COMPARE: Partial<Record<FilterOp, CompareOp>> = {
  eq: '=',
  ne: '!=',
  gt: '>',
  gte: '>=',
  lt: '<',
  lte: '<=',
}

export function ruleToCondition(rule: FilterRule): Condition {
  const left: Expr = { column: rule.column }
  const value = (logic: Logic | undefined): Expr => ({ value: logic ?? '' })
  let condition: Condition
  switch (rule.op) {
    case 'contains':
      condition = {
        compare: 'ilike',
        left,
        right: { value: { cat: ['%', rule.value ?? '', '%'] } },
      }
      break
    case 'starts':
      condition = {
        compare: 'ilike',
        left,
        right: { value: { cat: [rule.value ?? '', '%'] } },
      }
      break
    case 'in':
      condition = { in: left, list: rule.value ?? [] }
      break
    case 'between':
      condition = {
        between: left,
        low: value(rule.value),
        high: value(rule.value2),
      }
      break
    case 'empty':
      condition = { isNull: left }
      break
    case 'filled':
      condition = { isNull: left, negate: true }
      break
    default:
      condition = { compare: COMPARE[rule.op]!, left, right: value(rule.value) }
  }
  return rule.when !== undefined
    ? { when: rule.when, then: condition }
    : condition
}

export function conditionToRule(condition: Condition): FilterRule | null {
  let when: Logic | undefined
  if ('when' in condition) {
    when = condition.when
    condition = condition.then
  }
  const column = (expr: Expr | undefined) =>
    expr && 'column' in expr ? expr.column : null
  const valueOf = (expr: Expr | undefined) =>
    expr && 'value' in expr ? expr.value : undefined
  const withWhen = (
    rule: Omit<FilterRule, 'when'> | null,
  ): FilterRule | null =>
    rule ? (when !== undefined ? { ...rule, when } : rule) : null
  if ('compare' in condition) {
    const col = column(condition.left)
    if (!col) return null
    const right = valueOf(condition.right)
    if (
      condition.compare === 'ilike' &&
      right &&
      typeof right === 'object' &&
      'cat' in (right as object)
    ) {
      const parts = (right as { cat: Logic[] }).cat
      if (parts.length === 3 && parts[0] === '%' && parts[2] === '%')
        return withWhen({ column: col, op: 'contains', value: parts[1] })
      if (parts.length === 2 && parts[1] === '%')
        return withWhen({ column: col, op: 'starts', value: parts[0] })
    }
    const op = Object.entries(COMPARE).find(
      ([, sql]) => sql === condition.compare,
    )?.[0] as FilterOp | undefined
    if (!op || !('right' in condition) || !('value' in condition.right))
      return null
    return withWhen({ column: col, op, value: right })
  }
  if ('in' in condition && !condition.negate && condition.list !== undefined) {
    const col = column(condition.in)
    return col
      ? withWhen({ column: col, op: 'in', value: condition.list })
      : null
  }
  if ('between' in condition && !condition.negate) {
    const col = column(condition.between)
    return col
      ? withWhen({
          column: col,
          op: 'between',
          value: valueOf(condition.low),
          value2: valueOf(condition.high),
        })
      : null
  }
  if ('isNull' in condition) {
    const col = column(condition.isNull)
    return col
      ? withWhen({ column: col, op: condition.negate ? 'filled' : 'empty' })
      : null
  }
  return null
}

export function toGroup(condition: Condition | undefined): FilterGroup {
  if (!condition) return { mode: 'and', rules: [], advanced: [] }
  const mode: 'and' | 'or' = 'or' in condition ? 'or' : 'and'
  const items =
    'and' in condition
      ? condition.and
      : 'or' in condition
        ? condition.or
        : [condition]
  const group: FilterGroup = { mode, rules: [], advanced: [] }
  for (const item of items) {
    const rule = conditionToRule(item)
    if (rule) group.rules.push(rule)
    else group.advanced.push(item)
  }
  return group
}

export function fromGroup(group: FilterGroup): Condition | undefined {
  // Rules without a column stay, so the author sees them; the preview asks for a column.
  const items = [...group.rules.map(ruleToCondition), ...group.advanced]
  if (!items.length) return undefined
  return group.mode === 'or' ? { or: items } : { and: items }
}

/** Visual editor for database queries: authors pick tables, columns and filters; the engine writes the SQL. */
@Component({
  selector: 'query-builder',
  imports: [
    FormsModule,
    MatButtonModule,
    MatIconModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    MatButtonToggleModule,
    MatSlideToggleModule,
    MatTooltipModule,
    LogicField,
  ],
  templateUrl: './query-builder.html',
})
export class QueryBuilder {
  readonly query = input.required<QueryDef>()
  readonly source = input<DataSource | undefined>(undefined)
  readonly variables = input<string[]>([])
  readonly sample = input<Record<string, unknown> | null>(null)
  readonly queryChange = output<QueryDef>()

  readonly operators = FILTER_OPERATORS
  readonly functions = Object.entries(SQL_FUNCTIONS)
    .filter(([, info]) => info.aggregate)
    .map(([fn, info]) => ({ fn: fn as SqlFunction, label: info.label }))
  readonly showJson = signal(false)
  readonly jsonDraft = signal('')
  readonly jsonError = signal('')

  readonly tables = computed(() =>
    Object.keys(this.source()?.schema ?? {}).sort(),
  )
  readonly mainAlias = computed(
    () => this.query().from.alias ?? this.query().from.table,
  )
  /** Columns of every table in the query, as "alias.column" when joins exist. */
  readonly columns = computed(() => {
    const query = this.query()
    const schema = this.source()?.schema ?? {}
    const refs = [
      query.from,
      ...(query.joins ?? []).map((join) => join.table),
    ].filter((ref) => ref.table)
    const qualify = refs.length > 1
    return refs.flatMap((ref) =>
      (schema[ref.table!] ?? []).map((column: string) =>
        qualify ? `${ref.alias ?? ref.table}.${column}` : column,
      ),
    )
  })
  readonly baseColumns = computed(
    () => this.source()?.schema?.[this.query().from.table ?? ''] ?? [],
  )
  readonly filters = computed(() => toGroup(this.query().where))
  readonly selectedColumns = computed(() =>
    (this.query().fields ?? [])
      .filter((field) => 'column' in field.expr && !field.as)
      .map((field) => (field.expr as { column: string }).column),
  )
  readonly aggregates = computed(() =>
    (this.query().fields ?? [])
      .map((field, index) => ({ field, index }))
      .filter(({ field }) => 'fn' in field.expr),
  )
  readonly preview = computed(() => {
    const source = this.source()
    if (!source) return { ok: false, text: 'Choose a data source first.' }
    try {
      return {
        ok: true,
        text: previewSql(
          compileQuery(
            this.query(),
            source.type,
            this.sample() ?? {},
            source.schema,
          ),
        ),
      }
    } catch (error) {
      return {
        ok: false,
        text: error instanceof Error ? error.message : 'Invalid query.',
      }
    }
  })

  private emit(change: (query: QueryDef) => void): void {
    const next = structuredClone(this.query())
    change(next)
    this.queryChange.emit(next)
  }

  setOperation(operation: QueryDef['operation']): void {
    this.emit((query) => {
      query.operation = operation
      if (operation !== 'select') {
        delete query.fields
        delete query.joins
        delete query.groupBy
        delete query.having
        delete query.orderBy
        delete query.limit
        delete query.offset
        query.from = { table: query.from.table }
      }
      if (
        operation !== 'select' &&
        operation !== 'delete' &&
        !query.set?.length
      )
        query.set = []
      if (operation === 'upsert' || operation === 'insert') delete query.where
      if (operation !== 'upsert') delete query.conflict
    })
  }

  setTable(table: string): void {
    this.emit((query) => {
      query.from = { ...query.from, table }
      delete query.fields
      delete query.where
      delete query.orderBy
      delete query.groupBy
      query.joins = []
      if (query.set) query.set = []
    })
  }

  setColumns(columns: string[]): void {
    this.emit((query) => {
      const others = (query.fields ?? []).filter(
        (field) => !('column' in field.expr) || field.as,
      )
      query.fields = [
        ...columns.map((column) => ({ expr: { column } as Expr })),
        ...others,
      ]
      if (!query.fields.length) delete query.fields
    })
  }

  addAggregate(): void {
    this.emit((query) => {
      query.fields = [
        ...(query.fields ?? []),
        { expr: { fn: 'count' }, as: 'total' },
      ]
    })
  }

  setAggregate(
    index: number,
    key: 'fn' | 'column' | 'as',
    value: string,
  ): void {
    this.emit((query) => {
      const field = query.fields![index]
      const expr = field.expr as { fn: SqlFunction; args?: Expr[] }
      if (key === 'as')
        field.as = value.replace(/[^A-Za-z0-9_]/g, '_') || 'value'
      if (key === 'fn') expr.fn = value as SqlFunction
      if (key === 'column') expr.args = value ? [{ column: value }] : []
    })
  }

  aggregateColumn(expr: Expr): string {
    return 'fn' in expr && expr.args?.[0] && 'column' in expr.args[0]
      ? expr.args[0].column
      : ''
  }
  aggregateFn(expr: Expr): string {
    return 'fn' in expr ? expr.fn : ''
  }

  removeField(index: number): void {
    this.emit((query) => {
      query.fields!.splice(index, 1)
      if (!query.fields!.length) delete query.fields
    })
  }

  addJoin(): void {
    this.emit((query) => {
      const used = new Set([
        query.from.alias ?? query.from.table,
        ...(query.joins ?? []).map(
          (join) => join.table.alias ?? join.table.table,
        ),
      ])
      let n = 1
      while (used.has(`t${n}`)) n++
      if (!query.from.alias) query.from = { ...query.from, alias: 'main' }
      query.joins = [
        ...(query.joins ?? []),
        {
          type: 'left',
          table: { table: '', alias: `t${n}` },
          on: { compare: '=', left: { column: '' }, right: { column: '' } },
        },
      ]
    })
  }

  setJoin(
    index: number,
    key: 'type' | 'table' | 'left' | 'right',
    value: string,
  ): void {
    this.emit((query) => {
      const join = query.joins![index]
      if (key === 'type')
        join.type = value as 'inner' | 'left' | 'right' | 'full'
      if (key === 'table') join.table = { ...join.table, table: value }
      const on = join.on as { compare: string; left: Expr; right: Expr }
      if (key === 'left') on.left = { column: value }
      if (key === 'right') on.right = { column: value }
    })
  }

  joinColumn(index: number, side: 'left' | 'right'): string {
    const on = this.query().joins?.[index]?.on as
      { left?: Expr; right?: Expr } | undefined
    const expr = on?.[side]
    return expr && 'column' in expr ? expr.column : ''
  }

  removeJoin(index: number): void {
    this.emit((query) => {
      query.joins!.splice(index, 1)
      if (!query.joins!.length) {
        delete query.joins
        delete query.from.alias
      }
    })
  }

  private setFilters(change: (group: FilterGroup) => void): void {
    const group = structuredClone(this.filters())
    change(group)
    this.emit((query) => {
      const where = fromGroup(group)
      if (where) query.where = where
      else delete query.where
    })
  }

  addFilter(): void {
    this.setFilters((group) =>
      group.rules.push({
        column: this.columns()[0] ?? '',
        op: 'eq',
        value: '',
      }),
    )
  }
  setFilterMode(mode: 'and' | 'or'): void {
    this.setFilters((group) => (group.mode = mode))
  }
  setRule(index: number, key: keyof FilterRule, value: unknown): void {
    this.setFilters((group) => {
      const rule = group.rules[index] as unknown as Record<string, unknown>
      if (value === undefined) delete rule[key]
      else rule[key] = value
      if (key === 'op' && value === 'in' && !Array.isArray(rule['value']))
        rule['value'] = []
    })
  }
  removeRule(index: number): void {
    this.setFilters((group) => group.rules.splice(index, 1))
  }
  needsValue(op: FilterOp): boolean {
    return op !== 'empty' && op !== 'filled'
  }

  setGroupBy(columns: string[]): void {
    this.emit((query) => {
      if (columns.length) query.groupBy = columns.map((column) => ({ column }))
      else delete query.groupBy
    })
  }
  groupByColumns(): string[] {
    return (this.query().groupBy ?? []).flatMap((expr) =>
      'column' in expr ? [expr.column] : [],
    )
  }

  addSort(): void {
    this.emit((query) => {
      query.orderBy = [
        ...(query.orderBy ?? []),
        { expr: { column: this.columns()[0] ?? '' }, direction: 'asc' },
      ]
    })
  }
  setSort(index: number, key: 'column' | 'direction', value: string): void {
    this.emit((query) => {
      const order = query.orderBy![index]
      if (key === 'column') order.expr = { column: value }
      else order.direction = value as 'asc' | 'desc'
    })
  }
  sortColumn(index: number): string {
    const expr = this.query().orderBy?.[index]?.expr
    return expr && 'column' in expr ? expr.column : ''
  }
  removeSort(index: number): void {
    this.emit((query) => {
      query.orderBy!.splice(index, 1)
      if (!query.orderBy!.length) delete query.orderBy
    })
  }

  setPaging(key: 'limit' | 'offset', value: Logic | undefined): void {
    this.emit((query) => {
      if (value === undefined || value === '') delete query[key]
      else query[key] = value
    })
  }

  addSet(): void {
    this.emit((query) => {
      const used = new Set((query.set ?? []).map((item) => item.column))
      const column = this.baseColumns().find((name) => !used.has(name)) ?? ''
      query.set = [...(query.set ?? []), { column, value: { value: '' } }]
    })
  }
  setSetColumn(index: number, column: string): void {
    this.emit((query) => (query.set![index].column = column))
  }
  setSetValue(index: number, value: Logic | undefined): void {
    this.emit((query) => (query.set![index].value = { value: value ?? '' }))
  }
  setValueOf(index: number): Logic {
    const expr = this.query().set?.[index]?.value
    return expr && 'value' in expr ? expr.value : ''
  }
  removeSet(index: number): void {
    this.emit((query) => query.set!.splice(index, 1))
  }

  setConflict(columns: string[]): void {
    this.emit((query) => {
      if (columns.length) query.conflict = columns
      else delete query.conflict
    })
  }

  setFlag(key: 'distinct' | 'allowAllRows', value: boolean): void {
    this.emit((query) => {
      if (value) query[key] = true
      else delete query[key]
    })
  }
  setReturning(columns: string[]): void {
    this.emit((query) => {
      if (columns.length) query.returning = columns
      else delete query.returning
    })
  }

  openJson(): void {
    this.jsonDraft.set(JSON.stringify(this.query(), null, 2))
    this.jsonError.set('')
    this.showJson.set(true)
  }
  applyJson(): void {
    try {
      const parsed = JSON.parse(this.jsonDraft()) as QueryDef
      const source = this.source()
      if (source)
        compileQuery(parsed, source.type, this.sample() ?? {}, source.schema)
      this.queryChange.emit(parsed)
      this.showJson.set(false)
    } catch (error) {
      this.jsonError.set(
        error instanceof Error ? error.message : 'Invalid query.',
      )
    }
  }
}
