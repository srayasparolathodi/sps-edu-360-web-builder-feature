import { Component, input, inject } from '@angular/core'
import { CdkDragDrop, DragDropModule } from '@angular/cdk/drag-drop'
import { FormsModule } from '@angular/forms'
import { MatButtonModule } from '@angular/material/button'
import { MatIconModule } from '@angular/material/icon'
import { MatFormFieldModule } from '@angular/material/form-field'
import { MatInputModule } from '@angular/material/input'
import { MatSelectModule } from '@angular/material/select'
import { MatCheckboxModule } from '@angular/material/checkbox'
import { MatRadioModule } from '@angular/material/radio'
import { MatSlideToggleModule } from '@angular/material/slide-toggle'
import { MatSliderModule } from '@angular/material/slider'
import { MatTabsModule } from '@angular/material/tabs'
import { MatExpansionModule } from '@angular/material/expansion'
import { MatProgressBarModule } from '@angular/material/progress-bar'
import { MatTooltipModule } from '@angular/material/tooltip'
import { MatSnackBar } from '@angular/material/snack-bar'
import { Block, BlockType, isContainer, safeUrl } from './builder-model'
import { BuilderStore } from './builder-store'

@Component({
  selector: 'block-tree',
  imports: [
    DragDropModule,
    FormsModule,
    MatButtonModule,
    MatIconModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    MatCheckboxModule,
    MatRadioModule,
    MatSlideToggleModule,
    MatSliderModule,
    MatTabsModule,
    MatExpansionModule,
    MatProgressBarModule,
    MatTooltipModule,
  ],
  templateUrl: './block-tree.html',
})
export class BlockTree {
  readonly blocks = input.required<Block[]>()
  readonly parentId = input('root')
  readonly store = inject(BuilderStore)
  private readonly snack = inject(MatSnackBar)
  readonly isContainer = isContainer
  readonly safeUrl = safeUrl

  connections(): string[] {
    const ids = ['palette', 'root']
    const collect = (blocks: Block[]) =>
      blocks.forEach((block) => {
        if (isContainer(block.type)) ids.push(block.id)
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
    if (this.store.preview()) return
    event.stopPropagation()
    event.preventDefault()
    this.store.selectedId.set(block.id)
  }

  lines(block: Block): string[] {
    return block.options.split('\n').filter(Boolean)
  }
  part(line: string, index: number): string {
    return line.split('|')[index] || ''
  }
  cells(line: string): string[] {
    return line.split('|')
  }
  className(block: Block): string {
    return `page-block block-${block.type} element-${block.id} columns-${block.columns}`
  }

  follow(event: Event, url: string): void {
    if (!this.store.preview()) {
      event.preventDefault()
      return
    }
    const page = this.store
      .project()
      .pages.find((page) => url === `#${page.slug}` || url === `/${page.slug}`)
    if (page) {
      event.preventDefault()
      this.store.pageId.set(page.id)
    }
  }

  submit(event: Event): void {
    event.preventDefault()
    if (this.store.preview())
      this.snack.open(
        'Form validated. No submission endpoint is connected.',
        'Close',
        { duration: 5000 },
      )
  }
}
