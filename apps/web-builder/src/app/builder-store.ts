import { Injectable, computed, effect, inject, signal } from '@angular/core'
import {
  Block,
  DataSource,
  BlockType,
  Project,
  VariableDef,
  Viewport,
  createBlock,
  createProject,
  duplicateBlock,
  findBlock,
  isContainer,
  moveBlock,
  removeBlock,
  ComponentDef,
  Page,
  acceptsChildren,
} from '@spsedu360/engine/model'
import { Flow, createFlow } from '@spsedu360/engine/flow'
import { createsCycle } from '@spsedu360/engine/publishing'
import type { ApiDef } from '@spsedu360/engine/api'
import { ApiService, ProjectSummary } from './services/api'

@Injectable({ providedIn: 'root' })
export class BuilderStore {
  private readonly api = inject(ApiService)
  readonly project = signal<Project>(createProject())
  readonly pageId = signal(this.project().pages[0].id)
  readonly selectedId = signal('')
  readonly viewport = signal<Viewport>('desktop')
  readonly preview = signal(false)
  /** The page on the canvas, or the component being edited (shown like a page without a path). */
  readonly page = computed<Page>(() => {
    const project = this.project()
    const component = project.components?.find(
      (item) => item.id === this.pageId(),
    )
    if (component)
      return {
        id: component.id,
        name: component.name,
        path: '',
        blocks: component.blocks,
      }
    return (
      project.pages.find((page) => page.id === this.pageId()) ||
      project.pages[0]
    )
  })
  readonly editingComponent = computed(
    () =>
      this.project().components?.find((item) => item.id === this.pageId()) ??
      null,
  )
  readonly selected = computed(() =>
    findBlock(this.page().blocks, this.selectedId()),
  )
  readonly history = signal<Project[]>([])
  readonly future = signal<Project[]>([])
  readonly dirty = signal(false)
  readonly saving = signal(false)
  readonly summary = signal<ProjectSummary | null>(null)
  /** Credential names for this project (values stay on the server). */
  readonly secretNames = signal<string[]>([])
  private draftTimer: ReturnType<typeof setTimeout> | undefined

  constructor() {
    // Unsaved work is kept on this device so a closed tab loses nothing.
    effect(() => {
      const project = this.project()
      if (!this.dirty()) return
      clearTimeout(this.draftTimer)
      this.draftTimer = setTimeout(() => this.api.saveDraft(project), 800)
    })
  }

  change(update: (project: Project) => void): void {
    const current = this.project()
    const next = structuredClone(current)
    update(next)
    if (JSON.stringify(next) === JSON.stringify(current)) return
    this.history.update((history) => [
      ...history.slice(-49),
      structuredClone(current),
    ])
    this.future.set([])
    this.project.set(next)
    this.dirty.set(true)
  }

  private currentPage(project: Project): { blocks: Block[] } {
    return (
      project.components?.find((item) => item.id === this.pageId()) ??
      project.pages.find((page) => page.id === this.pageId()) ??
      project.pages[0]
    )
  }

  // ---- Reusable components ------------------------------------------------------------

  /** A name not yet used by another component (or page) of this app. */
  uniqueName(base: string, taken: string[]): string {
    const used = new Set(taken.map((name) => name.trim().toLowerCase()))
    let name = base
    for (let n = 2; used.has(name.toLowerCase()); n++) name = `${base} ${n}`
    return name
  }

  /** Creates a component; with `fromBlock`, that block moves into it and an instance takes its place. */
  createComponent(fromBlock?: Block): ComponentDef {
    const names = (this.project().components ?? []).map((item) => item.name)
    const component: ComponentDef = {
      id: crypto.randomUUID(),
      name: this.uniqueName(fromBlock?.name || 'Component', names),
      blocks: fromBlock ? [structuredClone(fromBlock)] : [],
    }
    this.change((project) => {
      project.components = [...(project.components ?? []), component]
      if (!fromBlock) return
      const instance = {
        ...createBlock('component'),
        name: component.name,
        componentId: component.id,
      }
      const swap = (blocks: Block[]): boolean => {
        const index = blocks.findIndex((block) => block.id === fromBlock.id)
        if (index >= 0) {
          blocks.splice(index, 1, instance)
          return true
        }
        return blocks.some((block) => swap(block.children))
      }
      swap(this.currentPage(project).blocks)
    })
    return component
  }

  /** Places a component on the page or component being edited. Returns an error message or ''. */
  placeComponent(componentId: string, parentId = 'root'): string {
    const editing = this.editingComponent()
    if (
      editing &&
      createsCycle(this.project().components ?? [], editing.id, componentId)
    )
      return 'A component cannot contain itself.'
    const component = this.project().components?.find(
      (item) => item.id === componentId,
    )
    if (!component) return 'That component no longer exists.'
    const instance = {
      ...createBlock('component'),
      name: component.name,
      componentId,
    }
    this.change((project) => {
      const page = this.currentPage(project)
      const parent =
        parentId === 'root' ? undefined : findBlock(page.blocks, parentId)
      ;(parent && acceptsChildren(parent.type)
        ? parent.children
        : page.blocks
      ).push(instance)
    })
    this.selectedId.set(instance.id)
    return ''
  }

  /** Adds or replaces one of the app's saved APIs. */
  saveApi(api: ApiDef): void {
    this.change((project) => {
      const apis = project.apis ?? []
      const index = apis.findIndex((item) => item.id === api.id)
      if (index >= 0) apis[index] = api
      else apis.push(api)
      project.apis = apis
    })
  }

  deleteApi(id: string): void {
    this.change((project) => {
      project.apis = (project.apis ?? []).filter((api) => api.id !== id)
      if (!project.apis.length) delete project.apis
    })
  }

  /** Names of flows with a step calling this API. */
  apiUsage(id: string): string[] {
    return this.project()
      .flows.filter((flow) =>
        flow.steps.some((step) => step.type === 'api' && step.apiId === id),
      )
      .map((flow) => flow.name)
  }

  /** Changes a component's inputs or outputs; placements drop values for removed inputs. */
  setComponentPorts(
    id: string,
    ports: {
      inputs?: ComponentDef['inputs']
      outputs?: ComponentDef['outputs']
    },
  ): void {
    this.change((project) => {
      const component = project.components?.find((item) => item.id === id)
      if (!component) return
      for (const key of ['inputs', 'outputs'] as const) {
        if (!(key in ports)) continue
        const list = ports[key]
        if (list?.length)
          (component as unknown as Record<string, unknown>)[key] = list
        else delete component[key]
      }
      const inputs = new Set(
        (component.inputs ?? []).map((input) => input.name),
      )
      const outputs = new Set(
        (component.outputs ?? []).map((output) => output.name),
      )
      const trim = (blocks: Block[]) =>
        blocks.forEach((block) => {
          if (block.type === 'component' && block.componentId === id) {
            if (block.props)
              for (const name of Object.keys(block.props))
                if (!inputs.has(name)) delete block.props[name]
            if (block.outputs)
              for (const name of Object.keys(block.outputs))
                if (!outputs.has(name)) delete block.outputs[name]
          }
          trim(block.children)
        })
      for (const page of project.pages) trim(page.blocks)
      for (const other of project.components ?? []) trim(other.blocks)
    })
  }

  renameComponent(id: string, name: string): void {
    this.change((project) => {
      const component = project.components?.find((item) => item.id === id)
      if (component) component.name = name.slice(0, 200)
    })
  }

  /** Removes a component that nothing uses any more. */
  deleteComponent(id: string): void {
    this.change((project) => {
      project.components = (project.components ?? []).filter(
        (item) => item.id !== id,
      )
    })
    if (this.pageId() === id) this.pageId.set(this.project().pages[0].id)
  }

  add(type: BlockType, parentId = 'root', index?: number): void {
    const block = createBlock(type)
    this.change((project) => {
      const page = this.currentPage(project)
      const parent =
        parentId === 'root' ? undefined : findBlock(page.blocks, parentId)
      if (parentId !== 'root' && (!parent || !acceptsChildren(parent.type)))
        return
      const target = parent ? parent.children : page.blocks
      target.splice(index ?? target.length, 0, block)
    })
    this.selectedId.set(block.id)
  }

  move(id: string, parentId: string, index: number): void {
    this.change((project) =>
      moveBlock(this.currentPage(project).blocks, id, parentId, index),
    )
  }

  updateBlock(patch: Partial<Block>): void {
    this.change((project) => {
      const block = findBlock(
        this.currentPage(project).blocks,
        this.selectedId(),
      )
      if (!block) return
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined)
          delete (block as unknown as Record<string, unknown>)[key]
        else (block as unknown as Record<string, unknown>)[key] = value
      }
    })
  }

  delete(): void {
    this.change((project) =>
      removeBlock(this.currentPage(project).blocks, this.selectedId()),
    )
    this.selectedId.set('')
  }

  duplicate(): void {
    const selected = this.selected()
    if (!selected) return
    const copy = duplicateBlock(selected)
    this.change((project) => {
      const insert = (blocks: Block[]): boolean => {
        const index = blocks.findIndex((block) => block.id === selected.id)
        if (index >= 0) {
          blocks.splice(index + 1, 0, copy)
          return true
        }
        return blocks.some((block) => insert(block.children))
      }
      insert(this.currentPage(project).blocks)
    })
    this.selectedId.set(copy.id)
  }

  undo(): void {
    const previous = this.history().at(-1)
    if (!previous) return
    this.future.update((future) => [...future, this.project()])
    this.history.update((history) => history.slice(0, -1))
    this.project.set(previous)
    this.dirty.set(true)
    this.selectedId.set('')
  }

  redo(): void {
    const next = this.future().at(-1)
    if (!next) return
    this.history.update((history) => [...history, this.project()])
    this.future.update((future) => future.slice(0, -1))
    this.project.set(next)
    this.dirty.set(true)
    this.selectedId.set('')
  }

  load(project: Project, summary: ProjectSummary | null = null): void {
    this.project.set(project)
    this.pageId.set(project.pages[0].id)
    this.selectedId.set('')
    this.history.set([])
    this.future.set([])
    this.dirty.set(false)
    this.preview.set(false)
    this.summary.set(summary)
  }

  async save(): Promise<void> {
    this.saving.set(true)
    try {
      const saved = this.project()
      const summary = await this.api.save(saved)
      this.summary.set({
        ...summary,
        publishedAt: summary.publishedAt ?? this.summary()?.publishedAt ?? null,
      })
      this.project.update((project) => ({
        ...project,
        updatedAt: summary.updatedAt,
      }))
      // Only clear the flag if nothing changed while saving.
      if (
        this.project().pages === saved.pages &&
        this.project().flows === saved.flows
      )
        this.dirty.set(false)
    } finally {
      this.saving.set(false)
    }
  }

  /** After a publish or unpublish: the live state shown in the toolbar. */
  applySummary(summary: ProjectSummary): void {
    this.summary.set({ ...this.summary(), ...summary })
  }

  /** Replaces the draft with one restored on the server, keeping the canvas where it was. */
  replaceDraft(project: Project): void {
    const pageId = this.pageId()
    this.load(project, this.summary())
    if (
      project.pages.some((page) => page.id === pageId) ||
      project.components?.some((item) => item.id === pageId)
    )
      this.pageId.set(pageId)
  }

  addPage(): void {
    if (this.project().pages.length >= 50) return
    const id = crypto.randomUUID()
    let number = this.project().pages.length + 1
    while (
      this.project().pages.some(
        (page) =>
          page.path === `page-${number}` ||
          page.name.trim().toLowerCase() === `page ${number}`,
      )
    )
      number++
    this.change((project) =>
      project.pages.push({
        id,
        name: `Page ${number}`,
        path: `page-${number}`,
        blocks: [],
      }),
    )
    this.pageId.set(id)
    this.selectedId.set('')
  }

  // ---- Flows -----------------------------------------------------------------

  addFlow(name = 'New flow'): Flow {
    const flow = createFlow(name)
    this.change((project) => project.flows.push(flow))
    return flow
  }

  duplicateFlow(id: string): void {
    const flow = this.project().flows.find((item) => item.id === id)
    if (!flow) return
    const ids = new Map(
      flow.steps.map((step) => [step.id, crypto.randomUUID()]),
    )
    const copy: Flow = {
      ...structuredClone(flow),
      id: crypto.randomUUID(),
      name: `${flow.name} copy`,
      steps: flow.steps.map((step) => ({
        ...structuredClone(step),
        id: ids.get(step.id)!,
        after: step.after.map((dep) => ids.get(dep) ?? dep),
      })),
      positions: Object.fromEntries(
        Object.entries(flow.positions).map(([key, value]) => [
          ids.get(key) ?? key,
          value,
        ]),
      ),
    }
    this.change((project) => project.flows.push(copy))
  }

  /** Removes a flow and every reference to it. */
  deleteFlow(id: string): void {
    this.change((project) => {
      project.flows = project.flows.filter((flow) => flow.id !== id)
      for (const flow of project.flows) {
        if (flow.onSuccess === id) delete flow.onSuccess
        if (flow.onFailure === id) delete flow.onFailure
        for (const step of flow.steps) if (step.flowId === id) step.flowId = ''
      }
      const clean = (blocks: Block[]) =>
        blocks.forEach((block) => {
          if (block.source === id) delete block.source
          for (const [event, flowId] of Object.entries(block.on ?? {}))
            if (flowId === id)
              delete (block.on as Record<string, string>)[event]
          clean(block.children)
        })
      project.pages.forEach((page) => clean(page.blocks))
    })
  }

  /** Flows referencing a flow, for delete warnings. */
  flowUsage(id: string): number {
    let count = 0
    const visit = (blocks: Block[]) =>
      blocks.forEach((block) => {
        if (block.source === id || Object.values(block.on ?? {}).includes(id))
          count++
        visit(block.children)
      })
    this.project().pages.forEach((page) => visit(page.blocks))
    return count
  }

  // ---- Data sources ------------------------------------------------------------

  addDataSource(): void {
    let n = this.project().dataSources.length + 1
    while (
      this.project().dataSources.some(
        (source) => source.name === `Database ${n}`,
      )
    )
      n++
    this.change((project) =>
      project.dataSources.push({
        id: crypto.randomUUID(),
        name: `Database ${n}`,
        type: 'postgres',
        credential: `DATABASE_URL_${n}`,
        readOnly: true,
      }),
    )
  }

  updateDataSource(id: string, patch: Partial<DataSource>): void {
    this.change((project) => {
      const source = project.dataSources.find((item) => item.id === id)
      if (source) Object.assign(source, patch)
    })
  }

  /** Steps using a data source, for delete warnings. */
  dataSourceUsage(id: string): number {
    return this.project().flows.reduce(
      (count, flow) =>
        count + flow.steps.filter((step) => step.dataSource === id).length,
      0,
    )
  }

  deleteDataSource(id: string): void {
    this.change((project) => {
      project.dataSources = project.dataSources.filter((item) => item.id !== id)
      for (const flow of project.flows)
        for (const step of flow.steps)
          if (step.dataSource === id) step.dataSource = ''
    })
  }

  // ---- Variables -------------------------------------------------------------

  addVariable(): void {
    let n = this.project().variables.length + 1
    while (this.project().variables.some((v) => v.name === `variable${n}`)) n++
    this.change((project) =>
      project.variables.push({
        id: crypto.randomUUID(),
        name: `variable${n}`,
        scope: 'vars',
        initial: '',
        description: '',
      }),
    )
  }

  updateVariable(id: string, patch: Partial<VariableDef>): void {
    this.change((project) => {
      const variable = project.variables.find((item) => item.id === id)
      if (variable) Object.assign(variable, patch)
    })
  }

  deleteVariable(id: string): void {
    this.change((project) => {
      project.variables = project.variables.filter((item) => item.id !== id)
    })
  }
}
