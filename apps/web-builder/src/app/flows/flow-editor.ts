import { Component, computed, inject, signal, viewChild } from '@angular/core'
import { FormsModule } from '@angular/forms'
import {
  MAT_DIALOG_DATA,
  MatDialogModule,
  MatDialogRef,
} from '@angular/material/dialog'
import { MatButtonModule } from '@angular/material/button'
import { MatIconModule } from '@angular/material/icon'
import { MatMenuModule } from '@angular/material/menu'
import { MatFormFieldModule } from '@angular/material/form-field'
import { MatInputModule } from '@angular/material/input'
import { MatSelectModule } from '@angular/material/select'
import { MatButtonToggleModule } from '@angular/material/button-toggle'
import { MatExpansionModule } from '@angular/material/expansion'
import { MatSlideToggleModule } from '@angular/material/slide-toggle'
import { MatTooltipModule } from '@angular/material/tooltip'
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner'
import {
  FCanvasComponent,
  FCreateConnectionEvent,
  FFlowModule,
  FSelectionChangeEvent,
} from '@foblex/flow'
import {
  Flow,
  FlowResult,
  FlowStep,
  STEP_TYPES,
  StepType,
  createStep,
  dependencies,
  fetchHttp,
  runFlow,
  validateFlow,
} from '@spsedu360/engine/flow'
import { Logic } from '@spsedu360/engine/logic'
import { BuilderStore } from '../builder-store'
import { LogicField } from '../logic/logic-editor'
import { QueryBuilder } from './query-builder'
import { QueryDef, validateQuery } from '@spsedu360/engine/query'
import { AccessRule } from '@spsedu360/engine/access'
import {
  flowSuggestions,
  sampleContext,
  variableSuggestions,
} from '../logic/suggestions'
import { ApiService } from '../services/api'

interface TestLog {
  kind: 'message' | 'variable' | 'navigate'
  text: string
}

@Component({
  selector: 'flow-editor',
  imports: [
    FormsModule,
    FFlowModule,
    MatDialogModule,
    MatButtonModule,
    MatIconModule,
    MatMenuModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    MatButtonToggleModule,
    MatExpansionModule,
    MatSlideToggleModule,
    MatTooltipModule,
    MatProgressSpinnerModule,
    LogicField,
    QueryBuilder,
  ],
  templateUrl: './flow-editor.html',
})
export class FlowEditor {
  readonly store = inject(BuilderStore)
  private readonly api = inject(ApiService)
  private readonly ref = inject(MatDialogRef<FlowEditor>)
  private readonly data = inject<{ flowId: string }>(MAT_DIALOG_DATA)
  private readonly canvas = viewChild(FCanvasComponent)

  readonly stepTypes = STEP_TYPES
  readonly schedulePresets = [
    { cron: '*/15 * * * *', label: 'Every 15 minutes' },
    { cron: '0 * * * *', label: 'Every hour' },
    { cron: '0 2 * * *', label: 'Every day at 2:00 (UTC)' },
    { cron: '0 8 * * 1', label: 'Every Monday at 8:00 (UTC)' },
    { cron: '0 0 1 * *', label: 'First day of every month' },
  ]
  readonly selectedId = signal('')
  readonly selectedConnection = signal('')
  readonly testInput = signal('{}')
  readonly testing = signal(false)
  readonly testResult = signal<FlowResult | null>(null)
  readonly testLog = signal<TestLog[]>([])
  readonly testError = signal('')

  readonly flow = computed(() =>
    this.store.project().flows.find((flow) => flow.id === this.data.flowId),
  )
  readonly step = computed(() =>
    this.flow()?.steps.find((step) => step.id === this.selectedId()),
  )
  readonly problems = computed(() => {
    const flow = this.flow()
    if (!flow) return []
    const problems = validateFlow(flow)
    for (const step of flow.steps) {
      if (step.type !== 'query' || !step.query) continue
      const source = this.store
        .project()
        .dataSources.find((item) => item.id === step.dataSource)
      if (!source) continue
      for (const problem of validateQuery(
        step.query,
        source.type,
        source.schema,
      ))
        problems.push(`"${step.name}": ${problem}`)
    }
    return problems
  })
  readonly otherFlows = computed(() =>
    this.store.project().flows.filter((flow) => flow.id !== this.data.flowId),
  )
  readonly serverFlows = computed(() =>
    this.store.project().flows.filter((flow) => flow.runAt === 'server'),
  )
  readonly dataSources = computed(() => this.store.project().dataSources)
  /** Saved APIs this flow may call: the app's, plus those of the pages it runs on. */
  readonly apis = computed(() => {
    const pageIds = this.flow()?.pageIds ?? []
    return (this.store.project().apis ?? []).filter(
      (api) => !api.pageId || !pageIds.length || pageIds.includes(api.pageId),
    )
  })
  readonly stepApi = computed(() =>
    (this.store.project().apis ?? []).find(
      (api) => api.id === this.step()?.apiId,
    ),
  )

  readonly Math = Math

  setCache(on: boolean): void {
    this.updateStep((step) => {
      if (on) step.cache = { scope: 'session', ttlSeconds: 600 }
      else delete step.cache
    })
  }
  setCacheField(field: 'scope' | 'ttlSeconds', value: unknown): void {
    this.updateStep((step) => {
      if (step.cache) step.cache = { ...step.cache, [field]: value }
    })
  }

  setArg(name: string, value: Logic | undefined): void {
    this.updateStep((step) => {
      const args = {
        ...((step.args as Record<string, unknown> | undefined) ?? {}),
      }
      if (value === undefined) delete args[name]
      else args[name] = value
      step.args = args as Logic
    })
  }
  readonly stepSource = computed(() =>
    this.dataSources().find((source) => source.id === this.step()?.dataSource),
  )

  accessChoice(rule: AccessRule | undefined): string[] {
    if (!rule || rule.mode === 'public') return ['public']
    if (rule.mode === 'signedIn') return ['signedIn']
    return rule.roles ?? []
  }
  setAccess(choices: string[]): void {
    const last = choices.at(-1)
    this.update((flow) => {
      if (!choices.length || last === 'public') delete flow.access
      else if (last === 'signedIn') flow.access = { mode: 'signedIn' }
      else
        flow.access = {
          mode: 'roles',
          roles: choices.filter((c) => c !== 'public' && c !== 'signedIn'),
        }
    })
  }

  setQuery(query: QueryDef): void {
    this.setStep('query', query)
  }
  readonly variables = computed(() => {
    const flow = this.flow()
    return flow
      ? variableSuggestions(this.store.project(), [
          ...flowSuggestions(flow),
          ...this.store.secretNames().map((name) => `secrets.${name}`),
        ])
      : []
  })
  readonly sample = computed(() => {
    let input: unknown = {}
    try {
      input = JSON.parse(this.testInput() || '{}')
    } catch {
      /* invalid sample input */
    }
    const outputs: Record<string, unknown> = {}
    for (const [id, step] of Object.entries(this.testResult()?.steps ?? {}))
      outputs[id] = step.output
    return {
      ...sampleContext(this.store.project()),
      input,
      steps: outputs,
      error: { message: 'Example error', status: 500 },
      response: [],
    }
  })
  readonly connections = computed(() => {
    const flow = this.flow()
    if (!flow) return []
    return flow.steps.flatMap((step) =>
      dependencies(flow, step)
        .filter((dep) => flow.steps.some((item) => item.id === dep))
        .map((dep) => ({
          id: `${dep}->${step.id}`,
          source: `out-${dep}`,
          target: `in-${step.id}`,
          implicit: !step.after.includes(dep),
        })),
    )
  })
  /** Positions, laid out by dependency depth for steps never moved by hand. */
  readonly positions = computed(() => {
    const flow = this.flow()
    const result: Record<string, { x: number; y: number }> = {}
    if (!flow) return result
    const depth = new Map<string, number>()
    const depthOf = (step: FlowStep, seen = new Set<string>()): number => {
      if (depth.has(step.id)) return depth.get(step.id)!
      if (seen.has(step.id)) return 0
      seen.add(step.id)
      const deps = dependencies(flow, step)
        .map((id) => flow.steps.find((item) => item.id === id))
        .filter(Boolean) as FlowStep[]
      const value = deps.length
        ? Math.max(...deps.map((dep) => depthOf(dep, seen))) + 1
        : 0
      depth.set(step.id, value)
      return value
    }
    const rows = new Map<number, number>()
    for (const step of flow.steps) {
      const level = depthOf(step)
      const row = rows.get(level) ?? 0
      rows.set(level, row + 1)
      result[step.id] = flow.positions[step.id] ?? {
        x: 40 + level * 300,
        y: 40 + row * 160,
      }
    }
    return result
  })

  constructor() {
    const first = this.flow()?.steps[0]
    if (first) this.selectedId.set(first.id)
  }

  private update(change: (flow: Flow) => void): void {
    this.store.change((project) => {
      const flow = project.flows.find((item) => item.id === this.data.flowId)
      if (flow) change(flow)
    })
  }

  private updateStep(change: (step: FlowStep) => void): void {
    const id = this.selectedId()
    this.update((flow) => {
      const step = flow.steps.find((item) => item.id === id)
      if (step) change(step)
    })
  }

  setFlow<K extends keyof Flow>(key: K, value: Flow[K]): void {
    this.update((flow) => {
      flow[key] = value
      if (key === 'trigger' && value === 'interval' && !flow.intervalSeconds)
        flow.intervalSeconds = 60
      if (key === 'trigger' && value === 'schedule' && !flow.schedule)
        flow.schedule = '0 2 * * *'
      // Browser flows can't be scheduled; fall back to manual when switching.
      if (key === 'runAt' && value === 'client' && flow.trigger === 'schedule')
        flow.trigger = 'manual'
    })
  }

  setStep<K extends keyof FlowStep>(key: K, value: FlowStep[K]): void {
    this.updateStep((step) => {
      if (value === undefined) delete step[key]
      else step[key] = value
    })
  }

  setLogic(key: keyof FlowStep, value: Logic | undefined): void {
    this.setStep(key, value as never)
  }

  setPolicy(
    group: 'retry' | 'breaker' | 'onError',
    key: string,
    value: unknown,
  ): void {
    this.updateStep((step) => {
      ;(step[group] as unknown as Record<string, unknown>)[key] = value
    })
  }

  setSaveAs(enabled: boolean): void {
    this.setStep(
      'saveAs',
      enabled ? { scope: 'vars', name: 'result' } : undefined,
    )
  }

  setSaveAsField(key: 'scope' | 'name', value: string): void {
    this.updateStep((step) => {
      if (step.saveAs) step.saveAs = { ...step.saveAs, [key]: value }
    })
  }

  addStep(type: StepType): void {
    const step = createStep(type)
    const selected = this.step()
    // New steps run after the selected one, which is what people expect.
    if (selected && this.flow()?.mode === 'parallel') step.after = [selected.id]
    if (selected) {
      const position = this.positions()[selected.id]
      this.update(
        (flow) =>
          (flow.positions[step.id] = { x: position.x + 300, y: position.y }),
      )
    }
    this.update((flow) => flow.steps.push(step))
    this.selectedId.set(step.id)
  }

  removeStep(): void {
    const id = this.selectedId()
    this.update((flow) => {
      flow.steps = flow.steps.filter((step) => step.id !== id)
      flow.steps.forEach(
        (step) => (step.after = step.after.filter((dep) => dep !== id)),
      )
      delete flow.positions[id]
    })
    this.selectedId.set(this.flow()?.steps[0]?.id ?? '')
  }

  duplicateStep(): void {
    const step = this.step()
    if (!step) return
    const copy: FlowStep = {
      ...structuredClone(step),
      id: crypto.randomUUID(),
      name: `${step.name} copy`,
    }
    this.update((flow) => flow.steps.push(copy))
    this.selectedId.set(copy.id)
  }

  moveStep(delta: number): void {
    const id = this.selectedId()
    this.update((flow) => {
      const index = flow.steps.findIndex((step) => step.id === id)
      const target = index + delta
      if (index < 0 || target < 0 || target >= flow.steps.length) return
      const [step] = flow.steps.splice(index, 1)
      flow.steps.splice(target, 0, step)
    })
  }

  connect(event: FCreateConnectionEvent): void {
    if (!event.targetId) return
    const from = event.sourceId.replace(/^out-/, '')
    const to = event.targetId.replace(/^in-/, '')
    if (from === to) return
    this.update((flow) => {
      const step = flow.steps.find((item) => item.id === to)
      if (step && !step.after.includes(from)) step.after.push(from)
    })
  }

  selection(event: FSelectionChangeEvent): void {
    this.selectedConnection.set(event.connectionIds[0] ?? '')
    const node = event.nodeIds[0]
    if (node) this.selectedId.set(node.replace(/^node-/, ''))
  }

  removeConnection(): void {
    const [from, to] = this.selectedConnection().split('->')
    this.update((flow) => {
      const step = flow.steps.find((item) => item.id === to)
      if (step) step.after = step.after.filter((dep) => dep !== from)
    })
    this.selectedConnection.set('')
  }

  toggleDependency(dep: string, on: boolean): void {
    this.updateStep((step) => {
      step.after = on
        ? [...new Set([...step.after, dep])]
        : step.after.filter((id) => id !== dep)
    })
  }

  moved(stepId: string, position: { x: number; y: number }): void {
    this.update(
      (flow) =>
        (flow.positions[stepId] = {
          x: Math.round(position.x),
          y: Math.round(position.y),
        }),
    )
  }

  fit(): void {
    this.canvas()?.fitToScreen({ x: 80, y: 80 }, false, false, 1)
  }

  typeInfo(type: StepType) {
    return STEP_TYPES.find((item) => item.type === type)
  }

  stepStatus(id: string) {
    return this.testResult()?.steps[id]
  }

  isDependency(dep: string): boolean {
    return !!this.step()?.after.includes(dep)
  }

  pageChoice(pageIds: string[]): void {
    this.setFlow('pageIds', pageIds)
  }

  async test(): Promise<void> {
    const flow = this.flow()
    if (!flow) return
    let input: unknown
    try {
      input = JSON.parse(this.testInput() || '{}')
      this.testError.set('')
    } catch {
      this.testError.set('Sample input must be valid JSON, e.g. {"qty": 2}.')
      return
    }
    this.testing.set(true)
    this.testResult.set(null)
    const log: TestLog[] = []
    const project = this.store.project()
    try {
      const context: Record<string, unknown> = {
        ...sampleContext(project),
        input,
        user: {
          signedIn: true,
          id: 'test-user',
          email: 'test@example.com',
          name: 'Test',
          roles: project.auth?.roles.map((role) => role.id) ?? [],
        },
      }
      const result =
        flow.runAt === 'server'
          ? await this.api.runServerFlow(
              project,
              flow.id,
              { input, params: context['params'], query: {} },
              true,
            )
          : await runFlow(
              flow,
              context,
              {
                http: (request, signal) =>
                  fetchHttp(request, signal, window.location.origin),
                setVariable: (scope, name, value) =>
                  log.push({
                    kind: 'variable',
                    text: `${scope}.${name} = ${JSON.stringify(value)}`,
                  }),
                notify: (level, message) =>
                  log.push({ kind: 'message', text: `${level}: ${message}` }),
                navigate: (to) =>
                  log.push({ kind: 'navigate', text: `Would open ${to}` }),
                enqueueFlow: (id, flowInput) =>
                  this.api.enqueueFlow(
                    project,
                    id,
                    { input: flowInput, params: {}, query: {} },
                    true,
                  ),
                serverFlow: async (id, flowInput) => {
                  const server = await this.api.runServerFlow(
                    project,
                    id,
                    { input: flowInput, params: {}, query: {} },
                    true,
                  )
                  if (server.status === 'error') throw new Error(server.error)
                  return server.output
                },
              },
              {
                side: 'client',
                breakers: this.api.breakers,
                key: `test:${project.id}`,
              },
            )
      for (const note of result.notifications ?? [])
        if (flow.runAt === 'server')
          log.push({ kind: 'message', text: `${note.level}: ${note.message}` })
      this.testResult.set(result)
      this.testLog.set(log)
    } catch (error) {
      this.testError.set(
        error instanceof Error ? error.message : 'The test could not run.',
      )
    } finally {
      this.testing.set(false)
    }
  }

  json(value: unknown): string {
    const text = JSON.stringify(value, null, 2)
    return text === undefined
      ? 'nothing'
      : text.length > 2000
        ? `${text.slice(0, 2000)}…`
        : text
  }

  close(): void {
    this.ref.close()
  }
}
