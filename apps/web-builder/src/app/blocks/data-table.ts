import {
  Component,
  DestroyRef,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
  viewChild,
} from '@angular/core'
import { NgTemplateOutlet } from '@angular/common'
import { FormsModule } from '@angular/forms'
import { ScrollingModule } from '@angular/cdk/scrolling'
import { MatButtonModule } from '@angular/material/button'
import { MatIconModule } from '@angular/material/icon'
import { MatCheckboxModule } from '@angular/material/checkbox'
import { MatFormFieldModule } from '@angular/material/form-field'
import { MatInputModule } from '@angular/material/input'
import { MatSelectModule } from '@angular/material/select'
import { MatProgressBarModule } from '@angular/material/progress-bar'
import { MatTooltipModule } from '@angular/material/tooltip'
import {
  Block,
  TableColumn,
  defaultTable,
  safeUrl,
} from '@spsedu360/engine/model'
import { RuntimeService } from '../runtime/runtime'
import { BlockView } from './block-view'
import {
  Row,
  TableState,
  TreeNode,
  buildTree,
  cellValue,
  filterAndSort,
  flattenTree,
  formatCell,
  groupRows,
  headerGroups,
  rowSpans,
  initialState,
  pageCount,
  readRows,
  rowsFromLines,
} from './table-data'
import { readPath } from '@spsedu360/engine/logic'

/**
 * Data table and tree list. In the editor it shows sample rows; on a live
 * site it talks to the runtime for row events, selection, server-side paging
 * and lazily loaded tree children.
 */
@Component({
  selector: 'data-table',
  imports: [
    NgTemplateOutlet,
    FormsModule,
    ScrollingModule,
    MatButtonModule,
    MatIconModule,
    MatCheckboxModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    MatProgressBarModule,
    MatTooltipModule,
  ],
  templateUrl: './data-table.html',
})
export class DataTable {
  readonly block = input.required<Block>()
  readonly view = input.required<BlockView>()
  readonly live = input(false)

  /** Present on live sites and in preview; absent in the editor. */
  private readonly runtime = inject(RuntimeService, { optional: true })
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef)
  private readonly sentinel = viewChild<ElementRef<HTMLElement>>('sentinel')

  readonly config = computed(
    () => this.block().table ?? defaultTable(this.block().type === 'treelist'),
  )
  readonly isTree = computed(() => this.block().type === 'treelist')
  readonly state = signal<TableState>(initialState(defaultTable()))
  readonly selected = signal<Set<string>>(new Set())
  readonly expanded = signal<Set<string>>(new Set())
  readonly loadedChildren = signal<Record<string, Row[]>>({})
  readonly loadingNodes = signal<Set<string>>(new Set())
  /** Server-side "load more" keeps earlier pages here. */
  private readonly accumulated = signal<Row[]>([])
  readonly pageSizes = [10, 25, 50, 100]

  readonly context = computed(
    () =>
      (this.runtime ? this.runtime.context() : {}) as Record<string, unknown>,
  )
  readonly visibleColumns = computed(() => this.config().columns)
  /** Column widths for the virtual-scroll grid. */
  readonly gridColumns = computed(() =>
    [
      ...(this.config().selection !== 'none' ? ['44px'] : []),
      ...this.visibleColumns().map(
        (column) => column.width || 'minmax(0, 1fr)',
      ),
    ].join(' '),
  )

  /** Source rows: flow output, items logic, or rows typed in the editor. */
  readonly source = computed(() => {
    const block = this.block()
    if (this.live() && this.runtime && block.source && !block.logic?.items)
      return readRows(this.runtime.status(block.source).output)
    const list = this.view().list
    if (list.length && typeof list[0] === 'object') return readRows(list)
    return { rows: rowsFromLines(block.options.split('\n').filter(Boolean)) }
  })
  readonly server = computed(
    () => this.live() && this.config().serverSide && !!this.block().source,
  )
  readonly loading = computed(
    () => this.live() && this.view().status === 'running',
  )

  readonly processed = computed(() => {
    if (this.server()) return this.source().rows
    return filterAndSort(
      this.source().rows,
      this.state(),
      this.visibleColumns(),
      this.context(),
    )
  })
  readonly total = computed(() =>
    this.server()
      ? (this.source().total ?? this.source().rows.length)
      : this.processed().length,
  )
  readonly pages = computed(() =>
    pageCount(this.total(), this.state().pageSize),
  )

  /** Rows on screen for the chosen paging style. */
  readonly rows = computed(() => {
    const mode = this.config().pagination
    const { page, pageSize } = this.state()
    if (this.server())
      return mode === 'loadMore' || mode === 'infinite'
        ? this.accumulated()
        : this.processed()
    const all = this.processed()
    if (mode === 'pages')
      return all.slice((page - 1) * pageSize, page * pageSize)
    if (mode === 'loadMore' || mode === 'infinite')
      return all.slice(0, page * pageSize)
    return all
  })
  readonly hasMore = computed(() => this.state().page < this.pages())
  readonly rangeLabel = computed(() => {
    const { page, pageSize } = this.state()
    const total = this.total()
    if (!total) return '0 rows'
    return `${(page - 1) * pageSize + 1}–${Math.min(page * pageSize, total)} of ${total}`
  })

  readonly headerGroups = computed(() => headerGroups(this.visibleColumns()))
  /** Rows in sections (one per group when grouping), with merged-cell spans per section. */
  readonly sections = computed(() => {
    const rows = this.rows()
    const field = this.config().groupBy
    const groups = field ? groupRows(rows, field) : [{ label: '', rows }]
    let offset = 0
    return groups.map((group) => {
      const section = {
        label: field ? group.label : null,
        rows: group.rows,
        offset,
        spans: rowSpans(group.rows, this.visibleColumns(), this.context()),
      }
      offset += group.rows.length
      return section
    })
  })
  readonly columnCount = computed(
    () =>
      this.visibleColumns().length +
      (this.config().selection !== 'none' ? 1 : 0),
  )

  readonly tree = computed(() =>
    this.isTree()
      ? buildTree(this.source().rows, this.config(), this.loadedChildren())
      : [],
  )
  readonly treeRows = computed(() => flattenTree(this.tree(), this.expanded()))

  constructor() {
    // Reset state when the table's settings change (e.g. page size in the inspector).
    effect(() => {
      const config = this.config()
      untracked(() =>
        this.state.set({ ...initialState(config), pageSize: config.pageSize }),
      )
    })
    // Server-side "load more": append each newly fetched page.
    effect(() => {
      const rows = this.source().rows
      if (!this.server()) return
      const page = untracked(this.state).page
      this.accumulated.set(
        page <= 1 ? rows : [...untracked(this.accumulated), ...rows],
      )
    })
    // Infinite scroll: load the next page when the end-of-list marker comes into view.
    let observer: IntersectionObserver | undefined
    effect(() => {
      const target = this.sentinel()?.nativeElement
      observer?.disconnect()
      if (!target || typeof IntersectionObserver === 'undefined') return
      observer = new IntersectionObserver(
        (entries) => {
          if (
            entries.some((entry) => entry.isIntersecting) &&
            this.hasMore() &&
            !this.loading()
          )
            this.goTo(this.state().page + 1)
        },
        { rootMargin: '200px' },
      )
      observer.observe(target)
    })
    inject(DestroyRef).onDestroy(() => observer?.disconnect())
  }

  // ---- Cells ------------------------------------------------------------------

  value(row: Row, column: TableColumn): unknown {
    return cellValue(row, column, this.context())
  }
  text(row: Row, column: TableColumn): string {
    return formatCell(this.value(row, column), column)
  }
  link(row: Row, column: TableColumn): string {
    return safeUrl(String(this.value(row, column) ?? ''))
  }
  image(row: Row, column: TableColumn): string {
    return safeUrl(String(this.value(row, column) ?? ''), true)
  }
  percent(row: Row, column: TableColumn): number {
    return Math.max(0, Math.min(100, Number(this.value(row, column)) || 0))
  }
  key(row: Row, index: number): string {
    return String(readPath(row, this.config().rowKey) ?? index)
  }

  // ---- Paging, sorting, searching ----------------------------------------------

  private update(patch: Partial<TableState>): void {
    this.state.update((state) => ({ ...state, ...patch }))
    if (this.server()) this.fetch()
  }

  /** Server-side tables: store the state for the flow's query, then re-run it. */
  private fetch(): void {
    const block = this.block()
    const stateVar = this.config().stateVar
    if (!this.runtime || !block.source) return
    if (stateVar)
      this.runtime.setVariable('vars', stateVar, { ...this.state() })
    void this.runtime.run(block.source, { table: { ...this.state() } })
  }

  sortBy(column: TableColumn): void {
    if (!column.sortable || !this.live()) return
    const { sort, direction } = this.state()
    const next: Partial<TableState> =
      sort !== column.key
        ? { sort: column.key, direction: 'asc' }
        : direction === 'asc'
          ? { direction: 'desc' }
          : { sort: '', direction: 'asc' }
    this.update({ ...next, page: 1 })
  }
  sortIcon(column: TableColumn): string {
    const { sort, direction } = this.state()
    return sort !== column.key
      ? 'unfold_more'
      : direction === 'asc'
        ? 'arrow_upward'
        : 'arrow_downward'
  }
  ariaSort(column: TableColumn): string | null {
    if (!column.sortable) return null
    const { sort, direction } = this.state()
    return sort === column.key
      ? direction === 'asc'
        ? 'ascending'
        : 'descending'
      : 'none'
  }

  private searchTimer: ReturnType<typeof setTimeout> | undefined
  search(term: string): void {
    this.state.update((state) => ({ ...state, search: term, page: 1 }))
    clearTimeout(this.searchTimer)
    // Wait for a pause in typing before asking the server.
    if (this.server()) this.searchTimer = setTimeout(() => this.fetch(), 350)
  }

  goTo(page: number): void {
    this.update({ page: Math.min(Math.max(1, page), this.pages()) })
    if (this.config().pagination === 'pages')
      this.host.nativeElement.scrollIntoView({ block: 'nearest' })
  }
  setPageSize(size: number): void {
    this.update({ pageSize: size, page: 1 })
  }

  // ---- Rows: clicks and selection -----------------------------------------------

  click(row: Row, index: number): void {
    if (!this.live() || !this.runtime) return
    this.runtime.fire(this.block(), 'click', { item: row, index })
  }

  isSelected(row: Row, index: number): boolean {
    return this.selected().has(this.key(row, index))
  }
  toggle(row: Row, index: number): void {
    const key = this.key(row, index)
    const single = this.config().selection === 'single'
    this.selected.update((current) => {
      const next = single ? new Set<string>() : new Set(current)
      if (current.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
    this.publishSelection()
  }
  allSelected(): boolean {
    const rows = this.rows()
    return rows.length > 0 && rows.every((row, i) => this.isSelected(row, i))
  }
  toggleAll(checked: boolean): void {
    this.selected.set(
      checked
        ? new Set(this.rows().map((row, i) => this.key(row, i)))
        : new Set(),
    )
    this.publishSelection()
  }
  private publishSelection(): void {
    const name = this.config().selectionVar
    if (!name || !this.runtime) return
    const rows = this.processed().filter((row, i) =>
      this.selected().has(this.key(row, i)),
    )
    this.runtime.setVariable(
      'vars',
      name,
      this.config().selection === 'single' ? (rows[0] ?? null) : rows,
    )
    this.runtime.fire(this.block(), 'change', { value: rows })
  }

  // ---- Tree ---------------------------------------------------------------------

  async toggleNode(node: TreeNode): Promise<void> {
    const open = this.expanded().has(node.key)
    this.expanded.update((current) => {
      const next = new Set(current)
      if (open) next.delete(node.key)
      else next.add(node.key)
      return next
    })
    const lazyFlow = this.config().lazyFlow
    if (open || !node.lazy || !lazyFlow || !this.runtime) return
    this.loadingNodes.update((set) => new Set(set).add(node.key))
    const result = await this.runtime.run(lazyFlow, { item: node.row })
    this.loadingNodes.update((set) => {
      const next = new Set(set)
      next.delete(node.key)
      return next
    })
    this.loadedChildren.update((loaded) => ({
      ...loaded,
      [node.key]: readRows(result.output).rows,
    }))
  }
  hasChildren(node: TreeNode): boolean {
    return node.children.length > 0 || node.lazy
  }
}
