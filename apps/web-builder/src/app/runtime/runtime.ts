import { Injectable, computed, inject, signal } from '@angular/core'
import { Router } from '@angular/router'
import { MatSnackBar } from '@angular/material/snack-bar'
import {
  Block,
  BindingKey,
  EventName,
  Page,
  Project,
  buildPath,
  resolvePage,
} from '@spsedu360/engine/model'
import {
  Flow,
  FlowResult,
  NotifyLevel,
  VariableScope,
  fetchHttp,
  runFlow,
} from '@spsedu360/engine/flow'
import { evaluate, isLogic } from '@spsedu360/engine/logic'
import { ApiService } from '../services/api'
import {
  BlockView,
  asText,
  toItems,
  toList,
  toRows,
} from '../blocks/block-view'
import { ANONYMOUS, Visitor } from '@spsedu360/engine/access'

export type FlowStatus = 'idle' | 'running' | 'success' | 'empty' | 'error'
export type { BlockView }

export interface FlowState {
  status: FlowStatus
  output?: unknown
  error?: string
  emptyMessage?: string
  result?: FlowResult
}

const storageKey = (projectId: string, name: string) =>
  `ps:${projectId}:${name}`

/**
 * Live state for one rendered site (or the builder preview). Provided per
 * renderer so each preview/site has its own variables and flow results.
 */
@Injectable()
export class RuntimeService {
  private readonly api = inject(ApiService)
  private readonly router = inject(Router)
  private readonly snack = inject(MatSnackBar)

  readonly project = signal<Project | null>(null)
  readonly page = signal<Page | null>(null)
  readonly params = signal<Record<string, string>>({})
  readonly query = signal<Record<string, string>>({})
  readonly vars = signal<Record<string, unknown>>({})
  readonly session = signal<Record<string, unknown>>({})
  readonly local = signal<Record<string, unknown>>({})
  readonly flows = signal<Record<string, FlowState>>({})
  /** Builder preview runs server flows against the unsaved draft. */
  readonly draft = signal(false)
  /** Where internal links go: '/site/:id' for live sites; the builder handles preview navigation. */
  readonly base = signal('')
  readonly navigateHook = signal<((path: string) => void) | null>(null)
  /** The site visitor (from the server session, or simulated in the builder preview). */
  readonly user = signal<Visitor>(ANONYMOUS)
  /** Called after signing in or out, so the site reloads with what this visitor may see. */
  readonly authHook = signal<(() => void) | null>(null)

  authChanged(): void {
    this.authHook()?.()
  }

  private readonly controllers = new Map<string, AbortController>()

  /** Data visible to all logic on the page. */
  readonly context = computed(() => ({
    vars: this.vars(),
    session: this.session(),
    local: this.local(),
    params: this.params(),
    query: this.query(),
    page: { name: this.page()?.name ?? '', path: this.page()?.path ?? '' },
    flows: this.flows(),
    user: this.user(),
  }))

  load(project: Project, draft: boolean): void {
    this.cancelAll()
    this.project.set(project)
    this.draft.set(draft)
    const read = (
      store: Storage | undefined,
      name: string,
      initial: unknown,
    ): unknown => {
      try {
        const raw = store?.getItem(storageKey(project.id, name))
        return raw === null || raw === undefined
          ? structuredClone(initial ?? null)
          : JSON.parse(raw)
      } catch {
        return structuredClone(initial ?? null)
      }
    }
    const vars: Record<string, unknown> = {}
    const session: Record<string, unknown> = {}
    const local: Record<string, unknown> = {}
    for (const variable of project.variables) {
      if (variable.scope === 'vars')
        vars[variable.name] = structuredClone(variable.initial ?? null)
      if (variable.scope === 'session')
        session[variable.name] = read(
          safeStorage('session'),
          variable.name,
          variable.initial,
        )
      if (variable.scope === 'local')
        local[variable.name] = read(
          safeStorage('local'),
          variable.name,
          variable.initial,
        )
    }
    this.vars.set(vars)
    this.session.set(session)
    this.local.set(local)
    this.flows.set({})
  }

  /** Shows the page for `path` and runs its page-load and data-source flows. */
  open(path: string, query: Record<string, string> = {}): boolean {
    const project = this.project()
    if (!project) return false
    const match = resolvePage(project, path)
    this.query.set(query)
    if (!match) {
      this.page.set(null)
      return false
    }
    this.page.set(match.page)
    this.params.set(match.params)
    this.cancelAll()
    this.flows.set({})
    for (const flow of this.pageFlows(project, match.page))
      void this.run(flow.id)
    for (const flow of project.flows)
      if (
        flow.trigger === 'interval' &&
        (!flow.pageIds.length || flow.pageIds.includes(match.page.id))
      )
        this.timers.push(
          setInterval(
            () => {
              if (this.status(flow.id).status !== 'running')
                void this.run(flow.id)
            },
            Math.max(5, flow.intervalSeconds ?? 60) * 1000,
          ),
        )
    return true
  }

  private pageFlows(project: Project, page: Page): Flow[] {
    const sources = new Set<string>()
    const collect = (blocks: Block[]) =>
      blocks.forEach((block) => {
        if (block.source) sources.add(block.source)
        collect(block.children)
      })
    collect(page.blocks)
    return project.flows.filter(
      (flow) =>
        sources.has(flow.id) ||
        ((flow.trigger === 'pageLoad' || flow.trigger === 'interval') &&
          (!flow.pageIds.length || flow.pageIds.includes(page.id))),
    )
  }

  setVariable(scope: VariableScope, name: string, value: unknown): void {
    const project = this.project()
    const target =
      scope === 'vars'
        ? this.vars
        : scope === 'session'
          ? this.session
          : this.local
    target.update((current) => ({ ...current, [name]: value }))
    if (scope !== 'vars' && project)
      try {
        safeStorage(scope)?.setItem(
          storageKey(project.id, name),
          JSON.stringify(value ?? null),
        )
      } catch {
        /* storage full or blocked: keep the in-memory value */
      }
  }

  notify(level: NotifyLevel, message: string): void {
    if (!message) return
    this.snack.open(message, 'Close', {
      duration: level === 'error' ? 8000 : 4000,
      panelClass: `snack-${level}`,
    })
  }

  navigate(to: string): void {
    const target = to.trim()
    if (!target) return
    if (/^https?:\/\//i.test(target)) {
      window.location.assign(target)
      return
    }
    const [path, search = ''] = target.replace(/^#/, '').split('?')
    const hook = this.navigateHook()
    if (hook) hook(target)
    else
      void this.router.navigateByUrl(
        `${this.base()}/${path.replace(/^\/+/, '')}${search ? `?${search}` : ''}`,
      )
  }

  /** Link for a page path pattern filled with the current values. */
  link(
    pattern: string,
    params: Record<string, unknown> = this.params(),
  ): string {
    return `${this.base()}/${buildPath(pattern, params)}`
  }

  status(flowId: string | undefined): FlowState {
    if (!flowId) return { status: 'success' }
    return this.flows()[flowId] ?? { status: 'idle' }
  }

  /** Runs a flow in the browser, or asks the Worker for server flows. */
  async run(
    flowId: string,
    input: Record<string, unknown> = {},
    extra: Record<string, unknown> = {},
    depth = 0,
  ): Promise<FlowState> {
    const project = this.project()
    const flow = project?.flows.find((item) => item.id === flowId)
    if (!project || !flow)
      return { status: 'error', error: 'This flow no longer exists.' }
    this.controllers.get(flowId)?.abort()
    const controller = new AbortController()
    this.controllers.set(flowId, controller)
    this.patchFlow(flowId, { ...this.status(flowId), status: 'running' })
    let state: FlowState
    try {
      const result =
        flow.runAt === 'server'
          ? await this.api.runServerFlow(
              project,
              flow.id,
              { input, params: this.params(), query: this.query() },
              this.draft(),
              controller.signal,
            )
          : await runFlow(
              flow,
              { ...this.context(), ...extra, input },
              {
                http: (request, signal) =>
                  fetchHttp(request, signal, window.location.origin),
                setVariable: (scope, name, value) =>
                  this.setVariable(scope, name, value),
                notify: (level, message) => this.notify(level, message),
                navigate: (to) => this.navigate(to),
                enqueueFlow: (id, flowInput, signal) =>
                  this.api.enqueueFlow(
                    project,
                    id,
                    {
                      input: flowInput,
                      params: this.params(),
                      query: this.query(),
                    },
                    this.draft(),
                    signal,
                  ),
                serverFlow: async (id, flowInput, signal) => {
                  const server = await this.api.runServerFlow(
                    project,
                    id,
                    {
                      input: flowInput,
                      params: this.params(),
                      query: this.query(),
                    },
                    this.draft(),
                    signal,
                  )
                  if (server.status === 'error') throw new Error(server.error)
                  return server.output
                },
              },
              {
                side: 'client',
                breakers: this.api.breakers,
                key: project.id,
                signal: controller.signal,
              },
            )
      if (flow.runAt === 'server') {
        // Apply what the server flow changed and show its messages here.
        for (const scope of ['vars', 'session', 'local'] as const)
          for (const [name, value] of Object.entries(
            result.variables?.[scope] ?? {},
          ))
            this.setVariable(scope, name, value)
        for (const note of result.notifications ?? [])
          this.notify(note.level, note.message)
      }
      state = {
        status: result.status,
        output: result.output,
        error: result.error,
        emptyMessage: result.emptyMessage,
        result,
      }
    } catch (error) {
      if (controller.signal.aborted) return this.status(flowId)
      const message =
        error instanceof Error ? error.message : 'The flow could not run.'
      this.notify('error', message)
      state = { status: 'error', error: message }
    }
    if (this.controllers.get(flowId) === controller) {
      this.controllers.delete(flowId)
      this.patchFlow(flowId, state)
    }
    // Chained flows; the depth cap stops accidental endless loops.
    const next = state.status === 'error' ? flow.onFailure : flow.onSuccess
    if (next && depth < 10)
      void this.run(
        next,
        state.status === 'error'
          ? { error: state.error, from: flow.id }
          : { result: state.output, from: flow.id },
        extra,
        depth + 1,
      )
    return state
  }

  private patchFlow(flowId: string, state: FlowState): void {
    this.flows.update((flows) => ({ ...flows, [flowId]: state }))
  }

  cancelAll(): void {
    for (const controller of this.controllers.values()) controller.abort()
    this.controllers.clear()
    for (const timer of this.timers) clearInterval(timer)
    this.timers = []
  }

  private timers: ReturnType<typeof setInterval>[] = []

  /** Runs the flow attached to a block event, with `event` details available to its logic. */
  fire(
    block: Block,
    event: EventName,
    details: Record<string, unknown> = {},
  ): void {
    const flowId = block.on?.[event]
    if (!flowId) return
    void this.run(
      flowId,
      {},
      { event: { type: event, block: block.name, ...details } },
    )
  }

  /** Ticks once a second while a countdown is on screen. */
  readonly now = signal(Date.now())
  private clock: ReturnType<typeof setInterval> | undefined
  startClock(): void {
    this.clock ??= setInterval(() => this.now.set(Date.now()), 1000)
  }
  stopClock(): void {
    clearInterval(this.clock)
    this.clock = undefined
  }

  /**
   * Evaluates a block's logic into display values. `scope` adds repeater
   * values (item, index). Errors are shown on the block, never thrown.
   */
  view(block: Block, scope: Record<string, unknown> = {}): BlockView {
    const source = this.status(block.source)
    const data = {
      ...this.context(),
      ...scope,
      data: source.output ?? scope['item'] ?? null,
    }
    const errors: string[] = []
    const get = (key: BindingKey, fallback: unknown): unknown => {
      const logic = block.logic?.[key]
      if (logic === undefined) return fallback
      try {
        return isLogic(logic) ? evaluate(logic, data) : logic
      } catch (error) {
        errors.push(
          `${key}: ${error instanceof Error ? error.message : 'error'}`,
        )
        return fallback
      }
    }
    // With a data source but no items logic, lists and tables show the flow output.
    const output = block.source ? source.output : undefined
    const sourceItems = Array.isArray(output) ? output : undefined
    const sourceText =
      output !== undefined && (typeof output !== 'object' || output === null)
        ? asText(output)
        : undefined
    const items = get(
      'items',
      sourceItems ?? (block.type === 'repeater' ? [] : block.options),
    )
    const rawValue = get('value', block.value)
    const bound = block.bind
      ? this.readVariable(block.bind.scope, block.bind.name)
      : undefined
    return {
      visible: !!get('visible', true),
      text: asText(get('text', sourceText ?? block.text)),
      label: asText(get('label', block.label)),
      url: asText(get('url', block.url)),
      items: toItems(items),
      rows: toRows(items),
      list: toList(items),
      value:
        block.type === 'rating' && bound !== undefined && bound !== null
          ? Number(bound) || 0
          : Math.max(0, Math.min(100, Number(rawValue) || 0)),
      inputValue:
        bound !== undefined && bound !== null
          ? bound
          : block.logic?.value !== undefined
            ? rawValue
            : '',
      disabled: !!get('disabled', block.disabled),
      status: block.source
        ? source.status === 'idle'
          ? 'running'
          : source.status
        : 'success',
      message:
        source.status === 'error'
          ? block.errorText || source.error || 'Something went wrong.'
          : source.status === 'empty'
            ? block.emptyText || source.emptyMessage || 'Nothing to show yet.'
            : '',
      errors,
    }
  }

  readVariable(scope: VariableScope, name: string): unknown {
    const store =
      scope === 'vars'
        ? this.vars()
        : scope === 'session'
          ? this.session()
          : this.local()
    return store[name]
  }
}

function safeStorage(scope: 'session' | 'local'): Storage | undefined {
  try {
    return scope === 'session' ? sessionStorage : localStorage
  } catch {
    return undefined
  }
}
