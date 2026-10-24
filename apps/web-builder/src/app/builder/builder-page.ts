import {
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core'
import { provideCharts, withDefaultRegisterables } from 'ng2-charts'
import { DOCUMENT } from '@angular/common'
import { FormsModule } from '@angular/forms'
import { ActivatedRoute, Router, RouterLink } from '@angular/router'
import { DragDropModule } from '@angular/cdk/drag-drop'
import { MatToolbarModule } from '@angular/material/toolbar'
import { MatButtonModule } from '@angular/material/button'
import { MatIconModule } from '@angular/material/icon'
import { MatTooltipModule } from '@angular/material/tooltip'
import { MatTabsModule } from '@angular/material/tabs'
import { MatFormFieldModule } from '@angular/material/form-field'
import { MatInputModule } from '@angular/material/input'
import { MatSelectModule } from '@angular/material/select'
import { MatButtonToggleModule } from '@angular/material/button-toggle'
import { MatExpansionModule } from '@angular/material/expansion'
import { MatSlideToggleModule } from '@angular/material/slide-toggle'
import { MatCheckboxModule } from '@angular/material/checkbox'
import { MatMenuModule } from '@angular/material/menu'
import { MatDividerModule } from '@angular/material/divider'
import { MatDialog } from '@angular/material/dialog'
import { MatSnackBar } from '@angular/material/snack-bar'
import {
  BINDINGS,
  BLOCKS,
  acceptsChildren,
  Block,
  BlockType,
  COLUMN_FORMATS,
  TableColumn,
  TableConfig,
  defaultTable,
  EVENTS,
  EventName,
  INPUT_TYPES,
  Project,
  STYLE_PROPERTIES,
  StyleMap,
  VARIANTS,
  VariableDef,
  blockCss,
  buildPath,
  exportPage,
  findBlock,
  isContainer,
  normalizePath,
  parseProject,
  pathParams,
  pathProblem,
  safeStyle,
} from '@spsedu360/engine/model'
import { BuilderStore } from '../builder-store'
import { BlockTree } from './block-tree'
import { AssetLibrary, AssetPicker, kindForBlock } from './asset-library'
import { LogicField } from '../logic/logic-editor'
import { sampleContext, variableSuggestions } from '../logic/suggestions'
import { FlowEditor } from '../flows/flow-editor'
import { SiteMap } from '../flows/site-map'
import { SiteRenderer } from '../runtime/site-renderer'
import { ApiService } from '../services/api'
import { Logic } from '@spsedu360/engine/logic'
import { STEP_TYPES } from '@spsedu360/engine/flow'
import { rowsFromLines } from '../blocks/table-data'
import {
  ANONYMOUS,
  AccessRule,
  SiteAuth,
  Visitor,
  defaultSiteAuth,
  forVisitor,
} from '@spsedu360/engine/access'
import { MemberRecord } from '../services/api'
import { PublishDialog } from './publish-dialog'
import {
  expandProject,
  nameProblems,
  pagesUsing,
} from '@spsedu360/engine/publishing'
import { siteUrl } from '@spsedu360/engine/address'

const DIALOG = {
  panelClass: 'fullscreen-dialog',
  maxWidth: '100vw',
  width: '100vw',
  height: '100dvh',
  autoFocus: false,
} as const

@Component({
  selector: 'builder-page',
  // Chart.js loads only with the pages that can show charts.
  providers: [provideCharts(withDefaultRegisterables())],
  imports: [
    FormsModule,
    RouterLink,
    DragDropModule,
    MatToolbarModule,
    MatButtonModule,
    MatIconModule,
    MatTooltipModule,
    MatTabsModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    MatButtonToggleModule,
    MatExpansionModule,
    MatSlideToggleModule,
    MatCheckboxModule,
    MatMenuModule,
    MatDividerModule,
    BlockTree,
    AssetLibrary,
    LogicField,
    SiteRenderer,
  ],
  templateUrl: './builder-page.html',
})
export class BuilderPage {
  readonly store = inject(BuilderStore)
  readonly api = inject(ApiService)
  private readonly document = inject(DOCUMENT)
  private readonly snack = inject(MatSnackBar)
  private readonly dialog = inject(MatDialog)
  private readonly route = inject(ActivatedRoute)
  private readonly router = inject(Router)

  /** Panel in front on smaller screens: library, canvas or inspector. */
  readonly panel = signal<'library' | 'canvas' | 'inspector'>('canvas')
  readonly loading = signal(true)
  readonly loadError = signal('')
  readonly groups = ['Layout', 'Content', 'Navigation', 'Forms', 'Data']
  readonly search = signal('')
  readonly styleProperty = signal<string>('padding')
  readonly styleValue = signal('')
  readonly styleScope = signal<'styles' | 'tabletStyles' | 'mobileStyles'>(
    'styles',
  )
  readonly previewPath = signal('')
  readonly styleProperties = STYLE_PROPERTIES
  readonly bindings = BINDINGS
  readonly events = EVENTS
  readonly variants = VARIANTS
  readonly inputTypes = INPUT_TYPES
  readonly stepTypes = STEP_TYPES
  readonly columnFormats = COLUMN_FORMATS
  readonly isContainer = isContainer
  readonly pathParams = pathParams
  readonly rejectPalette = () => false

  readonly variables = computed(() => variableSuggestions(this.store.project()))
  readonly secretsInfo = signal<{ provider: string; writable: boolean } | null>(
    null,
  )
  readonly secretsError = signal('')
  readonly newSecretName = signal('')
  readonly newSecretValue = signal('')
  readonly sample = computed(() => ({
    ...sampleContext(this.store.project()),
    data: this.sampleData(),
  }))
  readonly pathError = computed(() => pathProblem(this.store.page().path))
  readonly liveUrl = computed(() => {
    const slug = this.store.summary()?.slug
    return slug
      ? siteUrl(this.document.location.origin, slug)
      : `${this.document.location.origin}/site/${this.store.project().id}`
  })
  readonly saveState = computed(() =>
    this.store.saving()
      ? 'Saving…'
      : this.store.dirty()
        ? 'Unsaved changes'
        : this.api.isCloud()
          ? 'Saved to cloud'
          : 'Saved on this device',
  )
  /** The selected block's data source output from the last preview, for live logic results. */
  private readonly sampleData = signal<unknown>(null)
  readonly previewQuery = computed(() => {
    const [, search = ''] = this.previewPath().split('?')
    return Object.fromEntries(new URLSearchParams(search))
  })
  readonly previewRoute = computed(() => this.previewPath().split('?')[0])
  /** "Preview as": anonymous, signed in without a role, or a role id. */
  readonly previewAs = signal<string>('anonymous')
  readonly previewVisitor = computed<Visitor>(() => {
    const as = this.previewAs()
    if (as === 'anonymous') return ANONYMOUS
    return {
      signedIn: true,
      id: 'preview-user',
      email: 'preview@example.com',
      name: 'Preview visitor',
      roles: as === 'signedIn' ? [] : [as],
    }
  })
  /** What the chosen visitor would receive from the server. */
  readonly previewProject = computed(() =>
    forVisitor(expandProject(this.store.project()), this.previewVisitor()),
  )
  /** Duplicate page or component names; saving is refused until they are fixed. */
  readonly nameIssues = computed(() => nameProblems(this.store.project()))
  /** Pages that show the component being edited; they need review after it changes. */
  readonly editingUsedBy = computed(() => {
    const component = this.store.editingComponent()
    return component
      ? pagesUsing(this.store.project(), component.id).map((page) => page.name)
      : []
  })
  readonly componentRows = computed(() =>
    (this.store.project().components ?? []).map((component) => ({
      component,
      pages: pagesUsing(this.store.project(), component.id).map(
        (page) => page.name,
      ),
    })),
  )
  readonly roles = computed(() => this.store.project().auth?.roles ?? [])
  readonly members = signal<MemberRecord[]>([])
  readonly navigateInPreview = (target: string) => {
    this.previewPath.set(normalizePath(target.replace(/^#/, '')))
  }

  private readonly overrideSheet = this.document.createElement('style')

  constructor() {
    this.overrideSheet.id = 'page-studio-overrides'
    this.document.head.appendChild(this.overrideSheet)
    effect(() => {
      this.overrideSheet.textContent = this.store.preview()
        ? ''
        : this.store.page().blocks.map(blockCss).join('')
      this.document.documentElement.classList.toggle(
        'dark-theme',
        this.store.project().dark,
      )
    })
    // On tablets, picking a block shows its properties instead of the block library.
    effect(() => {
      if (this.store.selectedId() && untracked(this.panel) === 'library')
        this.panel.set('inspector')
    })
    // Preview opens the page being edited, with sample values for its path variables.
    effect(() => {
      if (this.store.preview()) {
        const page = this.store.page()
        this.previewPath.set(
          buildPath(
            page.path,
            Object.fromEntries(
              pathParams(page.path).map((name) => [name, `sample-${name}`]),
            ),
          ),
        )
      }
    })
    const keydown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement
      if (
        target.closest(
          'input, textarea, select, [contenteditable], .cdk-overlay-container',
        )
      )
        return
      if ((event.ctrlKey || event.metaKey) && event.key === 'z') {
        event.preventDefault()
        if (event.shiftKey) this.store.redo()
        else this.store.undo()
      }
      if ((event.ctrlKey || event.metaKey) && event.key === 's') {
        event.preventDefault()
        void this.save()
      }
      if (event.key === 'Delete' && !this.store.preview()) this.store.delete()
    }
    const saveShortcut = (event: KeyboardEvent) => {
      if (
        (event.ctrlKey || event.metaKey) &&
        event.key === 's' &&
        (event.target as HTMLElement).closest('input, textarea')
      ) {
        event.preventDefault()
        void this.save()
      }
    }
    const unload = (event: BeforeUnloadEvent) => {
      if (this.store.dirty()) event.preventDefault()
    }
    this.document.addEventListener('keydown', keydown)
    this.document.addEventListener('keydown', saveShortcut, true)
    window.addEventListener('beforeunload', unload)
    inject(DestroyRef).onDestroy(() => {
      this.overrideSheet.remove()
      this.document.removeEventListener('keydown', keydown)
      this.document.removeEventListener('keydown', saveShortcut, true)
      window.removeEventListener('beforeunload', unload)
    })
    void this.open(this.route.snapshot.paramMap.get('projectId') ?? '')
  }

  async open(id: string): Promise<void> {
    this.loading.set(true)
    this.loadError.set('')
    try {
      const project = await this.api.get(id)
      const summaries = await this.api.list().catch(() => [])
      this.store.load(project, summaries.find((item) => item.id === id) ?? null)
      this.document.title = `${project.name} · Page Studio`
      if (this.api.isCloud()) void this.loadSecrets()
      if (project.auth?.enabled) void this.loadMembers()
      const draft = this.api.draft(id)
      if (
        draft &&
        draft.updatedAt >= project.updatedAt &&
        JSON.stringify(draft) !== JSON.stringify(project)
      ) {
        this.snack
          .open(
            'You have unsaved changes from earlier on this device.',
            'Restore',
            { duration: 15000 },
          )
          .onAction()
          .subscribe(() => {
            this.store.load(draft, this.store.summary())
            this.store.dirty.set(true)
          })
      }
    } catch (error) {
      this.loadError.set(
        error instanceof Error
          ? error.message
          : 'The project could not be opened.',
      )
    } finally {
      this.loading.set(false)
    }
  }

  blocks(group: string) {
    return BLOCKS.filter(
      (block) =>
        block.group === group &&
        block.label.toLowerCase().includes(this.search().toLowerCase()),
    )
  }
  paletteConnections(): string[] {
    return [
      'root',
      ...this.layers()
        .filter((layer) => acceptsChildren(layer.block.type))
        .map((layer) => layer.block.id),
    ]
  }

  // ---- Reusable components ---------------------------------------------------------

  newComponent(): void {
    const component = this.store.createComponent()
    this.selectPage(component.id)
  }
  /** Turns the selected block into a component and puts the component in its place. */
  makeComponent(): void {
    const block = this.store.selected()
    if (!block || block.type === 'component') return
    const component = this.store.createComponent(block)
    this.snack.open(
      `“${component.name}” is now a reusable component. Edit it from the Components tab.`,
      'Close',
      { duration: 5000 },
    )
  }
  placeComponent(id: string): void {
    if (this.store.editingComponent()?.id === id) return
    const selected = this.store.selected()
    const problem = this.store.placeComponent(
      id,
      selected && acceptsChildren(selected.type) ? selected.id : 'root',
    )
    if (problem) this.snack.open(problem, 'Close', { duration: 4000 })
  }
  deleteComponent(id: string, pages: string[]): void {
    if (pages.length) {
      this.snack.open(`Remove it from ${pages.join(', ')} first.`, 'Close', {
        duration: 5000,
      })
      return
    }
    if (confirm('Delete this component?')) this.store.deleteComponent(id)
  }
  componentName(id: string, name: string): void {
    this.store.renameComponent(id, name)
  }
  add(type: BlockType): void {
    if (this.panel() === 'library') this.panel.set('canvas')
    const selected = this.store.selected()
    this.store.add(
      type,
      selected && acceptsChildren(selected.type) ? selected.id : 'root',
    )
  }
  patch(key: keyof Block, value: unknown): void {
    this.store.updateBlock({ [key]: value } as Partial<Block>)
  }
  toggleDark(): void {
    this.store.change((project) => {
      project.dark = !project.dark
    })
  }
  projectName(name: string): void {
    this.store.change((project) => {
      project.name = name.slice(0, 200)
    })
  }
  pageName(name: string): void {
    this.store.change((project) => {
      project.pages.find((page) => page.id === this.store.pageId())!.name = name
    })
  }
  pagePath(value: string): void {
    const path = normalizePath(value)
    const problem = pathProblem(path)
    const shape = path.replace(/:[^/]+/g, ':')
    if (
      problem ||
      this.store
        .project()
        .pages.some(
          (page) =>
            page.id !== this.store.pageId() &&
            page.path.replace(/:[^/]+/g, ':') === shape,
        )
    ) {
      this.snack.open(
        problem || 'Another page already uses this path.',
        'Close',
        { duration: 5000 },
      )
      return
    }
    this.store.change((project) => {
      project.pages.find((page) => page.id === this.store.pageId())!.path = path
    })
  }
  selectPage(id: string): void {
    this.store.pageId.set(id)
    this.store.selectedId.set('')
  }
  deletePage(): void {
    if (
      this.store.project().pages.length < 2 ||
      !confirm(`Delete ${this.store.page().name} and its content?`)
    )
      return
    this.store.change((project) => {
      project.pages = project.pages.filter(
        (page) => page.id !== this.store.pageId(),
      )
    })
    this.selectPage(this.store.project().pages[0].id)
  }
  layers(
    blocks = this.store.page().blocks,
    depth = 0,
  ): { block: Block; depth: number }[] {
    return blocks.flatMap((block) => [
      { block, depth },
      ...this.layers(block.children, depth + 1),
    ])
  }
  moveTo(parentId: string): void {
    this.store.move(this.store.selectedId(), parentId, 9999)
  }
  destinations(): Block[] {
    const selected = this.store.selected()
    return this.layers()
      .map((layer) => layer.block)
      .filter(
        (block) =>
          isContainer(block.type) &&
          block.id !== selected?.id &&
          (!selected || !findBlock(selected.children, block.id)),
      )
  }

  // ---- Logic, data and events for the selected block -------------------------

  setLogic(key: string, value: Logic | undefined): void {
    const block = this.store.selected()
    if (!block) return
    const logic = { ...(block.logic ?? {}) } as Record<string, Logic>
    if (value === undefined) delete logic[key]
    else logic[key] = value
    this.patch('logic', Object.keys(logic).length ? logic : undefined)
  }
  setEvent(event: EventName, flowId: string): void {
    const block = this.store.selected()
    if (!block) return
    const on = { ...(block.on ?? {}) } as Record<string, string>
    if (flowId) on[event] = flowId
    else delete on[event]
    this.patch('on', Object.keys(on).length ? on : undefined)
  }
  /** Creates a flow for an event or data source and opens it straight away. */
  createFlowFor(target: EventName | 'source'): void {
    const block = this.store.selected()
    if (!block) return
    const label =
      target === 'source'
        ? 'data'
        : (
            EVENTS.find((item) => item.key === target)?.label ?? target
          ).toLowerCase()
    const flow = this.store.addFlow(`${block.name} – ${label}`)
    if (target === 'source') this.patch('source', flow.id)
    else this.setEvent(target, flow.id)
    this.openFlow(flow.id)
  }
  setBind(enabled: boolean): void {
    const block = this.store.selected()
    if (!block) return
    const name =
      block.name.replace(/[^a-zA-Z0-9_]/g, '').replace(/^[^a-zA-Z_]+/, '') ||
      'value'
    this.patch(
      'bind',
      enabled
        ? { scope: 'vars', name: name.charAt(0).toLowerCase() + name.slice(1) }
        : undefined,
    )
  }
  setBindField(key: 'scope' | 'name', value: string): void {
    const bind = this.store.selected()?.bind
    if (bind) this.patch('bind', { ...bind, [key]: value })
  }
  hasLogic(block: Block): boolean {
    return (
      !!block.source ||
      !!Object.keys(block.logic ?? {}).length ||
      !!Object.keys(block.on ?? {}).length ||
      !!block.bind
    )
  }

  // ---- Sign-in, roles and access ---------------------------------------------------

  setAuth(patch: Partial<SiteAuth>): void {
    this.store.change((project) => {
      project.auth = { ...(project.auth ?? defaultSiteAuth()), ...patch }
    })
    if (patch.enabled) void this.loadMembers()
  }
  addRole(): void {
    const auth = this.store.project().auth ?? defaultSiteAuth()
    let n = auth.roles.length + 1
    while (auth.roles.some((role) => role.id === `role${n}`)) n++
    this.setAuth({
      roles: [
        ...auth.roles,
        { id: `role${n}`, name: `Role ${n}`, description: '' },
      ],
    })
  }
  setRole(
    index: number,
    patch: { id?: string; name?: string; description?: string },
  ): void {
    const auth = this.store.project().auth ?? defaultSiteAuth()
    if (patch.id !== undefined && !/^[a-z][a-z0-9_-]{0,40}$/.test(patch.id)) {
      this.snack.open(
        'Role ids use lowercase letters, numbers, - and _, starting with a letter.',
        'Close',
        { duration: 4000 },
      )
      return
    }
    const roles = auth.roles.map((role, i) =>
      i === index ? { ...role, ...patch } : role,
    )
    const defaultRole =
      patch.id && auth.roles[index].id === auth.defaultRole
        ? patch.id
        : auth.defaultRole
    this.setAuth({ roles, defaultRole })
  }
  removeRole(index: number): void {
    const auth = this.store.project().auth ?? defaultSiteAuth()
    if (auth.roles.length < 2) return
    const roles = auth.roles.filter((_, i) => i !== index)
    this.setAuth({
      roles,
      defaultRole: roles.some((role) => role.id === auth.defaultRole)
        ? auth.defaultRole
        : roles[0].id,
    })
  }
  async loadMembers(): Promise<void> {
    if (!this.api.isCloud()) return
    try {
      this.members.set(await this.api.members(this.store.project().id))
    } catch {
      this.members.set([])
    }
  }
  async setMemberRole(member: MemberRecord, role: string): Promise<void> {
    try {
      await this.api.setMemberRole(this.store.project().id, member.userId, role)
      await this.loadMembers()
    } catch (error) {
      this.snack.open(
        error instanceof Error
          ? error.message
          : 'Could not change the role. Publish the site first if you added the role recently.',
        'Close',
        { duration: 6000 },
      )
    }
  }
  async removeMember(member: MemberRecord): Promise<void> {
    if (!confirm(`Remove ${member.email} from this site?`)) return
    await this.api.removeMember(this.store.project().id, member.userId)
    await this.loadMembers()
  }
  /** Access as a single choice: public, signedIn, or a role id. */
  accessChoice(rule: AccessRule | undefined): string[] {
    if (!rule || rule.mode === 'public') return ['public']
    if (rule.mode === 'signedIn') return ['signedIn']
    return rule.roles ?? []
  }
  toRule(choices: string[]): AccessRule | undefined {
    const last = choices.at(-1)
    if (!choices.length || last === 'public') return undefined
    if (last === 'signedIn') return { mode: 'signedIn' }
    return {
      mode: 'roles',
      roles: choices.filter(
        (choice) => choice !== 'public' && choice !== 'signedIn',
      ),
    }
  }
  setPageAccess(choices: string[]): void {
    const rule = this.toRule(choices)
    this.store.change((project) => {
      const page = project.pages.find(
        (item) => item.id === this.store.pageId(),
      )!
      if (rule) page.access = rule
      else delete page.access
    })
  }
  setBlockAccess(choices: string[]): void {
    this.patch('access', this.toRule(choices))
  }

  // ---- Files ------------------------------------------------------------------------

  /** Opens the file library and puts the chosen file's link into a field. */
  chooseFile(key: 'url' | 'options'): void {
    const block = this.store.selected()
    if (!block) return
    this.dialog
      .open(AssetPicker, {
        data: {
          projectId: this.store.project().id,
          kind: kindForBlock(block.type),
        },
        width: 'min(860px, 96vw)',
        autoFocus: false,
      })
      .afterClosed()
      .subscribe((url?: string) => {
        if (!url) return
        // Galleries and carousels get the file added as a new line.
        if (key === 'options')
          this.patch(
            'options',
            [block.options.trim(), `${url}|`].filter(Boolean).join('\n'),
          )
        else this.patch('url', url)
      })
  }

  // ---- Data tables and tree lists ------------------------------------------------

  private table(): TableConfig {
    const block = this.store.selected()
    return structuredClone(
      block?.table ?? defaultTable(block?.type === 'treelist'),
    )
  }
  setTable(patch: Partial<TableConfig>): void {
    const table = { ...this.table(), ...patch }
    for (const [key, value] of Object.entries(patch))
      if (value === undefined || value === '')
        delete (table as unknown as Record<string, unknown>)[key]
    this.patch('table', table)
  }
  addColumn(): void {
    const table = this.table()
    table.columns.push({
      key: 'field',
      label: 'New column',
      format: 'text',
      sortable: true,
      filterable: true,
    })
    this.patch('table', table)
  }
  setColumn(index: number, patch: Partial<TableColumn>): void {
    const table = this.table()
    const column = { ...table.columns[index], ...patch }
    for (const [key, value] of Object.entries(patch))
      if (value === undefined || value === '')
        delete (column as unknown as Record<string, unknown>)[key]
    table.columns[index] = column
    this.patch('table', table)
  }
  moveColumn(index: number, delta: number): void {
    const table = this.table()
    const target = index + delta
    if (target < 0 || target >= table.columns.length) return
    const [column] = table.columns.splice(index, 1)
    table.columns.splice(target, 0, column)
    this.patch('table', table)
  }
  removeColumn(index: number): void {
    const table = this.table()
    table.columns.splice(index, 1)
    this.patch('table', table)
  }
  /** Creates columns from the sample rows' fields. */
  detectColumns(): void {
    const block = this.store.selected()
    if (!block) return
    const rows = rowsFromLines(block.options.split('\n').filter(Boolean))
    const keys = [...new Set(rows.flatMap((row) => Object.keys(row)))]
    if (!keys.length) {
      this.snack.open(
        'Add sample rows (first line = field names) under Items, or connect a data flow, then detect again.',
        'Close',
        { duration: 5000 },
      )
      return
    }
    const sample = rows[0] ?? {}
    const table = this.table()
    table.columns = keys.map((key) => ({
      key,
      label: key.replace(/[_-]+/g, ' ').replace(/^./, (c) => c.toUpperCase()),
      format:
        typeof sample[key] === 'number'
          ? 'number'
          : /date|_at$/i.test(key)
            ? 'date'
            : 'text',
      align: typeof sample[key] === 'number' ? 'end' : undefined,
      sortable: true,
      filterable: typeof sample[key] !== 'number',
    }))
    this.patch('table', table)
  }

  // ---- Flows and variables -----------------------------------------------------

  openFlow(id: string): void {
    this.dialog.open(FlowEditor, { ...DIALOG, data: { flowId: id } })
  }
  newFlow(): void {
    this.openFlow(this.store.addFlow().id)
  }
  deleteFlow(id: string): void {
    const uses = this.store.flowUsage(id)
    if (
      !confirm(
        uses
          ? `This flow is used by ${uses} block event(s) or data source(s). Delete it and remove those links?`
          : 'Delete this flow?',
      )
    )
      return
    this.store.deleteFlow(id)
  }
  openMap(): void {
    this.dialog.open(SiteMap, DIALOG)
  }
  flowTrigger(flowId: string): string {
    const flow = this.store.project().flows.find((item) => item.id === flowId)
    if (!flow) return ''
    return flow.trigger === 'pageLoad'
      ? 'On page open'
      : flow.trigger === 'interval'
        ? `Every ${flow.intervalSeconds}s`
        : 'On event'
  }
  variableInitial(variable: VariableDef): string {
    return JSON.stringify(variable.initial ?? null)
  }
  setVariableInitial(variable: VariableDef, text: string): void {
    let value: unknown = text
    try {
      value = JSON.parse(text)
    } catch {
      /* plain text */
    }
    this.store.updateVariable(variable.id, { initial: value })
  }
  setVariableName(variable: VariableDef, name: string): void {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,60}$/.test(name)) {
      this.snack.open(
        'Use letters, numbers and _ (no spaces), starting with a letter.',
        'Close',
        { duration: 4000 },
      )
      return
    }
    this.store.updateVariable(variable.id, { name })
  }

  // ---- Data sources --------------------------------------------------------------

  readonly loadingSchema = signal('')
  async loadTables(id: string): Promise<void> {
    this.loadingSchema.set(id)
    try {
      const schema = await this.api.loadSchema(this.store.project(), id)
      this.store.updateDataSource(id, { schema })
      this.snack.open(`Found ${Object.keys(schema).length} tables.`, 'Close', {
        duration: 3000,
      })
    } catch (error) {
      this.snack.open(
        error instanceof Error ? error.message : 'Could not read the database.',
        'Close',
        { duration: 8000 },
      )
    } finally {
      this.loadingSchema.set('')
    }
  }
  deleteDataSource(id: string): void {
    const uses = this.store.dataSourceUsage(id)
    if (
      !confirm(
        uses
          ? `${uses} flow step(s) use this data source. Delete it anyway?`
          : 'Delete this data source?',
      )
    )
      return
    this.store.deleteDataSource(id)
  }
  tableCount(schema: Record<string, string[]> | undefined): number {
    return Object.keys(schema ?? {}).length
  }

  // ---- Credentials -------------------------------------------------------------

  async loadSecrets(): Promise<void> {
    this.secretsError.set('')
    try {
      const info = await this.api.secrets(this.store.project().id)
      this.secretsInfo.set({ provider: info.provider, writable: info.writable })
      this.store.secretNames.set(info.names)
    } catch (error) {
      this.secretsInfo.set(null)
      this.secretsError.set(
        error instanceof Error ? error.message : 'Credentials are unavailable.',
      )
    }
  }
  async addSecret(): Promise<void> {
    const name = this.newSecretName().trim()
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name)) {
      this.snack.open(
        'Use letters, numbers and _ for the name, e.g. WEATHER_API_KEY.',
        'Close',
        { duration: 4000 },
      )
      return
    }
    try {
      await this.api.saveSecret(
        this.store.project().id,
        name,
        this.newSecretValue(),
      )
      this.newSecretName.set('')
      this.newSecretValue.set('')
      await this.loadSecrets()
      this.snack.open(
        `Saved ${name}. Use secrets.${name} in server flows.`,
        'Close',
        { duration: 4000 },
      )
    } catch (error) {
      this.snack.open(
        error instanceof Error
          ? error.message
          : 'Could not save the credential.',
        'Close',
        { duration: 6000 },
      )
    }
  }
  async removeSecret(name: string): Promise<void> {
    if (
      !confirm(
        `Delete the credential ${name}? Server flows using it will stop working.`,
      )
    )
      return
    try {
      await this.api.deleteSecret(this.store.project().id, name)
      await this.loadSecrets()
    } catch (error) {
      this.snack.open(
        error instanceof Error
          ? error.message
          : 'Could not delete the credential.',
        'Close',
        { duration: 6000 },
      )
    }
  }

  // ---- Styles ----------------------------------------------------------------

  currentStyles(): StyleMap {
    return this.store.selected()?.[this.styleScope()] || {}
  }
  entries(styles: StyleMap): [string, string][] {
    return Object.entries(styles)
  }
  applyStyle(): void {
    const value = this.styleValue().trim()
    if (
      !safeStyle(this.styleProperty(), value) ||
      !CSS.supports(this.styleProperty(), value)
    ) {
      this.snack.open('Enter a valid CSS value for this property.', 'Close', {
        duration: 4000,
      })
      return
    }
    this.store.updateBlock({
      [this.styleScope()]: {
        ...this.currentStyles(),
        [this.styleProperty()]: value,
      },
    })
    this.styleValue.set('')
  }
  removeStyle(property: string): void {
    const styles = { ...this.currentStyles() }
    delete styles[property]
    this.store.updateBlock({ [this.styleScope()]: styles })
  }
  resetStyles(): void {
    this.store.updateBlock({ styles: {}, tabletStyles: {}, mobileStyles: {} })
  }
  clampValue(value: number): number {
    return Math.max(0, Math.min(100, Number(value) || 0))
  }

  // ---- Saving, publishing, import/export -------------------------------------

  async save(): Promise<void> {
    if (this.nameIssues().length) {
      this.snack.open(this.nameIssues()[0], 'Close', { duration: 6000 })
      return
    }
    try {
      await this.store.save()
      if (this.editingUsedBy().length) {
        this.snack.open(
          `Saved. ${this.editingUsedBy().join(', ')} now need review: publish this component, then each page.`,
          'Close',
          { duration: 8000 },
        )
        return
      }
      this.snack.open(
        this.api.isCloud() ? 'Saved to the cloud.' : 'Saved on this device.',
        'Close',
        { duration: 2500 },
      )
    } catch (error) {
      this.snack.open(
        `Not saved: ${error instanceof Error ? error.message : 'unknown error'}. Your changes are kept on this device.`,
        'Close',
        { duration: 8000 },
      )
    }
  }
  readonly inviteEmail = signal('')
  readonly inviteRole = signal('')
  async invite(): Promise<void> {
    const role =
      this.inviteRole() || this.store.project().auth?.defaultRole || ''
    try {
      // The role must exist on the server's copy, so save pending edits first.
      if (this.store.dirty()) await this.store.save()
      await this.api.addMember(
        this.store.project().id,
        this.inviteEmail().trim(),
        role,
      )
      this.inviteEmail.set('')
      await this.loadMembers()
      this.snack.open(
        'Added. The role applies when they sign in to the site.',
        'Close',
        { duration: 4000 },
      )
    } catch (error) {
      this.snack.open(
        error instanceof Error ? error.message : 'Could not add this person.',
        'Close',
        { duration: 6000 },
      )
    }
  }
  openPublish(): void {
    this.dialog.open(PublishDialog, {
      data: { store: this.store },
      width: '760px',
      maxWidth: 'calc(100vw - 32px)',
      autoFocus: 'dialog',
    })
  }
  async copyLink(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.liveUrl())
      this.snack.open('Link copied.', 'Close', { duration: 2000 })
    } catch {
      this.snack.open(this.liveUrl(), 'Close', { duration: 8000 })
    }
  }
  download(name: string, content: string, type: string): void {
    const url = URL.createObjectURL(new Blob([content], { type }))
    const link = this.document.createElement('a')
    link.href = url
    link.download = name
    link.click()
    URL.revokeObjectURL(url)
  }
  exportJson(): void {
    this.download(
      `${this.store.project().name.replace(/[^\w-]+/g, '-') || 'website'}.page-studio.json`,
      JSON.stringify(this.store.project(), null, 2),
      'application/json',
    )
  }
  async importJson(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement
    const file = input.files?.[0]
    if (!file) return
    try {
      if (file.size > 2_000_000)
        throw new Error('Project exceeds the 2 MB limit.')
      const imported = parseProject(await file.text())
      if (
        !confirm(
          'Replace this project’s pages, flows and variables with the imported file?',
        )
      )
        return
      // Keep this project's identity so saving updates the same site.
      const project: Project = { ...imported, id: this.store.project().id }
      this.store.load(project, this.store.summary())
      this.store.dirty.set(true)
      this.snack.open('Project imported. Save to keep it.', 'Close', {
        duration: 3000,
      })
    } catch (error) {
      this.snack.open(
        error instanceof Error ? error.message : 'Unable to import project.',
        'Close',
      )
    } finally {
      input.value = ''
    }
  }
  exportHtml(): void {
    let themeCss = ''
    for (const sheet of Array.from(this.document.styleSheets)) {
      if (sheet.ownerNode === this.overrideSheet) continue
      try {
        themeCss += Array.from(sheet.cssRules)
          .map((rule) => rule.cssText)
          .join('\n')
      } catch {
        /* cross-origin sheet */
      }
    }
    const page = this.store.page()
    this.download(
      `${page.path.replace(/[/:]+/g, '-') || 'home'}.html`,
      exportPage(this.store.project(), page, themeCss),
      'text/html',
    )
    this.snack.open(
      'Static HTML exported. Logic, flows and live data need the published site.',
      'Close',
      { duration: 5000 },
    )
  }
  back(): void {
    void this.router.navigateByUrl('/')
  }
}
