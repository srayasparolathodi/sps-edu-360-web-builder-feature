import { LogicEngine } from 'json-logic-engine'

/** Any JSON value. Objects with a single operator key are evaluated as logic. */
export type Logic = unknown

export class LogicError extends Error {}

const FORBIDDEN_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor'])
const MAX_NODES = 5000
const MAX_DEPTH = 64
const MAX_TEXT = 100_000
const MAX_LIST = 10_000

type Args = unknown[]
type ArgKind = 'any' | 'number' | 'text' | 'list' | 'object' | 'logic'

export interface OperatorInfo {
  op: string
  label: string
  category: OperatorCategory
  description: string
  args: { name: string; kind: ArgKind }[]
  /** Last argument may repeat. */
  variadic?: boolean
  /** Short symbol or word used in plain-language summaries. */
  symbol?: string
}

export type OperatorCategory =
  | 'Data'
  | 'Compare'
  | 'Logic'
  | 'Math'
  | 'Text'
  | 'Lists'
  | 'Objects'
  | 'Dates'
  | 'Convert'

export const OPERATOR_CATEGORIES: OperatorCategory[] = [
  'Data',
  'Compare',
  'Logic',
  'Math',
  'Text',
  'Lists',
  'Objects',
  'Dates',
  'Convert',
]

// ---------------------------------------------------------------------------
// Helpers shared by the custom operators. They never call values as
// functions and only read own properties, so logic cannot reach prototypes.
// ---------------------------------------------------------------------------

const num = (value: unknown): number => {
  if (typeof value === 'number') return value
  if (typeof value === 'boolean') return value ? 1 : 0
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value.replace(/,/g, ''))
    return Number.isFinite(parsed) ? parsed : NaN
  }
  return NaN
}
const text = (value: unknown): string => {
  if (value === null || value === undefined) return ''
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])
const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
const limitText = (value: string): string => {
  if (value.length > MAX_TEXT) throw new LogicError('Text is too long.')
  return value
}
const limitList = <T>(value: T[]): T[] => {
  if (value.length > MAX_LIST) throw new LogicError('List is too long.')
  return value
}

export function readPath(source: unknown, path: string): unknown {
  if (path === '' || path === undefined) return source
  let current = source
  for (const segment of String(path).split('.')) {
    if (FORBIDDEN_SEGMENTS.has(segment)) return undefined
    if (current === null || current === undefined) return undefined
    if (Array.isArray(current)) {
      const index = Number(segment)
      current = Number.isInteger(index) ? current[index] : undefined
    } else if (
      typeof current === 'object' &&
      Object.prototype.hasOwnProperty.call(current, segment)
    ) {
      current = (current as Record<string, unknown>)[segment]
    } else return undefined
  }
  return current
}

function writePath(source: unknown, path: string, value: unknown): unknown {
  const segments = String(path).split('.').filter(Boolean)
  if (!segments.length) return value
  if (segments.some((segment) => FORBIDDEN_SEGMENTS.has(segment)))
    throw new LogicError('That property name is not allowed.')
  const root: Record<string, unknown> = isObject(source)
    ? structuredClone(source)
    : {}
  let current = root
  segments.slice(0, -1).forEach((segment) => {
    if (!isObject(current[segment])) current[segment] = {}
    current = current[segment] as Record<string, unknown>
  })
  current[segments.at(-1)!] = value
  return root
}

const toDate = (value: unknown): Date => {
  if (value instanceof Date) return value
  if (typeof value === 'number') return new Date(value)
  const date = new Date(text(value))
  if (Number.isNaN(date.getTime()))
    throw new LogicError(`"${text(value)}" is not a valid date.`)
  return date
}
const UNIT_MS: Record<string, number> = {
  seconds: 1000,
  minutes: 60_000,
  hours: 3_600_000,
  days: 86_400_000,
  weeks: 604_800_000,
}
function addToDate(value: unknown, amount: unknown, unit: unknown): string {
  const date = toDate(value)
  const count = num(amount)
  if (!Number.isFinite(count)) throw new LogicError('Amount must be a number.')
  const name = text(unit) || 'days'
  if (name === 'months') date.setMonth(date.getMonth() + count)
  else if (name === 'years') date.setFullYear(date.getFullYear() + count)
  else if (UNIT_MS[name]) date.setTime(date.getTime() + count * UNIT_MS[name])
  else throw new LogicError(`Unknown date unit "${name}".`)
  return date.toISOString()
}
function dateDifference(from: unknown, to: unknown, unit: unknown): number {
  const start = toDate(from)
  const end = toDate(to)
  const name = text(unit) || 'days'
  if (name === 'months' || name === 'years') {
    const months =
      (end.getFullYear() - start.getFullYear()) * 12 +
      (end.getMonth() - start.getMonth()) -
      (end.getDate() < start.getDate() ? 1 : 0)
    return name === 'years' ? Math.trunc(months / 12) : months
  }
  if (!UNIT_MS[name]) throw new LogicError(`Unknown date unit "${name}".`)
  return Math.trunc((end.getTime() - start.getTime()) / UNIT_MS[name])
}
function formatDate(value: unknown, style: unknown, locale: unknown): string {
  const date = toDate(value)
  const name = text(style) || 'medium'
  if (name === 'iso') return date.toISOString()
  if (name === 'date') return date.toISOString().slice(0, 10)
  const options: Intl.DateTimeFormatOptions =
    name === 'time'
      ? { timeStyle: 'short' }
      : name === 'datetime'
        ? { dateStyle: 'medium', timeStyle: 'short' }
        : { dateStyle: name as 'short' | 'medium' | 'long' | 'full' }
  try {
    return new Intl.DateTimeFormat(text(locale) || undefined, options).format(
      date,
    )
  } catch {
    throw new LogicError(`Unknown date format "${name}".`)
  }
}

function compareValues(a: unknown, b: unknown): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b
  return text(a).localeCompare(text(b), undefined, { numeric: true })
}

function safeRegex(pattern: unknown, flags: unknown): RegExp {
  const source = text(pattern)
  const options = text(flags).replace(/[^gimsu]/g, '')
  // Patterns are bounded and nested quantifiers are refused to avoid
  // catastrophic backtracking.
  if (source.length > 200 || /\([^)]*[+*][^)]*\)[+*{]/.test(source))
    throw new LogicError('That pattern is too complex.')
  try {
    return new RegExp(source, options)
  } catch {
    throw new LogicError('That pattern is not valid.')
  }
}

function template(format: unknown, values: unknown): string {
  return limitText(
    text(format).replace(/\{([a-zA-Z0-9_.]+)\}/g, (_, path: string) =>
      text(readPath(values, path)),
    ),
  )
}

const label = (value: unknown): string =>
  isObject(value)
    ? text(value['label'] ?? value['name'] ?? value['title'] ?? value['id'])
    : text(value)

// ---------------------------------------------------------------------------
// Custom operators. `fn` receives already-evaluated arguments.
// ---------------------------------------------------------------------------

interface CustomOperator extends OperatorInfo {
  fn: (args: Args) => unknown
  deterministic?: boolean
}

const custom: CustomOperator[] = [
  // Math
  {
    op: 'abs',
    label: 'Absolute value',
    category: 'Math',
    description: 'Removes the minus sign.',
    args: [{ name: 'Number', kind: 'number' }],
    fn: ([a]) => Math.abs(num(a)),
  },
  {
    op: 'round',
    label: 'Round',
    category: 'Math',
    description: 'Rounds to a number of decimal places.',
    args: [
      { name: 'Number', kind: 'number' },
      { name: 'Decimals', kind: 'number' },
    ],
    fn: ([a, d]) => {
      const f = 10 ** Math.min(Math.max(num(d) || 0, 0), 12)
      return Math.round(num(a) * f) / f
    },
  },
  {
    op: 'floor',
    label: 'Round down',
    category: 'Math',
    description: 'Rounds down to a whole number.',
    args: [{ name: 'Number', kind: 'number' }],
    fn: ([a]) => Math.floor(num(a)),
  },
  {
    op: 'ceil',
    label: 'Round up',
    category: 'Math',
    description: 'Rounds up to a whole number.',
    args: [{ name: 'Number', kind: 'number' }],
    fn: ([a]) => Math.ceil(num(a)),
  },
  {
    op: 'pow',
    label: 'Power',
    category: 'Math',
    description: 'Raises a number to a power.',
    symbol: '^',
    args: [
      { name: 'Number', kind: 'number' },
      { name: 'Power', kind: 'number' },
    ],
    fn: ([a, b]) => num(a) ** num(b),
  },
  {
    op: 'sqrt',
    label: 'Square root',
    category: 'Math',
    description: 'Square root of a number.',
    args: [{ name: 'Number', kind: 'number' }],
    fn: ([a]) => Math.sqrt(num(a)),
  },
  {
    op: 'sum',
    label: 'Sum of list',
    category: 'Math',
    description: 'Adds every number in a list.',
    args: [{ name: 'List', kind: 'list' }],
    fn: ([a]) =>
      list(a).reduce<number>((total, value) => total + (num(value) || 0), 0),
  },
  {
    op: 'avg',
    label: 'Average of list',
    category: 'Math',
    description: 'Average of the numbers in a list.',
    args: [{ name: 'List', kind: 'list' }],
    fn: ([a]) => {
      const values = list(a).map(num).filter(Number.isFinite)
      return values.length
        ? values.reduce((t, v) => t + v, 0) / values.length
        : 0
    },
  },
  {
    op: 'clamp',
    label: 'Keep between',
    category: 'Math',
    description: 'Keeps a number between a minimum and maximum.',
    args: [
      { name: 'Number', kind: 'number' },
      { name: 'Minimum', kind: 'number' },
      { name: 'Maximum', kind: 'number' },
    ],
    fn: ([a, min, max]) => Math.min(Math.max(num(a), num(min)), num(max)),
  },
  {
    op: 'percent',
    label: 'Percentage',
    category: 'Math',
    description: 'Part as a percentage of a total.',
    args: [
      { name: 'Part', kind: 'number' },
      { name: 'Total', kind: 'number' },
    ],
    fn: ([a, b]) => (num(b) ? (num(a) / num(b)) * 100 : 0),
  },
  {
    op: 'random',
    label: 'Random number',
    category: 'Math',
    description: 'Random whole number between minimum and maximum.',
    deterministic: false,
    args: [
      { name: 'Minimum', kind: 'number' },
      { name: 'Maximum', kind: 'number' },
    ],
    fn: ([min, max]) => {
      const lo = Math.ceil(num(min) || 0)
      const hi = Math.floor(num(max) || 100)
      return lo + Math.floor(Math.random() * (hi - lo + 1))
    },
  },
  {
    op: 'formatNumber',
    label: 'Format number',
    category: 'Math',
    description: 'Formats a number with separators.',
    args: [
      { name: 'Number', kind: 'number' },
      { name: 'Decimals', kind: 'number' },
      { name: 'Locale', kind: 'text' },
    ],
    fn: ([a, d, locale]) => {
      const digits = Math.min(Math.max(num(d) || 0, 0), 12)
      return new Intl.NumberFormat(text(locale) || undefined, {
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
      }).format(num(a))
    },
  },
  {
    op: 'formatCurrency',
    label: 'Format currency',
    category: 'Math',
    description: 'Formats a number as money, e.g. INR or USD.',
    args: [
      { name: 'Amount', kind: 'number' },
      { name: 'Currency code', kind: 'text' },
      { name: 'Locale', kind: 'text' },
    ],
    fn: ([a, c, locale]) => {
      try {
        return new Intl.NumberFormat(text(locale) || undefined, {
          style: 'currency',
          currency: text(c) || 'USD',
        }).format(num(a))
      } catch {
        throw new LogicError(`Unknown currency "${text(c)}".`)
      }
    },
  },

  // Text
  {
    op: 'upper',
    label: 'Uppercase',
    category: 'Text',
    description: 'MAKES TEXT UPPERCASE.',
    args: [{ name: 'Text', kind: 'text' }],
    fn: ([a]) => text(a).toUpperCase(),
  },
  {
    op: 'lower',
    label: 'Lowercase',
    category: 'Text',
    description: 'makes text lowercase.',
    args: [{ name: 'Text', kind: 'text' }],
    fn: ([a]) => text(a).toLowerCase(),
  },
  {
    op: 'trim',
    label: 'Trim spaces',
    category: 'Text',
    description: 'Removes spaces at the start and end.',
    args: [{ name: 'Text', kind: 'text' }],
    fn: ([a]) => text(a).trim(),
  },
  {
    op: 'replace',
    label: 'Replace text',
    category: 'Text',
    description: 'Replaces every occurrence of some text.',
    args: [
      { name: 'Text', kind: 'text' },
      { name: 'Find', kind: 'text' },
      { name: 'Replace with', kind: 'text' },
    ],
    fn: ([a, find, replacement]) =>
      limitText(
        text(find)
          ? text(a).split(text(find)).join(text(replacement))
          : text(a),
      ),
  },
  {
    op: 'split',
    label: 'Split text',
    category: 'Text',
    description: 'Splits text into a list.',
    args: [
      { name: 'Text', kind: 'text' },
      { name: 'Separator', kind: 'text' },
    ],
    fn: ([a, separator]) => limitList(text(a).split(text(separator ?? ','))),
  },
  {
    op: 'join',
    label: 'Join list',
    category: 'Text',
    description: 'Joins a list into text.',
    args: [
      { name: 'List', kind: 'list' },
      { name: 'Separator', kind: 'text' },
    ],
    fn: ([a, separator]) =>
      limitText(
        list(a)
          .map(text)
          .join(separator === undefined ? ', ' : text(separator)),
      ),
  },
  {
    op: 'startsWith',
    label: 'Starts with',
    category: 'Text',
    description: 'True when text starts with something.',
    args: [
      { name: 'Text', kind: 'text' },
      { name: 'Start', kind: 'text' },
    ],
    fn: ([a, b]) => text(a).startsWith(text(b)),
  },
  {
    op: 'endsWith',
    label: 'Ends with',
    category: 'Text',
    description: 'True when text ends with something.',
    args: [
      { name: 'Text', kind: 'text' },
      { name: 'End', kind: 'text' },
    ],
    fn: ([a, b]) => text(a).endsWith(text(b)),
  },
  {
    op: 'contains',
    label: 'Contains',
    category: 'Text',
    description: 'True when text or a list contains a value.',
    args: [
      { name: 'Text or list', kind: 'any' },
      { name: 'Value', kind: 'any' },
    ],
    fn: ([a, b]) =>
      Array.isArray(a)
        ? a.some((item) => item === b || text(item) === text(b))
        : text(a).toLowerCase().includes(text(b).toLowerCase()),
  },
  {
    op: 'padStart',
    label: 'Pad start',
    category: 'Text',
    description: 'Pads text to a length, e.g. 7 → 007.',
    args: [
      { name: 'Text', kind: 'text' },
      { name: 'Length', kind: 'number' },
      { name: 'Pad with', kind: 'text' },
    ],
    fn: ([a, n, pad]) =>
      text(a).padStart(Math.min(num(n) || 0, 1000), text(pad) || ' '),
  },
  {
    op: 'format',
    label: 'Fill template',
    category: 'Text',
    description: 'Fills {placeholders} in text, e.g. "Hi {name}".',
    args: [
      { name: 'Template', kind: 'text' },
      { name: 'Values', kind: 'object' },
    ],
    fn: ([a, values]) => template(a, values),
  },
  {
    op: 'slugify',
    label: 'Make URL-safe',
    category: 'Text',
    description: 'Turns text into lowercase-words-with-dashes.',
    args: [{ name: 'Text', kind: 'text' }],
    fn: ([a]) =>
      text(a)
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[^\w\s-]/g, '')
        .trim()
        .replace(/[\s_-]+/g, '-'),
  },
  {
    op: 'matches',
    label: 'Matches pattern',
    category: 'Text',
    description: 'True when text matches a pattern (regular expression).',
    args: [
      { name: 'Text', kind: 'text' },
      { name: 'Pattern', kind: 'text' },
      { name: 'Flags', kind: 'text' },
    ],
    fn: ([a, pattern, flags]) =>
      safeRegex(pattern, flags).test(limitText(text(a)).slice(0, 10_000)),
  },
  {
    op: 'isEmail',
    label: 'Is an email',
    category: 'Text',
    description: 'True when text looks like an email address.',
    args: [{ name: 'Text', kind: 'text' }],
    fn: ([a]) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text(a)),
  },

  // Lists
  {
    op: 'count',
    label: 'Count items',
    category: 'Lists',
    description: 'Number of items in a list.',
    args: [{ name: 'List', kind: 'list' }],
    fn: ([a]) => list(a).length,
  },
  {
    op: 'first',
    label: 'First item',
    category: 'Lists',
    description: 'The first item of a list.',
    args: [{ name: 'List', kind: 'list' }],
    fn: ([a]) => list(a)[0] ?? null,
  },
  {
    op: 'last',
    label: 'Last item',
    category: 'Lists',
    description: 'The last item of a list.',
    args: [{ name: 'List', kind: 'list' }],
    fn: ([a]) => list(a).at(-1) ?? null,
  },
  {
    op: 'at',
    label: 'Item at position',
    category: 'Lists',
    description: 'Item at a position (0 is first).',
    args: [
      { name: 'List', kind: 'list' },
      { name: 'Position', kind: 'number' },
    ],
    fn: ([a, i]) => list(a).at(num(i)) ?? null,
  },
  {
    op: 'slice',
    label: 'Part of list',
    category: 'Lists',
    description: 'Items from a start position up to an end position.',
    args: [
      { name: 'List', kind: 'list' },
      { name: 'Start', kind: 'number' },
      { name: 'End', kind: 'number' },
    ],
    fn: ([a, start, end]) =>
      list(a).slice(num(start) || 0, end === undefined ? undefined : num(end)),
  },
  {
    op: 'sort',
    label: 'Sort list',
    category: 'Lists',
    description:
      'Sorts a list, optionally by a field, ascending or descending.',
    args: [
      { name: 'List', kind: 'list' },
      { name: 'Field (optional)', kind: 'text' },
      { name: 'Direction (asc/desc)', kind: 'text' },
    ],
    fn: ([a, field, direction]) => {
      const key = text(field)
      const sign = text(direction) === 'desc' ? -1 : 1
      return [...list(a)].sort(
        (x, y) =>
          sign *
          compareValues(key ? readPath(x, key) : x, key ? readPath(y, key) : y),
      )
    },
  },
  {
    op: 'unique',
    label: 'Remove duplicates',
    category: 'Lists',
    description: 'Keeps only the first of each repeated value.',
    args: [{ name: 'List', kind: 'list' }],
    fn: ([a]) => {
      const seen = new Set<string>()
      return list(a).filter((item) => {
        const key = JSON.stringify(item)
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
    },
  },
  {
    op: 'reverse',
    label: 'Reverse list',
    category: 'Lists',
    description: 'Reverses the order of a list.',
    args: [{ name: 'List', kind: 'list' }],
    fn: ([a]) => [...list(a)].reverse(),
  },
  {
    op: 'flatten',
    label: 'Flatten lists',
    category: 'Lists',
    description: 'Turns a list of lists into one list.',
    args: [{ name: 'List', kind: 'list' }],
    fn: ([a]) => limitList(list(a).flat()),
  },
  {
    op: 'pluck',
    label: 'Pick field from each',
    category: 'Lists',
    description: 'Takes one field from every item, e.g. every name.',
    args: [
      { name: 'List', kind: 'list' },
      { name: 'Field', kind: 'text' },
    ],
    fn: ([a, field]) =>
      list(a).map((item) => readPath(item, text(field)) ?? null),
  },
  {
    op: 'sumBy',
    label: 'Sum of field',
    category: 'Lists',
    description: 'Adds one field across every item, e.g. total price.',
    args: [
      { name: 'List', kind: 'list' },
      { name: 'Field', kind: 'text' },
    ],
    fn: ([a, field]) =>
      list(a).reduce<number>(
        (total, item) => total + (num(readPath(item, text(field))) || 0),
        0,
      ),
  },
  {
    op: 'whereEquals',
    label: 'Items where field equals',
    category: 'Lists',
    description: 'Keeps items whose field equals a value.',
    args: [
      { name: 'List', kind: 'list' },
      { name: 'Field', kind: 'text' },
      { name: 'Value', kind: 'any' },
    ],
    fn: ([a, field, value]) =>
      list(a).filter((item) => {
        const v = readPath(item, text(field))
        return v === value || text(v) === text(value)
      }),
  },
  {
    op: 'groupBy',
    label: 'Group by field',
    category: 'Lists',
    description: 'Groups items into an object keyed by a field.',
    args: [
      { name: 'List', kind: 'list' },
      { name: 'Field', kind: 'text' },
    ],
    fn: ([a, field]) => {
      const groups: Record<string, unknown[]> = Object.create(null)
      for (const item of list(a)) {
        const key = text(readPath(item, text(field)))
        if (FORBIDDEN_SEGMENTS.has(key)) continue
        ;(groups[key] ||= []).push(item)
      }
      return { ...groups }
    },
  },
  {
    op: 'range',
    label: 'Number sequence',
    category: 'Lists',
    description: 'List of numbers from start up to (not including) end.',
    args: [
      { name: 'Start', kind: 'number' },
      { name: 'End', kind: 'number' },
    ],
    fn: ([start, end]) => {
      const from = Math.trunc(num(start) || 0)
      const to = Math.trunc(num(end) || 0)
      return limitList(
        Array.from({ length: Math.max(to - from, 0) }, (_, i) => from + i),
      )
    },
  },
  {
    op: 'indexOf',
    label: 'Position of item',
    category: 'Lists',
    description: 'Position of a value in a list, or -1.',
    args: [
      { name: 'List', kind: 'list' },
      { name: 'Value', kind: 'any' },
    ],
    fn: ([a, value]) =>
      list(a).findIndex((item) => item === value || text(item) === text(value)),
  },
  {
    op: 'labels',
    label: 'Labels of items',
    category: 'Lists',
    description: 'Readable label for each item (label, name, title or id).',
    args: [{ name: 'List', kind: 'list' }],
    fn: ([a]) => list(a).map(label),
  },

  // Objects
  {
    op: 'object',
    label: 'Build object',
    category: 'Objects',
    description: 'Builds an object from name and value pairs.',
    variadic: true,
    args: [
      { name: 'Name', kind: 'text' },
      { name: 'Value', kind: 'any' },
    ],
    fn: (args) => {
      const result: Record<string, unknown> = {}
      for (let i = 0; i + 1 < args.length; i += 2) {
        const key = text(args[i])
        if (!FORBIDDEN_SEGMENTS.has(key)) result[key] = args[i + 1]
      }
      return result
    },
  },
  {
    op: 'getField',
    label: 'Get field',
    category: 'Objects',
    description: 'Reads a field from an object, e.g. "address.city".',
    args: [
      { name: 'Object', kind: 'object' },
      { name: 'Field path', kind: 'text' },
    ],
    fn: ([o, path]) => readPath(o, text(path)) ?? null,
  },
  {
    op: 'setField',
    label: 'Set field',
    category: 'Objects',
    description: 'Copy of an object with one field changed.',
    args: [
      { name: 'Object', kind: 'object' },
      { name: 'Field path', kind: 'text' },
      { name: 'Value', kind: 'any' },
    ],
    fn: ([o, path, value]) => writePath(o, text(path), value),
  },
  {
    op: 'values',
    label: 'Field values',
    category: 'Objects',
    description: 'List of the values in an object.',
    args: [{ name: 'Object', kind: 'object' }],
    fn: ([o]) => (isObject(o) ? Object.values(o) : []),
  },
  {
    op: 'entries',
    label: 'Fields as list',
    category: 'Objects',
    description: 'List of {key, value} items.',
    args: [{ name: 'Object', kind: 'object' }],
    fn: ([o]) =>
      isObject(o)
        ? Object.entries(o).map(([key, value]) => ({ key, value }))
        : [],
  },
  {
    op: 'assign',
    label: 'Combine objects',
    category: 'Objects',
    description: 'Combines objects; later fields win.',
    variadic: true,
    args: [{ name: 'Object', kind: 'object' }],
    fn: (args) =>
      Object.assign(
        {},
        ...args
          .filter(isObject)
          .map((o) =>
            Object.fromEntries(
              Object.entries(o).filter(([k]) => !FORBIDDEN_SEGMENTS.has(k)),
            ),
          ),
      ),
  },

  // Dates
  {
    op: 'now',
    label: 'Now',
    category: 'Dates',
    description: 'The current date and time.',
    deterministic: false,
    args: [],
    fn: () => new Date().toISOString(),
  },
  {
    op: 'today',
    label: 'Today',
    category: 'Dates',
    description: "Today's date (YYYY-MM-DD).",
    deterministic: false,
    args: [],
    fn: () => new Date().toISOString().slice(0, 10),
  },
  {
    op: 'dateAdd',
    label: 'Add to date',
    category: 'Dates',
    description: 'Adds days, weeks, months, years, hours…',
    args: [
      { name: 'Date', kind: 'text' },
      { name: 'Amount', kind: 'number' },
      { name: 'Unit', kind: 'text' },
    ],
    fn: ([d, n, unit]) => addToDate(d, n, unit),
  },
  {
    op: 'dateDiff',
    label: 'Time between dates',
    category: 'Dates',
    description: 'Difference between two dates in a unit.',
    args: [
      { name: 'From', kind: 'text' },
      { name: 'To', kind: 'text' },
      { name: 'Unit', kind: 'text' },
    ],
    fn: ([a, b, unit]) => dateDifference(a, b, unit),
  },
  {
    op: 'formatDate',
    label: 'Format date',
    category: 'Dates',
    description: 'Shows a date as short, medium, long, date, time or iso.',
    args: [
      { name: 'Date', kind: 'text' },
      { name: 'Style', kind: 'text' },
      { name: 'Locale', kind: 'text' },
    ],
    fn: ([d, style, locale]) => formatDate(d, style, locale),
  },
  {
    op: 'datePart',
    label: 'Part of date',
    category: 'Dates',
    description: 'Year, month (1-12), day, weekday (0=Sun), hour or minute.',
    args: [
      { name: 'Date', kind: 'text' },
      { name: 'Part', kind: 'text' },
    ],
    fn: ([d, part]) => {
      const date = toDate(d)
      const parts: Record<string, number> = {
        year: date.getFullYear(),
        month: date.getMonth() + 1,
        day: date.getDate(),
        weekday: date.getDay(),
        hour: date.getHours(),
        minute: date.getMinutes(),
      }
      return parts[text(part)] ?? null
    },
  },
  {
    op: 'isBefore',
    label: 'Is before',
    category: 'Dates',
    description: 'True when the first date is before the second.',
    args: [
      { name: 'Date', kind: 'text' },
      { name: 'Compared to', kind: 'text' },
    ],
    fn: ([a, b]) => toDate(a).getTime() < toDate(b).getTime(),
  },

  // Convert & checks
  {
    op: 'toNumber',
    label: 'To number',
    category: 'Convert',
    description: 'Converts text like "1,200" to a number.',
    args: [{ name: 'Value', kind: 'any' }],
    fn: ([a]) => {
      const n = num(a)
      return Number.isFinite(n) ? n : null
    },
  },
  {
    op: 'toText',
    label: 'To text',
    category: 'Convert',
    description: 'Converts any value to text.',
    args: [{ name: 'Value', kind: 'any' }],
    fn: ([a]) => text(a),
  },
  {
    op: 'toBool',
    label: 'To yes/no',
    category: 'Convert',
    description: 'Converts "yes", "true", 1… to true.',
    args: [{ name: 'Value', kind: 'any' }],
    fn: ([a]) =>
      typeof a === 'string'
        ? ['true', 'yes', 'y', '1', 'on'].includes(a.trim().toLowerCase())
        : !!a,
  },
  {
    op: 'isEmpty',
    label: 'Is empty',
    category: 'Convert',
    description: 'True for empty text, empty list, empty object or nothing.',
    args: [{ name: 'Value', kind: 'any' }],
    fn: ([a]) =>
      a === null ||
      a === undefined ||
      a === '' ||
      (Array.isArray(a) && !a.length) ||
      (isObject(a) && !Object.keys(a).length),
  },
  {
    op: 'typeOf',
    label: 'Type of',
    category: 'Convert',
    description: 'number, text, yes/no, list, object or empty.',
    args: [{ name: 'Value', kind: 'any' }],
    fn: ([a]) =>
      a === null || a === undefined
        ? 'empty'
        : Array.isArray(a)
          ? 'list'
          : typeof a === 'string'
            ? 'text'
            : typeof a === 'boolean'
              ? 'yes/no'
              : typeof a,
  },
  {
    op: 'parseJson',
    label: 'Read JSON text',
    category: 'Convert',
    description: 'Turns JSON text into data.',
    args: [{ name: 'JSON text', kind: 'text' }],
    fn: ([a]) => {
      try {
        return JSON.parse(limitText(text(a)))
      } catch {
        throw new LogicError('That text is not valid JSON.')
      }
    },
  },
  {
    op: 'toJson',
    label: 'Write JSON text',
    category: 'Convert',
    description: 'Turns data into JSON text.',
    args: [{ name: 'Value', kind: 'any' }],
    fn: ([a]) => limitText(JSON.stringify(a ?? null)),
  },
  {
    op: 'between',
    label: 'Is between',
    category: 'Compare',
    description:
      'True when a number is between a minimum and maximum (inclusive).',
    args: [
      { name: 'Number', kind: 'number' },
      { name: 'Minimum', kind: 'number' },
      { name: 'Maximum', kind: 'number' },
    ],
    fn: ([a, min, max]) => num(a) >= num(min) && num(a) <= num(max),
  },
]

/** Built-in json-logic operators, described for the visual editor. */
const builtIn: OperatorInfo[] = [
  {
    op: 'var',
    label: 'Variable',
    category: 'Data',
    description: 'Reads a variable, e.g. vars.total or params.id.',
    args: [
      { name: 'Name', kind: 'text' },
      { name: 'Default', kind: 'any' },
    ],
  },
  {
    op: '??',
    label: 'First non-empty',
    category: 'Data',
    description: 'The first value that is not empty.',
    variadic: true,
    args: [{ name: 'Value', kind: 'any' }],
  },
  {
    op: 'missing',
    label: 'Missing variables',
    category: 'Data',
    description: 'Lists which of the named variables are empty.',
    variadic: true,
    args: [{ name: 'Name', kind: 'text' }],
  },
  {
    op: '==',
    label: 'Equals',
    symbol: '=',
    category: 'Compare',
    description: 'True when both values are equal.',
    args: [
      { name: 'Value', kind: 'any' },
      { name: 'Value', kind: 'any' },
    ],
  },
  {
    op: '!=',
    label: 'Not equal',
    symbol: '≠',
    category: 'Compare',
    description: 'True when values are different.',
    args: [
      { name: 'Value', kind: 'any' },
      { name: 'Value', kind: 'any' },
    ],
  },
  {
    op: '>',
    label: 'Greater than',
    symbol: '>',
    category: 'Compare',
    description: 'True when the first is larger.',
    args: [
      { name: 'Value', kind: 'number' },
      { name: 'Value', kind: 'number' },
    ],
  },
  {
    op: '>=',
    label: 'At least',
    symbol: '≥',
    category: 'Compare',
    description: 'True when the first is larger or equal.',
    args: [
      { name: 'Value', kind: 'number' },
      { name: 'Value', kind: 'number' },
    ],
  },
  {
    op: '<',
    label: 'Less than',
    symbol: '<',
    category: 'Compare',
    description: 'True when the first is smaller.',
    args: [
      { name: 'Value', kind: 'number' },
      { name: 'Value', kind: 'number' },
    ],
  },
  {
    op: '<=',
    label: 'At most',
    symbol: '≤',
    category: 'Compare',
    description: 'True when the first is smaller or equal.',
    args: [
      { name: 'Value', kind: 'number' },
      { name: 'Value', kind: 'number' },
    ],
  },
  {
    op: 'in',
    label: 'Is one of',
    category: 'Compare',
    description: 'True when a value is in a list or text.',
    args: [
      { name: 'Value', kind: 'any' },
      { name: 'List or text', kind: 'any' },
    ],
  },
  {
    op: 'if',
    label: 'If … then … else',
    category: 'Logic',
    description: 'Chooses a value by condition. Add more pairs for "else if".',
    variadic: true,
    args: [
      { name: 'If', kind: 'any' },
      { name: 'Then', kind: 'any' },
      { name: 'Else', kind: 'any' },
    ],
  },
  {
    op: 'and',
    label: 'All are true',
    symbol: 'and',
    category: 'Logic',
    description: 'True when every condition is true.',
    variadic: true,
    args: [{ name: 'Condition', kind: 'any' }],
  },
  {
    op: 'or',
    label: 'Any is true',
    symbol: 'or',
    category: 'Logic',
    description: 'True when at least one condition is true.',
    variadic: true,
    args: [{ name: 'Condition', kind: 'any' }],
  },
  {
    op: '!',
    label: 'Not',
    category: 'Logic',
    description: 'Flips true and false.',
    args: [{ name: 'Condition', kind: 'any' }],
  },
  {
    op: '+',
    label: 'Add',
    symbol: '+',
    category: 'Math',
    description: 'Adds numbers.',
    variadic: true,
    args: [{ name: 'Number', kind: 'number' }],
  },
  {
    op: '-',
    label: 'Subtract',
    symbol: '−',
    category: 'Math',
    description: 'Subtracts the second number from the first.',
    args: [
      { name: 'Number', kind: 'number' },
      { name: 'Number', kind: 'number' },
    ],
  },
  {
    op: '*',
    label: 'Multiply',
    symbol: '×',
    category: 'Math',
    description: 'Multiplies numbers.',
    variadic: true,
    args: [{ name: 'Number', kind: 'number' }],
  },
  {
    op: '/',
    label: 'Divide',
    symbol: '÷',
    category: 'Math',
    description: 'Divides the first number by the second.',
    args: [
      { name: 'Number', kind: 'number' },
      { name: 'Number', kind: 'number' },
    ],
  },
  {
    op: '%',
    label: 'Remainder',
    symbol: 'mod',
    category: 'Math',
    description: 'Remainder after dividing.',
    args: [
      { name: 'Number', kind: 'number' },
      { name: 'Number', kind: 'number' },
    ],
  },
  {
    op: 'min',
    label: 'Smallest',
    category: 'Math',
    description: 'The smallest number.',
    variadic: true,
    args: [{ name: 'Number', kind: 'number' }],
  },
  {
    op: 'max',
    label: 'Largest',
    category: 'Math',
    description: 'The largest number.',
    variadic: true,
    args: [{ name: 'Number', kind: 'number' }],
  },
  {
    op: 'cat',
    label: 'Join text',
    category: 'Text',
    description: 'Joins pieces of text together.',
    variadic: true,
    args: [{ name: 'Text', kind: 'text' }],
  },
  {
    op: 'substr',
    label: 'Part of text',
    category: 'Text',
    description: 'Part of text from a start position, with optional length.',
    args: [
      { name: 'Text', kind: 'text' },
      { name: 'Start', kind: 'number' },
      { name: 'Length', kind: 'number' },
    ],
  },
  {
    op: 'length',
    label: 'Length',
    category: 'Text',
    description: 'Number of characters or items.',
    args: [{ name: 'Text or list', kind: 'any' }],
  },
  {
    op: 'map',
    label: 'Transform each item',
    category: 'Lists',
    description:
      'Changes every item. Inside, use the variable "" for the item.',
    args: [
      { name: 'List', kind: 'list' },
      { name: 'Change each to', kind: 'logic' },
    ],
  },
  {
    op: 'filter',
    label: 'Keep matching items',
    category: 'Lists',
    description: 'Keeps items where the condition is true.',
    args: [
      { name: 'List', kind: 'list' },
      { name: 'Keep when', kind: 'logic' },
    ],
  },
  {
    op: 'reduce',
    label: 'Combine items',
    category: 'Lists',
    description: 'Combines items using "current" and "accumulator".',
    args: [
      { name: 'List', kind: 'list' },
      { name: 'Combine with', kind: 'logic' },
      { name: 'Start value', kind: 'any' },
    ],
  },
  {
    op: 'some',
    label: 'Any item matches',
    category: 'Lists',
    description: 'True when at least one item matches.',
    args: [
      { name: 'List', kind: 'list' },
      { name: 'Condition', kind: 'logic' },
    ],
  },
  {
    op: 'all',
    label: 'Every item matches',
    category: 'Lists',
    description: 'True when every item matches.',
    args: [
      { name: 'List', kind: 'list' },
      { name: 'Condition', kind: 'logic' },
    ],
  },
  {
    op: 'none',
    label: 'No item matches',
    category: 'Lists',
    description: 'True when no item matches.',
    args: [
      { name: 'List', kind: 'list' },
      { name: 'Condition', kind: 'logic' },
    ],
  },
  {
    op: 'merge',
    label: 'Combine lists',
    category: 'Lists',
    description: 'Joins lists into one list.',
    variadic: true,
    args: [{ name: 'List', kind: 'list' }],
  },
  {
    op: 'keys',
    label: 'Field names',
    category: 'Objects',
    description: 'List of the field names in an object.',
    args: [{ name: 'Object', kind: 'object' }],
  },
]

export const OPERATORS: OperatorInfo[] = [
  ...builtIn,
  ...custom.map(({ fn: _fn, deterministic: _d, ...info }) => info),
]
const OPERATOR_MAP = new Map(OPERATORS.map((info) => [info.op, info]))
/** Operators the engine accepts beyond the documented catalog. */
const EXTRA_ALLOWED = new Set([
  '===',
  '!==',
  '!!',
  'val',
  'exists',
  'missing_some',
  'preserve',
  'try',
  'throw',
  'get',
  'every',
  '?:',
  'not',
  'pipe',
  'eachKey',
])

export function operatorInfo(op: string): OperatorInfo | undefined {
  return OPERATOR_MAP.get(op)
}

const engine = new LogicEngine()
for (const operator of custom)
  engine.addMethod(
    operator.op,
    (args: unknown) => operator.fn(Array.isArray(args) ? args : [args]),
    {
      deterministic: operator.deterministic !== false,
    },
  )

const isOperator = (name: string): boolean =>
  OPERATOR_MAP.has(name) || EXTRA_ALLOWED.has(name)

/**
 * Returns the operator name when `value` is a logic node. An object is an
 * operation only when its single key is a known operator; any other object is
 * literal data (so `{ "Authorization": … }` headers just work).
 */
export function operatorOf(value: unknown): string | undefined {
  if (!isObject(value)) return undefined
  const keys = Object.keys(value)
  return keys.length === 1 && isOperator(keys[0]) ? keys[0] : undefined
}

/** Rewrites literal objects into `object` operations so nested logic in their values is evaluated. */
function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize)
  if (!isObject(value)) return value
  const op = operatorOf(value)
  if (op === 'preserve') return value
  if (op) {
    const args = value[op]
    return { [op]: Array.isArray(args) ? args.map(normalize) : normalize(args) }
  }
  if (!isLogic(value)) return { preserve: value }
  return {
    object: Object.entries(value).flatMap(([key, item]) => [
      key,
      normalize(item),
    ]),
  }
}

export function argsOf(value: unknown): unknown[] {
  const op = operatorOf(value)
  if (!op) return []
  const args = (value as Record<string, unknown>)[op]
  return Array.isArray(args) ? args : [args]
}

/** Returns human-readable problems; an empty list means the logic is safe. */
export function validateLogic(logic: Logic): string[] {
  const problems: string[] = []
  let nodes = 0
  const visit = (value: unknown, depth: number): void => {
    if (problems.length > 20) return
    if (++nodes > MAX_NODES) {
      problems.push('The logic is too large.')
      return
    }
    if (depth > MAX_DEPTH) {
      problems.push('The logic is nested too deeply.')
      return
    }
    if (Array.isArray(value)) {
      value.forEach((item) => visit(item, depth + 1))
      return
    }
    if (!isObject(value)) return
    const op = operatorOf(value)
    if (!op) {
      // Literal data: check its field names and any logic inside the values.
      for (const [key, item] of Object.entries(value)) {
        if (FORBIDDEN_SEGMENTS.has(key))
          problems.push(`The name "${key}" is not allowed.`)
        visit(item, depth + 1)
      }
      return
    }
    if (op === 'preserve') return
    const args = argsOf(value)
    if (['var', 'val', 'get', 'exists', 'missing'].includes(op)) {
      for (const arg of args) {
        const paths = Array.isArray(arg) ? arg : [arg]
        for (const path of paths)
          if (
            typeof path === 'string' &&
            path.split('.').some((segment) => FORBIDDEN_SEGMENTS.has(segment))
          )
            problems.push(`The name "${path}" is not allowed.`)
      }
    }
    args.forEach((arg) => visit(arg, depth + 1))
  }
  visit(logic, 0)
  return problems
}

const compiled = new Map<string, (data: unknown) => unknown>()

/** True when `logic` contains at least one operation. */
export function isLogic(logic: Logic): boolean {
  if (Array.isArray(logic)) return logic.some(isLogic)
  if (!isObject(logic)) return false
  return operatorOf(logic) !== undefined || Object.values(logic).some(isLogic)
}

/**
 * Compiled logic is fastest but needs `new Function`. Cloudflare Workers allow
 * that at startup yet refuse it while handling requests, so a startup check
 * can't tell; the first refused compile switches to the interpreter for good.
 */
let compileMode = true

const codegenRefused = (error: unknown): boolean =>
  error instanceof EvalError ||
  (error instanceof Error && /code generation|unsafe-eval/i.test(error.message))

/** Forces the interpreter (false) or compiler (true); used by tests to cover both. */
export function setCompileMode(enabled: boolean): void {
  compileMode = enabled
  compiled.clear()
}

/**
 * Evaluates JSON Logic against `data`. Logic is validated and prepared once,
 * then cached, so repeated evaluation (e.g. on every render) is cheap.
 */
export function evaluate(logic: Logic, data: unknown = {}): unknown {
  if (!isLogic(logic)) return logic
  const key = JSON.stringify(logic)
  let fn = compiled.get(key)
  if (!fn) {
    const problems = validateLogic(logic)
    if (problems.length) throw new LogicError(problems[0])
    const prepared = normalize(logic)
    const interpret = (input: unknown) => engine.run(prepared, input)
    // The engine may compile when built or on first call; either can be refused.
    const fallback = (error: unknown, input: unknown) => {
      if (!codegenRefused(error)) throw error
      compileMode = false
      compiled.set(key, interpret)
      return interpret(input)
    }
    try {
      if (!compileMode) fn = interpret
      else {
        const built = engine.build(prepared) as (data: unknown) => unknown
        fn = (input: unknown) => {
          try {
            return built(input)
          } catch (error) {
            return fallback(error, input)
          }
        }
      }
    } catch (error) {
      if (!codegenRefused(error)) throw new LogicError(friendly(error))
      compileMode = false
      fn = interpret
    }
    if (compiled.size > 2000) compiled.clear()
    compiled.set(key, fn)
  }
  try {
    return fn(data)
  } catch (error) {
    throw new LogicError(friendly(error))
  }
}

/** Like `evaluate`, but returns `fallback` instead of throwing. */
export function tryEvaluate<T = unknown>(
  logic: Logic,
  data: unknown,
  fallback: T,
): T | unknown {
  try {
    return evaluate(logic, data)
  } catch {
    return fallback
  }
}

function friendly(error: unknown): string {
  if (error instanceof LogicError) return error.message
  if (error && typeof error === 'object' && 'type' in error)
    return `Calculation failed: ${String((error as { type: unknown }).type)}.`
  if (error instanceof Error && error.message) return error.message
  return 'The calculation could not be completed.'
}

/** One-line plain-language description of logic for the visual editor. */
export function describe(logic: Logic, depth = 0): string {
  if (depth > 4) return '…'
  const op = operatorOf(logic)
  if (!op) {
    if (typeof logic === 'string') return `"${logic}"`
    if (Array.isArray(logic)) return `list of ${logic.length}`
    if (isObject(logic)) return 'object'
    return String(logic)
  }
  const args = argsOf(logic)
  if (op === 'var') return String(args[0] ?? 'item') || 'item'
  const info = OPERATOR_MAP.get(op)
  const parts = args.map((arg) => describe(arg, depth + 1))
  if (info?.symbol && args.length >= 2)
    return `(${parts.join(` ${info.symbol} `)})`
  return `${info?.label ?? op}(${parts.join(', ')})`
}
