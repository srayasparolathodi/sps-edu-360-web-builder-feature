import { Component, input, inject } from '@angular/core'
import { CdkDragDrop, DragDropModule } from '@angular/cdk/drag-drop'
import { MatButtonModule } from '@angular/material/button'
import { MatIconModule } from '@angular/material/icon'
import { MatTooltipModule } from '@angular/material/tooltip'
import {
  Block,
  BlockType,
  isContainer,
  safeUrl,
  acceptsChildren,
} from '@spsedu360/engine/model'
import { expandBlocks } from '@spsedu360/engine/publishing'
import { BuilderStore } from '../builder-store'
import { BlockContent } from '../blocks/block-content'
import { BlockView, staticView } from '../blocks/block-view'

/** Editable block tree on the builder canvas (drag, drop, select). */
@Component({
  selector: 'block-tree',
  imports: [
    DragDropModule,
    MatButtonModule,
    MatIconModule,
    MatTooltipModule,
    BlockContent,
  ],
  templateUrl: './block-tree.html',
})
export class BlockTree {
  readonly blocks = input.required<Block[]>()
  readonly parentId = input('root')
  /** Content of a placed component: shown, but edited on the component itself. */
  readonly readonly = input(false)
  readonly store = inject(BuilderStore)
  readonly isContainer = isContainer
  private readonly views = new WeakMap<Block, BlockView>()

  /** Static view, cached per block object (blocks are replaced on every change). */
  view(block: Block): BlockView {
    let view = this.views.get(block)
    if (!view) {
      view = staticView(block)
      this.views.set(block, view)
    }
    return view
  }

  componentOf(block: Block) {
    return this.store
      .project()
      .components?.find((item) => item.id === block.componentId)
  }
  /** The component's blocks as they will appear on this page (cached per instance). */
  private readonly expansions = new WeakMap<
    Block,
    { source: unknown; blocks: Block[] }
  >()
  expanded(block: Block): Block[] {
    const components = this.store.project().components ?? []
    const cached = this.expansions.get(block)
    if (cached && cached.source === components) return cached.blocks
    const blocks = expandBlocks([block], (id) =>
      components.find((item) => item.id === id),
    )[0].children
    this.expansions.set(block, { source: components, blocks })
    return blocks
  }
  editComponent(event: Event, block: Block): void {
    event.stopPropagation()
    if (!block.componentId) return
    this.store.pageId.set(block.componentId)
    this.store.selectedId.set('')
  }

  connections(): string[] {
    const ids = ['palette', 'root']
    const collect = (blocks: Block[]) =>
      blocks.forEach((block) => {
        if (acceptsChildren(block.type)) ids.push(block.id)
        collect(block.children)
      })
    collect(this.store.page().blocks)
    return ids.filter((id) => id !== this.parentId())
  }

  drop(event: CdkDragDrop<Block[]>): void {
    const data = event.item.data as { type?: BlockType; id?: string }
    if (data.id) this.store.move(data.id, this.parentId(), event.currentIndex)
    else if (data.type)
      this.store.add(data.type, this.parentId(), event.currentIndex)
  }

  select(event: Event, block: Block): void {
    event.stopPropagation()
    event.preventDefault()
    this.store.selectedId.set(block.id)
  }

  hasLogic(block: Block): boolean {
    return (
      !!block.source ||
      !!Object.keys(block.logic ?? {}).length ||
      !!Object.keys(block.on ?? {}).length ||
      !!block.bind
    )
  }

  className(block: Block): string {
    return `page-block block-${block.type} element-${block.id} columns-${block.columns} variant-${block.inputType}`
  }

  heroImage(block: Block): string | null {
    const url = safeUrl(block.url, true)
    return url ? `url("${url.replace(/["\\]/g, '')}")` : null
  }
}
