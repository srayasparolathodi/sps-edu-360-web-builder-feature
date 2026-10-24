import { Block, safeUrl } from '@spsedu360/engine/model'

export type ViewStatus = 'idle' | 'running' | 'success' | 'empty' | 'error'

/** Resolved, display-ready values for one block (static in the editor, computed live). */
export interface BlockView {
  visible: boolean
  text: string
  label: string
  url: string
  /** "name|link" or "title|content" style lines, as typed in the editor. */
  items: string[]
  rows: string[][]
  /** Raw list for repeaters and multi-selects. */
  list: unknown[]
  value: number
  inputValue: unknown
  disabled: boolean
  status: ViewStatus
  message: string
  errors: string[]
}

export const asText = (value: unknown): string =>
  value === null || value === undefined
    ? ''
    : typeof value === 'object'
      ? JSON.stringify(value)
      : String(value)

const pick = (item: Record<string, unknown>, keys: string[]): unknown => {
  for (const key of keys)
    if (item[key] !== undefined && item[key] !== null) return item[key]
  return undefined
}

const lines = (value: string): string[] => value.split('\n').filter(Boolean)

/** Turns whatever logic or a flow returns into display lines. */
export function toItems(value: unknown): string[] {
  if (value === null || value === undefined) return []
  if (typeof value === 'string') return lines(value)
  if (!Array.isArray(value)) return [asText(value)]
  return value.slice(0, 500).map((item) => {
    if (!item || typeof item !== 'object') return asText(item)
    const record = item as Record<string, unknown>
    const name = asText(
      pick(record, ['label', 'name', 'title', 'text', 'key', 'id']),
    )
    const second = pick(record, [
      'url',
      'href',
      'path',
      'link',
      'value',
      'content',
      'body',
      'description',
      'date',
    ])
    return second === undefined ? name : `${name}|${asText(second)}`
  })
}

export function toRows(value: unknown): string[][] {
  if (typeof value === 'string')
    return lines(value).map((line) => line.split('|'))
  if (!Array.isArray(value))
    return toItems(value).map((line) => line.split('|'))
  const rows = value.slice(0, 500)
  if (rows.every((row) => Array.isArray(row)))
    return rows.map((row) => (row as unknown[]).map(asText))
  if (rows.length && rows.every((row) => row && typeof row === 'object')) {
    const columns = [
      ...new Set(rows.flatMap((row) => Object.keys(row as object))),
    ].slice(0, 12)
    return [
      columns,
      ...rows.map((row) =>
        columns.map((column) =>
          asText((row as Record<string, unknown>)[column]),
        ),
      ),
    ]
  }
  // Plain values use the same "a|b" format as typed-in items.
  return rows.map((row) => asText(row).split('|'))
}

export function toList(value: unknown): unknown[] {
  if (Array.isArray(value)) return value.slice(0, 500)
  if (typeof value === 'string') return lines(value)
  return value === null || value === undefined ? [] : [value]
}

/** View used by the editor canvas: the block's typed-in content. */
export function staticView(block: Block): BlockView {
  return {
    visible: true,
    text: block.text,
    label: block.label,
    url: block.url,
    items: lines(block.options),
    rows: lines(block.options).map((line) => line.split('|')),
    list: lines(block.options),
    value: block.value,
    inputValue: '',
    disabled: block.disabled,
    status: 'success',
    message: '',
    errors: [],
  }
}

export const part = (line: string, index: number): string =>
  line.split('|')[index] ?? ''

// ---- Rich text: a small, safe Markdown subset ------------------------------

const escapeHtml = (value: string): string =>
  value.replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ]!,
  )

function inline(text: string): string {
  return escapeHtml(text)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`(.+?)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label: string, href: string) => {
      const url = safeUrl(href.replace(/&amp;/g, '&'))
      return url
        ? `<a href="${escapeHtml(url)}" rel="noopener" target="_blank">${label}</a>`
        : label
    })
}

/** Headings (#), lists (- or 1.), bold, italic, code and links. Output is escaped first. */
export function markdown(source: string): string {
  const out: string[] = []
  let list: 'ul' | 'ol' | null = null
  const close = () => {
    if (list) out.push(`</${list}>`)
    list = null
  }
  for (const raw of source.slice(0, 50_000).split('\n')) {
    const line = raw.trimEnd()
    const heading = /^(#{1,4})\s+(.*)$/.exec(line)
    const bullet = /^[-*]\s+(.*)$/.exec(line)
    const numbered = /^\d+\.\s+(.*)$/.exec(line)
    if (heading) {
      close()
      const level = heading[1].length + 1
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`)
    } else if (bullet || numbered) {
      const kind = bullet ? 'ul' : 'ol'
      if (list !== kind) {
        close()
        out.push(`<${kind}>`)
        list = kind
      }
      out.push(`<li>${inline((bullet ?? numbered)![1])}</li>`)
    } else if (!line.trim()) close()
    else {
      close()
      out.push(`<p>${inline(line)}</p>`)
    }
  }
  close()
  return out.join('')
}

// ---- Embeds: only well-known providers, always as embed URLs ---------------

export function embedUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    return ''
  }
  if (url.protocol !== 'https:') return ''
  const host = url.hostname.replace(/^www\./, '')
  if (host === 'youtube.com' || host === 'm.youtube.com') {
    const id =
      url.searchParams.get('v') ??
      (url.pathname.startsWith('/embed/') ? url.pathname.slice(7) : '')
    return /^[\w-]{6,20}$/.test(id)
      ? `https://www.youtube-nocookie.com/embed/${id}`
      : ''
  }
  if (host === 'youtu.be') {
    const id = url.pathname.slice(1)
    return /^[\w-]{6,20}$/.test(id)
      ? `https://www.youtube-nocookie.com/embed/${id}`
      : ''
  }
  if (host === 'youtube-nocookie.com' && url.pathname.startsWith('/embed/'))
    return url.toString()
  if (host === 'vimeo.com' && /^\/\d+$/.test(url.pathname))
    return `https://player.vimeo.com/video${url.pathname}`
  if (host === 'player.vimeo.com') return url.toString()
  if (host === 'google.com' && url.pathname.startsWith('/maps/embed'))
    return url.toString()
  if (
    host === 'docs.google.com' &&
    /^\/(forms|document|spreadsheets|presentation)\//.test(url.pathname)
  )
    return url.toString()
  if (
    host === 'calendar.google.com' &&
    url.pathname.startsWith('/calendar/embed')
  )
    return url.toString()
  return ''
}

// ---- Charts -----------------------------------------------------------------

export interface ChartPoint {
  label: string
  value: number
  /** Percent of the largest value (bar/line) or share of the total (pie). */
  ratio: number
}

export function chartPoints(view: BlockView): ChartPoint[] {
  const points = view.items.slice(0, 50).map((line) => {
    const [label, raw] = line.includes('|') ? line.split('|') : [line, line]
    const value = Number(String(raw).replace(/,/g, ''))
    return {
      label: label ?? '',
      value: Number.isFinite(value) ? value : 0,
      ratio: 0,
    }
  })
  const max = Math.max(...points.map((p) => Math.abs(p.value)), 0) || 1
  points.forEach((point) => (point.ratio = Math.abs(point.value) / max))
  return points
}

/** SVG path for a line chart in a 100 × 40 viewBox. */
export function linePath(points: ChartPoint[]): string {
  if (!points.length) return ''
  const step = points.length > 1 ? 100 / (points.length - 1) : 0
  return points
    .map(
      (p, i) =>
        `${i ? 'L' : 'M'}${(i * step).toFixed(2)},${(38 - p.ratio * 36).toFixed(2)}`,
    )
    .join(' ')
}

/** Conic-gradient for a pie chart using theme-friendly hues. */
export function pieGradient(points: ChartPoint[]): string {
  const total = points.reduce((sum, p) => sum + Math.abs(p.value), 0) || 1
  let start = 0
  return `conic-gradient(${points
    .map((p, i) => {
      const end = start + (Math.abs(p.value) / total) * 100
      const slice = `${PIE_COLORS[i % PIE_COLORS.length]} ${start.toFixed(2)}% ${end.toFixed(2)}%`
      start = end
      return slice
    })
    .join(', ')})`
}

export const PIE_COLORS = [
  'var(--mat-sys-primary)',
  'var(--mat-sys-tertiary)',
  'var(--mat-sys-secondary)',
  'var(--mat-sys-error)',
  'var(--mat-sys-outline)',
]

export function countdownParts(
  target: string,
  now: number,
): { label: string; value: number }[] | null {
  const end = new Date(target).getTime()
  if (Number.isNaN(end)) return null
  const left = Math.max(0, end - now)
  return [
    { label: 'days', value: Math.floor(left / 86_400_000) },
    { label: 'hours', value: Math.floor(left / 3_600_000) % 24 },
    { label: 'minutes', value: Math.floor(left / 60_000) % 60 },
    { label: 'seconds', value: Math.floor(left / 1000) % 60 },
  ]
}

export function initials(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? '')
    .join('')
}
