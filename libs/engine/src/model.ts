import { Flow, VariableScope, validateFlow } from './flow'
import { Dialect, SchemaMap, validateQuery } from './query'
import { AccessRule, SiteAuth } from './access'
import { slugProblem } from './address'
import { Logic, validateLogic } from './logic'
import { ApiDef, validateApi } from './api'

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
  {
    type: 'grid',
    label: 'Grid',
    icon: 'grid_view',
    group: 'Layout',
    container: true,
  },
  {
    type: 'repeater',
    label: 'Repeater',
    icon: 'dynamic_feed',
    group: 'Layout',
    container: true,
  },
  {
    type: 'hero',
    label: 'Hero',
    icon: 'panorama',
    group: 'Layout',
    container: true,
  },
  {
    type: 'header',
    label: 'Header',
    icon: 'web_asset',
    group: 'Layout',
    container: true,
  },
  {
    type: 'footer',
    label: 'Footer',
    icon: 'call_to_action',
    group: 'Layout',
    container: true,
  },
  {
    type: 'modal',
    label: 'Modal',
    icon: 'open_in_new',
    group: 'Layout',
    container: true,
  },
  {
    type: 'sidebar',
    label: 'Sidebar layout',
    icon: 'view_sidebar',
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
  { type: 'richtext', label: 'Rich text', icon: 'article', group: 'Content' },
  { type: 'embed', label: 'Embed', icon: 'smart_display', group: 'Content' },
  {
    type: 'gallery',
    label: 'Gallery',
    icon: 'photo_library',
    group: 'Content',
  },
  { type: 'avatar', label: 'Avatar', icon: 'account_circle', group: 'Content' },
  { type: 'chips', label: 'Chips', icon: 'sell', group: 'Content' },
  { type: 'quote', label: 'Quote', icon: 'format_quote', group: 'Content' },
  {
    type: 'keyvalue',
    label: 'Details list',
    icon: 'list_alt',
    group: 'Content',
  },
  { type: 'timeline', label: 'Timeline', icon: 'timeline', group: 'Content' },
  {
    type: 'carousel',
    label: 'Carousel',
    icon: 'view_carousel',
    group: 'Content',
  },
  { type: 'code', label: 'Code block', icon: 'code', group: 'Content' },
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
  { type: 'number', label: 'Number', icon: 'pin', group: 'Forms' },
  { type: 'search', label: 'Search', icon: 'search', group: 'Forms' },
  {
    type: 'multiselect',
    label: 'Multi-select',
    icon: 'checklist',
    group: 'Forms',
  },
  {
    type: 'togglegroup',
    label: 'Toggle group',
    icon: 'view_week',
    group: 'Forms',
  },
  { type: 'rating', label: 'Rating', icon: 'star_half', group: 'Forms' },
  { type: 'file', label: 'File upload', icon: 'upload_file', group: 'Forms' },
  { type: 'submit', label: 'Submit', icon: 'send', group: 'Forms' },
  { type: 'signin', label: 'Sign in', icon: 'login', group: 'Forms' },
  { type: 'table', label: 'Table', icon: 'table_chart', group: 'Data' },
  { type: 'datatable', label: 'Data table', icon: 'table_view', group: 'Data' },
  { type: 'treelist', label: 'Tree list', icon: 'account_tree', group: 'Data' },
  { type: 'stat', label: 'Statistic', icon: 'insights', group: 'Data' },
  { type: 'badge', label: 'Badge', icon: 'label', group: 'Data' },
  { type: 'progress', label: 'Progress', icon: 'linear_scale', group: 'Data' },
  { type: 'alert', label: 'Alert', icon: 'info', group: 'Data' },
  { type: 'chart', label: 'Chart', icon: 'bar_chart', group: 'Data' },
  { type: 'countdown', label: 'Countdown', icon: 'timer', group: 'Data' },
  {
    type: 'stepper',
    label: 'Stepper',
    icon: 'linear_scale',
    group: 'Navigation',
  },
  {
    type: 'menu',
    label: 'Dropdown menu',
    icon: 'more_vert',
    group: 'Navigation',
  },
  {
    type: 'pagination',
    label: 'Pagination',
    icon: 'last_page',
    group: 'Navigation',
  },
  // A placed reusable component; its content comes from the app's component of that id.
  {
    type: 'component',
    label: 'Component',
    icon: 'widgets',
    group: 'Components',
    container: true,
  },
] as const

/** Blocks whose `inputType` field holds a variant, with the choices shown in the inspector. */
export const VARIANTS: Partial<
  Record<string, { label: string; options: string[] }>
> = {
  input: {
    label: 'Input type',
    options: ['text', 'email', 'number', 'password', 'tel', 'url'],
  },
  chart: {
    label: 'Chart type',
    options: ['bar', 'line', 'pie', 'doughnut', 'radar'],
  },
  alert: { label: 'Tone', options: ['info', 'success', 'warning', 'error'] },
  togglegroup: { label: 'Selection', options: ['single', 'multiple'] },
  modal: { label: 'Size', options: ['small', 'medium', 'large'] },
  progress: { label: 'Style', options: ['linear', 'circle'] },
  sidebar: { label: 'Sidebar side', options: ['left', 'right'] },
}

/** Form blocks that can save their value into a variable. */
export const INPUT_TYPES: string[] = [
  'input',
  'textarea',
  'select',
  'checkbox',
  'radio',
  'switch',
  'slider',
  'date',
  'number',
  'search',
  'multiselect',
  'togglegroup',
  'rating',
  'file',
]

export type BlockType = (typeof BLOCKS)[number]['type']
export type Viewport = 'desktop' | 'tablet' | 'mobile'
export type StyleMap = Record<string, string>

/** Block properties that can be computed with JSON Logic at runtime. */
export const BINDINGS = [
  {
    key: 'visible',
    label: 'Show when',
    hint: 'Hide this block unless the logic is true.',
  },
  {
    key: 'text',
    label: 'Text',
    hint: 'Text, heading, button label or statistic value.',
  },
  { key: 'label', label: 'Label', hint: 'Field label or caption.' },
  {
    key: 'items',
    label: 'Items (list)',
    hint: 'List of items for lists, menus, selects, tables, tabs.',
  },
  {
    key: 'url',
    label: 'Link or media address',
    hint: 'Address for links, buttons, images and media.',
  },
  {
    key: 'value',
    label: 'Value',
    hint: 'Value for sliders, progress bars and inputs.',
  },
  {
    key: 'disabled',
    label: 'Disabled when',
    hint: 'Disable this control when the logic is true.',
  },
] as const
export type BindingKey = (typeof BINDINGS)[number]['key']

/** Events a block can react to; each runs its own flow with `event` details available to logic. */
export const EVENTS = [
  {
    key: 'click',
    label: 'Clicked',
    hint: 'event.item and event.index inside repeaters',
  },
  { key: 'dblclick', label: 'Double-clicked', hint: '' },
  { key: 'mouseenter', label: 'Pointer moves over', hint: '' },
  { key: 'mouseleave', label: 'Pointer moves away', hint: '' },
  {
    key: 'input',
    label: 'Typing (after a pause)',
    hint: 'event.value is the current text',
  },
  {
    key: 'change',
    label: 'Value changed',
    hint: 'event.value is the new value',
  },
  { key: 'focus', label: 'Gets focus', hint: '' },
  { key: 'blur', label: 'Loses focus', hint: 'Good for checking a field' },
  {
    key: 'enter',
    label: 'Enter key pressed',
    hint: 'event.value is the current text',
  },
  {
    key: 'submit',
    label: 'Form submitted',
    hint: 'event.form holds every field by name',
  },
  {
    key: 'load',
    label: 'Shown on screen',
    hint: 'Runs once when the block appears',
  },
  {
    key: 'visible',
    label: 'Scrolled into view',
    hint: 'Runs the first time it becomes visible',
  },
] as const
export type EventName = (typeof EVENTS)[number]['key']
/** Flow id to run, per event. */
export type BlockEvents = Partial<Record<EventName, string>>

export interface VariableDef {
  id: string
  name: string
  /** vars: this visit only; session: until the tab closes; local: kept on this device. */
  scope: VariableScope
  initial: unknown
  description: string
  /** Belongs to the signed-in user: cleared when someone signs in or out, or another person uses the device. */
  perUser?: boolean
}

/** A database the author connected. The connection URL lives in a credential, never in the project. */
export interface DataSource {
  id: string
  name: string
  type: Dialect
  /** Name of the credential (secrets.NAME) holding the connection URL. */
  credential: string
  /** Only allow reading rows. */
  readOnly: boolean
  /** Tables and columns, loaded from the database, used to check queries. */
  schema?: SchemaMap
}

export const COLUMN_FORMATS = [
  'text',
  'number',
  'currency',
  'date',
  'datetime',
  'badge',
  'link',
  'image',
  'boolean',
  'progress',
] as const
export type ColumnFormat = (typeof COLUMN_FORMATS)[number]

export interface TableColumn {
  /** Field of each row, e.g. "name" or "address.city". */
  key: string
  label: string
  format: ColumnFormat
  align?: 'start' | 'center' | 'end'
  /** CSS width, e.g. "120px" or "20%". */
  width?: string
  sortable: boolean
  filterable: boolean
  /** Optional JSON Logic computing the cell from `row`. */
  cell?: Logic
  /** Currency code for the currency format. */
  currency?: string
  /** Merge consecutive rows with the same value into one tall cell. */
  mergeRepeated?: boolean
  /** Columns with the same group name share a header above them. */
  group?: string
}

export type Pagination = 'none' | 'pages' | 'loadMore' | 'infinite' | 'virtual'

/** Settings for data tables and tree lists. */
export interface TableConfig {
  columns: TableColumn[]
  pagination: Pagination
  pageSize: number
  /** Re-run the data flow for each page, sort or search (for large databases). */
  serverSide: boolean
  /** Variable holding { page, pageSize, sort, direction, search } for server-side tables. */
  stateVar?: string
  search: boolean
  selection: 'none' | 'single' | 'multiple'
  /** Variable receiving the selected row (single) or rows (multiple). */
  selectionVar?: string
  /** Field that uniquely identifies a row. */
  rowKey: string
  /** Show rows under a heading per value of this field (with a count). */
  groupBy?: string
  dense: boolean
  striped: boolean
  stickyHeader: boolean
  // Tree lists
  /** Field holding child rows (nested data). */
  childrenKey?: string
  /** Field pointing to the parent row's key (flat data). */
  parentKey?: string
  /** Flow that loads a node's children when it is opened; it receives the node as input.item. */
  lazyFlow?: string
}

export function defaultTable(tree = false): TableConfig {
  return {
    columns: tree
      ? [
          {
            key: 'name',
            label: 'Name',
            format: 'text',
            sortable: false,
            filterable: false,
          },
        ]
      : [
          {
            key: 'name',
            label: 'Name',
            format: 'text',
            sortable: true,
            filterable: true,
          },
          {
            key: 'grade',
            label: 'Grade',
            format: 'number',
            sortable: true,
            filterable: false,
            align: 'end',
          },
          {
            key: 'status',
            label: 'Status',
            format: 'badge',
            sortable: true,
            filterable: true,
          },
        ],
    pagination: tree ? 'none' : 'pages',
    pageSize: 10,
    serverSide: false,
    search: !tree,
    selection: 'none',
    rowKey: 'id',
    dense: false,
    striped: false,
    stickyHeader: true,
    ...(tree ? { childrenKey: 'children' } : {}),
  }
}

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
  /** Properties computed with JSON Logic. */
  logic?: Partial<Record<BindingKey, Logic>>
  /** Flow whose result feeds this block; the block shows a skeleton while it runs. */
  source?: string
  /** Input blocks write their value into this variable. */
  bind?: { scope: VariableScope; name: string }
  on?: BlockEvents
  emptyText?: string
  errorText?: string
  /** Data tables and tree lists. */
  table?: TableConfig
  /** Who can see this block (enforced by the server on published sites). */
  access?: AccessRule
  /** Component blocks: which of the app's reusable components is placed here. */
  componentId?: string
  /** Component blocks: values for the component's inputs (logic or plain values), read inside as props.<name>. */
  props?: Record<string, Logic>
  /** Component blocks: flow to run for each of the component's outputs. */
  outputs?: Record<string, string>
}

/** A value a component receives where it is placed, e.g. the student a "Student card" shows. */
export interface ComponentInput {
  name: string
  label: string
  /** Used when a placement gives no value. */
  default?: unknown
  description?: string
}

/** Something a component reports to the page using it, e.g. "selected" when its button is clicked. */
export interface ComponentOutput {
  name: string
  label: string
  description?: string
}

/** Block events inside a component can raise one of its outputs with this flow value. */
export const OUTPUT_PREFIX = '@output:'

/** A reusable piece of page, built once and placed on any number of pages of the same app. */
export interface ComponentDef {
  id: string
  name: string
  blocks: Block[]
  /** Values each placement provides (props.<name> inside the component). */
  inputs?: ComponentInput[]
  /** Events the component raises for the page to handle. */
  outputs?: ComponentOutput[]
}
export interface Page {
  id: string
  name: string
  /** Route pattern below the site root, e.g. "students/:studentId/reports/:term". */
  path: string
  blocks: Block[]
  /** Who can open this page. */
  access?: AccessRule
  /** Set by the server when the visitor may not open this page; content is removed. */
  locked?: boolean
}
export interface Project {
  version: 2
  id: string
  name: string
  dark: boolean
  pages: Page[]
  variables: VariableDef[]
  flows: Flow[]
  dataSources: DataSource[]
  /** Sign-in and roles for the published site. */
  auth?: SiteAuth
  /** Web address: the app name in URL form, <origin>/<slug>/<page path>. Set by the server. */
  slug?: string
  /** Reusable components of this app. */
  components?: ComponentDef[]
  /** Reusable APIs of this app (some may belong to one page). */
  apis?: ApiDef[]
  updatedAt: string
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
  'min-width',
  'max-height',
  'margin-top',
  'margin-bottom',
  'padding-top',
  'padding-bottom',
  'flex-wrap',
  'flex',
  'align-self',
  'justify-self',
  'row-gap',
  'column-gap',
  'grid-template-rows',
  'grid-column',
  'grid-row',
  'font-family',
  'font-style',
  'line-height',
  'letter-spacing',
  'text-transform',
  'text-decoration',
  'white-space',
  'background',
  'border-color',
  'border-top',
  'border-bottom',
  'border-left',
  'border-right',
  'overflow',
  'aspect-ratio',
  'object-fit',
  'object-position',
] as const

export function isContainer(type: BlockType): boolean {
  const definition = BLOCKS.find((block) => block.type === type)
  return !!definition && 'container' in definition
}

/** Whether authors can drop blocks inside: component content is edited on the component itself. */
export function acceptsChildren(type: BlockType): boolean {
  return isContainer(type) && type !== 'component'
}

const IMAGE =
  'https://images.unsplash.com/photo-1497366811353-6870744d04b2?auto=format&fit=crop&w=1000&q=80'

/** Starting content per block type, so new blocks look meaningful. */
const DEFAULTS: Partial<Record<BlockType, Partial<Block>>> = {
  heading: { text: 'Your heading' },
  text: { text: 'Write your content here.' },
  stat: { text: '1,280' },
  icon: { text: 'star' },
  submit: { text: 'Submit' },
  button: { text: 'Continue' },
  image: { url: IMAGE },
  hero: { url: IMAGE, columns: 1 },
  grid: { columns: 3 },
  repeater: { columns: 3, options: '' },
  modal: { inputType: 'medium', label: 'Dialog' },
  richtext: {
    text: '## Rich text\nUse **bold**, *italic*, [links](https://example.com) and lists:\n- First point\n- Second point',
  },
  embed: {
    url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    label: 'Embedded video',
  },
  gallery: {
    options: `${IMAGE}|Workspace\nhttps://images.unsplash.com/photo-1523050854058-8df90110c9f1?auto=format&fit=crop&w=800&q=80|Campus\nhttps://images.unsplash.com/photo-1509062522246-3755977927d7?auto=format&fit=crop&w=800&q=80|Classroom`,
  },
  avatar: { text: 'Asha Rao', url: '' },
  chips: { options: 'Science\nMathematics\nArt' },
  quote: {
    text: 'Education is the most powerful tool you can use to change the world.',
    label: 'Nelson Mandela',
  },
  keyvalue: { options: 'Name|Asha Rao\nGrade|8\nHouse|Blue' },
  timeline: {
    options:
      'Admissions open|1 June\nTerm starts|15 July\nAnnual day|20 December',
  },
  number: { label: 'Quantity', text: '0' },
  search: { label: 'Search', text: 'Search…' },
  multiselect: { label: 'Choose subjects' },
  togglegroup: {
    label: 'View',
    options: 'Day\nWeek\nMonth',
    inputType: 'single',
  },
  rating: { label: 'Your rating', value: 3 },
  file: { label: 'Upload a file', text: 'Choose file' },
  chart: {
    label: 'Enrolment',
    options: 'Mon|12\nTue|19\nWed|8\nThu|15\nFri|22',
    inputType: 'bar',
  },
  countdown: {
    label: 'Starts in',
    text: new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10),
  },
  stepper: { options: 'Details\nDocuments\nPayment\nDone', value: 2 },
  signin: { label: 'Welcome back', text: 'Sign in' },
  alert: { inputType: 'info' },
  table: { options: 'Name|Class|Score\nAsha|8A|92\nRavi|8B|88' },
  datatable: {
    label: 'Students',
    options:
      'id|name|grade|status\n1|Asha Rao|8|Active\n2|Ravi Kumar|9|Active\n3|Meera Iyer|8|On leave\n4|Kabir Shah|10|Active',
    table: defaultTable(),
  },
  treelist: { label: 'Departments', options: '', table: defaultTable(true) },
  carousel: {
    options: `${IMAGE}|Welcome to our school\nhttps://images.unsplash.com/photo-1523050854058-8df90110c9f1?auto=format&fit=crop&w=1200&q=80|Admissions open`,
  },
  code: {
    text: 'const greeting = "Hello"\nconsole.log(greeting)',
    label: 'JavaScript',
  },
  menu: {
    text: 'Options',
    options: 'Profile|/profile\nSettings|/settings\nSign out|/',
  },
  pagination: { label: 'Page', text: '5', value: 1 },
  progress: { inputType: 'linear' },
  sidebar: { inputType: 'left' },
}

export function createBlock(type: BlockType): Block {
  const definition = BLOCKS.find((block) => block.type === type)!
  return {
    id: crypto.randomUUID(),
    type,
    name: definition.label,
    text: definition.label,
    url: '',
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
    // Copied so blocks never share nested settings such as table columns.
    ...structuredClone(DEFAULTS[type] ?? {}),
  }
}

export function createProject(name = 'Untitled website'): Project {
  return {
    version: 2,
    id: crypto.randomUUID(),
    name,
    dark: false,
    pages: [{ id: crypto.randomUUID(), name: 'Home', path: '', blocks: [] }],
    variables: [],
    flows: [],
    dataSources: [],
    updatedAt: new Date().toISOString(),
  }
}

// ---------------------------------------------------------------------------
// Page paths: "students/:studentId/reports/:term" style patterns.
// ---------------------------------------------------------------------------

const SEGMENT = /^(?:[a-z0-9-]+|:[a-zA-Z][a-zA-Z0-9_]{0,40})$/

export function normalizePath(path: string): string {
  return path
    .trim()
    .replace(/^\/+|\/+$/g, '')
    .replace(/\/{2,}/g, '/')
}

/** Returns a problem with the pattern, or '' when it is valid. */
export function pathProblem(pattern: string): string {
  const path = normalizePath(pattern)
  if (!path) return ''
  const segments = path.split('/')
  if (segments.length > 12) return 'Use at most 12 path parts.'
  const bad = segments.find((segment) => !SEGMENT.test(segment))
  if (bad)
    return `"${bad}" is not valid. Use lowercase words with dashes, or :name for a variable.`
  const names = segments.filter((s) => s.startsWith(':'))
  if (new Set(names).size !== names.length)
    return 'Each path variable needs a different name.'
  return ''
}

export function pathParams(pattern: string): string[] {
  return normalizePath(pattern)
    .split('/')
    .filter((segment) => segment.startsWith(':'))
    .map((segment) => segment.slice(1))
}

/** Matches a URL path against a pattern; returns the path variables or null. */
export function matchPath(
  pattern: string,
  url: string,
): Record<string, string> | null {
  const expected = normalizePath(pattern).split('/').filter(Boolean)
  const actual = normalizePath(url).split('/').filter(Boolean)
  if (expected.length !== actual.length) return null
  const params: Record<string, string> = {}
  for (let i = 0; i < expected.length; i++) {
    if (expected[i].startsWith(':')) {
      try {
        params[expected[i].slice(1)] = decodeURIComponent(actual[i])
      } catch {
        return null
      }
    } else if (expected[i] !== actual[i].toLowerCase()) return null
  }
  return params
}

/** Picks the page for a URL; static segments win over variables. */
export function resolvePage(
  project: Project,
  url: string,
): { page: Page; params: Record<string, string> } | null {
  const ranked = [...project.pages].sort(
    (a, b) => pathParams(a.path).length - pathParams(b.path).length,
  )
  for (const page of ranked) {
    const params = matchPath(page.path, url)
    if (params) return { page, params }
  }
  return null
}

export function buildPath(
  pattern: string,
  params: Record<string, unknown>,
): string {
  return normalizePath(pattern)
    .split('/')
    .filter(Boolean)
    .map((segment) =>
      segment.startsWith(':')
        ? encodeURIComponent(
            String(params[segment.slice(1)] ?? segment.slice(1)),
          )
        : segment,
    )
    .join('/')
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
  if (
    !block ||
    (parentId !== 'root' && (!parent || !acceptsChildren(parent.type)))
  )
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
  // Buttons draw their own surface, so their styles go on the button itself: the exported
  // <a>/<button>, or the Material button inside the editor/live wrapper (specific enough to
  // win over Material's own colour, shape and size).
  const selector =
    block.type === 'button' || block.type === 'submit'
      ? `.element-${block.id}:is(a,button),.page-block.element-${block.id} :is(a.mat-mdc-button-base,button.mat-mdc-button-base)`
      : `.element-${block.id}`
  const base = `${selector}{${declarations(block.styles)}}`
  const tablet = `@media(max-width:1024px){${selector}{${declarations(block.tabletStyles)}}}@container page-surface (max-width:1024px){${selector}{${declarations(block.tabletStyles)}}}`
  const mobile = `@media(max-width:600px){${selector}{${declarations(block.mobileStyles)}}}@container page-surface (max-width:600px){${selector}{${declarations(block.mobileStyles)}}}`
  return base + tablet + mobile + block.children.map(blockCss).join('')
}

const ID = /^[a-zA-Z0-9-]{1,80}$/
/** Block ids; copies of component content get "<instance id>_<block id>". */
const BLOCK_ID = /^[a-zA-Z0-9_-]{1,400}$/
const ROLE_ID = /^[a-z][a-z0-9_-]{0,40}$/
function checkAccess(access: any, where: string): void {
  if (access === undefined) return
  if (
    !access ||
    !['public', 'signedIn', 'roles'].includes(access.mode) ||
    (access.roles !== undefined &&
      (!Array.isArray(access.roles) ||
        access.roles.some(
          (role: unknown) => typeof role !== 'string' || !ROLE_ID.test(role),
        )))
  )
    throw new Error(`${where} has invalid access settings.`)
}
const VAR_NAME = /^[a-zA-Z_][a-zA-Z0-9_]{0,60}$/
/** Component input and output names. */
const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/
const SCOPES = ['vars', 'session', 'local']

/** Upgrades a version 1 project (slug-based pages, no logic) in place. */
function migrate(project: any): void {
  if (project.version === 1) {
    project.version = 2
    project.id = crypto.randomUUID()
    project.variables = []
    project.flows = []
    project.updatedAt = new Date().toISOString()
    project.pages?.forEach((page: any, index: number) => {
      page.path = index === 0 ? '' : String(page.slug ?? '')
      delete page.slug
    })
  }
}

export function parseProject(json: string): Project {
  if (json.length > 2_000_000)
    throw new Error('Project exceeds the 2 MB limit.')
  const project = JSON.parse(json)
  if (project && typeof project === 'object') {
    migrate(project)
    // Projects saved before data sources existed.
    if (project.dataSources === undefined) project.dataSources = []
  }
  const ids = new Set<string>()
  const flowIds = new Set<string>(
    Array.isArray(project?.flows)
      ? project.flows.map((flow: any) => flow?.id)
      : [],
  )
  let count = 0
  const instances: Block[] = []
  const validateBlocks = (blocks: unknown, depth: number): void => {
    if (!Array.isArray(blocks) || depth > 12)
      throw new Error('Invalid or excessively nested blocks.')
    for (const block of blocks) {
      if (
        ++count > 2000 ||
        !block ||
        !BLOCK_ID.test(block.id) ||
        ids.has(block.id) ||
        !BLOCKS.some((item) => item.type === block.type)
      )
        throw new Error('Invalid block or duplicate identifier.')
      if (block.type === 'component') {
        if (
          typeof block.componentId !== 'string' ||
          !ID.test(block.componentId)
        )
          throw new Error('A placed component is missing its component.')
        if (block.props !== undefined) {
          if (
            !block.props ||
            typeof block.props !== 'object' ||
            Array.isArray(block.props)
          )
            throw new Error(`"${block.name}" has invalid input values.`)
          for (const [name, value] of Object.entries(block.props)) {
            if (!NAME.test(name))
              throw new Error(`"${block.name}" has an invalid input name.`)
            const problems = validateLogic(value as Logic)
            if (problems.length)
              throw new Error(`"${block.name}" → input ${name}: ${problems[0]}`)
          }
        }
        if (block.outputs !== undefined) {
          if (
            !block.outputs ||
            typeof block.outputs !== 'object' ||
            Array.isArray(block.outputs)
          )
            throw new Error(`"${block.name}" has invalid outputs.`)
          for (const [name, flowId] of Object.entries(block.outputs))
            if (!NAME.test(name) || !flowIds.has(flowId as string))
              throw new Error(
                `"${block.name}" runs a flow that no longer exists for its "${name}" output.`,
              )
        }
        instances.push(block)
      } else if (
        block.componentId !== undefined ||
        block.props !== undefined ||
        block.outputs !== undefined
      )
        throw new Error('Invalid block.')
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
      if (block.logic !== undefined) {
        if (
          !block.logic ||
          typeof block.logic !== 'object' ||
          Array.isArray(block.logic)
        )
          throw new Error(`"${block.name}" has invalid logic.`)
        for (const [key, logic] of Object.entries(block.logic)) {
          if (!BINDINGS.some((binding) => binding.key === key))
            throw new Error(
              `"${block.name}" has an unknown logic property "${key}".`,
            )
          const problems = validateLogic(logic)
          if (problems.length)
            throw new Error(`"${block.name}" → ${key}: ${problems[0]}`)
        }
      }
      checkAccess(block.access, `"${block.name}"`)
      if (block.source !== undefined && !flowIds.has(block.source))
        throw new Error(`"${block.name}" uses a flow that no longer exists.`)
      if (block.on !== undefined) {
        for (const [event, flowId] of Object.entries(block.on ?? {}))
          if (
            !EVENTS.some((item) => item.key === event) ||
            (flowId !== undefined &&
              !flowIds.has(flowId as string) &&
              !(
                typeof flowId === 'string' &&
                flowId.startsWith(OUTPUT_PREFIX) &&
                NAME.test(flowId.slice(OUTPUT_PREFIX.length))
              ))
          )
            throw new Error(
              `"${block.name}" runs a flow that no longer exists.`,
            )
      }
      if (
        block.bind !== undefined &&
        (!SCOPES.includes(block.bind?.scope) ||
          !VAR_NAME.test(block.bind?.name ?? ''))
      )
        throw new Error(`"${block.name}" saves to an invalid variable.`)
      for (const key of ['emptyText', 'errorText'])
        if (
          block[key] !== undefined &&
          (typeof block[key] !== 'string' || block[key].length > 500)
        )
          throw new Error('Invalid block message.')
      if (block.table !== undefined) {
        const table = block.table
        if (
          !table ||
          typeof table !== 'object' ||
          !Array.isArray(table.columns) ||
          table.columns.length > 50 ||
          !['none', 'pages', 'loadMore', 'infinite', 'virtual'].includes(
            table.pagination,
          ) ||
          !Number.isInteger(table.pageSize) ||
          table.pageSize < 1 ||
          table.pageSize > 500 ||
          !['none', 'single', 'multiple'].includes(table.selection) ||
          (table.lazyFlow !== undefined &&
            table.lazyFlow !== '' &&
            !flowIds.has(table.lazyFlow)) ||
          [table.stateVar, table.selectionVar].some(
            (name) => name !== undefined && name !== '' && !VAR_NAME.test(name),
          )
        )
          throw new Error(`"${block.name}" has invalid table settings.`)
        for (const column of table.columns) {
          if (
            !column ||
            typeof column.key !== 'string' ||
            typeof column.label !== 'string' ||
            !COLUMN_FORMATS.includes(column.format)
          )
            throw new Error(`"${block.name}" has an invalid column.`)
          const problems = validateLogic(column.cell)
          if (problems.length)
            throw new Error(
              `"${block.name}" → column "${column.label}": ${problems[0]}`,
            )
        }
      }
      if (!isContainer(block.type) && block.children?.length)
        throw new Error('Only layout and form blocks accept children.')
      validateBlocks(block.children, depth + 1)
    }
  }
  if (
    !project ||
    project.version !== 2 ||
    !ID.test(project.id) ||
    typeof project.name !== 'string' ||
    project.name.length > 200 ||
    typeof project.dark !== 'boolean' ||
    !Array.isArray(project.pages) ||
    !project.pages.length ||
    project.pages.length > 50 ||
    !Array.isArray(project.variables) ||
    !Array.isArray(project.flows) ||
    project.flows.length > 100 ||
    project.variables.length > 200
  )
    throw new Error('Not a supported Page Studio project.')
  if (typeof project.updatedAt !== 'string')
    project.updatedAt = new Date().toISOString()
  if (
    project.slug !== undefined &&
    (typeof project.slug !== 'string' || slugProblem(project.slug))
  )
    delete project.slug
  const paths = new Set<string>()
  for (const page of project.pages) {
    if (
      !page ||
      typeof page.name !== 'string' ||
      !ID.test(page.id) ||
      ids.has(page.id) ||
      typeof page.path !== 'string'
    )
      throw new Error('Invalid or duplicate page.')
    checkAccess(page.access, `Page "${page.name}"`)
    if (page.locked !== undefined && typeof page.locked !== 'boolean')
      throw new Error('Invalid page.')
    page.path = normalizePath(page.path)
    const problem = pathProblem(page.path)
    if (problem) throw new Error(`Page "${page.name}": ${problem}`)
    // Two patterns clash when they only differ in variable names.
    const shape = page.path.replace(/:[^/]+/g, ':')
    if (paths.has(shape))
      throw new Error(`Page "${page.name}" has the same path as another page.`)
    paths.add(shape)
    ids.add(page.id)
    validateBlocks(page.blocks, 0)
  }
  const names = new Set<string>()
  for (const variable of project.variables) {
    if (
      !variable ||
      !ID.test(variable.id) ||
      !VAR_NAME.test(variable.name ?? '') ||
      !SCOPES.includes(variable.scope) ||
      typeof variable.description !== 'string' ||
      names.has(`${variable.scope}.${variable.name}`) ||
      (variable.perUser !== undefined && typeof variable.perUser !== 'boolean')
    )
      throw new Error(`Variable "${variable?.name}" is invalid or duplicated.`)
    names.add(`${variable.scope}.${variable.name}`)
    if (JSON.stringify(variable.initial ?? null).length > 100_000)
      throw new Error(`Variable "${variable.name}" is too large.`)
  }
  if (project.auth !== undefined) {
    const auth = project.auth
    if (
      !auth ||
      typeof auth.enabled !== 'boolean' ||
      typeof auth.allowSignUp !== 'boolean' ||
      !Array.isArray(auth.roles) ||
      auth.roles.length > 30 ||
      auth.roles.some(
        (role: any) =>
          !role ||
          !ROLE_ID.test(role.id) ||
          typeof role.name !== 'string' ||
          typeof role.description !== 'string',
      ) ||
      new Set(auth.roles.map((role: any) => role.id)).size !==
        auth.roles.length ||
      !auth.roles.some((role: any) => role.id === auth.defaultRole)
    )
      throw new Error('Sign-in and role settings are invalid.')
  }
  if (!Array.isArray(project.dataSources) || project.dataSources.length > 50)
    throw new Error('Invalid data sources.')
  const sources = new Map<string, DataSource>()
  for (const source of project.dataSources) {
    if (
      !source ||
      !ID.test(source.id) ||
      typeof source.name !== 'string' ||
      !['postgres', 'mysql'].includes(source.type) ||
      !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(source.credential ?? '') ||
      typeof source.readOnly !== 'boolean' ||
      (source.schema !== undefined &&
        (typeof source.schema !== 'object' || Array.isArray(source.schema)))
    )
      throw new Error(`Data source "${source?.name}" is invalid.`)
    sources.set(source.id, source)
  }
  if (project.components !== undefined) {
    if (!Array.isArray(project.components) || project.components.length > 100)
      throw new Error('Invalid components.')
    for (const component of project.components) {
      if (
        !component ||
        !ID.test(component.id) ||
        ids.has(component.id) ||
        typeof component.name !== 'string' ||
        component.name.length > 200
      )
        throw new Error('Invalid or duplicate component.')
      ids.add(component.id)
      for (const [list, what] of [
        [component.inputs, 'input'],
        [component.outputs, 'output'],
      ] as const) {
        if (list === undefined) continue
        if (!Array.isArray(list) || list.length > 30)
          throw new Error(`Component "${component.name}" has invalid ${what}s.`)
        const seen = new Set<string>()
        for (const item of list as { name: string; label: string }[]) {
          if (
            !item ||
            !NAME.test(item.name) ||
            seen.has(item.name) ||
            typeof item.label !== 'string'
          )
            throw new Error(
              `Component "${component.name}": ${what} names use letters, digits and _, and must be unique.`,
            )
          seen.add(item.name)
        }
      }
      validateBlocks(component.blocks, 0)
    }
  }
  // Placed components with no content yet must name one of this app's components (published sites carry
  // the content inline instead), and a component may not contain itself.
  const componentIds = new Set<string>(
    (project.components ?? []).map((component: ComponentDef) => component.id),
  )
  for (const instance of instances) {
    if (!instance.children.length && !componentIds.has(instance.componentId!))
      throw new Error(
        `"${instance.name}" uses a component that does not exist.`,
      )
    const component = (project.components as ComponentDef[] | undefined)?.find(
      (item) => item.id === instance.componentId,
    )
    if (component)
      for (const name of Object.keys(instance.props ?? {}))
        if (!component.inputs?.some((input) => input.name === name))
          throw new Error(
            `"${instance.name}" sets "${name}", which "${component.name}" does not have as an input.`,
          )
  }
  for (const component of (project.components ?? []) as ComponentDef[]) {
    const used = new Set<string>()
    const walk = (blocks: Block[], depth: number): void => {
      for (const block of blocks) {
        if (
          block.type === 'component' &&
          block.componentId &&
          !used.has(block.componentId) &&
          depth < 20
        ) {
          used.add(block.componentId)
          walk(
            (project.components as ComponentDef[]).find(
              (item) => item.id === block.componentId,
            )?.blocks ?? [],
            depth + 1,
          )
        }
        walk(block.children, depth)
      }
    }
    walk(component.blocks, 0)
    if (used.has(component.id))
      throw new Error(`Component "${component.name}" contains itself.`)
  }
  const apiIds = new Set<string>()
  if (project.apis !== undefined) {
    if (!Array.isArray(project.apis) || project.apis.length > 100)
      throw new Error('Invalid APIs.')
    const pageIdSet = new Set(project.pages.map((page: Page) => page.id))
    for (const api of project.apis as ApiDef[]) {
      const problems = validateApi(api)
      if (problems.length) throw new Error(problems[0])
      if (ids.has(api.id) || apiIds.has(api.id))
        throw new Error(`API "${api.name}" has a duplicate id.`)
      if (api.pageId !== undefined && !pageIdSet.has(api.pageId))
        throw new Error(
          `API "${api.name}" belongs to a page that no longer exists.`,
        )
      for (const problem of [
        ...validateLogic(api.body),
        ...validateLogic(api.auth.token),
        ...validateLogic(api.auth.headers),
        ...validateLogic(api.auth.hmacMessage),
      ])
        throw new Error(`API "${api.name}": ${problem}`)
      checkAccess(api.access, `API "${api.name}"`)
      apiIds.add(api.id)
    }
  }
  for (const flow of project.flows) {
    if (
      !flow ||
      !ID.test(flow.id) ||
      typeof flow.name !== 'string' ||
      !['client', 'server'].includes(flow.runAt) ||
      !['parallel', 'sequential'].includes(flow.mode) ||
      !['manual', 'pageLoad', 'interval', 'schedule'].includes(flow.trigger) ||
      !Array.isArray(flow.pageIds) ||
      !Array.isArray(flow.steps) ||
      flow.steps.length > 100 ||
      flow.steps.some((step: any) => !step || !ID.test(step.id)) ||
      typeof flow.positions !== 'object'
    )
      throw new Error(`Flow "${flow?.name}" is invalid.`)
    for (const next of [flow.onSuccess, flow.onFailure])
      if (next !== undefined && next !== '' && !flowIds.has(next))
        throw new Error(
          `Flow "${flow.name}" continues with a flow that no longer exists.`,
        )
    checkAccess(flow.access, `Flow "${flow.name}"`)
    const problems = validateFlow(flow)
    if (problems.length) throw new Error(`Flow "${flow.name}": ${problems[0]}`)
    for (const step of flow.steps)
      if (step.type === 'api' && !apiIds.has(step.apiId ?? ''))
        throw new Error(
          `Flow "${flow.name}" → "${step.name}" calls an API that no longer exists.`,
        )
    for (const step of flow.steps) {
      if (step.type !== 'query') continue
      const source = sources.get(step.dataSource)
      if (!source)
        throw new Error(
          `Flow "${flow.name}" → "${step.name}" uses a data source that no longer exists.`,
        )
      const queryProblems = validateQuery(
        step.query,
        source.type,
        source.schema,
      )
      if (queryProblems.length)
        throw new Error(
          `Flow "${flow.name}" → "${step.name}": ${queryProblems[0]}`,
        )
    }
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
