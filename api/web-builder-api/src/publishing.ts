/**
 * Publishing per part: records draft versions on save, publishes one page, component or the app
 * settings at a time, keeps only the last KEEP_VERSIONS versions, and assembles the live app from
 * whatever is published. See libs/engine/src/publishing.ts for the model.
 */
import {
  ComponentDef,
  Page,
  Project,
  parseProject,
} from '@spsedu360/engine/model'
import {
  APP_ENTITY,
  AppSettings,
  EntityKind,
  EntityVersion,
  KEEP_VERSIONS,
  componentsUsed,
  entitiesOf,
  expandBlocks,
  hashOf,
} from '@spsedu360/engine/publishing'
import type { ProjectStore } from './storage'

export class PublishError extends Error {
  constructor(
    message: string,
    readonly status = 409,
  ) {
    super(message)
  }
}

const KINDS: EntityKind[] = ['app', 'page', 'component']
export const isKind = (value: unknown): value is EntityKind =>
  KINDS.includes(value as EntityKind)

function versionsOf(
  all: EntityVersion[],
  kind: EntityKind,
  id: string,
): EntityVersion[] {
  return all
    .filter((item) => item.kind === kind && item.entityId === id)
    .sort((a, b) => b.version - a.version)
}

/** Keeps the newest KEEP_VERSIONS versions of an entity, and always the live one. */
async function prune(
  store: ProjectStore,
  list: EntityVersion[],
): Promise<void> {
  const sorted = [...list].sort((a, b) => b.version - a.version)
  const keep = new Set(
    sorted.slice(0, KEEP_VERSIONS).map((item) => item.version),
  )
  await store.deleteEntityVersions(
    sorted.filter(
      (item) => !keep.has(item.version) && item.status !== 'published',
    ),
  )
}

/**
 * After a save: every page, component or app setting whose content differs from its newest version
 * gets a new draft version. Returns what changed.
 */
export async function recordChanges(
  store: ProjectStore,
  project: Project,
  userId: string | null,
): Promise<EntityVersion[]> {
  const all = await store.listEntityVersions(project.id)
  const added: EntityVersion[] = []
  for (const entity of entitiesOf(project)) {
    const list = versionsOf(all, entity.kind, entity.id)
    const hash = await hashOf(entity.data)
    if (list[0]?.hash === hash) continue
    const record: EntityVersion = {
      projectId: project.id,
      kind: entity.kind,
      entityId: entity.id,
      version: (list[0]?.version ?? 0) + 1,
      name: entity.name,
      hash,
      status: 'draft',
      createdBy: userId,
      createdAt: new Date().toISOString(),
    }
    await store.addEntityVersion(record, entity.data)
    await prune(store, [record, ...list])
    added.push(record)
  }
  return added
}

/** Builds the live app from the published app settings, pages and the component versions each page pinned. */
export async function assembleSite(
  store: ProjectStore,
  projectId: string,
): Promise<Project | null> {
  const all = await store.listEntityVersions(projectId)
  const liveApp = all.find(
    (item) => item.kind === 'app' && item.status === 'published',
  )
  if (!liveApp) return null
  const settings = (await store.getEntityData(
    projectId,
    'app',
    APP_ENTITY,
    liveApp.version,
  )) as AppSettings | null
  if (!settings) return null
  const livePages = all.filter(
    (item) => item.kind === 'page' && item.status === 'published',
  )
  const order = (id: string) => {
    const index = settings.pageOrder.indexOf(id)
    return index < 0 ? Number.MAX_SAFE_INTEGER : index
  }
  livePages.sort((a, b) => order(a.entityId) - order(b.entityId))
  const componentCache = new Map<string, ComponentDef | null>()
  const pages: Page[] = []
  for (const live of livePages) {
    const page = (await store.getEntityData(
      projectId,
      'page',
      live.entityId,
      live.version,
    )) as Page | null
    if (!page) continue
    const pins = live.pins ?? {}
    // Load every pinned component version first; expansion itself is synchronous.
    for (const [componentId, version] of Object.entries(pins)) {
      const key = `${componentId}@${version}`
      if (!componentCache.has(key))
        componentCache.set(
          key,
          (await store.getEntityData(
            projectId,
            'component',
            componentId,
            version,
          )) as ComponentDef | null,
        )
    }
    const lookup = (id: string) =>
      pins[id]
        ? (componentCache.get(`${id}@${pins[id]}`) ?? undefined)
        : undefined
    pages.push({ ...page, blocks: expandBlocks(page.blocks, lookup) })
  }
  if (!pages.length) return null
  const { pageOrder: _order, ...rest } = settings
  const site = {
    version: 2,
    id: projectId,
    ...rest,
    pages,
    components: [],
    updatedAt: new Date().toISOString(),
  }
  try {
    return parseProject(JSON.stringify(site))
  } catch (error) {
    throw new PublishError(
      `The live app would not work: ${error instanceof Error ? error.message : 'invalid content'} ` +
        'Publish the app settings (journeys, variables, sign-in) or the related page so they match.',
    )
  }
}

/** Rebuilds the live app; takes it offline when nothing can be served. */
async function refreshSite(
  store: ProjectStore,
  projectId: string,
): Promise<Project | null> {
  const site = await assembleSite(store, projectId)
  if (site) await store.saveSite(projectId, site)
  return site
}

function entityName(project: Project, kind: EntityKind, id: string): string {
  if (kind === 'app') return project.name
  if (kind === 'page')
    return project.pages.find((page) => page.id === id)?.name ?? 'Page'
  return (
    project.components?.find((component) => component.id === id)?.name ??
    'Component'
  )
}

export interface PublishOutcome {
  site: Project | null
  version: number
}

/** Makes the newest version of one page, component or the app settings live. */
export async function publishEntity(
  store: ProjectStore,
  project: Project,
  kind: EntityKind,
  id: string,
  userId: string | null,
): Promise<PublishOutcome> {
  await recordChanges(store, project, userId)
  const all = await store.listEntityVersions(project.id)
  const list = versionsOf(all, kind, id)
  const latest = list[0]
  if (!latest)
    throw new PublishError(
      `${kind === 'page' ? 'Page' : kind === 'component' ? 'Component' : 'App'} not found.`,
      404,
    )

  let pins: Record<string, number> | undefined
  if (kind === 'page') {
    const page = project.pages.find((item) => item.id === id)
    if (!page)
      throw new PublishError(
        'This page was deleted from the draft. Unpublish it instead.',
      )
    pins = {}
    const components = project.components ?? []
    for (const componentId of componentsUsed(page.blocks, components)) {
      const versions = versionsOf(all, 'component', componentId)
      const live = versions.find((item) => item.status === 'published')
      const name = entityName(project, 'component', componentId)
      if (!live)
        throw new PublishError(
          `Publish the component “${name}” first: this page uses it.`,
        )
      if (versions[0].version !== live.version)
        throw new PublishError(
          `The component “${name}” has changes that are not published. Review and publish it first, then this page.`,
        )
      pins[componentId] = live.version
    }
  }
  if (kind === 'app') {
    const anyPage = all.some(
      (item) => item.kind === 'page' && item.status === 'published',
    )
    if (!anyPage)
      throw new PublishError('Publish at least one page first, then the app.')
  }

  const previous = list.filter(
    (item) => item.status === 'published' && item.version !== latest.version,
  )
  const changes: EntityVersion[] = [
    ...previous.map((item) => ({ ...item, status: 'draft' as const })),
    { ...latest, status: 'published', ...(pins ? { pins } : {}) },
  ]
  await store.updateEntityVersions(changes)
  try {
    const site = await refreshSite(store, project.id)
    await prune(
      store,
      versionsOf(await store.listEntityVersions(project.id), kind, id),
    )
    return { site, version: latest.version }
  } catch (error) {
    // The live app would be broken: put the previous live version back.
    await store.updateEntityVersions([
      ...previous,
      {
        ...latest,
        status: latest.status,
        ...(latest.pins ? { pins: latest.pins } : {}),
      },
    ])
    throw error
  }
}

/** Takes one page or component down, or (for the app) the whole live app. */
export async function unpublishEntity(
  store: ProjectStore,
  project: Project,
  kind: EntityKind,
  id: string,
): Promise<Project | null> {
  const all = await store.listEntityVersions(project.id)
  const live = versionsOf(all, kind, id).filter(
    (item) => item.status === 'published',
  )
  if (kind === 'component') {
    // Live pages carry the component's content, so taking it down needs the pages republished without it.
    const pinnedBy = all.filter(
      (item) =>
        item.kind === 'page' && item.status === 'published' && item.pins?.[id],
    )
    if (pinnedBy.length)
      throw new PublishError(
        `Live pages still show this component: ${pinnedBy.map((item) => `“${item.name}”`).join(', ')}. Remove it from them and publish them first.`,
      )
  }
  await store.updateEntityVersions(
    live.map((item) => ({ ...item, status: 'draft' as const })),
  )
  if (kind === 'app') {
    await store.unpublish(project.id)
    return null
  }
  const site = await assembleSite(store, project.id)
  if (site) await store.saveSite(project.id, site)
  else await store.unpublish(project.id)
  return site
}

/** Puts an older version of one page, component or the app settings back into the draft. */
export async function restoreEntity(
  store: ProjectStore,
  project: Project,
  kind: EntityKind,
  id: string,
  version: number,
): Promise<Project> {
  const data = await store.getEntityData(project.id, kind, id, version)
  if (!data)
    throw new PublishError(
      'That version is no longer kept. Only the last two versions are stored.',
      404,
    )
  const next: Project = structuredClone(project)
  if (kind === 'app') {
    const { pageOrder, ...settings } = data as AppSettings
    Object.assign(next, settings)
    // Pages keep their current set; the restored order applies to the ones that still exist.
    next.pages.sort((a, b) => {
      const ia = pageOrder.indexOf(a.id)
      const ib = pageOrder.indexOf(b.id)
      return (
        (ia < 0 ? Number.MAX_SAFE_INTEGER : ia) -
        (ib < 0 ? Number.MAX_SAFE_INTEGER : ib)
      )
    })
  } else if (kind === 'page') {
    const index = next.pages.findIndex((page) => page.id === id)
    if (index >= 0) next.pages[index] = data as Page
    else next.pages.push(data as Page)
  } else {
    next.components ??= []
    const index = next.components.findIndex((component) => component.id === id)
    if (index >= 0) next.components[index] = data as ComponentDef
    else next.components.push(data as ComponentDef)
  }
  return next
}
