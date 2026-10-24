/**
 * Publishing model. An app is published in parts:
 *  - the app itself: name, theme, journeys (flows), variables, data sources, sign-in and page order;
 *  - each page;
 *  - each reusable component.
 * Every saved change becomes a new draft version of the part it touched. Only one version of a part
 * is live at a time, and only the last KEEP_VERSIONS versions are kept (plus the live one).
 * A page is published with the component versions it was reviewed with ("pins"); when a component
 * changes, every page using it needs review and must be published again.
 */
import type { Block, ComponentDef, Page, Project } from './model'

export type EntityKind = 'app' | 'page' | 'component'

/** The app has a single settings entity with this id. */
export const APP_ENTITY = 'app'
/** Versions kept per page, component and the app, in addition to the live one. */
export const KEEP_VERSIONS = 2

export interface EntityVersion {
  projectId: string
  kind: EntityKind
  entityId: string
  version: number
  name: string
  hash: string
  status: 'draft' | 'published'
  /** Pages: component id → component version it was published with. */
  pins?: Record<string, number>
  createdBy: string | null
  createdAt: string
}

/** App-level settings: everything except page and component content. */
export interface AppSettings {
  name: string
  dark: boolean
  variables: Project['variables']
  flows: Project['flows']
  dataSources: Project['dataSources']
  apis?: Project['apis']
  auth?: Project['auth']
  slug?: string
  pageOrder: string[]
}

export interface Entity {
  kind: EntityKind
  id: string
  name: string
  data: AppSettings | Page | ComponentDef
}

export type EntityState = 'live' | 'changed' | 'review' | 'draft' | 'deleted'

export interface EntityStatus {
  kind: EntityKind
  id: string
  name: string
  state: EntityState
  liveVersion: number | null
  latestVersion: number | null
  versions: EntityVersion[]
  /** Why a page needs review, e.g. which components changed. */
  reasons: string[]
  /** Components: names of the pages that use it. */
  usedBy: string[]
}

export function appSettings(project: Project): AppSettings {
  return {
    name: project.name,
    dark: project.dark,
    variables: project.variables,
    flows: project.flows,
    dataSources: project.dataSources,
    ...(project.apis?.length ? { apis: project.apis } : {}),
    ...(project.auth ? { auth: project.auth } : {}),
    ...(project.slug ? { slug: project.slug } : {}),
    pageOrder: project.pages.map((page) => page.id),
  }
}

export function entitiesOf(project: Project): Entity[] {
  return [
    {
      kind: 'app',
      id: APP_ENTITY,
      name: project.name,
      data: appSettings(project),
    },
    ...project.pages.map((page) => ({
      kind: 'page' as const,
      id: page.id,
      name: page.name,
      data: page,
    })),
    ...(project.components ?? []).map((component) => ({
      kind: 'component' as const,
      id: component.id,
      name: component.name,
      data: component,
    })),
  ]
}

/** JSON with sorted keys, so equal content always hashes the same. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`,
      )
      .join(',')}}`
  return JSON.stringify(value) ?? 'null'
}

export async function hashOf(value: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(canonical(value)),
  )
  return [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

/** Components a block tree uses, including components used inside those components. */
export function componentsUsed(
  blocks: Block[],
  components: ComponentDef[],
  found = new Set<string>(),
): Set<string> {
  for (const block of blocks) {
    if (
      block.type === 'component' &&
      block.componentId &&
      !found.has(block.componentId)
    ) {
      found.add(block.componentId)
      const component = components.find((item) => item.id === block.componentId)
      if (component) componentsUsed(component.blocks, components, found)
    }
    componentsUsed(block.children, components, found)
  }
  return found
}

/** Pages that use a component, directly or through another component. */
export function pagesUsing(project: Project, componentId: string): Page[] {
  const components = project.components ?? []
  return project.pages.filter((page) =>
    componentsUsed(page.blocks, components).has(componentId),
  )
}

/** Whether placing `componentId` inside `targetId` (a component) would make a component contain itself. */
export function createsCycle(
  components: ComponentDef[],
  targetId: string,
  componentId: string,
): boolean {
  if (targetId === componentId) return true
  const inner = components.find((item) => item.id === componentId)
  return !!inner && componentsUsed(inner.blocks, components).has(targetId)
}

/**
 * Replaces each component instance's (empty) children with a copy of the component's blocks.
 * Copied ids get the instance id as a prefix, so two instances on one page never share ids.
 */
export function expandBlocks(
  blocks: Block[],
  lookup: (id: string) => ComponentDef | undefined,
  prefix = '',
  depth = 0,
): Block[] {
  return blocks.map((block) => {
    const id = prefix ? `${prefix}_${block.id}` : block.id
    if (block.type === 'component') {
      const component = block.componentId
        ? lookup(block.componentId)
        : undefined
      const children =
        component && depth < 8
          ? expandBlocks(component.blocks, lookup, id, depth + 1)
          : []
      const defaults = Object.fromEntries(
        (component?.inputs ?? [])
          .filter((input) => input.default !== undefined)
          .map((input) => [input.name, input.default]),
      )
      const props = { ...defaults, ...(block.props ?? {}) }
      return {
        ...block,
        id,
        children,
        ...(Object.keys(props).length
          ? { props: props as Block['props'] }
          : {}),
      }
    }
    return {
      ...block,
      id,
      children: expandBlocks(block.children, lookup, prefix, depth),
    }
  })
}

/** The draft as visitors would see it, with components filled in (used by the builder preview). */
export function expandProject(project: Project): Project {
  const components = project.components ?? []
  const lookup = (id: string) => components.find((item) => item.id === id)
  return {
    ...project,
    pages: project.pages.map((page) => ({
      ...page,
      blocks: expandBlocks(page.blocks, lookup),
    })),
    components: [],
  }
}

/** Names must be unique within an app: pages among pages, components among components. */
export function nameProblems(project: Project): string[] {
  const problems: string[] = []
  const check = (items: { name: string }[], what: string) => {
    const seen = new Set<string>()
    for (const item of items) {
      const key = item.name.trim().toLowerCase()
      if (!key) problems.push(`Every ${what} needs a name.`)
      else if (seen.has(key))
        problems.push(
          `Two ${what}s are called “${item.name.trim()}”. Names must be unique in an app.`,
        )
      seen.add(key)
    }
  }
  check(project.pages, 'page')
  check(project.components ?? [], 'component')
  return problems
}

/** Where each part of the app stands, compared with what is live. */
export async function statuses(
  project: Project,
  versions: EntityVersion[],
): Promise<EntityStatus[]> {
  const byEntity = new Map<string, EntityVersion[]>()
  for (const version of versions) {
    const key = `${version.kind}:${version.entityId}`
    byEntity.set(key, [...(byEntity.get(key) ?? []), version])
  }
  for (const list of byEntity.values())
    list.sort((a, b) => b.version - a.version)
  const latestOf = (kind: EntityKind, id: string) =>
    byEntity.get(`${kind}:${id}`)?.[0]
  const componentName = (id: string) =>
    project.components?.find((item) => item.id === id)?.name ??
    'a deleted component'

  const result: EntityStatus[] = []
  const seen = new Set<string>()
  for (const entity of entitiesOf(project)) {
    const key = `${entity.kind}:${entity.id}`
    seen.add(key)
    const list = byEntity.get(key) ?? []
    const live = list.find((version) => version.status === 'published')
    const hash = await hashOf(entity.data)
    const reasons: string[] = []
    let state: EntityState = !live
      ? 'draft'
      : live.hash === hash
        ? 'live'
        : 'changed'
    if (entity.kind === 'page' && live && state === 'live') {
      for (const [componentId, pinned] of Object.entries(live.pins ?? {})) {
        const latest = latestOf('component', componentId)
        if (latest && latest.version !== pinned)
          reasons.push(
            `Component “${componentName(componentId)}” changed since this page was published.`,
          )
      }
      if (reasons.length) state = 'review'
    }
    result.push({
      kind: entity.kind,
      id: entity.id,
      name: entity.name,
      state,
      liveVersion: live?.version ?? null,
      latestVersion: list[0]?.version ?? null,
      versions: list,
      reasons,
      usedBy:
        entity.kind === 'component'
          ? pagesUsing(project, entity.id).map((page) => page.name)
          : [],
    })
  }
  // Deleted from the draft but still live: shown so they can be taken down.
  for (const [key, list] of byEntity) {
    const live = list.find((version) => version.status === 'published')
    if (seen.has(key) || !live) continue
    result.push({
      kind: live.kind,
      id: live.entityId,
      name: live.name,
      state: 'deleted',
      liveVersion: live.version,
      latestVersion: list[0].version,
      versions: list,
      reasons: [],
      usedBy: [],
    })
  }
  return result
}
