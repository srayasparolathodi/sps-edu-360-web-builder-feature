import {
  Component,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core'
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser'
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
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner'
import { MatButtonToggleModule } from '@angular/material/button-toggle'
import { MatChipsModule } from '@angular/material/chips'
import { MatMenuModule } from '@angular/material/menu'
import { MatTooltipModule } from '@angular/material/tooltip'
import { BaseChartDirective } from 'ng2-charts'
import { DataTable } from './data-table'
import { SiteSignIn } from '../runtime/sign-in'
import { RuntimeService } from '../runtime/runtime'
import { staticCells } from './table-data'
import type { ChartConfiguration, ChartType } from 'chart.js'
import { Block, EventName, safeUrl } from '@spsedu360/engine/model'
import {
  BlockView,
  asText,
  chartPoints,
  countdownParts,
  embedUrl,
  initials,
  markdown,
  part,
} from './block-view'

export interface BlockEvent {
  event: EventName
  details: Record<string, unknown>
}

/** Files up to this size are read so a journey can store them (the server accepts up to 10 MB). */
const MAX_FILE_DATA = 10 * 1024 * 1024

/**
 * Renders the content of one non-container block from a resolved view.
 * `live` enables interaction; in the editor every control is inert.
 */
@Component({
  selector: 'block-content',
  imports: [
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
    MatProgressSpinnerModule,
    MatButtonToggleModule,
    MatChipsModule,
    MatMenuModule,
    MatTooltipModule,
    BaseChartDirective,
    DataTable,
    SiteSignIn,
  ],
  templateUrl: './block-content.html',
})
export class BlockContent {
  readonly block = input.required<Block>()
  readonly view = input.required<BlockView>()
  readonly live = input(false)
  readonly now = input(Date.now())
  /** New value for inputs; the renderer stores it in the bound variable. */
  readonly valueChange = output<unknown>()
  readonly blockEvent = output<BlockEvent>()
  /** Internal link clicked (live only). */
  readonly navigate = output<string>()

  private readonly sanitizer = inject(DomSanitizer)
  private readonly embeds = new Map<string, SafeResourceUrl | null>()
  readonly slide = signal(0)
  readonly imageLoaded = signal(false)

  readonly safeUrl = safeUrl
  private readonly runtime = inject(RuntimeService, { optional: true })

  /** Link address: internal page paths get the app's own prefix (/<app>/…), so they also work in a new tab. */
  href(url: string): string {
    const safe = safeUrl(url)
    if (!safe || /^(https?:|mailto:|tel:|#)/i.test(safe)) return safe || '#'
    return `${this.runtime?.base() ?? ''}/${safe.replace(/^\/+/, '')}`
  }
  readonly part = part
  readonly asText = asText
  readonly markdown = markdown
  readonly initials = initials
  readonly points = computed(() => chartPoints(this.view()))
  /** Typed tables with ^^ (merge up) and << (merge left) markers. */
  readonly tableCells = computed(() => staticCells(this.view().rows))
  readonly chartType = computed<ChartType>(() => {
    const variant = this.block().inputType
    return variant === 'line' ||
      variant === 'pie' ||
      variant === 'doughnut' ||
      variant === 'radar'
      ? variant
      : 'bar'
  })
  readonly isRound = computed(() =>
    ['pie', 'doughnut'].includes(this.chartType()),
  )
  readonly chartSummary = computed(() =>
    this.points()
      .map((p) => `${p.label} ${p.value}`)
      .join(', '),
  )
  /** Chart colours come from the page theme so charts match light and dark mode. */
  private palette(): { series: string[]; text: string; grid: string } {
    // Theme colours use light-dark(), so resolve them through a probe element.
    const probe = document.createElement('span')
    probe.style.display = 'none'
    document.body.appendChild(probe)
    const read = (name: string, fallback: string) => {
      probe.style.color = fallback
      probe.style.color = `var(${name}, ${fallback})`
      return getComputedStyle(probe).color || fallback
    }
    const colors = {
      series: [
        read('--mat-sys-primary', '#23307a'),
        '#ffd84d',
        read('--live', '#1f9d6b'),
        '#e8743b',
        '#7c5cff',
        '#2bb3c0',
        '#d6457a',
      ],
      text: read('--mat-sys-on-surface-variant', '#5b6478'),
      grid: read('--mat-sys-outline-variant', '#e1e5ef'),
    }
    probe.remove()
    return colors
  }
  readonly chartData = computed<ChartConfiguration['data']>(() => {
    const points = this.points()
    const { series } = this.palette()
    const round = this.isRound()
    return {
      labels: points.map((p) => p.label),
      datasets: [
        {
          label: this.view().label || 'Value',
          data: points.map((p) => p.value),
          backgroundColor: round
            ? points.map((_, i) => series[i % series.length])
            : series[0],
          borderColor: round ? '#ffffff' : series[0],
          borderWidth: round ? 2 : this.chartType() === 'line' ? 2.5 : 0,
          borderRadius: this.chartType() === 'bar' ? 8 : 0,
          tension: 0.35,
          fill:
            this.chartType() === 'line'
              ? { target: 'origin', above: 'rgba(35, 48, 122, 0.08)' }
              : false,
          pointRadius: 3,
        },
      ],
    } as ChartConfiguration['data']
  })
  readonly chartOptions = computed<ChartConfiguration['options']>(() => {
    const { text, grid } = this.palette()
    const round = this.isRound()
    const font = { family: 'Hanken Grotesk, system-ui, sans-serif', size: 12 }
    return {
      responsive: true,
      maintainAspectRatio: false,
      animation: this.live() ? { duration: 500 } : false,
      plugins: {
        legend: {
          display: round,
          position: 'right',
          labels: { color: text, font, usePointStyle: true },
        },
        tooltip: {
          cornerRadius: 8,
          padding: 10,
          titleFont: font,
          bodyFont: font,
        },
      },
      scales:
        round || this.chartType() === 'radar'
          ? {}
          : {
              x: {
                grid: { display: false },
                ticks: { color: text, font },
                border: { display: false },
              },
              y: {
                grid: { color: grid },
                ticks: { color: text, font },
                border: { display: false },
                beginAtZero: true,
              },
            },
    } as ChartConfiguration['options']
  })
  readonly countdown = computed(() =>
    countdownParts(this.view().text, this.now()),
  )
  readonly totalPages = computed(() =>
    Math.max(1, Math.min(500, Math.trunc(Number(this.view().text) || 1))),
  )
  readonly currentPage = computed(() => {
    const value = Number(this.view().inputValue) || this.view().value || 1
    return Math.min(Math.max(1, Math.trunc(value)), this.totalPages())
  })
  readonly pageNumbers = computed(() => {
    const total = this.totalPages()
    const start = Math.max(1, Math.min(this.currentPage() - 2, total - 4))
    return Array.from({ length: Math.min(5, total) }, (_, i) => start + i)
  })

  /** Iframe address for allow-listed providers only (YouTube, Vimeo, Google Maps/Docs). */
  embed(url: string): SafeResourceUrl | null {
    if (!this.embeds.has(url)) {
      const safe = embedUrl(url)
      this.embeds.set(
        url,
        safe ? this.sanitizer.bypassSecurityTrustResourceUrl(safe) : null,
      )
    }
    return this.embeds.get(url)!
  }

  inputValue(): string {
    return asText(this.view().inputValue)
  }
  listValue(): unknown[] {
    const value = this.view().inputValue
    return Array.isArray(value)
      ? value
      : value === '' || value === null || value === undefined
        ? []
        : [value]
  }

  emit(event: EventName, details: Record<string, unknown> = {}): void {
    if (this.live()) this.blockEvent.emit({ event, details })
  }

  change(value: unknown): void {
    if (!this.live()) return
    this.valueChange.emit(value)
    this.emit('change', { value })
  }

  typing(value: unknown): void {
    if (!this.live()) return
    this.valueChange.emit(value)
    this.emit('input', { value })
  }

  typingNumber(value: unknown): void {
    this.typing(
      value === null || value === '' || value === undefined
        ? null
        : Number(value),
    )
  }

  sliderValue(): number {
    const value = this.view().inputValue
    return value === '' || value === null || value === undefined
      ? this.view().value
      : Number(value) || 0
  }

  enter(event: Event): void {
    this.emit('enter', { value: (event.target as HTMLInputElement).value })
  }

  follow(event: Event, url: string): void {
    if (!this.live()) {
      event.preventDefault()
      return
    }
    const safe = safeUrl(url)
    if (!safe || /^(https?:|mailto:|tel:)/i.test(safe)) return
    event.preventDefault()
    this.navigate.emit(safe)
  }

  rate(value: number): void {
    this.change(value)
  }

  page(value: number): void {
    this.change(Math.min(Math.max(1, value), this.totalPages()))
  }

  async file(event: Event): Promise<void> {
    const file = (event.target as HTMLInputElement).files?.[0]
    if (!file || !this.live()) return
    const info: Record<string, unknown> = {
      name: file.name,
      size: file.size,
      type: file.type,
    }
    if (file.size <= MAX_FILE_DATA)
      info['dataUrl'] = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result))
        reader.onerror = () => reject(reader.error)
        reader.readAsDataURL(file)
      }).catch(() => '')
    this.change(info)
  }

  step(delta: number): void {
    const count = this.view().items.length
    if (count) this.slide.update((index) => (index + delta + count) % count)
  }

  headingLevel(): string {
    return /^[1-6]$/.test(this.block().level) ? this.block().level : '2'
  }
}
