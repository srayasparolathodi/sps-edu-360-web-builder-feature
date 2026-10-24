/**
 * Query engine: turns a structured JSON query definition into parameterized
 * SQL for a given dialect. Authors never write SQL; values always come from
 * JSON Logic and are bound as parameters, identifiers are validated (and
 * checked against the real schema when known), and functions are allow-listed.
 *
 * Supported: joins (inner/left/right/full/cross, self-joins via aliases),
 * nested and/or/not filters, IN lists and subqueries, EXISTS, BETWEEN, LIKE,
 * CASE, arithmetic, aggregates with GROUP BY/HAVING, window functions,
 * CTEs (WITH), subqueries as tables, UNION/INTERSECT/EXCEPT, CAST, paging,
 * insert (values, many rows, from a select), update, delete, upsert, RETURNING.
 */
import { Logic, evaluate, isLogic, validateLogic } from './logic'

export type Dialect = 'postgres' | 'mysql'

export interface TableRef {
  table?: string
  schema?: string
  alias?: string
  /** A sub-query used as a table; needs an alias. */
  subquery?: QueryDef
}

export type WindowFunction =
  | 'row_number'
  | 'rank'
  | 'dense_rank'
  | 'sum'
  | 'avg'
  | 'count'
  | 'min'
  | 'max'
  | 'lag'
  | 'lead'
export type CastType =
  'text' | 'integer' | 'decimal' | 'date' | 'datetime' | 'boolean'

export interface OrderItem {
  expr: Expr
  direction?: 'asc' | 'desc'
  nulls?: 'first' | 'last'
}

export type Expr =
  | { column: string }
  | { value: Logic }
  | { fn: SqlFunction; args?: Expr[]; distinct?: boolean }
  | { op: '+' | '-' | '*' | '/' | '%'; left: Expr; right: Expr }
  | { case: { when: Condition; then: Expr }[]; else?: Expr }
  | { subquery: QueryDef }
  | { star: true }
  | {
      window: WindowFunction
      args?: Expr[]
      partitionBy?: Expr[]
      orderBy?: OrderItem[]
    }
  | { cast: Expr; to: CastType }

export type CompareOp =
  '=' | '!=' | '<' | '<=' | '>' | '>=' | 'like' | 'notLike' | 'ilike'

export type Condition =
  | { and: Condition[] }
  | { or: Condition[] }
  | { not: Condition }
  | { compare: CompareOp; left: Expr; right: Expr }
  | {
      in: Expr
      values?: Expr[]
      list?: Logic
      subquery?: QueryDef
      negate?: boolean
    }
  | { between: Expr; low: Expr; high: Expr; negate?: boolean }
  | { isNull: Expr; negate?: boolean }
  | { exists: QueryDef; negate?: boolean }
  /** Optional filter: only applied when the logic is true (e.g. a search box has text). */
  | { when: Logic; then: Condition }

export type JoinType = 'inner' | 'left' | 'right' | 'full' | 'cross'

export interface QueryDef {
  operation: 'select' | 'insert' | 'update' | 'delete' | 'upsert'
  /** Named sub-results usable as tables in the rest of the query. */
  with?: { name: string; query: QueryDef }[]
  from: TableRef
  distinct?: boolean
  /** Empty or missing means all columns. */
  fields?: { expr: Expr; as?: string }[]
  joins?: { type: JoinType; table: TableRef; on?: Condition }[]
  where?: Condition
  groupBy?: Expr[]
  having?: Condition
  /** Combine with other selects; order/limit then apply to the combined result. */
  union?: {
    type: 'union' | 'unionAll' | 'intersect' | 'except'
    query: QueryDef
  }[]
  orderBy?: OrderItem[]
  limit?: Logic
  offset?: Logic
  /** insert/upsert (one row) and update: column values. */
  set?: { column: string; value: Expr }[]
  /** insert/upsert many rows: logic returning a list of objects keyed by column. */
  rows?: Logic
  /** insert rows produced by a select into these columns. */
  select?: QueryDef
  columns?: string[]
  /** upsert: columns that identify an existing row (a unique key). */
  conflict?: string[]
  /** upsert: columns to overwrite when the row exists; default all non-key columns. */
  updateOnConflict?: string[]
  /** Columns to return after insert/update/delete (Postgres). */
  returning?: string[]
  /** Allow update/delete without a where clause. */
  allowAllRows?: boolean
}

export interface CompiledQuery {
  sql: string
  params: unknown[]
  /** True for select; used to enforce read-only data sources. */
  readOnly: boolean
}

/** Known tables and their columns, from the database itself. */
export type SchemaMap = Record<string, string[]>

export class QueryError extends Error {}

export const SQL_FUNCTIONS = {
  count: { label: 'Count', aggregate: true },
  sum: { label: 'Sum', aggregate: true },
  avg: { label: 'Average', aggregate: true },
  min: { label: 'Smallest', aggregate: true },
  max: { label: 'Largest', aggregate: true },
  lower: { label: 'Lowercase', aggregate: false },
  upper: { label: 'Uppercase', aggregate: false },
  trim: { label: 'Trim', aggregate: false },
  length: { label: 'Length', aggregate: false },
  concat: { label: 'Join text', aggregate: false },
  substring: { label: 'Part of text', aggregate: false },
  replace: { label: 'Replace text', aggregate: false },
  coalesce: { label: 'First non-empty', aggregate: false },
  nullif: { label: 'Empty if equal', aggregate: false },
  round: { label: 'Round', aggregate: false },
  abs: { label: 'Absolute', aggregate: false },
  now: { label: 'Now', aggregate: false },
  year: { label: 'Year of', aggregate: false },
  month: { label: 'Month of', aggregate: false },
  day: { label: 'Day of', aggregate: false },
  date: { label: 'Date part', aggregate: false },
  addDays: { label: 'Add days', aggregate: false },
  daysBetween: { label: 'Days between', aggregate: false },
} as const
export type SqlFunction = keyof typeof SQL_FUNCTIONS

export const WINDOW_FUNCTIONS: { fn: WindowFunction; label: string }[] = [
  { fn: 'row_number', label: 'Row number' },
  { fn: 'rank', label: 'Rank (gaps on ties)' },
  { fn: 'dense_rank', label: 'Rank (no gaps)' },
  { fn: 'sum', label: 'Running / group total' },
  { fn: 'avg', label: 'Running / group average' },
  { fn: 'count', label: 'Running / group count' },
  { fn: 'min', label: 'Group smallest' },
  { fn: 'max', label: 'Group largest' },
  { fn: 'lag', label: 'Previous row value' },
  { fn: 'lead', label: 'Next row value' },
]

const IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/
const DEFAULT_LIMIT = 1000
const MAX_LIMIT = 10_000
const MAX_DEPTH = 8
const TRUE = 'TRUE_PLACEHOLDER'
/** Scope marker for tables whose columns aren't known (CTEs, sub-queries). */
const DYNAMIC = '\u0000dynamic'

const isObj = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

class Compiler {
  readonly params: unknown[] = []
  /** alias or table name → real table name (or DYNAMIC), for schema checks. */
  private readonly scopes: Map<string, string>[] = []
  /** Names defined with WITH, usable as tables. */
  private readonly ctes = new Set<string>()

  constructor(
    private readonly dialect: Dialect,
    private readonly data: unknown,
    private readonly schema?: SchemaMap,
  ) {}

  private ident(name: string, what: string): string {
    if (typeof name !== 'string' || !IDENT.test(name))
      throw new QueryError(`"${name}" is not a valid ${what} name.`)
    return this.dialect === 'mysql' ? `\`${name}\`` : `"${name}"`
  }

  private bind(value: unknown): string {
    if (value !== null && typeof value === 'object' && !(value instanceof Date))
      throw new QueryError(
        'A value must be text, a number, yes/no, a date or empty — not a list or object.',
      )
    this.params.push(value === undefined ? null : value)
    return this.dialect === 'postgres' ? `$${this.params.length}` : '?'
  }

  private value(logic: Logic): unknown {
    const problems = validateLogic(logic)
    if (problems.length) throw new QueryError(problems[0])
    return isLogic(logic) ? evaluate(logic, this.data) : logic
  }

  /** Registers a table in the current scope and returns its SQL. */
  private table(ref: TableRef, depth: number): string {
    if (!ref || typeof ref !== 'object') throw new QueryError('Choose a table.')
    const scope = this.scopes.at(-1)!
    if (ref.subquery) {
      if (!ref.alias)
        throw new QueryError(
          'A sub-query used as a table needs a name (alias).',
        )
      if (scope.has(ref.alias))
        throw new QueryError(
          `"${ref.alias}" is used twice; give one of them a different alias.`,
        )
      const sql = `(${this.select(ref.subquery, depth + 1)}) AS ${this.ident(ref.alias, 'alias')}`
      scope.set(ref.alias, DYNAMIC)
      return sql
    }
    if (typeof ref.table !== 'string' || !ref.table)
      throw new QueryError('Choose a table.')
    const isCte = this.ctes.has(ref.table) && !ref.schema
    if (!isCte && this.schema && !(ref.table in this.schema))
      throw new QueryError(`Table "${ref.table}" does not exist.`)
    const key = ref.alias ?? ref.table
    if (scope.has(key))
      throw new QueryError(
        `"${key}" is used twice; give one of them a different alias.`,
      )
    scope.set(key, isCte ? DYNAMIC : ref.table)
    const name =
      (ref.schema ? `${this.ident(ref.schema, 'schema')}.` : '') +
      this.ident(ref.table, 'table')
    return ref.alias ? `${name} AS ${this.ident(ref.alias, 'alias')}` : name
  }

  private column(path: string): string {
    if (typeof path !== 'string' || !path)
      throw new QueryError('Choose a column.')
    const parts = path.split('.')
    if (parts.length > 2)
      throw new QueryError(`"${path}" should be "column" or "table.column".`)
    const [owner, column] = parts.length === 2 ? parts : [undefined, parts[0]]
    if (this.schema) {
      // Look the owner up from the innermost scope outwards (correlated sub-queries).
      const owners = owner
        ? [...this.scopes]
            .reverse()
            .map((scope) => scope.get(owner))
            .filter((t): t is string => !!t)
            .slice(0, 1)
        : [...new Set(this.scopes.flatMap((scope) => [...scope.values()]))]
      if (owner && !owners.length)
        throw new QueryError(`"${owner}" is not a table in this query.`)
      const known = owners.some(
        (table) => table === DYNAMIC || this.schema![table]?.includes(column),
      )
      if (!known) throw new QueryError(`Column "${path}" does not exist.`)
    }
    return owner
      ? `${this.ident(owner, 'table')}.${this.ident(column, 'column')}`
      : this.ident(column, 'column')
  }

  private order(items: OrderItem[], depth: number): string {
    return items
      .map((order) => {
        const direction = order.direction === 'desc' ? 'DESC' : 'ASC'
        const expr = this.expr(order.expr, depth + 1)
        if (!order.nulls) return `${expr} ${direction}`
        // MySQL has no NULLS FIRST/LAST; emulate it with an IS NULL sort key.
        return this.dialect === 'postgres'
          ? `${expr} ${direction} NULLS ${order.nulls.toUpperCase()}`
          : `${expr} IS NULL ${order.nulls === 'first' ? 'DESC' : 'ASC'}, ${expr} ${direction}`
      })
      .join(', ')
  }

  expr(expr: Expr, depth: number): string {
    if (depth > MAX_DEPTH * 4)
      throw new QueryError('The query is nested too deeply.')
    if (!isObj(expr))
      throw new QueryError(
        'Each part of the query needs a column, a value or a calculation.',
      )
    if ('column' in expr) return this.column(expr.column)
    if ('value' in expr) return this.bind(this.value(expr.value))
    if ('star' in expr) return '*'
    if ('fn' in expr) {
      if (!SQL_FUNCTIONS[expr.fn as SqlFunction])
        throw new QueryError(`"${String(expr.fn)}" is not an allowed function.`)
      return this.fn(
        expr.fn,
        (expr.args ?? []).map((arg) => this.expr(arg, depth + 1)),
        !!expr.distinct,
      )
    }
    if ('op' in expr) {
      if (!['+', '-', '*', '/', '%'].includes(expr.op))
        throw new QueryError('Unknown arithmetic.')
      return `(${this.expr(expr.left, depth + 1)} ${expr.op} ${this.expr(expr.right, depth + 1)})`
    }
    if ('case' in expr) {
      if (!Array.isArray(expr.case) || !expr.case.length)
        throw new QueryError('Add at least one "when" to the case.')
      const whens = expr.case.map(
        (item) =>
          `WHEN ${this.solid(this.condition(item.when, depth + 1))} THEN ${this.expr(item.then, depth + 1)}`,
      )
      return `CASE ${whens.join(' ')}${expr.else ? ` ELSE ${this.expr(expr.else, depth + 1)}` : ''} END`
    }
    if ('subquery' in expr) return `(${this.select(expr.subquery, depth + 1)})`
    if ('window' in expr) return this.window(expr, depth)
    if ('cast' in expr)
      return this.cast(this.expr(expr.cast, depth + 1), expr.to)
    throw new QueryError('Unknown query part.')
  }

  private window(
    expr: Extract<Expr, { window: WindowFunction }>,
    depth: number,
  ): string {
    const fn = WINDOW_FUNCTIONS.find((item) => item.fn === expr.window)
    if (!fn)
      throw new QueryError(
        `"${String(expr.window)}" is not an allowed window function.`,
      )
    const args = (expr.args ?? []).map((arg) => this.expr(arg, depth + 1))
    const ranking = ['row_number', 'rank', 'dense_rank'].includes(expr.window)
    if (ranking && args.length)
      throw new QueryError(`${fn.label} takes no inputs.`)
    if (!ranking && expr.window !== 'count' && !args.length)
      throw new QueryError(`${fn.label} needs a column.`)
    if ((expr.window === 'lag' || expr.window === 'lead') && args.length > 2)
      throw new QueryError(`${fn.label} takes a column and an optional offset.`)
    if (!ranking && !['lag', 'lead'].includes(expr.window) && args.length > 1)
      throw new QueryError(`${fn.label} takes one column.`)
    if (
      (ranking || expr.window === 'lag' || expr.window === 'lead') &&
      !expr.orderBy?.length
    )
      throw new QueryError(`${fn.label} needs a sort order.`)
    const call = `${expr.window.toUpperCase()}(${args.join(', ') || (expr.window === 'count' ? '*' : '')})`
    const partition = expr.partitionBy?.length
      ? `PARTITION BY ${expr.partitionBy.map((item) => this.expr(item, depth + 1)).join(', ')}`
      : ''
    const order = expr.orderBy?.length
      ? `ORDER BY ${this.order(expr.orderBy, depth)}`
      : ''
    return `${call} OVER (${[partition, order].filter(Boolean).join(' ')})`
  }

  private cast(sql: string, to: CastType): string {
    const types: Record<Dialect, Record<CastType, string | null>> = {
      postgres: {
        text: 'TEXT',
        integer: 'INTEGER',
        decimal: 'NUMERIC',
        date: 'DATE',
        datetime: 'TIMESTAMP',
        boolean: 'BOOLEAN',
      },
      mysql: {
        text: 'CHAR',
        integer: 'SIGNED',
        decimal: 'DECIMAL(18,4)',
        date: 'DATE',
        datetime: 'DATETIME',
        boolean: null,
      },
    }
    const type = types[this.dialect][to]
    if (type === undefined)
      throw new QueryError(`Can't convert to "${String(to)}".`)
    if (type === null)
      throw new QueryError(
        'MySQL has no yes/no type; compare with 1 or 0 instead.',
      )
    return `CAST(${sql} AS ${type})`
  }

  private fn(name: SqlFunction, args: string[], distinct: boolean): string {
    const label = SQL_FUNCTIONS[name].label
    const count = (min: number, max = min) => {
      if (args.length < min || args.length > max)
        throw new QueryError(
          min === max
            ? `${label} needs exactly ${min} input${min === 1 ? '' : 's'}.`
            : `${label} needs ${min} to ${max} inputs.`,
        )
    }
    const mysql = this.dialect === 'mysql'
    switch (name) {
      case 'count':
        count(0, 1)
        return `COUNT(${distinct ? 'DISTINCT ' : ''}${args[0] ?? '*'})`
      case 'sum':
      case 'avg':
      case 'min':
      case 'max':
        count(1)
        return `${name.toUpperCase()}(${distinct ? 'DISTINCT ' : ''}${args[0]})`
      case 'lower':
      case 'upper':
      case 'trim':
      case 'abs':
        count(1)
        return `${name.toUpperCase()}(${args[0]})`
      case 'length':
        count(1)
        return mysql ? `CHAR_LENGTH(${args[0]})` : `LENGTH(${args[0]})`
      case 'concat':
        count(1, 50)
        return `CONCAT(${args.join(', ')})`
      case 'substring':
        count(2, 3)
        return `SUBSTRING(${args.join(', ')})`
      case 'replace':
        count(3)
        return `REPLACE(${args.join(', ')})`
      case 'coalesce':
        count(1, 50)
        return `COALESCE(${args.join(', ')})`
      case 'nullif':
        count(2)
        return `NULLIF(${args.join(', ')})`
      case 'round':
        count(1, 2)
        return `ROUND(${args.join(', ')})`
      case 'now':
        count(0)
        return 'NOW()'
      case 'year':
      case 'month':
      case 'day':
        count(1)
        return mysql
          ? `${name.toUpperCase()}(${args[0]})`
          : `EXTRACT(${name.toUpperCase()} FROM ${args[0]})`
      case 'date':
        count(1)
        return mysql ? `DATE(${args[0]})` : `(${args[0]})::date`
      case 'addDays':
        count(2)
        return mysql
          ? `DATE_ADD(${args[0]}, INTERVAL ${args[1]} DAY)`
          : `(${args[0]} + (${args[1]}) * INTERVAL '1 day')`
      case 'daysBetween':
        count(2)
        return mysql
          ? `DATEDIFF(${args[1]}, ${args[0]})`
          : `((${args[1]})::date - (${args[0]})::date)`
    }
  }

  /** Turns the "no filter" marker into always-true where a condition is required. */
  private solid(sql: string): string {
    return sql === TRUE ? '1 = 1' : sql
  }

  condition(condition: Condition, depth: number): string {
    if (depth > MAX_DEPTH * 4)
      throw new QueryError('The filters are nested too deeply.')
    if (!isObj(condition)) throw new QueryError('A filter is incomplete.')
    if ('when' in condition)
      return this.value(condition.when)
        ? this.condition(condition.then, depth + 1)
        : TRUE
    if ('and' in condition || 'or' in condition) {
      const items = ('and' in condition ? condition.and : condition.or) ?? []
      const parts = items
        .map((item) => this.condition(item, depth + 1))
        .filter((part) => part !== TRUE)
      if (!parts.length) return TRUE
      return parts.length === 1
        ? parts[0]
        : `(${parts.join('and' in condition ? ' AND ' : ' OR ')})`
    }
    if ('not' in condition) {
      const inner = this.condition(condition.not, depth + 1)
      return inner === TRUE ? inner : `NOT (${inner})`
    }
    if ('compare' in condition) {
      const left = this.expr(condition.left, depth + 1)
      const right = this.expr(condition.right, depth + 1)
      switch (condition.compare) {
        case '=':
        case '!=':
        case '<':
        case '<=':
        case '>':
        case '>=':
          return `${left} ${condition.compare === '!=' ? '<>' : condition.compare} ${right}`
        case 'like':
          return `${left} LIKE ${right}`
        case 'notLike':
          return `${left} NOT LIKE ${right}`
        case 'ilike':
          return this.dialect === 'postgres'
            ? `${left} ILIKE ${right}`
            : `LOWER(${left}) LIKE LOWER(${right})`
        default:
          throw new QueryError('Unknown comparison.')
      }
    }
    if ('in' in condition) {
      const left = this.expr(condition.in, depth + 1)
      const not = condition.negate ? 'NOT ' : ''
      if (condition.subquery)
        return `${left} ${not}IN (${this.select(condition.subquery, depth + 1)})`
      const items = condition.values
        ? condition.values.map((value) => this.expr(value, depth + 1))
        : (() => {
            const list = this.value(condition.list ?? [])
            if (!Array.isArray(list))
              throw new QueryError('"Is one of" needs a list.')
            if (list.length > 1000)
              throw new QueryError('"Is one of" accepts at most 1000 values.')
            return list.map((value) => this.bind(value))
          })()
      // An empty list matches nothing (or everything when negated).
      if (!items.length) return condition.negate ? '1 = 1' : '1 = 0'
      return `${left} ${not}IN (${items.join(', ')})`
    }
    if ('between' in condition)
      return `${this.expr(condition.between, depth + 1)} ${condition.negate ? 'NOT ' : ''}BETWEEN ${this.expr(condition.low, depth + 1)} AND ${this.expr(condition.high, depth + 1)}`
    if ('isNull' in condition)
      return `${this.expr(condition.isNull, depth + 1)} IS ${condition.negate ? 'NOT ' : ''}NULL`
    if ('exists' in condition)
      return `${condition.negate ? 'NOT ' : ''}EXISTS (${this.select(condition.exists, depth + 1)})`
    throw new QueryError('Unknown filter.')
  }

  private where(condition: Condition | undefined, depth: number): string {
    if (!condition) return ''
    const sql = this.condition(condition, depth)
    return sql === TRUE ? '' : ` WHERE ${sql}`
  }

  private number(
    logic: Logic | undefined,
    fallback: number | undefined,
    max: number,
    label: string,
  ): number | undefined {
    if (logic === undefined || logic === null || logic === '') return fallback
    const value = Number(this.value(logic))
    if (!Number.isInteger(value) || value < 0)
      throw new QueryError(`${label} must be a whole number of 0 or more.`)
    return Math.min(value, max)
  }

  private paging(def: QueryDef, top: boolean): string {
    const limit = this.number(
      def.limit,
      top ? DEFAULT_LIMIT : undefined,
      MAX_LIMIT,
      'Row limit',
    )
    const offset = this.number(def.offset, undefined, 10_000_000, 'Skip rows')
    let sql = ''
    if (limit !== undefined) sql += ` LIMIT ${this.bind(limit)}`
    if (offset)
      sql += `${limit === undefined && this.dialect === 'mysql' ? ` LIMIT ${this.bind(MAX_LIMIT)}` : ''} OFFSET ${this.bind(offset)}`
    return sql
  }

  /** WITH clause; CTE names become usable tables for the rest of the query. */
  private with(def: QueryDef, depth: number): string {
    if (!def.with?.length) return ''
    const parts = def.with.map((cte) => {
      const name = this.ident(cte.name, 'named result')
      const sql = `${name} AS (${this.select(cte.query, depth + 1)})`
      this.ctes.add(cte.name)
      return sql
    })
    return `WITH ${parts.join(', ')} `
  }

  /** The SELECT … HAVING part, without union, order or paging. */
  private core(def: QueryDef, depth: number): string {
    this.scopes.push(new Map())
    try {
      const from = this.table(def.from, depth)
      const joins = (def.joins ?? []).map((join) => {
        const kind = {
          inner: 'INNER',
          left: 'LEFT',
          right: 'RIGHT',
          full: 'FULL',
          cross: 'CROSS',
        }[join.type]
        if (!kind) throw new QueryError('Unknown join type.')
        if (kind === 'FULL' && this.dialect === 'mysql')
          throw new QueryError('MySQL does not support full joins.')
        if (kind !== 'CROSS' && !join.on)
          throw new QueryError('Say how the tables match (the "on" part).')
        return { kind, join, table: this.table(join.table, depth) }
      })
      // Every table is registered first so columns resolve; then each part is
      // compiled in SQL text order, because MySQL's "?" placeholders are positional.
      const fields = def.fields?.length
        ? def.fields
            .map(
              (field) =>
                this.expr(field.expr, depth + 1) +
                (field.as ? ` AS ${this.ident(field.as, 'result')}` : ''),
            )
            .join(', ')
        : '*'
      const joinSql = joins
        .map(({ kind, join, table }) =>
          kind === 'CROSS'
            ? ` CROSS JOIN ${table}`
            : ` ${kind} JOIN ${table} ON ${this.solid(this.condition(join.on!, depth + 1))}`,
        )
        .join('')
      let sql = `SELECT ${def.distinct ? 'DISTINCT ' : ''}${fields} FROM ${from}${joinSql}${this.where(def.where, depth + 1)}`
      if (def.groupBy?.length)
        sql += ` GROUP BY ${def.groupBy.map((expr) => this.expr(expr, depth + 1)).join(', ')}`
      if (def.having) {
        const having = this.condition(def.having, depth + 1)
        if (having !== TRUE) sql += ` HAVING ${having}`
      }
      return sql
    } finally {
      this.scopes.pop()
    }
  }

  select(def: QueryDef, depth: number, top = false): string {
    if (depth > MAX_DEPTH) throw new QueryError('Too many nested sub-queries.')
    if (!isObj(def) || def.operation !== 'select')
      throw new QueryError('Sub-queries must be selects.')
    const withSql = this.with(def, depth)
    let sql = this.core(def, depth)
    if (def.union?.length) {
      const words = {
        union: 'UNION',
        unionAll: 'UNION ALL',
        intersect: 'INTERSECT',
        except: 'EXCEPT',
      }
      sql = `(${sql})`
      for (const part of def.union) {
        if (!words[part.type])
          throw new QueryError('Unknown way to combine results.')
        if (
          (part.type === 'intersect' || part.type === 'except') &&
          this.dialect === 'mysql'
        )
          throw new QueryError(
            'This MySQL version may not support INTERSECT/EXCEPT; use a filter with "is one of" instead.',
          )
        sql += ` ${words[part.type]} (${this.select(part.query, depth + 1)})`
      }
    }
    // Order and paging of the combined result use the outer scope's names.
    this.scopes.push(
      new Map(def.union?.length ? [['*', DYNAMIC]] : this.lastScopeOf(def)),
    )
    try {
      if (def.orderBy?.length)
        sql += ` ORDER BY ${this.order(def.orderBy, depth)}`
      return withSql + sql + this.paging(def, top)
    } finally {
      this.scopes.pop()
    }
  }

  /** Re-creates the table names of a select so ORDER BY can reference them. */
  private lastScopeOf(def: QueryDef): [string, string][] {
    const refs = [def.from, ...(def.joins ?? []).map((join) => join.table)]
    const entries: [string, string][] = refs.map((ref) => [
      ref.alias ?? ref.table ?? '',
      ref.subquery || (ref.table && this.ctes.has(ref.table))
        ? DYNAMIC
        : (ref.table ?? ''),
    ])
    // Result names (AS …) can be sorted on too.
    if (def.fields?.some((field) => field.as)) entries.push(['', DYNAMIC])
    return entries
  }

  private returning(def: QueryDef): string {
    if (!def.returning?.length) return ''
    if (this.dialect === 'mysql')
      throw new QueryError('MySQL cannot return rows after a change.')
    return ` RETURNING ${def.returning.map((column) => this.column(column)).join(', ')}`
  }

  /** Column list and VALUES for insert/upsert; returns the column names used. */
  private values(def: QueryDef): { sql: string; columns: string[] } {
    if (def.select) {
      if (!def.columns?.length)
        throw new QueryError('Choose which columns the selected rows fill.')
      const columns = def.columns
        .map((column) => this.column(column))
        .join(', ')
      return {
        sql: ` (${columns}) ${this.select(def.select, 1)}`,
        columns: def.columns,
      }
    }
    if (def.rows !== undefined) {
      const rows = this.value(def.rows)
      if (!Array.isArray(rows) || !rows.length)
        throw new QueryError('Rows to add must be a non-empty list.')
      if (rows.length > 1000)
        throw new QueryError('Add at most 1000 rows at a time.')
      const columns = [
        ...new Set(rows.flatMap((row) => (isObj(row) ? Object.keys(row) : []))),
      ]
      if (!columns.length)
        throw new QueryError('Each row needs at least one column.')
      const columnSql = columns.map((column) => this.column(column)).join(', ')
      const values = rows.map(
        (row) =>
          `(${columns.map((column) => this.bind((row as Record<string, unknown>)[column] ?? null)).join(', ')})`,
      )
      return { sql: ` (${columnSql}) VALUES ${values.join(', ')}`, columns }
    }
    if (!def.set?.length) throw new QueryError('Choose the columns to fill in.')
    const columns = def.set.map((item) => this.column(item.column)).join(', ')
    const values = def.set.map((item) => this.expr(item.value, 1)).join(', ')
    return {
      sql: ` (${columns}) VALUES (${values})`,
      columns: def.set.map((item) => item.column),
    }
  }

  write(def: QueryDef): string {
    const withSql = this.with(def, 0)
    this.scopes.push(new Map())
    try {
      const table = this.table({ ...def.from, alias: undefined }, 0)
      if (def.operation === 'insert' || def.operation === 'upsert') {
        const { sql, columns } = this.values(def)
        let tail = ''
        if (def.operation === 'upsert') {
          if (!def.conflict?.length)
            throw new QueryError(
              'Choose the column(s) that identify an existing row.',
            )
          const keys = def.conflict.map((column) => this.column(column))
          const updates = (
            def.updateOnConflict ??
            columns.filter((column) => !def.conflict!.includes(column))
          ).map((column) => this.column(column))
          tail =
            this.dialect === 'postgres'
              ? ` ON CONFLICT (${keys.join(', ')}) ${updates.length ? `DO UPDATE SET ${updates.map((column) => `${column} = EXCLUDED.${column}`).join(', ')}` : 'DO NOTHING'}`
              : ` ON DUPLICATE KEY UPDATE ${(updates.length ? updates : keys.slice(0, 1)).map((column) => `${column} = VALUES(${column})`).join(', ')}`
        }
        return `${withSql}INSERT INTO ${table}${sql}${tail}${this.returning(def)}`
      }
      // Parts are compiled in SQL order: MySQL's "?" placeholders are positional.
      let sets = ''
      if (def.operation === 'update') {
        if (!def.set?.length)
          throw new QueryError('Choose the columns to change.')
        sets = def.set
          .map(
            (item) =>
              `${this.column(item.column)} = ${this.expr(item.value, 1)}`,
          )
          .join(', ')
      }
      const where = this.where(def.where, 1)
      if (!where && !def.allowAllRows)
        throw new QueryError(
          `Add a filter so only some rows are ${def.operation === 'delete' ? 'deleted' : 'changed'}, or allow changing all rows.`,
        )
      if (def.operation === 'update')
        return `${withSql}UPDATE ${table} SET ${sets}${where}${this.returning(def)}`
      return `${withSql}DELETE FROM ${table}${where}${this.returning(def)}`
    } finally {
      this.scopes.pop()
    }
  }
}

/** Compiles a query definition; `data` is what its JSON Logic values can read. */
export function compileQuery(
  def: QueryDef,
  dialect: Dialect,
  data: unknown = {},
  schema?: SchemaMap,
): CompiledQuery {
  if (!isObj(def)) throw new QueryError('The query is empty.')
  const compiler = new Compiler(dialect, data, schema)
  if (def.operation === 'select')
    return {
      sql: compiler.select(def, 0, true),
      params: compiler.params,
      readOnly: true,
    }
  if (['insert', 'update', 'delete', 'upsert'].includes(def.operation))
    return {
      sql: compiler.write(def),
      params: compiler.params,
      readOnly: false,
    }
  throw new QueryError(
    'Choose what the query does: read, add, change, add-or-update or delete rows.',
  )
}

/** Readable SQL for the builder's preview, with parameters shown inline. */
export function previewSql(compiled: CompiledQuery): string {
  let index = 0
  return compiled.sql.replace(/\$\d+|\?/g, () => {
    const value = compiled.params[index++]
    return value === null
      ? 'NULL'
      : typeof value === 'string'
        ? `'${value.replace(/'/g, "''")}'`
        : String(value)
  })
}

/** Checks a query's shape without values, for validation while editing. */
export function validateQuery(
  def: QueryDef,
  dialect: Dialect,
  schema?: SchemaMap,
): string[] {
  try {
    compileQuery(def, dialect, new Proxy({}, { get: () => undefined }), schema)
    return []
  } catch (error) {
    // Errors caused only by missing sample data are fine at design time.
    if (
      error instanceof QueryError &&
      /must be a whole number|needs a list|non-empty list/.test(error.message)
    )
      return []
    return [error instanceof Error ? error.message : 'Invalid query.']
  }
}
