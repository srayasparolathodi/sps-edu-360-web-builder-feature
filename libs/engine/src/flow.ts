import { Logic, LogicError, evaluate, isLogic, validateLogic } from './logic'
import type { QueryDef } from './query'
import type { AccessRule } from './access'
import {
  BreakerPolicy,
  BreakerRegistry,
  CircuitOpenError,
  DEFAULT_BREAKER,
  DEFAULT_RETRY,
  RetryPolicy,
  StepError,
  TimeoutError,
  isRetryable,
  retryDelay,
  sleep,
  withTimeout,
} from './resilience'

export type VariableScope = 'vars' | 'session' | 'local'
export type StepType =
  | 'compute'
  | 'http'
  | 'setVariable'
  | 'notify'
  | 'navigate'
  | 'delay'
  | 'serverFlow'
  | 'query'
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
export type NotifyLevel = 'info' | 'success' | 'warning' | 'error'

export interface ErrorPolicy {
  /** stop: fail the flow. continue: keep going without output. fallback: use a value instead. */
  action: 'stop' | 'continue' | 'fallback'
  fallback: Logic
  notify: boolean
  /** Text shown to visitors; {error} is replaced with the technical reason. */
  message: string
}

export interface FlowStep {
  id: string
  name: string
  type: StepType
  /** Ids of steps that must finish first. */
  after: string[]
  /** Only run when this logic is true; skipped otherwise. */
  when?: Logic
  timeoutMs: number
  retry: RetryPolicy
  breaker: BreakerPolicy
  onError: ErrorPolicy
  /** Also store the step's output in a variable. */
  saveAs?: { scope: VariableScope; name: string }
  // compute
  logic?: Logic
  // http
  method?: HttpMethod
  url?: Logic
  headers?: Logic
  body?: Logic
  responseType?: 'json' | 'text'
  /** Logic deciding "no data"; receives `response`. Defaults to an empty response. */
  emptyWhen?: Logic
  // setVariable
  scope?: VariableScope
  variable?: string
  value?: Logic
  // notify
  level?: NotifyLevel
  message?: Logic
  // navigate
  to?: Logic
  // delay
  ms?: number
  // serverFlow
  flowId?: string
  input?: Logic
  /** Queue the server flow and continue without waiting for its result. */
  background?: boolean
  // query
  dataSource?: string
  query?: QueryDef
  /** rows: every row; first: the first row; value: first column of the first row; count: number of rows. */
  queryResult?: 'rows' | 'first' | 'value' | 'count'
}

export interface Flow {
  id: string
  name: string
  description: string
  runAt: 'client' | 'server'
  mode: 'parallel' | 'sequential'
  /** manual: run by events or other flows. pageLoad: when a page opens. interval: repeatedly while a page is open. */
  trigger: 'manual' | 'pageLoad' | 'interval' | 'schedule'
  /** Cron expression (UTC) for the schedule trigger, e.g. "0 2 * * *". Server flows only. */
  schedule?: string
  /** Seconds between runs for the interval trigger. */
  intervalSeconds?: number
  /** Flow to run after this one succeeds (receives this result as input). */
  onSuccess?: string
  /** Flow to run after this one fails (receives the error as input). */
  onFailure?: string
  /** Pages whose load triggers this flow; empty means every page. */
  pageIds: string[]
  steps: FlowStep[]
  /** Flow output; defaults to the output of the last step. */
  result?: Logic
  /** Logic deciding the whole flow has no data; receives `result`. */
  emptyWhen?: Logic
  emptyMessage: string
  /** Diagram positions keyed by step id. */
  positions: Record<string, { x: number; y: number }>
  /** Who may run this flow (server flows are checked on the server). */
  access?: AccessRule
}

export interface HttpRequest {
  method: HttpMethod
  url: string
  headers: Record<string, string>
  body?: string
}
export interface HttpResponse {
  status: number
  ok: boolean
  body: unknown
}

export interface FlowHooks {
  http(request: HttpRequest, signal: AbortSignal): Promise<HttpResponse>
  setVariable?(scope: VariableScope, name: string, value: unknown): void
  notify?(level: NotifyLevel, message: string): void
  navigate?(to: string): void
  serverFlow?(
    flowId: string,
    input: unknown,
    signal: AbortSignal,
  ): Promise<unknown>
  /** Runs a database query on the server; returns the rows. */
  query?(
    dataSourceId: string,
    query: QueryDef,
    data: unknown,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>[]>
  /** Queues a server flow to run in the background; returns a message id. */
  enqueueFlow?(
    flowId: string,
    input: unknown,
    signal: AbortSignal,
  ): Promise<string>
  onStep?(stepId: string, result: StepResult): void
}

export type StepStatus =
  'pending' | 'running' | 'success' | 'empty' | 'error' | 'skipped'

export interface StepResult {
  status: StepStatus
  output?: unknown
  error?: string
  /** True when the step failed but a fallback value was used. */
  recovered?: boolean
  attempts: number
  durationMs: number
}

export interface FlowResult {
  status: 'success' | 'empty' | 'error'
  output: unknown
  error?: string
  emptyMessage?: string
  steps: Record<string, StepResult>
  /** Variables written by the flow, by scope. */
  variables: Record<VariableScope, Record<string, unknown>>
  notifications: { level: NotifyLevel; message: string }[]
  durationMs: number
}

export interface RunOptions {
  side: 'client' | 'server'
  breakers?: BreakerRegistry
  /** Prefix for circuit keys, e.g. the project id. */
  key?: string
  signal?: AbortSignal
  /** Maximum steps running at the same time in parallel mode. */
  concurrency?: number
}

export const STEP_TYPES: {
  type: StepType
  label: string
  icon: string
  description: string
  sides: ('client' | 'server')[]
}[] = [
  {
    type: 'compute',
    label: 'Calculate',
    icon: 'functions',
    description: 'Works out a value with logic.',
    sides: ['client', 'server'],
  },
  {
    type: 'http',
    label: 'Call an API',
    icon: 'cloud_sync',
    description: 'Fetches or sends data to a web address.',
    sides: ['client', 'server'],
  },
  {
    type: 'setVariable',
    label: 'Set variable',
    icon: 'data_object',
    description: 'Saves a value for other blocks and steps.',
    sides: ['client', 'server'],
  },
  {
    type: 'notify',
    label: 'Show message',
    icon: 'notifications',
    description: 'Shows a notification to the visitor.',
    sides: ['client', 'server'],
  },
  {
    type: 'navigate',
    label: 'Go to page',
    icon: 'alt_route',
    description: 'Opens another page or address.',
    sides: ['client'],
  },
  {
    type: 'delay',
    label: 'Wait',
    icon: 'hourglass_top',
    description: 'Pauses before the next steps.',
    sides: ['client', 'server'],
  },
  {
    type: 'serverFlow',
    label: 'Run server flow',
    icon: 'dns',
    description: 'Runs a server-side flow and uses its result.',
    sides: ['client'],
  },
  {
    type: 'query',
    label: 'Query database',
    icon: 'database',
    description: 'Reads or changes rows in a connected database.',
    sides: ['server'],
  },
]

export function createStep(type: StepType, id = crypto.randomUUID()): FlowStep {
  const label = STEP_TYPES.find((item) => item.type === type)?.label ?? type
  const step: FlowStep = {
    id,
    name: label,
    type,
    after: [],
    timeoutMs: type === 'http' || type === 'serverFlow' ? 10_000 : 0,
    retry: { ...DEFAULT_RETRY, attempts: type === 'http' ? 3 : 1 },
    breaker: { ...DEFAULT_BREAKER, enabled: type === 'http' },
    onError: {
      action: 'stop',
      fallback: null,
      notify: true,
      message: 'Something went wrong. Please try again.',
    },
  }
  if (type === 'compute') step.logic = { '+': [1, 1] }
  if (type === 'http') {
    step.method = 'GET'
    step.url = 'https://jsonplaceholder.typicode.com/users'
    step.headers = {}
    step.body = null
    step.responseType = 'json'
  }
  if (type === 'setVariable') {
    step.scope = 'vars'
    step.variable = 'result'
    step.value = ''
  }
  if (type === 'notify') {
    step.level = 'info'
    step.message = 'Done!'
  }
  if (type === 'navigate') step.to = '/'
  if (type === 'delay') step.ms = 1000
  if (type === 'serverFlow') {
    step.flowId = ''
    step.input = {}
  }
  if (type === 'query') {
    step.dataSource = ''
    step.query = { operation: 'select', from: { table: '' } }
    step.queryResult = 'rows'
    step.timeoutMs = 15_000
    step.retry = { ...DEFAULT_RETRY, attempts: 2 }
  }
  return step
}

export function createFlow(name = 'New flow'): Flow {
  return {
    id: crypto.randomUUID(),
    name,
    description: '',
    runAt: 'client',
    mode: 'parallel',
    trigger: 'manual',
    pageIds: [],
    steps: [],
    emptyMessage: 'Nothing to show yet.',
    positions: {},
  }
}

/** Effective dependencies, including the implicit chain in sequential mode. */
export function dependencies(flow: Flow, step: FlowStep): string[] {
  const deps = new Set(step.after)
  if (flow.mode === 'sequential') {
    const index = flow.steps.findIndex((item) => item.id === step.id)
    if (index > 0) deps.add(flow.steps[index - 1].id)
  }
  return [...deps]
}

const LOGIC_FIELDS = [
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
] as const

/** Returns human-readable problems; an empty list means the flow can run. */
export function validateFlow(flow: Flow, side?: 'client' | 'server'): string[] {
  const problems: string[] = []
  const ids = new Set<string>()
  for (const step of flow.steps) {
    if (ids.has(step.id)) problems.push(`Two steps share the id "${step.id}".`)
    ids.add(step.id)
  }
  for (const step of flow.steps) {
    const info = STEP_TYPES.find((item) => item.type === step.type)
    if (!info) {
      problems.push(`"${step.name}" has an unknown type.`)
      continue
    }
    const runSide = side ?? flow.runAt
    if (!info.sides.includes(runSide))
      problems.push(
        `"${step.name}" (${info.label}) can't run on the ${runSide}.`,
      )
    for (const dep of step.after)
      if (!ids.has(dep))
        problems.push(`"${step.name}" waits for a step that no longer exists.`)
    for (const field of LOGIC_FIELDS)
      for (const problem of validateLogic(step[field]))
        problems.push(`"${step.name}" → ${field}: ${problem}`)
    for (const problem of validateLogic(step.onError?.fallback))
      problems.push(`"${step.name}" → fallback: ${problem}`)
    if (step.saveAs && !/^[a-zA-Z_][a-zA-Z0-9_]{0,60}$/.test(step.saveAs.name))
      problems.push(`"${step.name}" saves to an invalid variable name.`)
    if (step.type === 'query' && (!step.dataSource || !step.query?.from?.table))
      problems.push(`"${step.name}" needs a data source and a table.`)
    if (
      step.type === 'setVariable' &&
      !/^[a-zA-Z_][a-zA-Z0-9_]{0,60}$/.test(step.variable ?? '')
    )
      problems.push(
        `"${step.name}" needs a variable name (letters, numbers, _).`,
      )
    if (step.retry.attempts < 1 || step.retry.attempts > 10)
      problems.push(`"${step.name}" retry attempts must be between 1 and 10.`)
  }
  if (
    flow.trigger === 'interval' &&
    !((flow.intervalSeconds ?? 0) >= 5 && (flow.intervalSeconds ?? 0) <= 86_400)
  )
    problems.push('Repeat every must be between 5 seconds and 1 day.')
  if (flow.trigger === 'schedule') {
    if (flow.runAt !== 'server')
      problems.push('Scheduled flows must run on the server.')
    if (!/^S+(s+S+){4}$/.test(flow.schedule?.trim() ?? ''))
      problems.push(
        'Enter a schedule with 5 parts, e.g. "0 2 * * *" (2am every day, UTC).',
      )
  }
  if (flow.onSuccess === flow.id || flow.onFailure === flow.id)
    problems.push('A flow cannot run itself afterwards.')
  for (const problem of [
    ...validateLogic(flow.result),
    ...validateLogic(flow.emptyWhen),
  ])
    problems.push(`Flow result: ${problem}`)
  // Cycle detection over the effective dependency graph.
  const state = new Map<string, 'visiting' | 'done'>()
  const byId = new Map(flow.steps.map((step) => [step.id, step]))
  const visit = (id: string, trail: string[]): boolean => {
    if (state.get(id) === 'done') return false
    if (state.get(id) === 'visiting') {
      const names = [...trail, id].map(
        (stepId) => byId.get(stepId)?.name ?? stepId,
      )
      problems.push(
        `Steps wait for each other in a loop: ${names.join(' → ')}.`,
      )
      return true
    }
    state.set(id, 'visiting')
    const step = byId.get(id)
    if (step)
      for (const dep of dependencies(flow, step))
        if (byId.has(dep) && visit(dep, [...trail, id])) return true
    state.set(id, 'done')
    return false
  }
  for (const step of flow.steps) if (visit(step.id, [])) break
  return problems
}

const isEmptyValue = (value: unknown): boolean =>
  value === null ||
  value === undefined ||
  value === '' ||
  (Array.isArray(value) && value.length === 0) ||
  (typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value as object).length === 0)

const asText = (value: unknown): string =>
  value === null || value === undefined
    ? ''
    : typeof value === 'object'
      ? JSON.stringify(value)
      : String(value)

function friendlyError(error: unknown): string {
  if (error instanceof CircuitOpenError || error instanceof TimeoutError)
    return error.message
  if (error instanceof StepError) return error.message
  if (error instanceof LogicError) return error.message
  if (error instanceof TypeError)
    return "Couldn't reach the server. Check the address or your connection."
  return error instanceof Error ? error.message : 'Unknown error.'
}

/**
 * Runs a flow. Steps whose dependencies are finished run in parallel (up to
 * `concurrency`); every step gets its own retries, timeout and circuit breaker.
 * `context` is the data visible to logic (vars, session, local, params…).
 */
export async function runFlow(
  flow: Flow,
  context: Record<string, unknown>,
  hooks: FlowHooks,
  options: RunOptions,
): Promise<FlowResult> {
  const started = Date.now()
  const breakers = options.breakers ?? new BreakerRegistry()
  const variables: FlowResult['variables'] = {
    vars: {},
    session: {},
    local: {},
  }
  const notifications: FlowResult['notifications'] = []
  const results: Record<string, StepResult> = {}
  const outputs: Record<string, unknown> = {}
  const data: Record<string, unknown> = {
    ...context,
    vars: { ...((context['vars'] as object) ?? {}) },
    session: { ...((context['session'] as object) ?? {}) },
    local: { ...((context['local'] as object) ?? {}) },
    steps: outputs,
  }
  const finish = (
    status: FlowResult['status'],
    output: unknown,
    error?: string,
    emptyMessage?: string,
  ): FlowResult => ({
    status,
    output,
    error,
    emptyMessage,
    steps: results,
    variables,
    notifications,
    durationMs: Date.now() - started,
  })

  const problems = validateFlow(flow, options.side)
  if (problems.length) return finish('error', null, problems[0])

  const notify = (level: NotifyLevel, message: string) => {
    notifications.push({ level, message })
    hooks.notify?.(level, message)
  }
  const setVariable = (scope: VariableScope, name: string, value: unknown) => {
    variables[scope][name] = value
    data[scope] = { ...(data[scope] as object), [name]: value }
    hooks.setVariable?.(scope, name, value)
  }
  const report = (id: string, result: StepResult) => {
    results[id] = result
    hooks.onStep?.(id, result)
  }
  for (const step of flow.steps)
    report(step.id, { status: 'pending', attempts: 0, durationMs: 0 })

  const execute = async (
    step: FlowStep,
    signal: AbortSignal,
  ): Promise<{ output: unknown; empty: boolean }> => {
    switch (step.type) {
      case 'compute':
        return { output: evaluate(step.logic, data), empty: false }
      case 'http': {
        const url = asText(evaluate(step.url, data)).trim()
        if (!/^https?:\/\//i.test(url) && !url.startsWith('/'))
          throw new StepError(
            'The API address must start with https:// or /.',
            undefined,
            false,
          )
        const rawHeaders = evaluate(step.headers ?? {}, data)
        const headers: Record<string, string> = {}
        if (
          rawHeaders &&
          typeof rawHeaders === 'object' &&
          !Array.isArray(rawHeaders)
        )
          for (const [name, value] of Object.entries(rawHeaders))
            if (/^[A-Za-z0-9-]{1,64}$/.test(name)) headers[name] = asText(value)
        const method = step.method ?? 'GET'
        let body: string | undefined
        if (method !== 'GET' && step.body !== null && step.body !== undefined) {
          const value = evaluate(step.body, data)
          body = typeof value === 'string' ? value : JSON.stringify(value)
          if (
            typeof value !== 'string' &&
            !Object.keys(headers).some(
              (h) => h.toLowerCase() === 'content-type',
            )
          )
            headers['Content-Type'] = 'application/json'
        }
        const response = await hooks.http(
          { method, url, headers, body },
          signal,
        )
        if (!response.ok) {
          const detail =
            response.status === 404
              ? 'not found'
              : response.status >= 500
                ? 'server error'
                : 'request rejected'
          throw new StepError(
            `The API answered ${response.status} (${detail}).`,
            response.status,
          )
        }
        const empty =
          step.emptyWhen !== undefined && isLogic(step.emptyWhen)
            ? !!evaluate(step.emptyWhen, { ...data, response: response.body })
            : isEmptyValue(response.body)
        return { output: response.body, empty }
      }
      case 'setVariable': {
        const value = evaluate(step.value, data)
        setVariable(step.scope ?? 'vars', step.variable ?? 'value', value)
        return { output: value, empty: false }
      }
      case 'notify': {
        const message = asText(evaluate(step.message, data))
        notify(step.level ?? 'info', message)
        return { output: message, empty: false }
      }
      case 'navigate': {
        const to = asText(evaluate(step.to, data))
        hooks.navigate?.(to)
        return { output: to, empty: false }
      }
      case 'delay':
        await sleep(Math.min(Math.max(step.ms ?? 0, 0), 60_000), signal)
        return { output: null, empty: false }
      case 'query': {
        if (!hooks.query)
          throw new StepError(
            'Databases can only be queried on the server.',
            undefined,
            false,
          )
        const rows = await hooks.query(
          step.dataSource ?? '',
          step.query!,
          data,
          signal,
        )
        const first = rows[0] ?? null
        const output =
          step.queryResult === 'first'
            ? first
            : step.queryResult === 'value'
              ? first
                ? (Object.values(first)[0] ?? null)
                : null
              : step.queryResult === 'count'
                ? rows.length
                : rows
        return {
          output,
          empty: step.queryResult === 'count' ? false : isEmptyValue(output),
        }
      }
      case 'serverFlow': {
        if (step.background) {
          if (!hooks.enqueueFlow)
            throw new StepError(
              'Background runs are not available here.',
              undefined,
              false,
            )
          const id = await hooks.enqueueFlow(
            step.flowId ?? '',
            evaluate(step.input ?? {}, data),
            signal,
          )
          return { output: { queued: true, messageId: id }, empty: false }
        }
        if (!hooks.serverFlow)
          throw new StepError(
            'Server flows are not available here.',
            undefined,
            false,
          )
        const output = await hooks.serverFlow(
          step.flowId ?? '',
          evaluate(step.input ?? {}, data),
          signal,
        )
        return { output, empty: isEmptyValue(output) }
      }
    }
  }

  const runStep = async (step: FlowStep): Promise<'ok' | 'stop'> => {
    const stepStarted = Date.now()
    if (step.when !== undefined && isLogic(step.when)) {
      let allowed = false
      try {
        allowed = !!evaluate(step.when, data)
      } catch (error) {
        report(step.id, {
          status: 'error',
          error: friendlyError(error),
          attempts: 0,
          durationMs: 0,
        })
        return 'stop'
      }
      if (!allowed) {
        report(step.id, { status: 'skipped', attempts: 0, durationMs: 0 })
        return 'ok'
      }
    }
    const circuit = `${options.key ?? ''}:${flow.id}:${step.id}`
    const retry = { ...DEFAULT_RETRY, ...step.retry }
    const breaker = { ...DEFAULT_BREAKER, ...step.breaker }
    let attempts = 0
    let lastError: unknown
    report(step.id, { status: 'running', attempts: 0, durationMs: 0 })
    while (attempts < retry.attempts) {
      if (options.signal?.aborted) {
        lastError = new StepError('Cancelled.', undefined, false)
        break
      }
      try {
        breakers.before(circuit, breaker)
      } catch (error) {
        lastError = error
        break
      }
      attempts++
      try {
        const { output, empty } = await withTimeout(
          (signal) => execute(step, signal),
          step.timeoutMs,
          options.signal,
        )
        breakers.success(circuit)
        outputs[step.id] = output
        if (step.saveAs)
          setVariable(step.saveAs.scope, step.saveAs.name, output)
        report(step.id, {
          status: empty ? 'empty' : 'success',
          output,
          attempts,
          durationMs: Date.now() - stepStarted,
        })
        return 'ok'
      } catch (error) {
        lastError = error
        if (!(error instanceof LogicError)) breakers.failure(circuit, breaker)
        if (
          error instanceof LogicError ||
          !isRetryable(error) ||
          attempts >= retry.attempts
        )
          break
        report(step.id, {
          status: 'running',
          error: friendlyError(error),
          attempts,
          durationMs: Date.now() - stepStarted,
        })
        try {
          await sleep(retryDelay(retry, attempts), options.signal)
        } catch {
          break
        }
      }
    }
    const message = friendlyError(lastError)
    const policy = step.onError
    // A cancelled run (page left, flow restarted) stays silent.
    if (policy.notify && !options.signal?.aborted)
      notify(
        'error',
        (policy.message || 'Something went wrong.').replace('{error}', message),
      )
    if (policy.action === 'fallback') {
      try {
        const output = evaluate(policy.fallback, {
          ...data,
          error: {
            message,
            status:
              lastError instanceof StepError
                ? (lastError.status ?? null)
                : null,
          },
        })
        outputs[step.id] = output
        if (step.saveAs)
          setVariable(step.saveAs.scope, step.saveAs.name, output)
        report(step.id, {
          status: 'success',
          output,
          error: message,
          recovered: true,
          attempts,
          durationMs: Date.now() - stepStarted,
        })
        return 'ok'
      } catch (error) {
        report(step.id, {
          status: 'error',
          error: `Fallback failed: ${friendlyError(error)}`,
          attempts,
          durationMs: Date.now() - stepStarted,
        })
        return 'stop'
      }
    }
    outputs[step.id] = null
    report(step.id, {
      status: 'error',
      error: message,
      attempts,
      durationMs: Date.now() - stepStarted,
    })
    return policy.action === 'continue' ? 'ok' : 'stop'
  }

  // Scheduler: start every step whose dependencies have finished.
  const pending = new Set(flow.steps.map((step) => step.id))
  const finished = new Set<string>()
  const running = new Map<string, Promise<void>>()
  const limit = Math.max(1, options.concurrency ?? 6)
  let stopped: string | undefined
  while ((pending.size || running.size) && !stopped) {
    for (const step of flow.steps) {
      if (!pending.has(step.id) || running.size >= limit) continue
      if (dependencies(flow, step).every((dep) => finished.has(dep))) {
        pending.delete(step.id)
        running.set(
          step.id,
          runStep(step).then((outcome) => {
            running.delete(step.id)
            finished.add(step.id)
            if (outcome === 'stop' && !stopped) stopped = step.id
          }),
        )
      }
    }
    if (!running.size) break
    await Promise.race(running.values())
  }
  if (running.size) await Promise.allSettled(running.values())
  for (const id of pending)
    report(id, { status: 'skipped', attempts: 0, durationMs: 0 })

  if (stopped)
    return finish(
      'error',
      null,
      `${flow.steps.find((s) => s.id === stopped)?.name}: ${results[stopped].error}`,
    )

  let output: unknown
  try {
    output =
      flow.result !== undefined && isLogic(flow.result)
        ? evaluate(flow.result, data)
        : flow.steps.length
          ? outputs[flow.steps.at(-1)!.id]
          : null
  } catch (error) {
    return finish('error', null, `Flow result: ${friendlyError(error)}`)
  }
  let empty = false
  try {
    empty =
      flow.emptyWhen !== undefined && isLogic(flow.emptyWhen)
        ? !!evaluate(flow.emptyWhen, { ...data, result: output })
        : Object.values(results).some((result) => result.status === 'empty') &&
          isEmptyValue(output)
  } catch (error) {
    return finish('error', output, `Flow result: ${friendlyError(error)}`)
  }
  return empty
    ? finish('empty', output, undefined, flow.emptyMessage)
    : finish('success', output)
}

/** Fetch-based HTTP hook used by both the browser and the Worker. */
export async function fetchHttp(
  request: HttpRequest,
  signal: AbortSignal,
  base?: string,
): Promise<HttpResponse> {
  const response = await fetch(
    base ? new URL(request.url, base) : request.url,
    {
      method: request.method,
      headers: request.headers,
      body: request.body,
      signal,
    },
  )
  const raw = await response.text()
  let body: unknown = raw
  if (
    (response.headers.get('content-type') ?? '').includes('json') ||
    /^\s*[[{]/.test(raw)
  ) {
    try {
      body = raw ? JSON.parse(raw) : null
    } catch {
      body = raw
    }
  }
  return { status: response.status, ok: response.ok, body }
}
