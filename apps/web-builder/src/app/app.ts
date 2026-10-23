import { Component, DestroyRef, effect, inject, signal } from '@angular/core'
import { DOCUMENT } from '@angular/common'
import { FormsModule } from '@angular/forms'
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
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar'
import {
  Block,
  BLOCKS,
  BlockType,
  STYLE_PROPERTIES,
  StyleMap,
  blockCss,
  exportPage,
  findBlock,
  isContainer,
  parseProject,
  safeStyle,
} from './builder-model'
import { BuilderStore } from './builder-store'
import { BlockTree } from './block-tree'

@Component({
  selector: 'app-root',
  imports: [
    FormsModule,
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
    MatSnackBarModule,
    BlockTree,
  ],
  templateUrl: './app.html',
})
export class AppComponent {
  readonly store = inject(BuilderStore)
  private readonly document = inject(DOCUMENT)
  private readonly snack = inject(MatSnackBar)
  readonly groups = ['Layout', 'Content', 'Navigation', 'Forms', 'Data']
  readonly search = signal('')
  readonly tab = signal(0)
  readonly styleProperty = signal<string>('padding')
  readonly styleValue = signal('')
  readonly styleScope = signal<'styles' | 'tabletStyles' | 'mobileStyles'>(
    'styles',
  )
  readonly styleProperties = STYLE_PROPERTIES
  readonly isContainer = isContainer
  readonly rejectPalette = () => false
  readonly projectThemeToggle = (
    project: import('./builder-model').Project,
  ) => {
    project.dark = !project.dark
  }
  clampValue(value: number): number {
    return Math.max(0, Math.min(100, Number(value) || 0))
  }
  private readonly overrideSheet = this.document.createElement('style')

  constructor() {
    this.overrideSheet.id = 'page-studio-overrides'
    this.document.head.appendChild(this.overrideSheet)
    effect(() => {
      this.overrideSheet.textContent = this.store
        .page()
        .blocks.map(blockCss)
        .join('')
      this.document.documentElement.classList.toggle(
        'dark-theme',
        this.store.project().dark,
      )
    })
    const keydown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement
      if (target.closest('input, textarea, select, [contenteditable]')) return
      if ((event.ctrlKey || event.metaKey) && event.key === 'z') {
        event.preventDefault()
        event.shiftKey ? this.store.redo() : this.store.undo()
      }
      if ((event.ctrlKey || event.metaKey) && event.key === 's') {
        event.preventDefault()
        this.save()
      }
      if (event.key === 'Delete' && !this.store.preview()) this.store.delete()
    }
    const unload = (event: BeforeUnloadEvent) => {
      if (this.store.dirty()) event.preventDefault()
    }
    this.document.addEventListener('keydown', keydown)
    window.addEventListener('beforeunload', unload)
    inject(DestroyRef).onDestroy(() => {
      this.overrideSheet.remove()
      this.document.removeEventListener('keydown', keydown)
      window.removeEventListener('beforeunload', unload)
    })
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
        .filter((layer) => isContainer(layer.block.type))
        .map((layer) => layer.block.id),
    ]
  }
  add(type: BlockType): void {
    const selected = this.store.selected()
    this.store.add(
      type,
      selected && isContainer(selected.type) ? selected.id : 'root',
    )
  }
  patch(key: keyof Block, value: string | number | boolean): void {
    this.store.updateBlock({ [key]: value })
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
  pageSlug(slug: string): void {
    if (
      !/^[a-z0-9-]+$/.test(slug) ||
      this.store
        .project()
        .pages.some(
          (page) => page.id !== this.store.pageId() && page.slug === slug,
        )
    ) {
      this.snack.open(
        'Use a unique slug with lowercase letters, numbers and hyphens.',
        'Close',
        { duration: 4000 },
      )
      return
    }
    this.store.change((project) => {
      project.pages.find((page) => page.id === this.store.pageId())!.slug = slug
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
  save(): void {
    try {
      this.store.save()
      this.snack.open('Saved on this device.', 'Close', { duration: 2500 })
    } catch {
      this.snack.open(
        'Storage is full or unavailable. Export your project instead.',
        'Close',
      )
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
      'website.page-studio.json',
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
      const project = parseProject(await file.text())
      if (
        this.store.dirty() &&
        !confirm('Replace unsaved work with this project?')
      )
        return
      this.store.load(project)
      this.store.dirty.set(true)
      this.snack.open('Project imported.', 'Close', { duration: 2500 })
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
      } catch {}
    }
    this.download(
      `${this.store.page().slug}.html`,
      exportPage(this.store.project(), this.store.page(), themeCss),
      'text/html',
    )
    this.snack.open(
      'Static HTML exported. App data and backend actions are not included.',
      'Close',
      { duration: 5000 },
    )
  }
}
