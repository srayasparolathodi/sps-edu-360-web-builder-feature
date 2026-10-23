import { Injectable, computed, signal } from '@angular/core'
import {
  Block,
  BlockType,
  Project,
  Viewport,
  createBlock,
  createProject,
  duplicateBlock,
  findBlock,
  isContainer,
  moveBlock,
  parseProject,
  removeBlock,
} from './builder-model'

@Injectable({ providedIn: 'root' })
export class BuilderStore {
  readonly project = signal<Project>(createProject())
  readonly pageId = signal(this.project().pages[0].id)
  readonly selectedId = signal('')
  readonly viewport = signal<Viewport>('desktop')
  readonly preview = signal(false)
  readonly page = computed(
    () =>
      this.project().pages.find((page) => page.id === this.pageId()) ||
      this.project().pages[0],
  )
  readonly selected = computed(() =>
    findBlock(this.page().blocks, this.selectedId()),
  )
  readonly history = signal<Project[]>([])
  readonly future = signal<Project[]>([])
  readonly dirty = signal(false)

  constructor() {
    try {
      const saved = localStorage.getItem('page-studio-project')
      if (saved) this.load(parseProject(saved))
    } catch {}
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

  add(type: BlockType, parentId = 'root', index?: number): void {
    const block = createBlock(type)
    this.change((project) => {
      const page = project.pages.find((page) => page.id === this.pageId())!
      const parent =
        parentId === 'root' ? undefined : findBlock(page.blocks, parentId)
      if (parentId !== 'root' && (!parent || !isContainer(parent.type))) return
      const target = parent ? parent.children : page.blocks
      target.splice(index ?? target.length, 0, block)
    })
    this.selectedId.set(block.id)
  }

  move(id: string, parentId: string, index: number): void {
    this.change((project) =>
      moveBlock(
        project.pages.find((page) => page.id === this.pageId())!.blocks,
        id,
        parentId,
        index,
      ),
    )
  }

  updateBlock(patch: Partial<Block>): void {
    this.change((project) => {
      const block = findBlock(
        project.pages.find((page) => page.id === this.pageId())!.blocks,
        this.selectedId(),
      )
      if (block) Object.assign(block, patch)
    })
  }

  delete(): void {
    this.change((project) =>
      removeBlock(
        project.pages.find((page) => page.id === this.pageId())!.blocks,
        this.selectedId(),
      ),
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
      insert(project.pages.find((page) => page.id === this.pageId())!.blocks)
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

  load(project: Project): void {
    this.project.set(project)
    this.pageId.set(project.pages[0].id)
    this.selectedId.set('')
    this.history.set([])
    this.future.set([])
    this.dirty.set(false)
  }

  save(): void {
    localStorage.setItem('page-studio-project', JSON.stringify(this.project()))
    this.dirty.set(false)
  }

  addPage(): void {
    if (this.project().pages.length >= 50) return
    const id = crypto.randomUUID()
    let number = this.project().pages.length + 1
    while (this.project().pages.some((page) => page.slug === `page-${number}`))
      number++
    this.change((project) =>
      project.pages.push({
        id,
        name: `Page ${number}`,
        slug: `page-${number}`,
        blocks: [],
      }),
    )
    this.pageId.set(id)
    this.selectedId.set('')
  }
}
