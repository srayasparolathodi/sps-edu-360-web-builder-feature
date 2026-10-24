/**
 * Importing apps and pages written by people or AI assistants.
 *
 *  - aiPrompt(): instructions to paste into any AI assistant (ChatGPT, Claude, Copilot, …) so it
 *    answers with JSON this app can import. It is generated from the live block catalogue, so it
 *    never drifts from what the builder supports.
 *  - importJson(): accepts that answer (or a hand-written/exported file) and turns it into a valid
 *    app: fills missing fields with defaults, creates ids, resolves references by name, fixes
 *    common mistakes, and reports every change it made as a warning.
 */
import {
  BINDINGS,
  BLOCKS,
  Block,
  BlockType,
  COLUMN_FORMATS,
  ComponentDef,
  ComponentInput,
  ComponentOutput,
  DataSource,
  OUTPUT_PREFIX,
  EVENTS,
  INPUT_TYPES,
  Page,
  Project,
  STYLE_PROPERTIES,
  TableColumn,
  VARIANTS,
  VariableDef,
  acceptsChildren,
  createBlock,
  createProject,
  defaultTable,
  isContainer,
  parseProject,
  safeStyle,
} from './model'
import {
  Flow,
  FlowStep,
  STEP_TYPES,
  StepType,
  createFlow,
  createStep,
} from './flow'
import { OPERATORS, validateLogic } from './logic'
import { AccessRule } from './access'
import { AUTH_TYPES, ApiDef, ApiParam, createApi, placeholders } from './api'
import { nameProblems } from './publishing'

export class ImportError extends Error {}

export interface ImportResult {
  project: Project
  /** Everything that was filled in or corrected, in plain words. */
  warnings: string[]
  /** What the assistant could not find or had to assume, for the author to check. */
  notes: string[]
  summary: {
    pages: number
    components: number
    flows: number
    variables: number
    blocks: number
    apis: number
  }
}

const ID = /^[a-zA-Z0-9-]{1,80}$/
const VAR_NAME = /^[a-zA-Z_][a-zA-Z0-9_]{0,60}$/
const SCOPES = ['vars', 'session', 'local'] as const
const BLOCK_TYPES = new Set<string>(BLOCKS.map((block) => block.type))
const STEP_TYPE_SET = new Set<string>(STEP_TYPES.map((step) => step.type))
const SIZE_STYLES = new Set([
  'font-size',
  'padding',
  'margin',
  'gap',
  'width',
  'max-width',
  'min-height',
  'height',
  'border-radius',
])

/** Names AI assistants and HTML habits use for blocks, mapped to ours. */
const BLOCK_ALIASES: Record<string, BlockType> = {
  paragraph: 'text',
  p: 'text',
  span: 'text',
  label: 'text',
  title: 'heading',
  h1: 'heading',
  h2: 'heading',
  h3: 'heading',
  h4: 'heading',
  h5: 'heading',
  h6: 'heading',
  img: 'image',
  picture: 'image',
  photo: 'image',
  navbar: 'navigation',
  nav: 'navigation',
  menubar: 'navigation',
  row: 'columns',
  column: 'stack',
  col: 'stack',
  div: 'container',
  box: 'container',
  panel: 'card',
  banner: 'hero',
  jumbotron: 'hero',
  dialog: 'modal',
  popup: 'modal',
  faq: 'accordion',
  collapse: 'accordion',
  markdown: 'richtext',
  html: 'richtext',
  kpi: 'stat',
  metric: 'stat',
  statistic: 'stat',
  dropdown: 'select',
  textbox: 'input',
  textfield: 'input',
  field: 'input',
  email: 'input',
  password: 'input',
  cta: 'button',
  btn: 'button',
  anchor: 'link',
  a: 'link',
  hr: 'divider',
  separator: 'divider',
  ul: 'list',
  ol: 'list',
  grid_list: 'grid',
  cards: 'grid',
  loop: 'repeater',
  foreach: 'repeater',
  datagrid: 'datatable',
  'data-table': 'datatable',
  tree: 'treelist',
  graph: 'chart',
  toggle: 'switch',
  datepicker: 'date',
  upload: 'file',
  fileupload: 'file',
  tag: 'badge',
  tags: 'chips',
  chip: 'chips',
  testimonial: 'quote',
  slideshow: 'carousel',
  slider_images: 'carousel',
  steps: 'stepper',
  login: 'signin',
  signIn: 'signin',
  iframe: 'embed',
  youtube: 'embed',
  map: 'embed',
  textareafield: 'textarea',
}
const STEP_ALIASES: Record<string, StepType> = {
  api: 'http',
  fetch: 'http',
  request: 'http',
  call: 'http',
  rest: 'http',
  calculate: 'compute',
  calc: 'compute',
  logic: 'compute',
  set: 'setVariable',
  setvar: 'setVariable',
  setvariable: 'setVariable',
  variable: 'setVariable',
  toast: 'notify',
  message: 'notify',
  alert: 'notify',
  notification: 'notify',
  redirect: 'navigate',
  goto: 'navigate',
  route: 'navigate',
  wait: 'delay',
  sleep: 'delay',
  callflow: 'serverFlow',
  serverflow: 'serverFlow',
  subflow: 'serverFlow',
  sql: 'query',
  db: 'query',
  database: 'query',
}

const isObj = (value: unknown): value is Record<string, any> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
const str = (value: unknown, fallback = ''): string =>
  value === undefined || value === null
    ? fallback
    : typeof value === 'string'
      ? value
      : typeof value === 'object'
        ? JSON.stringify(value)
        : String(value)
const kebab = (key: string) =>
  key.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`)
const key = (value: unknown) => str(value).trim().toLowerCase()

/** Finds the JSON in an AI answer: strips code fences and any text around it. */
export function extractJson(text: string): unknown {
  const trimmed = text.trim()
  if (!trimmed) throw new ImportError('Paste the JSON first.')
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed)
  const body = fenced ? fenced[1].trim() : trimmed
  const start = body.search(/[[{]/)
  if (start < 0)
    throw new ImportError(
      'No JSON found. The answer should start with { and end with }.',
    )
  const open = body[start]
  const end = body.lastIndexOf(open === '{' ? '}' : ']')
  if (end <= start)
    throw new ImportError(
      'The JSON is cut off: it has no closing bracket. Ask the assistant to send the complete JSON.',
    )
  const candidate = body.slice(start, end + 1)
  try {
    return JSON.parse(candidate)
  } catch (error) {
    // Common assistant habits: trailing commas and comments.
    const cleaned = candidate
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:"'])\/\/[^\n]*/g, '$1')
      .replace(/,\s*([}\]])/g, '$1')
    try {
      return JSON.parse(cleaned)
    } catch {
      throw new ImportError(
        `This is not valid JSON: ${error instanceof Error ? error.message : 'syntax error'}.`,
      )
    }
  }
}

interface Context {
  warnings: string[]
  usedIds: Set<string>
  flows: Map<string, string>
  components: Map<string, string>
  pages: Map<string, string>
  dataSources: Map<string, string>
  apis: Map<string, string>
  /** Component id → its input and output names, to check placements. */
  componentShapes: Map<string, { inputs: Set<string>; outputs: Set<string> }>
  /** Variables blocks write to; declared automatically when missing. */
  boundVariables: Map<string, { scope: (typeof SCOPES)[number]; name: string }>
  blockCount: number
}

function warnOnce(ctx: Context, message: string): void {
  if (!ctx.warnings.includes(message)) ctx.warnings.push(message)
}

/** A valid, unused id: keeps the given one when possible. */
function claimId(ctx: Context, wanted: unknown): string {
  let id = str(wanted)
    .trim()
    .replace(/[^a-zA-Z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
  if (!id || !ID.test(id) || ctx.usedIds.has(id)) id = crypto.randomUUID()
  ctx.usedIds.add(id)
  return id
}

function remember(
  map: Map<string, string>,
  id: string,
  ...names: unknown[]
): void {
  for (const name of names) if (str(name).trim()) map.set(key(name), id)
}

/** Resolves a reference given by id or by name. */
function resolve(map: Map<string, string>, ref: unknown): string | undefined {
  if (ref === undefined || ref === null || ref === '') return undefined
  return map.get(key(ref))
}

function lines(value: unknown): string {
  if (Array.isArray(value))
    return value
      .map((item) =>
        Array.isArray(item)
          ? item.map((cell) => str(cell)).join('|')
          : isObj(item)
            ? Object.values(item)
                .map((cell) => str(cell))
                .join('|')
            : str(item),
      )
      .join('\n')
  return str(value)
}

function styles(
  ctx: Context,
  value: unknown,
  where: string,
): Record<string, string> {
  if (!isObj(value)) return {}
  const result: Record<string, string> = {}
  // padding-top, margin-left, … are folded into the padding / margin shorthand.
  const sides: Record<
    'padding' | 'margin',
    Partial<Record<'top' | 'right' | 'bottom' | 'left', string>>
  > = { padding: {}, margin: {} }
  for (const [rawKey, rawValue] of Object.entries(value)) {
    const property = kebab(rawKey.trim())
    const side = /^(padding|margin)-(top|right|bottom|left)$/.exec(property)
    const css =
      typeof rawValue === 'number'
        ? (SIZE_STYLES.has(property) || side) && rawValue !== 0
          ? `${rawValue}px`
          : String(rawValue)
        : str(rawValue).trim()
    if (side) sides[side[1] as 'padding' | 'margin'][side[2] as 'top'] = css
    else if (safeStyle(property, css)) result[property] = css
    else
      warnOnce(
        ctx,
        `Style "${property}" on ${where} is not supported and was left out.`,
      )
  }
  for (const box of ['padding', 'margin'] as const) {
    const parts = sides[box]
    if (!Object.keys(parts).length || result[box]) continue
    const css = [parts.top, parts.right, parts.bottom, parts.left]
      .map((part) => part ?? '0')
      .join(' ')
    if (safeStyle(box, css)) result[box] = css
  }
  return result
}

function logicOrSkip(ctx: Context, value: unknown, where: string): unknown {
  if (value === undefined) return undefined
  const problems = validateLogic(value as never)
  if (!problems.length) return value
  warnOnce(ctx, `Logic on ${where} was left out: ${problems[0]}`)
  return undefined
}

function access(
  ctx: Context,
  value: unknown,
  where: string,
): AccessRule | undefined {
  if (!isObj(value)) return undefined
  if (value['mode'] === 'public') return undefined
  if (value['mode'] === 'signedIn') return { mode: 'signedIn' }
  if (
    value['mode'] === 'roles' &&
    Array.isArray(value['roles']) &&
    value['roles'].length
  )
    return {
      mode: 'roles',
      roles: value['roles']
        .map((role: unknown) => key(role).replace(/[^a-z0-9_-]/g, ''))
        .filter(Boolean),
    }
  warnOnce(ctx, `Access rule on ${where} was not understood and was left out.`)
  return undefined
}

function bind(ctx: Context, value: unknown): Block['bind'] {
  let scope: string = 'vars'
  let name = ''
  if (typeof value === 'string') {
    const parts = value.split('.')
    if (parts.length > 1 && (SCOPES as readonly string[]).includes(parts[0]))
      [scope, name] = [parts[0], parts.slice(1).join('_')]
    else name = value
  } else if (isObj(value)) {
    scope = (SCOPES as readonly string[]).includes(value['scope'])
      ? value['scope']
      : 'vars'
    name = str(value['name'])
  } else return undefined
  name = name
    .trim()
    .replace(/[^a-zA-Z0-9_]/g, '_')
    .replace(/^(\d)/, '_$1')
    .slice(0, 61)
  if (!VAR_NAME.test(name)) return undefined
  const result = { scope: scope as (typeof SCOPES)[number], name }
  ctx.boundVariables.set(`${scope}.${name}`, result)
  return result
}

function table(
  ctx: Context,
  type: BlockType,
  value: unknown,
  where: string,
): Block['table'] {
  const base = defaultTable(type === 'treelist')
  if (!isObj(value)) return base
  const columns: TableColumn[] = Array.isArray(value['columns'])
    ? value['columns']
        .map((column: unknown) => {
          const raw =
            typeof column === 'string'
              ? { key: column }
              : isObj(column)
                ? column
                : null
          if (!raw || !str(raw['key'] ?? raw['field']).trim()) return null
          const columnKey = str(raw['key'] ?? raw['field']).trim()
          const format = (COLUMN_FORMATS as readonly string[]).includes(
            raw['format'],
          )
            ? raw['format']
            : 'text'
          const result: TableColumn = {
            key: columnKey,
            label: str(raw['label'] ?? raw['title'], columnKey),
            format,
            sortable: raw['sortable'] !== false,
            filterable: !!raw['filterable'],
          }
          if (['start', 'center', 'end'].includes(raw['align']))
            result.align = raw['align']
          if (raw['width']) result.width = str(raw['width'])
          if (raw['currency'])
            result.currency = str(raw['currency']).toUpperCase().slice(0, 3)
          if (raw['mergeRepeated']) result.mergeRepeated = true
          if (raw['group']) result.group = str(raw['group'])
          const cell = logicOrSkip(
            ctx,
            raw['cell'],
            `column "${result.label}" of ${where}`,
          )
          if (cell !== undefined) result.cell = cell as never
          return result
        })
        .filter((column: TableColumn | null): column is TableColumn => !!column)
        .slice(0, 50)
    : base.columns
  const result = { ...base, columns: columns.length ? columns : base.columns }
  if (
    ['none', 'pages', 'loadMore', 'infinite', 'virtual'].includes(
      value['pagination'],
    )
  )
    result.pagination = value['pagination']
  if (Number.isInteger(value['pageSize']))
    result.pageSize = Math.min(500, Math.max(1, value['pageSize']))
  if (['none', 'single', 'multiple'].includes(value['selection']))
    result.selection = value['selection']
  for (const flag of [
    'serverSide',
    'search',
    'dense',
    'striped',
    'stickyHeader',
  ] as const)
    if (typeof value[flag] === 'boolean') result[flag] = value[flag]
  for (const field of [
    'rowKey',
    'groupBy',
    'childrenKey',
    'parentKey',
  ] as const)
    if (typeof value[field] === 'string') result[field] = value[field]
  for (const field of ['stateVar', 'selectionVar'] as const)
    if (typeof value[field] === 'string' && VAR_NAME.test(value[field]))
      result[field] = value[field]
  const lazy = resolve(ctx.flows, value['lazyFlow'])
  if (lazy) result.lazyFlow = lazy
  return result
}

/** One block (and its children). Non-container blocks with children are flattened. */
function normalizeBlock(ctx: Context, raw: unknown, where: string): Block[] {
  if (!isObj(raw)) {
    if (typeof raw === 'string' && raw.trim())
      return [{ ...createBlock('text'), id: claimId(ctx, ''), text: raw }]
    return []
  }
  let typeName = str(raw['type']).trim()
  let type = (
    BLOCK_TYPES.has(typeName) ? typeName : BLOCK_ALIASES[typeName.toLowerCase()]
  ) as BlockType | undefined
  if (!type) {
    warnOnce(
      ctx,
      `Block type "${typeName || '(none)'}" does not exist; it was turned into a text block.`,
    )
    type = 'text'
  }
  const block = createBlock(type)
  block.id = claimId(ctx, raw['id'])
  ctx.blockCount++
  const label = `"${str(raw['name'] ?? raw['label'] ?? raw['text'] ?? type).slice(0, 40)}" (${type}) on ${where}`
  for (const field of [
    'name',
    'text',
    'url',
    'alt',
    'label',
    'inputType',
  ] as const)
    if (raw[field] !== undefined) block[field] = str(raw[field])
  if (raw['content'] !== undefined && raw['text'] === undefined)
    block.text = str(raw['content'])
  if (raw['src'] !== undefined && raw['url'] === undefined)
    block.url = str(raw['src'])
  if (raw['href'] !== undefined && raw['url'] === undefined)
    block.url = str(raw['href'])
  if (raw['placeholder'] !== undefined && raw['text'] === undefined)
    block.text = str(raw['placeholder'])
  if (raw['variant'] !== undefined && raw['inputType'] === undefined)
    block.inputType = str(raw['variant'])
  if (raw['options'] !== undefined) block.options = lines(raw['options'])
  else if (raw['items'] !== undefined && !Array.isArray(raw['children']))
    block.options = lines(raw['items'])
  // Heading level from the field or from an h1..h6 type name.
  const level = raw['level'] ?? /^h([1-6])$/i.exec(typeName)?.[1]
  if (level !== undefined)
    block.level = String(Math.min(6, Math.max(1, Number(level) || 2)))
  if (!block.name) block.name = BLOCKS.find((item) => item.type === type)!.label
  block.required = !!raw['required']
  block.disabled = !!raw['disabled']
  if (raw['columns'] !== undefined)
    block.columns = Math.min(
      4,
      Math.max(1, Math.round(Number(raw['columns']) || 2)),
    )
  if (raw['value'] !== undefined && Number.isFinite(Number(raw['value'])))
    block.value = Number(raw['value'])
  if (
    typeName.toLowerCase() === 'email' ||
    typeName.toLowerCase() === 'password'
  )
    block.inputType = typeName.toLowerCase()
  const variant = VARIANTS[type]
  if (variant && !variant.options.includes(block.inputType)) {
    if (raw['inputType'] !== undefined || raw['variant'] !== undefined)
      warnOnce(
        ctx,
        `"${block.inputType}" is not a choice for ${type}; used "${variant.options[0]}".`,
      )
    block.inputType =
      createBlock(type).inputType &&
      variant.options.includes(createBlock(type).inputType)
        ? createBlock(type).inputType
        : variant.options[0]
  }
  block.styles = styles(ctx, raw['styles'] ?? raw['style'], label)
  block.tabletStyles = styles(ctx, raw['tabletStyles'], label)
  block.mobileStyles = styles(ctx, raw['mobileStyles'], label)
  if (isObj(raw['logic'])) {
    const logic: Record<string, unknown> = {}
    for (const [binding, value] of Object.entries(raw['logic'])) {
      if (!BINDINGS.some((item) => item.key === binding)) {
        warnOnce(
          ctx,
          `"${binding}" can't be computed with logic; it was left out of ${label}.`,
        )
        continue
      }
      const checked = logicOrSkip(ctx, value, `${label} → ${binding}`)
      if (checked !== undefined) logic[binding] = checked
    }
    if (Object.keys(logic).length) block.logic = logic as Block['logic']
  }
  if (raw['source'] !== undefined) {
    const source = resolve(ctx.flows, raw['source'])
    if (source) block.source = source
    else
      warnOnce(
        ctx,
        `${label} reads data from flow "${str(raw['source'])}", which is not in the JSON; the link was removed.`,
      )
  }
  if (isObj(raw['on'])) {
    const on: Record<string, string> = {}
    for (const [event, ref] of Object.entries(raw['on'])) {
      const output =
        isObj(ref) && typeof ref['output'] === 'string'
          ? ref['output']
          : typeof ref === 'string' && ref.startsWith(OUTPUT_PREFIX)
            ? ref.slice(OUTPUT_PREFIX.length)
            : null
      if (output !== null) {
        if (
          /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(output) &&
          EVENTS.some((item) => item.key === event)
        ) {
          on[event] = OUTPUT_PREFIX + output
          continue
        }
      }
      const flowId = resolve(ctx.flows, ref)
      if (!EVENTS.some((item) => item.key === event))
        warnOnce(
          ctx,
          `Event "${event}" does not exist (${label}); it was left out.`,
        )
      else if (!flowId)
        warnOnce(
          ctx,
          `${label} runs flow "${str(ref)}" on ${event}, but that flow is not in the JSON; the link was removed.`,
        )
      else on[event] = flowId
    }
    if (Object.keys(on).length) block.on = on
  }
  if (raw['bind'] !== undefined) {
    const bound = bind(ctx, raw['bind'])
    if (bound && (INPUT_TYPES.includes(type) || type === 'modal'))
      block.bind = bound
    else if (raw['bind'])
      warnOnce(ctx, `${label} can't save into a variable; "bind" was left out.`)
  }
  if (typeof raw['emptyText'] === 'string') block.emptyText = raw['emptyText']
  if (typeof raw['errorText'] === 'string') block.errorText = raw['errorText']
  if (type === 'datatable' || type === 'treelist')
    block.table = table(ctx, type, raw['table'], label)
  const rule = access(ctx, raw['access'], label)
  if (rule) block.access = rule
  if (type === 'component') {
    const componentId = resolve(
      ctx.components,
      raw['componentId'] ?? raw['component'],
    )
    if (!componentId) {
      warnOnce(
        ctx,
        `${label} uses a component that is not in the JSON; it was left out.`,
      )
      ctx.blockCount--
      return []
    }
    block.componentId = componentId
    const shape = ctx.componentShapes.get(componentId)
    if (isObj(raw['props'] ?? raw['inputs'])) {
      const props: Record<string, unknown> = {}
      for (const [name, value] of Object.entries(
        raw['props'] ?? raw['inputs'],
      )) {
        if (shape && !shape.inputs.has(name)) {
          warnOnce(
            ctx,
            `${label} sets "${name}", which the component does not have as an input; it was left out.`,
          )
          continue
        }
        const checked = logicOrSkip(ctx, value, `${label} → input ${name}`)
        if (checked !== undefined) props[name] = checked
      }
      if (Object.keys(props).length) block.props = props as Block['props']
    }
    if (isObj(raw['outputs'])) {
      const outputs: Record<string, string> = {}
      for (const [name, ref] of Object.entries(raw['outputs'])) {
        const flowId = resolve(ctx.flows, ref)
        if (shape && !shape.outputs.has(name))
          warnOnce(
            ctx,
            `${label} handles output "${name}", which the component does not have.`,
          )
        else if (!flowId)
          warnOnce(
            ctx,
            `${label} runs flow "${str(ref)}" for "${name}", but that flow is not in the JSON.`,
          )
        else outputs[name] = flowId
      }
      if (Object.keys(outputs).length) block.outputs = outputs
    }
    return [block]
  }
  const children = Array.isArray(raw['children'])
    ? raw['children'].flatMap((child: unknown) =>
        normalizeBlock(ctx, child, where),
      )
    : []
  if (acceptsChildren(type)) {
    block.children = children
    return [block]
  }
  if (children.length)
    warnOnce(
      ctx,
      `${type} blocks can't contain other blocks; their content was placed after them (${where}).`,
    )
  return [block, ...children]
}

function normalizeStep(
  ctx: Context,
  raw: unknown,
  flowName: string,
  index: number,
  stepIds: Map<string, string>,
): FlowStep | null {
  if (!isObj(raw)) return null
  const typeName = str(raw['type']).trim()
  const savedApi = raw['apiId'] ?? raw['api']
  const plainCall =
    /^(api|fetch|request|call|rest)$/i.test(typeName) &&
    raw['url'] !== undefined &&
    savedApi === undefined
  const type = (
    plainCall
      ? 'http'
      : STEP_TYPE_SET.has(typeName)
        ? typeName
        : savedApi !== undefined && /^(api|callapi|saved_?api)$/i.test(typeName)
          ? 'api'
          : STEP_ALIASES[typeName.toLowerCase()]
  ) as StepType | undefined
  if (!type) {
    warnOnce(
      ctx,
      `Step type "${typeName}" in flow "${flowName}" does not exist; the step was left out.`,
    )
    return null
  }
  if (
    type === 'api' &&
    resolve(ctx.apis, savedApi) === undefined &&
    savedApi === undefined
  ) {
    warnOnce(
      ctx,
      `A step in flow "${flowName}" calls a saved API but does not say which; the step was left out.`,
    )
    return null
  }
  const step = createStep(
    type,
    stepIds.get(key(raw['id'] ?? raw['name'] ?? `step-${index + 1}`)) ??
      crypto.randomUUID(),
  )
  if (raw['name'] !== undefined) step.name = str(raw['name'])
  const where = `step "${step.name}" of flow "${flowName}"`
  step.after = (
    Array.isArray(raw['after'])
      ? raw['after']
      : raw['after']
        ? [raw['after']]
        : []
  )
    .map((ref: unknown) => stepIds.get(key(ref)))
    .filter((id: string | undefined): id is string => !!id && id !== step.id)
  if (type === 'api') {
    const apiId = resolve(ctx.apis, savedApi)
    if (apiId) step.apiId = apiId
    else
      warnOnce(
        ctx,
        `${where} calls API "${str(savedApi)}", which is not in the JSON.`,
      )
  }
  for (const field of [
    'when',
    'logic',
    'url',
    'headers',
    'body',
    'emptyWhen',
    'value',
    'message',
    'to',
    'input',
    'args',
    'file',
  ] as const) {
    const value = logicOrSkip(ctx, raw[field], `${where} → ${field}`)
    if (value !== undefined) (step as any)[field] = value
  }
  if (Number.isFinite(Number(raw['timeoutMs'])))
    step.timeoutMs = Math.max(0, Number(raw['timeoutMs']))
  if (isObj(raw['retry'])) step.retry = { ...step.retry, ...raw['retry'] }
  if (isObj(raw['breaker']))
    step.breaker = { ...step.breaker, ...raw['breaker'] }
  if (isObj(raw['onError']))
    step.onError = { ...step.onError, ...raw['onError'] }
  if (
    ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(
      str(raw['method']).toUpperCase(),
    )
  )
    step.method = str(raw['method']).toUpperCase() as FlowStep['method']
  if (['json', 'text'].includes(raw['responseType']))
    step.responseType = raw['responseType']
  if ((SCOPES as readonly string[]).includes(raw['scope']))
    step.scope = raw['scope']
  if (typeof raw['variable'] === 'string' && VAR_NAME.test(raw['variable']))
    step.variable = raw['variable']
  if (['info', 'success', 'warning', 'error'].includes(raw['level']))
    step.level = raw['level']
  if (Number.isFinite(Number(raw['ms'])))
    step.ms = Math.max(0, Number(raw['ms']))
  if (raw['flowId'] !== undefined || raw['flow'] !== undefined) {
    const flowId = resolve(ctx.flows, raw['flowId'] ?? raw['flow'])
    if (flowId) step.flowId = flowId
    else
      warnOnce(
        ctx,
        `${where} calls flow "${str(raw['flowId'] ?? raw['flow'])}", which is not in the JSON.`,
      )
  }
  if (typeof raw['background'] === 'boolean')
    step.background = raw['background']
  if (raw['dataSource'] !== undefined)
    step.dataSource = resolve(ctx.dataSources, raw['dataSource']) ?? ''
  if (isObj(raw['query'])) step.query = raw['query'] as FlowStep['query']
  if (['rows', 'first', 'value', 'count'].includes(raw['queryResult']))
    step.queryResult = raw['queryResult']
  if (
    isObj(raw['cache']) &&
    ['vars', 'session', 'local'].includes(raw['cache']['scope'] ?? 'session')
  ) {
    const ttl = Number(
      raw['cache']['ttlSeconds'] ??
        (Number(raw['cache']['minutes']) || 10) * 60,
    )
    step.cache = {
      scope: raw['cache']['scope'] ?? 'session',
      ttlSeconds: Math.min(2_592_000, Math.max(1, Math.round(ttl) || 600)),
    }
  }
  if (isObj(raw['saveAs'])) {
    const target = bind(ctx, raw['saveAs'])
    if (target) step.saveAs = target
  } else if (typeof raw['saveAs'] === 'string') {
    const target = bind(ctx, raw['saveAs'])
    if (target) step.saveAs = target
  }
  return step
}

/** Rewrites {"var": "steps.<old id>…"} after step ids changed. */
function renameStepRefs(value: unknown, renames: Map<string, string>): unknown {
  if (Array.isArray(value))
    return value.map((item) => renameStepRefs(item, renames))
  if (isObj(value)) {
    const result: Record<string, unknown> = {}
    for (const [field, inner] of Object.entries(value)) {
      if (field === 'var' && typeof inner === 'string') {
        const match = /^steps\.([^.]+)(.*)$/.exec(inner)
        result[field] =
          match && renames.has(match[1])
            ? `steps.${renames.get(match[1])}${match[2]}`
            : inner
      } else if (
        field === 'var' &&
        Array.isArray(inner) &&
        typeof inner[0] === 'string'
      ) {
        const match = /^steps\.([^.]+)(.*)$/.exec(inner[0])
        result[field] =
          match && renames.has(match[1])
            ? [`steps.${renames.get(match[1])}${match[2]}`, ...inner.slice(1)]
            : inner
      } else result[field] = renameStepRefs(inner, renames)
    }
    return result
  }
  return value
}

function normalizeFlow(
  ctx: Context,
  raw: Record<string, any>,
  id: string,
): Flow {
  const flow = createFlow(str(raw['name'], 'Imported flow').slice(0, 200))
  flow.id = id
  flow.description = str(raw['description'])
  if (raw['runAt'] === 'server') flow.runAt = 'server'
  if (raw['mode'] === 'sequential') flow.mode = 'sequential'
  if (['manual', 'pageLoad', 'interval', 'schedule'].includes(raw['trigger']))
    flow.trigger = raw['trigger']
  if (flow.trigger === 'schedule') {
    flow.runAt = 'server'
    flow.schedule = str(raw['schedule'], '0 2 * * *')
  }
  if (flow.trigger === 'interval')
    flow.intervalSeconds = Math.max(5, Number(raw['intervalSeconds']) || 60)
  if (typeof raw['emptyMessage'] === 'string')
    flow.emptyMessage = raw['emptyMessage']
  const pageRefs: unknown[] = Array.isArray(raw['pageIds'])
    ? raw['pageIds']
    : Array.isArray(raw['pages'])
      ? raw['pages']
      : []
  flow.pageIds = pageRefs
    .map((ref) => resolve(ctx.pages, ref))
    .filter((pageId): pageId is string => !!pageId)
  for (const field of ['onSuccess', 'onFailure'] as const) {
    const next = resolve(ctx.flows, raw[field])
    if (next && next !== flow.id) flow[field] = next
  }
  // Steps: keep their ids where valid (logic refers to steps.<id>), otherwise create and rename.
  const rawSteps: unknown[] = Array.isArray(raw['steps']) ? raw['steps'] : []
  const stepIds = new Map<string, string>()
  const renames = new Map<string, string>()
  const used = new Set<string>()
  rawSteps.forEach((rawStep, index) => {
    if (!isObj(rawStep)) return
    const wanted = str(rawStep['id'] ?? rawStep['name'] ?? `step-${index + 1}`)
    let stepId = wanted
      .trim()
      .replace(/[^a-zA-Z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80)
    if (!ID.test(stepId) || used.has(stepId))
      stepId = `step-${index + 1}-${crypto.randomUUID().slice(0, 4)}`
    used.add(stepId)
    if (rawStep['id'] !== undefined && stepId !== str(rawStep['id']))
      renames.set(str(rawStep['id']), stepId)
    stepIds.set(key(rawStep['id'] ?? wanted), stepId)
    if (rawStep['name'] !== undefined) stepIds.set(key(rawStep['name']), stepId)
  })
  flow.steps = rawSteps
    .map((rawStep, index) =>
      normalizeStep(ctx, rawStep, flow.name, index, stepIds),
    )
    .filter((step): step is FlowStep => !!step)
  const result = logicOrSkip(ctx, raw['result'], `flow "${flow.name}" → result`)
  if (result !== undefined) flow.result = result as never
  const emptyWhen = logicOrSkip(
    ctx,
    raw['emptyWhen'],
    `flow "${flow.name}" → emptyWhen`,
  )
  if (emptyWhen !== undefined) flow.emptyWhen = emptyWhen as never
  const rule = access(ctx, raw['access'], `flow "${flow.name}"`)
  if (rule) flow.access = rule
  flow.positions = Object.fromEntries(
    flow.steps.map((step, index) => [
      step.id,
      { x: 60 + (index % 4) * 260, y: 60 + Math.floor(index / 4) * 170 },
    ]),
  )
  return renames.size ? (renameStepRefs(flow, renames) as Flow) : flow
}

const SECRET_FIELDS = [
  'secret',
  'username',
  'password',
  'clientId',
  'clientSecret',
] as const

function normalizeApi(
  ctx: Context,
  raw: Record<string, any>,
  id: string,
  taken: Set<string>,
): ApiDef {
  const api = createApi(
    uniqueName(str(raw['name'], 'API').slice(0, 200), taken),
  )
  const where = `API "${api.name}"`
  api.id = id
  api.description = str(raw['description'])
  const page = resolve(ctx.pages, raw['pageId'] ?? raw['page'])
  if (page) api.pageId = page
  const method = str(raw['method'], 'GET').toUpperCase()
  api.method = (
    ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method) ? method : 'GET'
  ) as ApiDef['method']
  // Accept ":id" style placeholders too.
  api.url = str(raw['url'] ?? raw['address'] ?? raw['endpoint'])
    .trim()
    .replace(/\/:([A-Za-z_][A-Za-z0-9_]*)/g, '/{$1}')
  const params: ApiParam[] = []
  for (const item of (Array.isArray(raw['params'])
    ? raw['params']
    : Array.isArray(raw['parameters'])
      ? raw['parameters']
      : []
  ).filter(isObj)) {
    const name = str(item['name'])
      .trim()
      .replace(/[^A-Za-z0-9_]/g, '_')
    if (!name || params.some((param) => param.name === name)) continue
    const place = ['path', 'query', 'header', 'body', 'none'].includes(
      item['in'],
    )
      ? item['in']
      : placeholders(api.url).includes(name)
        ? 'path'
        : api.method === 'GET'
          ? 'query'
          : 'body'
    params.push({
      name,
      in: place,
      required: !!item['required'] || place === 'path',
      ...(item['default'] !== undefined ? { default: item['default'] } : {}),
      ...(item['description'] ? { description: str(item['description']) } : {}),
    })
  }
  for (const name of placeholders(api.url))
    if (!params.some((param) => param.name === name))
      params.push({ name, in: 'path', required: true })
  api.params = params
  api.headers = isObj(raw['headers'])
    ? Object.fromEntries(
        Object.entries(raw['headers'])
          .filter(([name]) => /^[A-Za-z0-9-]{1,64}$/.test(name))
          .map(([name, value]) => [name, str(value)]),
      )
    : {}
  api.bodyType = ['json', 'form', 'text', 'none'].includes(raw['bodyType'])
    ? raw['bodyType']
    : api.method === 'GET'
      ? 'none'
      : 'json'
  const body = logicOrSkip(ctx, raw['body'], `${where} → body`)
  if (body !== undefined) api.body = body as never
  api.responseType = raw['responseType'] === 'text' ? 'text' : 'json'
  api.browser = raw['browser'] !== false
  const rule = access(ctx, raw['access'], where)
  if (rule) api.access = rule
  if (isObj(raw['sample'])) api.sample = raw['sample']
  const auth = isObj(raw['auth']) ? raw['auth'] : {}
  const type = AUTH_TYPES.some((item) => item.type === auth['type'])
    ? auth['type']
    : 'none'
  api.auth = { type }
  for (const field of [
    'keyName',
    'keyIn',
    'tokenUrl',
    'scope',
    'audience',
    'clientAuth',
    'hmacHeader',
    'hmacAlgorithm',
    'hmacEncoding',
    'hmacPrefix',
    'hmacTimestampHeader',
  ] as const)
    if (typeof auth[field] === 'string') (api.auth as any)[field] = auth[field]
  for (const field of SECRET_FIELDS)
    if (auth[field] !== undefined)
      (api.auth as any)[field] = str(auth[field])
        .replace(/^secrets\./, '')
        .replace(/[^A-Za-z0-9_]/g, '_')
        .replace(/^[^A-Za-z]+/, '')
  for (const field of ['token', 'headers', 'hmacMessage'] as const) {
    const value = logicOrSkip(ctx, auth[field], `${where} → auth ${field}`)
    if (value !== undefined) (api.auth as any)[field] = value
  }
  if (type === 'apiKey') api.auth.keyIn ??= 'header'
  return api
}

/** A unique name, adding " 2", " 3", … when it is taken. */
function uniqueName(name: string, taken: Set<string>): string {
  let result = name.trim() || 'Untitled'
  for (let n = 2; taken.has(result.toLowerCase()); n++)
    result = `${name.trim() || 'Untitled'} ${n}`
  taken.add(result.toLowerCase())
  return result
}

function normalizePath(path: unknown, index: number, name: string): string {
  const raw = str(path, index === 0 ? '' : name)
  return raw
    .trim()
    .replace(/^https?:\/\/[^/]+/i, '')
    .split('/')
    .map((segment) =>
      segment.startsWith(':')
        ? `:${segment.slice(1).replace(/[^a-zA-Z0-9_]/g, '')}`
        : segment
            .toLowerCase()
            .replace(/[^a-z0-9-]+/g, '-')
            .replace(/^-+|-+$/g, ''),
    )
    .filter(Boolean)
    .join('/')
}

/**
 * Turns imported JSON (a whole app, a page, or a list of blocks) into a valid app.
 * With `existing`, ids and names are chosen so the result can be merged into that app.
 */
export function importJson(
  input: unknown,
  options: { name?: string; existing?: Project } = {},
): ImportResult {
  const value = typeof input === 'string' ? extractJson(input) : input
  // Accept a whole app, { app: … }, a single page, or a bare list of blocks.
  let app: Record<string, any>
  if (Array.isArray(value))
    app = { pages: [{ name: 'Home', path: '', blocks: value }] }
  else if (isObj(value) && isObj(value['app'])) app = value['app']
  else if (
    isObj(value) &&
    Array.isArray(value['blocks']) &&
    !Array.isArray(value['pages'])
  )
    app = { pages: [value] }
  else if (isObj(value)) app = value
  else
    throw new ImportError(
      'The JSON must be an object describing the app, or a list of blocks.',
    )

  const ctx: Context = {
    warnings: [],
    usedIds: new Set(),
    flows: new Map(),
    components: new Map(),
    pages: new Map(),
    dataSources: new Map(),
    apis: new Map(),
    componentShapes: new Map(),
    boundVariables: new Map(),
    blockCount: 0,
  }
  const existing = options.existing
  if (existing) {
    const walk = (blocks: Block[]) =>
      blocks.forEach(
        (block) => (ctx.usedIds.add(block.id), walk(block.children)),
      )
    for (const page of existing.pages)
      (ctx.usedIds.add(page.id),
        walk(page.blocks),
        remember(
          ctx.pages,
          page.id,
          page.id,
          page.name,
          page.path,
          `/${page.path}`,
        ))
    for (const component of existing.components ?? [])
      (ctx.usedIds.add(component.id),
        walk(component.blocks),
        remember(ctx.components, component.id, component.id, component.name))
    for (const flow of existing.flows)
      (ctx.usedIds.add(flow.id),
        remember(ctx.flows, flow.id, flow.id, flow.name))
    for (const source of existing.dataSources)
      (ctx.usedIds.add(source.id),
        remember(ctx.dataSources, source.id, source.id, source.name))
    for (const variable of existing.variables) ctx.usedIds.add(variable.id)
    for (const api of existing.apis ?? [])
      (ctx.usedIds.add(api.id), remember(ctx.apis, api.id, api.id, api.name))
    for (const component of existing.components ?? [])
      ctx.componentShapes.set(component.id, {
        inputs: new Set((component.inputs ?? []).map((input) => input.name)),
        outputs: new Set(
          (component.outputs ?? []).map((output) => output.name),
        ),
      })
  }

  // 1. Ids and names first, so blocks and flows can refer to each other in any order.
  const rawFlows: Record<string, any>[] = (
    Array.isArray(app['flows'])
      ? app['flows']
      : Array.isArray(app['journeys'])
        ? app['journeys']
        : []
  ).filter(isObj)
  const flowIds = rawFlows.map((raw) => {
    const id = claimId(ctx, raw['id'])
    remember(ctx.flows, id, raw['id'], raw['name'], id)
    return id
  })
  const rawComponents: Record<string, any>[] = (
    Array.isArray(app['components']) ? app['components'] : []
  ).filter(isObj)
  const paramName = (value: unknown) =>
    str(value)
      .trim()
      .replace(/[^A-Za-z0-9_]/g, '_')
      .replace(/^(\d)/, '_$1')
      .slice(0, 64)
  const componentShape = (raw: Record<string, any>) => {
    const pick = (list: unknown) =>
      (Array.isArray(list) ? list : [])
        .map((item: unknown) =>
          typeof item === 'string' ? { name: item } : isObj(item) ? item : null,
        )
        .filter(
          (item): item is Record<string, any> =>
            !!item && !!paramName(item['name']),
        )
        .slice(0, 30)
    const inputs: ComponentInput[] = []
    for (const item of pick(raw['inputs'] ?? raw['props'])) {
      const name = paramName(item['name'])
      if (inputs.some((input) => input.name === name)) continue
      inputs.push({
        name,
        label: str(item['label'], name),
        ...(item['default'] !== undefined ? { default: item['default'] } : {}),
        ...(item['description']
          ? { description: str(item['description']) }
          : {}),
      })
    }
    const outputs: ComponentOutput[] = []
    for (const item of pick(raw['outputs'] ?? raw['events'])) {
      const name = paramName(item['name'])
      if (!outputs.some((output) => output.name === name))
        outputs.push({ name, label: str(item['label'], name) })
    }
    return { inputs, outputs }
  }
  const componentShapes = rawComponents.map(componentShape)
  const componentIds = rawComponents.map((raw, index) => {
    const id = claimId(ctx, raw['id'])
    remember(ctx.components, id, raw['id'], raw['name'], id)
    ctx.componentShapes.set(id, {
      inputs: new Set(componentShapes[index].inputs.map((input) => input.name)),
      outputs: new Set(
        componentShapes[index].outputs.map((output) => output.name),
      ),
    })
    return id
  })
  const rawPages: Record<string, any>[] = (
    Array.isArray(app['pages']) ? app['pages'] : []
  ).filter(isObj)
  if (!rawPages.length && !rawComponents.length && !existing)
    throw new ImportError(
      'The JSON has no pages. An app needs at least one page in "pages".',
    )
  const pageIds = rawPages.map((raw, index) => {
    const id = claimId(ctx, raw['id'])
    remember(
      ctx.pages,
      id,
      raw['id'],
      raw['name'],
      raw['path'],
      `/${str(raw['path'])}`,
      id,
      index === 0 && !existing ? 'home' : undefined,
    )
    return id
  })
  const rawApis: Record<string, any>[] = (
    Array.isArray(app['apis']) ? app['apis'] : []
  ).filter(isObj)
  const apiIds = rawApis.map((raw) => {
    const id = claimId(ctx, raw['id'])
    remember(ctx.apis, id, raw['id'], raw['name'], id)
    return id
  })
  const rawSources: Record<string, any>[] = (
    Array.isArray(app['dataSources']) ? app['dataSources'] : []
  ).filter(isObj)
  const dataSources: DataSource[] = []
  for (const raw of rawSources) {
    if (!['postgres', 'mysql'].includes(raw['type'])) {
      warnOnce(
        ctx,
        `Data source "${str(raw['name'])}" must be type "postgres" or "mysql"; it was left out.`,
      )
      continue
    }
    const id = claimId(ctx, raw['id'])
    remember(ctx.dataSources, id, raw['id'], raw['name'], id)
    const credential =
      str(raw['credential'], 'DATABASE')
        .replace(/[^A-Za-z0-9_]/g, '_')
        .replace(/^[^A-Za-z]+/, '') || 'DATABASE'
    dataSources.push({
      id,
      name: str(raw['name'], 'Database'),
      type: raw['type'],
      credential: credential.slice(0, 64),
      readOnly: raw['readOnly'] !== false,
    })
  }

  // 2. Content.
  const pageNames = new Set(
    (existing?.pages ?? []).map((page) => page.name.toLowerCase()),
  )
  const paths = new Set(
    (existing?.pages ?? []).map((page) => page.path.replace(/:[^/]+/g, ':')),
  )
  const pages: Page[] = rawPages.map((raw, index) => {
    const name = uniqueName(
      str(
        raw['name'] ?? raw['title'],
        index === 0 ? 'Home' : `Page ${index + 1}`,
      ).slice(0, 200),
      pageNames,
    )
    let path = normalizePath(
      raw['path'] ?? raw['route'] ?? raw['url'],
      existing ? 1 : index,
      name,
    )
    while (paths.has(path.replace(/:[^/]+/g, ':')))
      path = path
        ? `${path}-2`
        : `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`
    paths.add(path.replace(/:[^/]+/g, ':'))
    const blocks = (
      Array.isArray(raw['blocks'])
        ? raw['blocks']
        : Array.isArray(raw['children'])
          ? raw['children']
          : []
    ).flatMap((block: unknown) => normalizeBlock(ctx, block, `page "${name}"`))
    const page: Page = { id: pageIds[index], name, path, blocks }
    const rule = access(ctx, raw['access'], `page "${name}"`)
    if (rule) page.access = rule
    return page
  })
  const componentNames = new Set(
    (existing?.components ?? []).map((component) =>
      component.name.toLowerCase(),
    ),
  )
  const components: ComponentDef[] = rawComponents.map((raw, index) => {
    const name = uniqueName(
      str(raw['name'], `Component ${index + 1}`).slice(0, 200),
      componentNames,
    )
    const shape = componentShapes[index]
    return {
      id: componentIds[index],
      name,
      blocks: (Array.isArray(raw['blocks'])
        ? raw['blocks']
        : Array.isArray(raw['children'])
          ? raw['children']
          : []
      ).flatMap((block: unknown) =>
        normalizeBlock(ctx, block, `component "${name}"`),
      ),
      ...(shape.inputs.length ? { inputs: shape.inputs } : {}),
      ...(shape.outputs.length ? { outputs: shape.outputs } : {}),
    }
  })
  const apiNames = new Set(
    (existing?.apis ?? []).map((api) => api.name.toLowerCase()),
  )
  const apis: ApiDef[] = rawApis.map((raw, index) =>
    normalizeApi(ctx, raw, apiIds[index], apiNames),
  )
  const flowNames = new Set(
    (existing?.flows ?? []).map((flow) => flow.name.toLowerCase()),
  )
  const flows: Flow[] = rawFlows.map((raw, index) => {
    const flow = normalizeFlow(ctx, raw, flowIds[index])
    flow.name = uniqueName(flow.name, flowNames)
    return flow
  })

  // 3. Variables: declared ones, plus any a block or step saves into.
  const variables: VariableDef[] = []
  const declared = new Set(
    (existing?.variables ?? []).map(
      (variable) => `${variable.scope}.${variable.name}`,
    ),
  )
  for (const raw of (Array.isArray(app['variables'])
    ? app['variables']
    : []
  ).filter(isObj)) {
    const target = bind(ctx, { scope: raw['scope'], name: raw['name'] })
    if (!target || declared.has(`${target.scope}.${target.name}`)) continue
    declared.add(`${target.scope}.${target.name}`)
    variables.push({
      id: claimId(ctx, raw['id']),
      name: target.name,
      scope: target.scope,
      initial: raw['initial'] ?? raw['value'] ?? null,
      description: str(raw['description']),
      ...(raw['perUser'] === true ? { perUser: true } : {}),
    })
  }
  for (const target of ctx.boundVariables.values()) {
    if (declared.has(`${target.scope}.${target.name}`)) continue
    declared.add(`${target.scope}.${target.name}`)
    variables.push({
      id: claimId(ctx, ''),
      name: target.name,
      scope: target.scope,
      initial: null,
      description: 'Created by the import because a block saves into it.',
    })
  }

  const project: Project = existing
    ? {
        ...structuredClone(existing),
        pages: [...existing.pages, ...pages],
        components: [...(existing.components ?? []), ...components],
        flows: [...existing.flows, ...flows],
        variables: [...existing.variables, ...variables],
        dataSources: [...existing.dataSources, ...dataSources],
        apis: [...(existing.apis ?? []), ...apis],
      }
    : {
        ...createProject(
          str(options.name ?? app['name'], 'Imported app').slice(0, 200),
        ),
        dark: !!app['dark'],
        pages,
        components,
        flows,
        variables,
        dataSources,
        ...(apis.length ? { apis } : {}),
      }
  if (
    !existing &&
    isObj(app['auth']) &&
    Array.isArray(app['auth']['roles']) &&
    app['auth']['roles'].length
  ) {
    const roles = app['auth']['roles']
      .filter(isObj)
      .map((role: Record<string, any>) => ({
        id: key(role['id'] ?? role['name'])
          .replace(/[^a-z0-9_-]/g, '')
          .replace(/^[^a-z]+/, '')
          .slice(0, 40),
        name: str(role['name'] ?? role['id']),
        description: str(role['description']),
      }))
      .filter((role: { id: string }) => role.id)
    if (roles.length)
      project.auth = {
        enabled: app['auth']['enabled'] !== false,
        allowSignUp: app['auth']['allowSignUp'] !== false,
        defaultRole: roles.some(
          (role: { id: string }) => role.id === app['auth']['defaultRole'],
        )
          ? app['auth']['defaultRole']
          : roles[0].id,
        roles,
      }
  }
  if (!project.pages.length)
    throw new ImportError(
      'The JSON has no pages. An app needs at least one page in "pages".',
    )

  const names = nameProblems(project)
  if (names.length) throw new ImportError(names[0])
  let checked: Project
  try {
    checked = parseProject(JSON.stringify(project))
  } catch (error) {
    throw new ImportError(
      error instanceof Error ? error.message : 'The app is not valid.',
    )
  }
  return {
    project: checked,
    warnings: ctx.warnings,
    notes: (Array.isArray(app['notes']) ? app['notes'] : [])
      .map((note: unknown) => str(note).trim().slice(0, 300))
      .filter(Boolean)
      .slice(0, 40),
    summary: {
      pages: pages.length,
      components: components.length,
      flows: flows.length,
      variables: variables.length,
      blocks: ctx.blockCount,
      apis: apis.length,
    },
  }
}

// ---- Instructions for AI assistants ------------------------------------------------------

/** How each block uses the common fields (only the fields that matter are listed). */
const BLOCK_GUIDE: Partial<Record<BlockType, string>> = {
  section: 'children; a full-width band of the page',
  container: 'children; groups blocks',
  columns:
    'children shown side by side, one column per child (put a "stack" in each column)',
  stack: 'children stacked vertically',
  card: 'children inside a raised card',
  grid: 'children in a responsive grid; columns 1-4',
  repeater:
    'children repeated once per item of a list. The list comes from "source" (a flow returning an array) or logic.items. Inside, read the item with {"var":"item.field"} and its position with {"var":"index"}. columns 1-4; emptyText when the list is empty',
  hero: 'children over a large banner; url = background image',
  header: 'children; top bar (logo, navigation)',
  footer: 'children; bottom bar',
  modal:
    'children shown in a dialog while the variable in "bind" is true (open it with a setVariable step setting that variable to true); label = dialog title; inputType small|medium|large',
  sidebar:
    'children; first child is the side panel (180-260px), the rest is the main area; inputType left|right',
  form: 'children = form fields and a "submit" block; on.submit runs a flow with event.form = { fieldName: value } (field name = bind.name, else the block name in lowercase-with-dashes)',
  heading: 'text; level "1"-"6"',
  text: 'text (plain)',
  richtext:
    'text in Markdown (## headings, **bold**, *italic*, [links](url), - lists)',
  image: 'url; alt (describe the image)',
  video: 'url (direct .mp4/.webm file); label',
  audio: 'url; label',
  embed:
    'url of a YouTube, Vimeo, Google Maps or Google Docs/Forms page; label',
  button:
    'text; url (page path like "/admissions" or a full https:// address; leave empty to only run on.click)',
  submit: 'text; only inside a "form"',
  link: 'text; url',
  icon: 'text = Material Symbols icon name (e.g. "school", "event", "call")',
  list: 'options = one item per line',
  divider: 'nothing',
  spacer: 'nothing; vertical space',
  navigation: 'options = one "Label|/path" per line',
  breadcrumb: 'options = one "Label|/path" per line',
  menu: 'text = button label; options = one "Label|/path" per line',
  tabs: 'options = one "Tab title|Tab text" per line',
  accordion: 'options = one "Question|Answer" per line',
  stepper:
    'options = one step title per line; value = current step number (1-based)',
  pagination:
    'label; text = total pages; value = current page; saves the page into "bind"',
  input:
    'label; text = placeholder; inputType text|email|number|password|tel|url; required; bind',
  textarea: 'label; text = placeholder; required; bind',
  number: 'label; text = placeholder; bind',
  search:
    'label; text = placeholder; bind (use the variable in logic to filter lists)',
  date: 'label; required; bind (value "YYYY-MM-DD")',
  select:
    'label; options = one "Label|value" per line (or just "Label"); required; bind',
  multiselect: 'label; options = "Label|value" lines; bind (receives a list)',
  togglegroup:
    'label; options = "Label|value" lines; inputType single|multiple; bind',
  checkbox: 'label; bind (true/false)',
  switch: 'label; bind (true/false)',
  radio: 'label; options = "Label|value" lines; bind',
  slider: 'label; value 0-100; bind',
  rating: 'label; value 1-5; bind',
  file: 'label; text = button text; bind (receives { name, type, size, dataUrl })',
  signin:
    'label = heading; sign-in / create-account form for app users (needs auth.enabled)',
  table:
    'static table: options = one row per line, cells separated by "|"; first line is the header. "^^" in a cell merges it with the cell above, "<<" with the cell to the left',
  datatable:
    'rows come from "source" (a flow returning an array of objects) or options ("|"-separated lines, first line = field names); "table" = { columns: [{ key, label, format, sortable, filterable, align, currency, mergeRepeated, group }], pagination: none|pages|loadMore|infinite|virtual, pageSize, search, selection: none|single|multiple, selectionVar, rowKey, groupBy, dense, striped, stickyHeader, serverSide, stateVar }',
  treelist:
    'like datatable for hierarchies; table.childrenKey (nested children field) or table.parentKey (flat list with parent ids); table.lazyFlow loads children on open',
  stat: 'label = caption; text = the number',
  badge: 'text',
  progress: 'label; value 0-100; inputType linear|circle',
  alert: 'text; inputType info|success|warning|error',
  chart:
    'label = title; options = one "Label|number" per line (or "source" returning [{ label, value }]); inputType bar|line|pie|doughnut|radar',
  countdown: 'label; text = target date "YYYY-MM-DD"',
  gallery: 'options = one "imageUrl|caption" per line',
  carousel: 'options = one "imageUrl|caption" per line; label',
  avatar:
    'text = person name; url = photo (optional, initials shown otherwise)',
  chips: 'options = one chip per line',
  quote: 'text = quotation; label = author',
  keyvalue: 'options = one "Key|Value" per line',
  timeline: 'options = one "Title|Date or detail" per line',
  code: 'text = code; label = language',
  component:
    'componentId = id of an entry in "components" (a reusable piece placed on several pages); props = values for the component\'s inputs (plain values or logic, e.g. { "student": { "var": "item" } }); outputs = { "outputName": "flow-id" } to react to the component; no children',
}

function blockCatalogue(): string {
  const groups = new Map<string, string[]>()
  for (const block of BLOCKS) {
    const guide = BLOCK_GUIDE[block.type] ?? ''
    groups.set(block.group, [
      ...(groups.get(block.group) ?? []),
      `- ${block.type}${isContainer(block.type) && block.type !== 'component' ? ' (container)' : ''}: ${guide}`,
    ])
  }
  return [...groups]
    .map(([group, entries]) => `${group}:\n${entries.join('\n')}`)
    .join('\n\n')
}

/** A small app that uses the main features correctly; also used as a test fixture. */
export const EXAMPLE_APP = {
  name: 'Greenfield School',
  pages: [
    {
      id: 'home',
      name: 'Home',
      path: '',
      blocks: [
        { type: 'component', componentId: 'site-header' },
        {
          type: 'hero',
          url: 'https://images.unsplash.com/photo-1523050854058-8df90110c9f1?auto=format&fit=crop&w=1600&q=80',
          styles: { 'min-height': '420px', color: '#ffffff' },
          children: [
            {
              type: 'heading',
              level: '1',
              text: 'Learning that lasts a lifetime',
            },
            { type: 'button', text: 'Apply now', url: '/admissions' },
          ],
        },
        {
          type: 'section',
          styles: { padding: '48px 24px' },
          children: [
            { type: 'heading', level: '2', text: 'Our teachers' },
            {
              type: 'repeater',
              columns: 3,
              source: 'load-teachers',
              emptyText: 'No teachers yet.',
              children: [
                {
                  type: 'card',
                  on: { click: 'open-teacher' },
                  children: [
                    {
                      type: 'heading',
                      level: '3',
                      logic: { text: { var: 'item.name' } },
                    },
                    {
                      type: 'text',
                      logic: {
                        text: { cat: ['Email: ', { var: 'item.email' }] },
                      },
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
    {
      id: 'admissions',
      name: 'Admissions',
      path: 'admissions',
      blocks: [
        { type: 'component', componentId: 'site-header' },
        {
          type: 'form',
          on: { submit: 'submit-application' },
          styles: {
            'max-width': '560px',
            margin: '32px auto',
            padding: '24px',
          },
          children: [
            { type: 'heading', level: '2', text: 'Apply for admission' },
            {
              type: 'input',
              name: 'studentName',
              label: 'Student name',
              required: true,
              bind: { scope: 'vars', name: 'studentName' },
            },
            {
              type: 'input',
              name: 'email',
              label: 'Parent email',
              inputType: 'email',
              required: true,
              bind: { scope: 'vars', name: 'parentEmail' },
            },
            {
              type: 'select',
              name: 'grade',
              label: 'Grade',
              options: 'Grade 1|1\nGrade 2|2\nGrade 3|3',
              required: true,
              bind: { scope: 'vars', name: 'grade' },
            },
            { type: 'submit', text: 'Send application' },
          ],
        },
      ],
    },
    {
      id: 'teacher',
      name: 'Teacher profile',
      path: 'teachers/:teacherId',
      blocks: [
        {
          type: 'heading',
          level: '1',
          logic: { text: { cat: ['Teacher #', { var: 'params.teacherId' }] } },
        },
      ],
    },
  ],
  components: [
    {
      id: 'site-header',
      name: 'Site header',
      blocks: [
        {
          type: 'header',
          styles: {
            display: 'flex',
            'justify-content': 'space-between',
            'align-items': 'center',
            padding: '12px 24px',
          },
          children: [
            { type: 'heading', level: '3', text: 'Greenfield School' },
            { type: 'navigation', options: 'Home|/\nAdmissions|/admissions' },
          ],
        },
      ],
    },
  ],
  flows: [
    {
      id: 'load-teachers',
      name: 'Load teachers',
      trigger: 'pageLoad',
      pageIds: ['home'],
      steps: [
        {
          id: 'fetch',
          type: 'http',
          method: 'GET',
          url: 'https://jsonplaceholder.typicode.com/users',
          retry: { attempts: 3 },
        },
      ],
    },
    {
      id: 'open-teacher',
      name: 'Open teacher profile',
      steps: [
        {
          id: 'go',
          type: 'navigate',
          to: { cat: ['/teachers/', { var: 'event.item.id' }] },
        },
      ],
    },
    {
      id: 'submit-application',
      name: 'Submit application',
      steps: [
        {
          id: 'send',
          type: 'http',
          method: 'POST',
          url: 'https://jsonplaceholder.typicode.com/posts',
          body: { var: 'event.form' },
        },
        {
          id: 'thanks',
          type: 'notify',
          after: ['send'],
          level: 'success',
          message: 'Application sent. We will email you soon.',
        },
        { id: 'home', type: 'navigate', after: ['thanks'], to: '/' },
      ],
    },
  ],
  variables: [
    {
      name: 'grade',
      scope: 'vars',
      initial: '',
      description: 'Grade chosen in the admission form',
    },
  ],
  notes: [
    'The application form posts to a test address; connect the admissions API before publishing.',
  ],
}

function existingSummary(project: Project): string {
  const list = (items: string[]) => (items.length ? items.join('; ') : 'none')
  return [
    `App name: ${project.name}`,
    `Pages (id, name, path): ${list(project.pages.map((page) => `${page.id}, ${page.name}, /${page.path}`))}`,
    `Components (id, name): ${list((project.components ?? []).map((component) => `${component.id}, ${component.name}`))}`,
    `Flows (id, name, trigger, runs on): ${list(project.flows.map((flow) => `${flow.id}, ${flow.name}, ${flow.trigger}, ${flow.runAt}`))}`,
    `Variables (scope.name): ${list(project.variables.map((variable) => `${variable.scope}.${variable.name}`))}`,
    `Data sources (id, name, type): ${list(project.dataSources.map((source) => `${source.id}, ${source.name}, ${source.type}`))}`,
    `Saved APIs (id, name, method, parameters): ${list((project.apis ?? []).map((api) => `${api.id}, ${api.name}, ${api.method}, ${api.params.map((param) => param.name).join('/') || 'no parameters'}`))}`,
    `Component inputs/outputs: ${list((project.components ?? []).filter((component) => component.inputs?.length || component.outputs?.length).map((component) => `${component.id}: inputs ${(component.inputs ?? []).map((input) => input.name).join('/') || '-'}, outputs ${(component.outputs ?? []).map((output) => output.name).join('/') || '-'}`))}`,
    `Roles: ${list(project.auth?.enabled ? project.auth.roles.map((role) => role.id) : [])}`,
  ].join('\n')
}

/**
 * Instructions an author pastes into any AI assistant, with their own requirements, screenshots
 * or Figma designs. `existing` switches to "add pages and components to this app" mode.
 */
export function aiPrompt(
  options: { requirements?: string; existing?: Project } = {},
): string {
  const adding = !!options.existing
  const operators = OPERATORS.map((operator) => operator.op).join(' ')
  return `You are a senior web designer and front-end engineer generating an app definition for "Page Studio", a no-code web app builder (SPS EDU 360).
A program imports your answer, renders every page from it and runs its journeys, so it must follow these rules exactly.

# Output rules
- Answer with ONE JSON object and nothing else: no explanation, no Markdown, no code fences, no comments, no trailing commas.
- Use only the block types, step types, fields and values listed below. Unknown ones are dropped silently.
- Put what the author must know in the top-level "notes" list, one short sentence each: facts you could not find,
  assumptions, placeholders to fill, things these blocks cannot do, settings to configure. The author sees it after importing.
  Never put such remarks in page text.
- If something cannot be built with these blocks, get as close as possible, keep the JSON valid and say so in "notes".

# What to build
${options.requirements?.trim() || '(The author describes what they need below, possibly with website addresses, screenshots, Figma designs or documents.)'}

# How to work (do this before writing the JSON; do not show it)
1. Collect every source the author gave: website addresses, screenshots, Figma frames, documents and text. Together they are the specification.
2. Website address: if you can browse, open the home page AND every page linked from the main menu, its sub-menus, the top bar
   and the footer. If you cannot open it, use only what the author pasted (never your memory of the site) and add a note saying so.
   From each page take: the exact text (headings, paragraphs, button and menu labels), the order of sections, contact details,
   people and their titles, dates, numbers, image and logo addresses (absolute https URLs), maps, videos, social links and documents.
   From its styles take the theme: brand colour, accent colour, page and section backgrounds, text colour, heading weight,
   corner roundness and shadow style.
3. Screenshots and designs: read every word exactly as shown, keep the sections in the same order top to bottom,
   estimate colours as hex values, and match sizes and spacing as closely as the blocks allow.
4. Make an inventory: every page (one page per menu entry, sub-menu entry and footer link that has its own page on the source),
   every section of each page, every form, every list of records, and every interaction (sliders, tabs, dropdowns, filters,
   search, counters, pop-ups).
5. Map each item to blocks and journeys with the rules below, write the JSON, then run the final check.
"Same as" or "like this site" means the same pages, the same sections in the same order, the same wording, images, logo and colours.
"Better" means a cleaner layout, consistent spacing, a good mobile layout, readable contrast, fast pages and working links,
not different content.

# Content truthfulness
- Copy facts exactly from the sources: names, titles, phone numbers, emails, addresses, dates, fees, statistics, and affiliation
  or registration numbers. Never invent any of them.
- When a page or section needs content the sources do not give, keep the section, write a clearly marked placeholder such as
  "[Add the principal's message]" and add a note. Do not make up quotes, people, clubs, events, statistics or testimonials.
  Short neutral connecting text (a section intro, a button label) may be written when the source has none.
- Never "Lorem ipsum".
- Images: use the addresses from the sources (logo, banners, photos). Only when the sources have no image for a spot, use an
  https://images.unsplash.com photo that fits, with "?auto=format&fit=crop&w=1200&q=70" (w=1600 for full-width banners).
  Every image has an "alt" that describes it.
- Links: every navigation entry, button and link points to a page in your JSON ("/<path>"), a full https:// address,
  "tel:" or "mailto:". Never "#", an empty address, or a page you did not build.

# Theme and layout
- Fix a palette before writing: primary, accent, page background, alternate section background, text and muted text.
  Use exactly these hex values everywhere. Set "dark": true only for a dark site.
- There is no app-wide theme and no web fonts beyond the app's sans-serif (font-family may name fonts installed on devices,
  e.g. Georgia, serif): show the source's character with "styles" on each block (colours, sizes, weights, spacing, borders),
  and keep repeated parts (header, footer, page banner, cards used in many places) in components so their styles live in one place.
- Every block follows its own styles: links, menus and buttons take their colour, background, padding, border and radius from
  "styles"; an image with a "height" is cropped to fill it ("object-fit"). Containers stack their children vertically unless
  "flex-direction": "row" is set; give rows "flex-wrap": "wrap" and grids "grid-template-columns" for an exact column layout.
- When the source has a logo, the header shows it as an "image" about 48-64px high, next to the site name if the source shows one.
- Each band is a full-width "section" (padding about 64-96px top and bottom on desktop, 40-56px on mobile) with alternating
  backgrounds; its content sits in a "container" or "stack" with "max-width": "1200px" and "margin": "0 auto".
- One spacing scale (8, 16, 24, 32, 48, 64px) and one corner radius throughout. One h1 per page, h2 per section, h3 in cards.
- Text contrast at least 4.5:1; light text over a photo needs a dark background colour on the hero.
- Grids and repeaters already drop to fewer columns on small screens; use mobileStyles only for real differences
  (a smaller hero heading, a stacked top bar).

# Website patterns and the blocks for them
- Top bar with phone, email and quick links: a "container" with "display": "flex" above the "header", inside the header component.
- Menu with dropdowns: "navigation" for the plain items, plus a "menu" block (text = parent label, options = its sub-pages)
  for each dropdown. "navigation" itself is one flat row.
- Banner slider: "carousel" with every slide image and caption. One banner with text and buttons over it: "hero".
- Feature, program or facility cards: a "grid" (columns 2-4) of "card" blocks with an icon or image, heading, text and link.
- People (staff, management, toppers), news, events, notices, testimonials and downloads: a journey that returns the list
  (see below) shown by a "repeater". Records in rows and columns: "datatable".
- Counters and achievements: "stat" blocks in a "grid". FAQs: "accordion". Tabbed content: "tabs". History or steps:
  "timeline" or "stepper". Photo galleries: "gallery". YouTube or Vimeo videos and Google Maps: "embed".
  Documents such as PDFs: a "link" or "button" to the document address.
- Social media: "link" blocks to the real profile addresses from the source (add a note when the source only links to a site's home page).
- Contact, enquiry, admission and feedback forms: a "form" with fields and a "submit", on.submit running a journey.
- Pop-up notices: a "modal" opened by a setVariable step (on page load or from a button).
- Sticky headers, parallax, animations and hover effects cannot be built: leave them out, keep the content, and note it.

# Where each piece of work happens
- Fixed text and images: blocks with "text" and "url". No journey.
- A list shown in more than one place or likely to change (events, staff, notices): ONE journey returns the array, and every
  "repeater" or "datatable" showing it uses "source". Without a real API the journey has one compute step whose logic is the
  list: { "parseJson": [ "[{\\"title\\":\\"…\\"}]" ] }. It can later be swapped for an api or query step without touching the pages.
- Showing, hiding, filtering, counting and formatting on the page: block "logic" reading variables (for example a "search"
  bound to vars.q and a list whose logic.items filters by it). No journey needed.
- Anything that sends data, uses a secret, reads a database or must be trusted (form submissions, sign-in checks, payments,
  emails): a saved API or a journey with runAt "server". Never put keys in the JSON; name a secret instead.
- Form submissions send event.form through a saved API or server journey, then show a success notify and navigate or reset.
  Give the sending step an onError with a friendly message that offers the phone number or email. If the requirements name no
  backend, use a saved API with an obvious placeholder endpoint and add a note that it must be configured before publishing.
- Journeys that load data when a page opens use trigger "pageLoad" with pageIds. Cache lists that rarely change
  ("cache": { "scope": "session", "ttlSeconds": 600 }).

# Performance
- Few, shallow containers: do not wrap a single block in extra containers.
- More than about six similar cards, or the same cards on several pages: a repeater with a data journey, not copied blocks.
- Images no larger than needed (the Unsplash w= parameter). When images are linked from an old site, add a note to upload
  them to the app's storage.
- No "interval" journeys unless the requirements need live updates. Long tables use datatable pagination.
${
  adding
    ? `
# Add to this existing app
Return ONLY the new pages, components, flows and variables. You may place existing components
(block "component" with their componentId), run existing flows (by id), and read existing
variables. Do not repeat existing pages; new page names and paths must differ from these:
${existingSummary(options.existing!)}
`
    : ''
}
# Shape of the answer
{
  ${adding ? '' : '"name": "App name",\n  "dark": false,\n  '}"pages": [ Page ],
  "components": [ { "id": "site-header", "name": "Site header", "blocks": [ Block ] } ],
  "flows": [ Flow ],
  "apis": [ Api ],
  "variables": [ { "name": "teacherSearch", "scope": "vars", "initial": "", "description": "…" } ],
  "notes": [ "The principal's message was not on the site; a placeholder marks where it goes." ]${
    adding
      ? ''
      : `,
  "dataSources": [ { "id": "school-db", "name": "School database", "type": "postgres", "credential": "SCHOOL_DB", "readOnly": true } ],
  "auth": { "enabled": true, "allowSignUp": true, "defaultRole": "parent", "roles": [ { "id": "parent", "name": "Parent", "description": "" } ] }`
  }
}
Only include dataSources and auth when the requirements need a database or sign-in.

# Ids and references
- Give every page, component, flow and step an "id": lowercase letters, digits and hyphens only (e.g. "load-teachers").
- Refer to things by those ids: block "source" and "on" → flow ids; "componentId" → component ids;
  flow "pageIds" → page ids; step "after" → step ids in the same flow; {"var":"steps.<stepId>"} → a step's output.

# Page
{ "id": "admissions", "name": "Admissions", "path": "admissions", "blocks": [ Block ], "access": Access (optional) }
- "path" is the address after the app's web address: "" for the home page, lowercase words with hyphens,
  sub-paths with "/" (e.g. "students/reports"), and path variables with ":" (e.g. "students/:studentId"),
  read in logic as {"var":"params.studentId"}. Query strings (?tab=marks) are read as {"var":"query.tab"}.
- Every page needs a unique name and path. Navigation and buttons link to pages with "/<path>".
- Put a shared header/footer in a component and place it on each page with { "type": "component", "componentId": "…" }.

# Block
{ "type": "…", "name": "Short name", "text": "", "label": "", "url": "", "alt": "", "options": "",
  "level": "2", "inputType": "", "columns": 2, "value": 0, "required": false, "disabled": false,
  "styles": { }, "tabletStyles": { }, "mobileStyles": { },
  "children": [ Block ], "logic": { }, "source": "flow-id", "on": { "click": "flow-id" },
  "bind": { "scope": "vars", "name": "variableName" }, "emptyText": "", "errorText": "",
  "table": { }, "access": Access, "componentId": "" }
Only include the fields a block uses. "options" is a string with one entry per line ("\\n" between lines).
Only containers may have "children".

Block types and the fields they use:
${blockCatalogue()}

Styles (desktop in "styles", overrides in "tabletStyles" ≤1024px and "mobileStyles" ≤600px), CSS values as strings:
${STYLE_PROPERTIES.join(', ')}. Nothing else (no position, url(), or class names).
Layout is responsive by default; use mobileStyles only for real differences.

# Logic (JSON Logic) — dynamic values
"logic" on a block computes: ${BINDINGS.map((binding) => `${binding.key} (${binding.hint.replace(/\.$/, '')})`).join('; ')}.
Example: "logic": { "visible": { "==": [ { "var": "vars.tab" }, "marks" ] }, "text": { "cat": [ "Hello ", { "var": "user.name" } ] } }
Values available to block logic: vars.*, session.*, local.* (variables); params.* (path variables); query.* (query string);
page.name, page.path; user.signedIn, user.email, user.name, user.roles; data (output of the block's "source" flow);
item and index (inside a repeater); flows.<flowId>.status and flows.<flowId>.output.
Operators: ${operators}
Use {"var":"path.to.value"} to read values and {"??":[ value, fallback ]} for defaults.

# Flow (journey) — actions, API calls, calculations
{ "id": "load-teachers", "name": "Load teachers", "runAt": "client" | "server", "mode": "parallel" | "sequential",
  "trigger": "manual" | "pageLoad" | "interval" | "schedule", "pageIds": [ "home" ], "intervalSeconds": 60,
  "schedule": "0 7 * * *", "steps": [ Step ], "result": Logic, "emptyWhen": Logic, "emptyMessage": "Nothing to show yet.",
  "onSuccess": "flow-id", "onFailure": "flow-id", "access": Access }
- trigger "manual": run by block events ("on") or other flows; "pageLoad": when a page in pageIds opens (all pages if empty);
  "interval": every intervalSeconds while the page is open; "schedule": cron (UTC), server only.
- A flow's output is its last step's output (or "result"); a block with "source" shows it, with loading skeletons and error states built in.
- runAt "server" for anything secret (API keys, databases); browsers never see server steps or credentials.
- Values in flows: event.* when a block event started the flow (event.form for forms, event.value for inputs,
  event.item and event.index for blocks inside a repeater), input.* (input from another flow or a serverFlow step),
  params.*, query.*, vars.*, session.*, local.*, steps.<stepId> (earlier step outputs), secrets.NAME (server only), user.*.

Step:
{ "id": "fetch", "type": "…", "name": "…", "after": [ "step-id" ], "when": Logic, "timeoutMs": 10000,
  "retry": { "attempts": 3 }, "onError": { "action": "stop" | "continue" | "fallback", "fallback": Logic, "notify": true, "message": "…" },
  "saveAs": { "scope": "vars", "name": "variableName" }, "cache": { "scope": "vars" | "session" | "local", "ttlSeconds": 600 } }
"cache" (api, http, query, serverFlow steps) reuses the answer for the same inputs for ttlSeconds, e.g. a list of classes in session storage for 10 minutes.
Step types and their fields:
${STEP_TYPES.map(
  (step) =>
    `- ${step.type}: ${step.description} ${
      {
        compute: '"logic": Logic',
        http: '"method": GET|POST|PUT|PATCH|DELETE, "url": Logic or string, "headers": { }, "body": Logic, "responseType": "json"|"text", "emptyWhen": Logic',
        setVariable:
          '"scope": vars|session|local, "variable": "name", "value": Logic',
        notify:
          '"level": info|success|warning|error, "message": Logic or string',
        navigate: '"to": "/path" or Logic',
        delay: '"ms": 1000',
        serverFlow:
          '"flowId": "server-flow-id", "input": Logic, "background": false',
        api: '"apiId": "saved-api-id", "args": { "paramName": Logic or value } (values can come from earlier steps, forms, variables, the route or the user), "emptyWhen": Logic',
        storeFile:
          '"file": Logic giving the value of a "file" block (e.g. {"var":"vars.document"} or {"var":"event.value"}); output { url, name, type, size }',
        query:
          '"dataSource": "data-source-id", "query": QueryDef (server only), "queryResult": rows|first|value|count',
      }[step.type] ?? ''
    }${step.sides.length === 1 ? ` (${step.sides[0]} only)` : ''}`,
).join('\n')}
Steps run in parallel unless "after" (or mode "sequential") orders them.
QueryDef (no SQL text): { "operation": "select", "from": { "table": "students", "alias": "s" }, "fields": [ { "expr": { "column": "s.name" } } ],
  "where": { "compare": "=", "left": { "column": "s.grade" }, "right": { "value": { "var": "input.grade" } } }, "orderBy": [ ], "limit": 50 }

# Saved APIs (reusable, app level or one page)
Define each external API once in "apis" and call it from any flow with a step { "type": "api", "apiId": "…", "args": { … } }.
The server sends the request, so keys and passwords stay secret; pages can still call them.
Api:
{ "id": "get-student", "name": "Get student", "pageId": "page-id (optional: only for that page)", "method": "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  "url": "https://api.school.edu/v1/students/{studentId}",
  "params": [ { "name": "studentId", "in": "path" | "query" | "header" | "body" | "none" (not sent; used by auth or body), "required": true, "default": "…" } ],
  "headers": { "Accept": "application/json" }, "bodyType": "json" | "form" | "text" | "none", "body": Logic using args.* (optional; otherwise body params form the JSON object),
  "responseType": "json" | "text", "browser": true, "access": Access, "auth": Auth }
- Every {placeholder} in "url" needs a "path" param of the same name. Query params become ?name=value.
- Chain calls by passing earlier results as args, e.g. { "studentId": { "var": "steps.find-student.id" }, "token": { "var": "steps.login.access_token" } }.
Auth (credentials are names of secrets the author saves in the builder, e.g. "SCHOOL_API_KEY"; never put real keys in the JSON):
${AUTH_TYPES.map((item) => `- ${item.type}: ${item.description}`).join('\n')}
  apiKey: { "type": "apiKey", "keyName": "X-API-Key", "keyIn": "header" | "query", "secret": "SCHOOL_API_KEY" }
  bearer: { "type": "bearer", "secret": "API_TOKEN" } or { "type": "bearer", "token": { "var": "args.token" } } with a param { "name": "token", "in": "none" } (token passed from a login step)
  basic:  { "type": "basic", "username": "API_USER", "password": "API_PASSWORD" }
  oauth2: { "type": "oauth2", "tokenUrl": "https://auth.example.com/oauth/token", "clientId": "CLIENT_ID", "clientSecret": "CLIENT_SECRET", "scope": "read", "audience": "", "clientAuth": "body" | "basic" }
  hmac:   { "type": "hmac", "secret": "SIGNING_SECRET", "hmacHeader": "X-Signature", "hmacAlgorithm": "SHA-256", "hmacEncoding": "hex" | "base64", "hmacPrefix": "sha256=", "hmacTimestampHeader": "X-Timestamp" }
  custom: { "type": "custom", "headers": { "X-Tenant": { "var": "args.tenant" }, "X-Key": { "var": "secrets.API_KEY" } } }

# Components with inputs and outputs
A component can declare "inputs": [ { "name": "student", "label": "Student", "default": null } ] and "outputs": [ { "name": "selected", "label": "Selected" } ].
Inside the component read inputs as {"var":"props.student.name"}; raise an output from a block event with "on": { "click": "@output:selected" }.
Where it is placed: { "type": "component", "componentId": "student-card", "props": { "student": { "var": "item" } }, "outputs": { "selected": "open-student" } }.
The output's flow receives event.value (the component's props) and event.output.

# Files chosen by app users
A "file" block saves the chosen file into its bind variable. To keep it, add a flow step { "type": "storeFile", "file": { "var": "vars.document" } };
its output { url, name, type, size } can be sent to an API or database in a later step.

# Variables
{ "name": "camelCase", "scope": "vars" (this visit) | "session" (until the tab closes) | "local" (kept on this device), "initial": value, "perUser": true }
"perUser": the value belongs to the signed-in user and is cleared on sign-in/sign-out (e.g. a cached profile or cart).
Server flows also see the page's current vars.*, session.* and local.* (sent by the browser). Treat them as user input:
decide access only with user.* (from the signed-in session) and the "access" rules, never with variables.
Inputs save into variables with "bind"; logic reads them as vars.name / session.name / local.name.

# Access (optional, needs auth)
{ "mode": "signedIn" } or { "mode": "roles", "roles": [ "teacher" ] } on pages, blocks or flows. Leave it out for public.

# Events ("on" on a block, value = flow id)
${EVENTS.map((event) => `${event.key} (${event.label}${event.hint ? `: ${event.hint}` : ''})`).join('; ')}

# Before answering, check
- One JSON object, nothing else; every id unique; every reference points to an id in your JSON${adding ? ' or the existing app' : ''}.
- Every page has a unique name and path; the first page has path "".
- Every page in the inventory exists, and every page places the shared header and footer components.
- Every link and button goes to a page you built, a full https:// address, "tel:" or "mailto:".
- Every fact (name, number, date, phone, address) appears in the sources; everything else is a marked placeholder listed in "notes".
- The same palette hex values are used on every page; every image has "alt".
- Forms are "form" blocks containing fields and a "submit" block, with on.submit set to a journey that reports success and failure.
- Lists of records use "repeater" (cards) or "datatable" (tables) with "source" pointing to a flow.
- Secrets, databases and trusted actions run on the server; nothing secret is in the JSON.

# Example of a correct answer
${JSON.stringify(EXAMPLE_APP)}
`
}

/** Follow-up instructions when an imported answer could not be used. */
export function fixPrompt(error: string): string {
  return `Your JSON could not be imported into Page Studio: ${error}
Fix that problem, keep everything else as it was (including "notes"), and send the complete corrected JSON again — one JSON object only, no explanation, no code fences.`
}
