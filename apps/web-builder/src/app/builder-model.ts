export const BLOCKS = [
  {
    type: 'section',
    label: 'Section',
    icon: 'view_agenda',
    group: 'Layout',
    container: true,
  },
  {
    type: 'container',
    label: 'Container',
    icon: 'crop_square',
    group: 'Layout',
    container: true,
  },
  {
    type: 'columns',
    label: 'Columns',
    icon: 'view_column',
    group: 'Layout',
    container: true,
  },
  {
    type: 'stack',
    label: 'Stack',
    icon: 'view_stream',
    group: 'Layout',
    container: true,
  },
  {
    type: 'card',
    label: 'Card',
    icon: 'crop_portrait',
    group: 'Layout',
    container: true,
  },
  { type: 'heading', label: 'Heading', icon: 'title', group: 'Content' },
  { type: 'text', label: 'Text', icon: 'notes', group: 'Content' },
  { type: 'image', label: 'Image', icon: 'image', group: 'Content' },
  { type: 'video', label: 'Video', icon: 'videocam', group: 'Content' },
  { type: 'audio', label: 'Audio', icon: 'audiotrack', group: 'Content' },
  { type: 'button', label: 'Button', icon: 'smart_button', group: 'Content' },
  { type: 'link', label: 'Link', icon: 'link', group: 'Content' },
  {
    type: 'list',
    label: 'List',
    icon: 'format_list_bulleted',
    group: 'Content',
  },
  {
    type: 'divider',
    label: 'Divider',
    icon: 'horizontal_rule',
    group: 'Content',
  },
  { type: 'spacer', label: 'Spacer', icon: 'height', group: 'Content' },
  { type: 'icon', label: 'Icon', icon: 'star_outline', group: 'Content' },
  {
    type: 'navigation',
    label: 'Navigation',
    icon: 'menu',
    group: 'Navigation',
  },
  {
    type: 'breadcrumb',
    label: 'Breadcrumbs',
    icon: 'chevron_right',
    group: 'Navigation',
  },
  { type: 'tabs', label: 'Tabs', icon: 'tab', group: 'Navigation' },
  {
    type: 'accordion',
    label: 'Accordion',
    icon: 'expand_more',
    group: 'Navigation',
  },
  {
    type: 'form',
    label: 'Form',
    icon: 'dynamic_form',
    group: 'Forms',
    container: true,
  },
  { type: 'input', label: 'Input', icon: 'input', group: 'Forms' },
  { type: 'textarea', label: 'Text area', icon: 'subject', group: 'Forms' },
  {
    type: 'select',
    label: 'Select',
    icon: 'arrow_drop_down_circle',
    group: 'Forms',
  },
  { type: 'checkbox', label: 'Checkbox', icon: 'check_box', group: 'Forms' },
  {
    type: 'radio',
    label: 'Radio group',
    icon: 'radio_button_checked',
    group: 'Forms',
  },
  { type: 'switch', label: 'Switch', icon: 'toggle_on', group: 'Forms' },
  { type: 'slider', label: 'Slider', icon: 'tune', group: 'Forms' },
  {
    type: 'date',
    label: 'Date picker',
    icon: 'calendar_today',
    group: 'Forms',
  },
  { type: 'submit', label: 'Submit', icon: 'send', group: 'Forms' },
  { type: 'table', label: 'Table', icon: 'table_chart', group: 'Data' },
  { type: 'stat', label: 'Statistic', icon: 'insights', group: 'Data' },
  { type: 'badge', label: 'Badge', icon: 'label', group: 'Data' },
  { type: 'progress', label: 'Progress', icon: 'linear_scale', group: 'Data' },
  { type: 'alert', label: 'Alert', icon: 'info', group: 'Data' },
] as const

export type BlockType = (typeof BLOCKS)[number]['type']
export type Viewport = 'desktop' | 'tablet' | 'mobile'
export type StyleMap = Record<string, string>
export interface Block {
  id: string
  type: BlockType
  name: string
  text: string
  url: string
  alt: string
  label: string
  options: string
  level: string
  inputType: string
  required: boolean
  disabled: boolean
  columns: number
  value: number
  styles: StyleMap
  tabletStyles: StyleMap
  mobileStyles: StyleMap
  children: Block[]
}
export interface Page {
  id: string
  name: string
  slug: string
  blocks: Block[]
}
export interface Project {
  version: 1
  name: string
  dark: boolean
  pages: Page[]
}
export const STYLE_PROPERTIES = [
  'color',
  'background-color',
  'font-size',
  'font-weight',
  'text-align',
  'padding',
  'margin',
  'gap',
  'width',
  'max-width',
  'min-height',
  'height',
  'border',
  'border-radius',
  'display',
  'align-items',
  'justify-content',
  'flex-direction',
  'grid-template-columns',
  'box-shadow',
  'opacity',
] as const

export function isContainer(type: BlockType): boolean {
  const definition = BLOCKS.find((block) => block.type === type)
  return !!definition && 'container' in definition
}

export function createBlock(type: BlockType): Block {
  const definition = BLOCKS.find((block) => block.type === type)!
  return {
    id: crypto.randomUUID(),
    type,
    name: definition.label,
    text:
      type === 'heading'
        ? 'Your heading'
        : type === 'stat'
          ? '1,280'
          : type === 'icon'
            ? 'star'
            : type === 'submit'
              ? 'Submit'
              : type === 'button'
                ? 'Continue'
                : type === 'text'
                  ? 'Write your content here.'
                  : definition.label,
    url:
      type === 'image'
        ? 'https://images.unsplash.com/photo-1497366811353-6870744d04b2?auto=format&fit=crop&w=1000&q=80'
        : '',
    alt: 'Office workspace',
    label: definition.label,
    options: 'First item\nSecond item\nThird item',
    level: '2',
    inputType: 'text',
    required: false,
    disabled: false,
    columns: 2,
    value: 50,
    styles: {},
    tabletStyles: {},
    mobileStyles: {},
    children: [],
  }
}

export function createProject(): Project {
  return {
    version: 1,
    name: 'Untitled website',
    dark: false,
    pages: [
      { id: crypto.randomUUID(), name: 'Home', slug: 'home', blocks: [] },
    ],
  }
}

export function findBlock(blocks: Block[], id: string): Block | undefined {
  for (const block of blocks) {
    if (block.id === id) return block
    const nested = findBlock(block.children, id)
    if (nested) return nested
  }
  return undefined
}

export function removeBlock(blocks: Block[], id: string): Block | undefined {
  const index = blocks.findIndex((block) => block.id === id)
  if (index >= 0) return blocks.splice(index, 1)[0]
  for (const block of blocks) {
    const removed = removeBlock(block.children, id)
    if (removed) return removed
  }
  return undefined
}

export function moveBlock(
  blocks: Block[],
  id: string,
  parentId: string,
  index: number,
): boolean {
  const block = findBlock(blocks, id)
  const parent = parentId === 'root' ? undefined : findBlock(blocks, parentId)
  if (!block || (parentId !== 'root' && (!parent || !isContainer(parent.type))))
    return false
  if (parentId === id || findBlock(block.children, parentId)) return false
  removeBlock(blocks, id)
  const target = parent ? parent.children : blocks
  target.splice(Math.min(Math.max(index, 0), target.length), 0, block)
  return true
}

export function duplicateBlock(block: Block): Block {
  return {
    ...structuredClone(block),
    id: crypto.randomUUID(),
    children: block.children.map(duplicateBlock),
  }
}

export function safeUrl(value: string, media = false): string {
  const trimmed = value.trim()
  if (!trimmed) return ''
  if (/^(https?:\/\/|\/(?!\/)|#|\.\/|\.\.\/)/i.test(trimmed)) return trimmed
  if (!media && /^(mailto:|tel:)/i.test(trimmed)) return trimmed
  return ''
}

export function safeStyle(property: string, value: string): boolean {
  return (
    STYLE_PROPERTIES.includes(property as (typeof STYLE_PROPERTIES)[number]) &&
    value.length <= 240 &&
    !/[{};<>\\]|url\s*\(|expression\s*\(|@import/i.test(value)
  )
}

export function blockCss(block: Block): string {
  const declarations = (styles: StyleMap) =>
    Object.entries(styles)
      .filter(([property, value]) => safeStyle(property, value))
      .map(([property, value]) => `${property}:${value}`)
      .join(';')
  const selector = `.element-${block.id}`
  const base = `${selector}{${declarations(block.styles)}}`
  const tablet = `@media(max-width:1024px){${selector}{${declarations(block.tabletStyles)}}}@container page-surface (max-width:1024px){${selector}{${declarations(block.tabletStyles)}}}`
  const mobile = `@media(max-width:600px){${selector}{${declarations(block.mobileStyles)}}}@container page-surface (max-width:600px){${selector}{${declarations(block.mobileStyles)}}}`
  return base + tablet + mobile + block.children.map(blockCss).join('')
}

export function parseProject(json: string): Project {
  if (json.length > 2_000_000)
    throw new Error('Project exceeds the 2 MB limit.')
  const project = JSON.parse(json)
  const ids = new Set<string>()
  let count = 0
  const validateBlocks = (blocks: unknown, depth: number): void => {
    if (!Array.isArray(blocks) || depth > 12)
      throw new Error('Invalid or excessively nested blocks.')
    for (const block of blocks) {
      if (
        ++count > 2000 ||
        !block ||
        !/^[a-zA-Z0-9-]{1,80}$/.test(block.id) ||
        ids.has(block.id) ||
        !BLOCKS.some((item) => item.type === block.type)
      )
        throw new Error('Invalid block or duplicate identifier.')
      ids.add(block.id)
      for (const key of [
        'name',
        'text',
        'url',
        'alt',
        'label',
        'options',
        'level',
        'inputType',
      ]) {
        if (typeof block[key] !== 'string' || block[key].length > 20000)
          throw new Error('Invalid block content.')
      }
      if (
        typeof block.required !== 'boolean' ||
        typeof block.disabled !== 'boolean' ||
        !Number.isFinite(block.value) ||
        ![1, 2, 3, 4].includes(block.columns)
      )
        throw new Error('Invalid block properties.')
      for (const key of ['styles', 'tabletStyles', 'mobileStyles']) {
        const styles = block[key]
        if (!styles || Array.isArray(styles) || typeof styles !== 'object')
          throw new Error('Invalid styles.')
        for (const [property, value] of Object.entries(styles)) {
          if (typeof value !== 'string' || !safeStyle(property, value))
            throw new Error('Unsupported or unsafe style.')
        }
      }
      if (!isContainer(block.type) && block.children?.length)
        throw new Error('Only layout and form blocks accept children.')
      validateBlocks(block.children, depth + 1)
    }
  }
  if (
    !project ||
    project.version !== 1 ||
    typeof project.name !== 'string' ||
    project.name.length > 200 ||
    typeof project.dark !== 'boolean' ||
    !Array.isArray(project.pages) ||
    !project.pages.length ||
    project.pages.length > 50
  )
    throw new Error('Not a supported Page Studio project.')
  const slugs = new Set<string>()
  for (const page of project.pages) {
    if (
      !page ||
      typeof page.name !== 'string' ||
      !/^[a-zA-Z0-9-]{1,80}$/.test(page.id) ||
      ids.has(page.id) ||
      !/^[a-z0-9-]+$/.test(page.slug) ||
      slugs.has(page.slug)
    )
      throw new Error('Invalid or duplicate page.')
    ids.add(page.id)
    slugs.add(page.slug)
    validateBlocks(page.blocks, 0)
  }
  return project as Project
}

const escapeHtml = (value: string): string =>
  value.replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        character
      ]!,
  )

export function exportBlock(block: Block): string {
  const text = escapeHtml(block.text)
  const label = escapeHtml(block.label)
  const url = escapeHtml(
    safeUrl(block.url, ['image', 'video', 'audio'].includes(block.type)),
  )
  const attributes = `class="page-block block-${block.type} element-${block.id} columns-${block.columns}"`
  const items = block.options.split('\n').filter(Boolean).map(escapeHtml)
  const children = block.children.map(exportBlock).join('\n')
  const state = `${block.required ? ' required' : ''}${block.disabled ? ' disabled' : ''}`
  switch (block.type) {
    case 'section':
    case 'container':
    case 'columns':
    case 'stack':
    case 'card':
      return `<section ${attributes}>${children}</section>`
    case 'form':
      return `<form ${attributes}>${children}</form>`
    case 'heading':
      return `<h${/^[1-6]$/.test(block.level) ? block.level : '2'} ${attributes}>${text}</h${/^[1-6]$/.test(block.level) ? block.level : '2'}>`
    case 'text':
      return `<p ${attributes}>${text}</p>`
    case 'image':
      return `<img ${attributes} src="${url}" alt="${escapeHtml(block.alt)}">`
    case 'video':
    case 'audio':
      return `<${block.type} ${attributes} controls src="${url}"></${block.type}>`
    case 'button':
      return url
        ? `<a ${attributes} href="${url}">${text}</a>`
        : `<button ${attributes} type="button"${state}>${text}</button>`
    case 'submit':
      return `<button ${attributes} type="submit"${state}>${text}</button>`
    case 'link':
      return `<a ${attributes} href="${url || '#'}">${text}</a>`
    case 'icon':
      return `<span ${attributes}><span class="material-icons" aria-label="${label}">${text}</span></span>`
    case 'list':
      return `<ul ${attributes}>${items.map((item) => `<li>${item}</li>`).join('')}</ul>`
    case 'divider':
      return `<hr ${attributes}>`
    case 'spacer':
      return `<div ${attributes} aria-hidden="true"></div>`
    case 'input':
    case 'date':
      return `<label ${attributes}>${label}<input name="${block.id}" type="${block.type === 'date' ? 'date' : ['text', 'email', 'number', 'password', 'tel', 'url'].includes(block.inputType) ? block.inputType : 'text'}" placeholder="${text}"${state}></label>`
    case 'textarea':
      return `<label ${attributes}>${label}<textarea name="${block.id}" placeholder="${text}"${state}></textarea></label>`
    case 'select':
      return `<label ${attributes}>${label}<select name="${block.id}"${state}>${items.map((item) => `<option>${item}</option>`).join('')}</select></label>`
    case 'checkbox':
    case 'switch':
      return `<label ${attributes}><input type="checkbox" name="${block.id}"${state}>${label}</label>`
    case 'radio':
      return `<fieldset ${attributes}><legend>${label}</legend>${items.map((item) => `<label><input type="radio" name="${block.id}" value="${item}"${state}>${item}</label>`).join('')}</fieldset>`
    case 'slider':
      return `<label ${attributes}>${label}<input type="range" name="${block.id}" value="${block.value}"${state}></label>`
    case 'navigation':
    case 'breadcrumb':
      return `<nav ${attributes} aria-label="${label}">${items
        .map((item) => {
          const [name, href] = item.split('|')
          return `<a href="${escapeHtml(safeUrl(href || '#'))}">${name}</a>`
        })
        .join('')}</nav>`
    case 'accordion':
      return `<section ${attributes}>${items
        .map((item) => {
          const [title, content] = item.split('|')
          return `<details><summary>${title}</summary><p>${content || text}</p></details>`
        })
        .join('')}</section>`
    case 'tabs':
      return `<section ${attributes}>${items
        .map((item) => {
          const [title, content] = item.split('|')
          return `<details><summary>${title}</summary><p>${content || text}</p></details>`
        })
        .join('')}</section>`
    case 'table':
      return `<div ${attributes}><table>${items
        .map(
          (row, index) =>
            `<tr>${row
              .split('|')
              .map(
                (cell) =>
                  `<${index === 0 ? 'th' : 'td'}>${cell}</${index === 0 ? 'th' : 'td'}>`,
              )
              .join('')}</tr>`,
        )
        .join('')}</table></div>`
    case 'stat':
      return `<section ${attributes}><span>${label}</span><h2>${text}</h2></section>`
    case 'progress':
      return `<label ${attributes}>${label}<progress max="100" value="${block.value}"></progress></label>`
    default:
      return `<div ${attributes}>${text}</div>`
  }
}

export function exportPage(
  project: Project,
  page: Page,
  themeCss: string,
): string {
  return `<!doctype html><html lang="en" class="${project.dark ? 'dark-theme' : ''}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(page.name)} | ${escapeHtml(project.name)}</title><link href="https://fonts.googleapis.com/css2?family=Public+Sans:wght@400;500;600;700&family=Material+Icons&display=swap" rel="stylesheet"><style>${themeCss.replace(/<\/style/gi, '')}${page.blocks.map(blockCss).join('')}</style></head><body><main class="published-page">${page.blocks.map(exportBlock).join('\n')}</main></body></html>`
}
