import {
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  computed,
  forwardRef,
  inject,
  input,
} from '@angular/core'
import { MatButtonModule } from '@angular/material/button'
import { MatIconModule } from '@angular/material/icon'
import {
  Block,
  EventName,
  INPUT_TYPES,
  isContainer,
  safeUrl,
} from '@spsedu360/engine/model'
import { BlockContent, BlockEvent } from '../blocks/block-content'
import { RuntimeService } from './runtime'

const slug = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '') || 'field'

/** Renders a list of blocks live. `scope` carries repeater values (item, index). */
@Component({
  selector: 'live-blocks',
  imports: [forwardRef(() => LiveBlock)],
  template: `@for (block of blocks(); track block.id) {
    <live-block [block]="block" [scope]="scope()" />
  }`,
  styles: ':host { display: contents; }',
})
export class LiveBlocks {
  readonly blocks = input.required<Block[]>()
  readonly scope = input<Record<string, unknown>>({})
}

@Component({
  selector: 'live-block',
  imports: [LiveBlocks, BlockContent, MatButtonModule, MatIconModule],
  templateUrl: './live-block.html',
  host: {
    '[style.display]': 'view().visible ? null : "none"',
    '(click)': 'pointer($event, "click")',
    '(dblclick)': 'pointer($event, "dblclick")',
    '(mouseenter)': 'pointer($event, "mouseenter")',
    '(mouseleave)': 'pointer($event, "mouseleave")',
  },
  styles: ':host { display: block; min-width: 0; }',
})
export class LiveBlock {
  readonly block = input.required<Block>()
  readonly scope = input<Record<string, unknown>>({})
  readonly runtime = inject(RuntimeService)
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef)
  private readonly destroyRef = inject(DestroyRef)
  private typingTimer: ReturnType<typeof setTimeout> | undefined

  readonly view = computed(() => this.runtime.view(this.block(), this.scope()))
  readonly isContainer = computed(() => isContainer(this.block().type))
  readonly modalOpen = computed(() => {
    const block = this.block()
    if (block.type !== 'modal') return false
    return block.bind
      ? !!this.runtime.readVariable(block.bind.scope, block.bind.name)
      : this.view().visible
  })
  readonly heroImage = computed(() => {
    const url = safeUrl(this.view().url, true)
    return url ? `url("${url.replace(/["\\]/g, '')}")` : null
  })
  readonly skeletonRows = computed(() =>
    this.block().type === 'table' || this.block().type === 'repeater'
      ? [1, 2, 3, 4]
      : [1, 2, 3],
  )

  constructor() {
    afterNextRender(() => {
      const block = this.block()
      if (block.type === 'countdown') this.runtime.startClock()
      this.fire('load')
      if (block.on?.visible && 'IntersectionObserver' in window) {
        const observer = new IntersectionObserver((entries) => {
          if (entries.some((entry) => entry.isIntersecting)) {
            this.fire('visible')
            observer.disconnect()
          }
        })
        observer.observe(this.host.nativeElement)
        this.destroyRef.onDestroy(() => observer.disconnect())
      }
    })
  }

  className(): string {
    const block = this.block()
    return `page-block block-${block.type} element-${block.id} columns-${block.columns} variant-${block.inputType}`
  }

  private fire(
    event: EventName,
    details: Record<string, unknown> = {},
  ): boolean {
    const block = this.block()
    if (!block.on?.[event]) return false
    this.runtime.fire(block, event, { ...this.scope(), ...details })
    return true
  }

  pointer(event: Event, name: EventName): void {
    if (
      (name === 'click' || name === 'dblclick') &&
      ['datatable', 'treelist'].includes(this.block().type)
    )
      return
    // The innermost block with a handler takes the click, like stopPropagation in code.
    if (this.fire(name) && (name === 'click' || name === 'dblclick'))
      event.stopPropagation()
  }

  setValue(value: unknown): void {
    const bind = this.block().bind
    if (bind) this.runtime.setVariable(bind.scope, bind.name, value)
  }

  onEvent({ event, details }: BlockEvent): void {
    if (event === 'input') {
      clearTimeout(this.typingTimer)
      this.typingTimer = setTimeout(() => this.fire('input', details), 400)
      return
    }
    this.fire(event, details)
  }

  closeModal(): void {
    const bind = this.block().bind
    if (bind) this.runtime.setVariable(bind.scope, bind.name, false)
  }

  retry(): void {
    const source = this.block().source
    if (source) void this.runtime.run(source)
  }

  submit(event: Event): void {
    event.preventDefault()
    const form = event.target as HTMLFormElement
    if (!form.reportValidity()) return
    const native = new FormData(form)
    const values: Record<string, unknown> = {}
    const collect = (blocks: Block[]) =>
      blocks.forEach((block) => {
        if (INPUT_TYPES.includes(block.type)) {
          const key = block.bind?.name ?? slug(block.name)
          values[key] = block.bind
            ? this.runtime.readVariable(block.bind.scope, block.bind.name)
            : (native.get(block.id) ?? null)
        }
        collect(block.children)
      })
    collect(this.block().children)
    if (!this.fire('submit', { form: values }))
      this.runtime.notify(
        'info',
        'Form is valid. Connect a flow to its "Form submitted" event to send it.',
      )
  }

  repeaterScope(item: unknown, index: number): Record<string, unknown> {
    return { ...this.scope(), item, index }
  }
}
