import { beforeEach, describe, expect, it } from 'vitest'
import { createBlock, createProject } from '@spsedu360/engine/model'
import { createFlow, createStep } from '@spsedu360/engine/flow'
import worker, { Env, KVLike, canEdit } from './index'

class MemoryKV implements KVLike {
  readonly data = new Map<string, { value: string; metadata?: unknown }>()
  async get(key: string) {
    return this.data.get(key)?.value ?? null
  }
  async getWithMetadata(key: string) {
    const entry = this.data.get(key)
    return { value: entry?.value ?? null, metadata: entry?.metadata ?? null }
  }
  async put(key: string, value: string, options?: { metadata?: unknown }) {
    this.data.set(key, { value, metadata: options?.metadata })
  }
  async delete(key: string) {
    this.data.delete(key)
  }
  async list({ prefix }: { prefix: string }) {
    const keys = [...this.data]
      .filter(([name]) => name.startsWith(prefix))
      .map(([name, entry]) => ({ name, metadata: entry.metadata }))
    return { keys, list_complete: true }
  }
}

/** Publishes each page, then the app settings: the order an author follows. */
async function publishAll(project: { id: string; pages: { id: string }[] }) {
  for (const page of project.pages)
    await call(`/api/projects/${project.id}/publish`, {
      method: 'POST',
      admin: true,
      body: JSON.stringify({ kind: 'page', id: page.id }),
    })
  return call(`/api/projects/${project.id}/publish`, {
    method: 'POST',
    admin: true,
    body: JSON.stringify({ kind: 'app' }),
  })
}

let env: Env
const call = (path: string, init: RequestInit & { admin?: boolean } = {}) =>
  worker.fetch(
    new Request(`https://site.test${path}`, {
      ...init,
      headers: {
        ...(init.admin ? { Authorization: 'Bearer secret-token' } : {}),
        ...(init.headers as object),
      },
    }),
    env,
  )

beforeEach(() => {
  env = {
    ASSETS: { fetch: async () => new Response('asset') },
    PROJECTS: new MemoryKV(),
    ADMIN_TOKEN: 'secret-token',
  }
})

describe('worker API', () => {
  it('serves static assets outside /api', async () => {
    expect(await (await call('/builder/x')).text()).toBe('asset')
  })

  it('protects the admin API', async () => {
    expect((await call('/api/projects')).status).toBe(401)
    expect(
      (
        await call('/api/projects', {
          headers: { Authorization: 'Bearer wrong' },
        })
      ).status,
    ).toBe(401)
    expect((await call('/api/projects', { admin: true })).status).toBe(200)
    env.ADMIN_TOKEN = undefined
    expect((await call('/api/projects', { admin: true })).status).toBe(503)
  })

  it('saves, lists, publishes and serves projects', async () => {
    const project = createProject('School site')
    const saved = await call(`/api/projects/${project.id}`, {
      method: 'PUT',
      admin: true,
      body: JSON.stringify(project),
    })
    expect(saved.status).toBe(200)
    const list = await (await call('/api/projects', { admin: true })).json()
    expect(list).toMatchObject([
      { id: project.id, name: 'School site', publishedAt: null },
    ])
    expect((await call(`/api/sites/${project.id}`)).status).toBe(404)
    const published = await (await publishAll(project)).json()
    expect(published.publishedAt).toBeTruthy()
    const site = await (await call(`/api/sites/${project.id}`)).json()
    expect(site.name).toBe('School site')
    // Saving again keeps the published date.
    await call(`/api/projects/${project.id}`, {
      method: 'PUT',
      admin: true,
      body: JSON.stringify(project),
    })
    const after = await (await call('/api/projects', { admin: true })).json()
    expect(after[0].publishedAt).toBe(published.publishedAt)
  })

  it('rejects invalid projects with a reason', async () => {
    const project = createProject()
    project.pages[0].path = 'Bad Path!'
    const response = await call(`/api/projects/${project.id}`, {
      method: 'PUT',
      admin: true,
      body: JSON.stringify(project),
    })
    expect(response.status).toBe(422)
    expect((await response.json()).error).toMatch(/not valid/)
  })

  it('runs published server flows without exposing step outputs', async () => {
    const project = createProject()
    const flow = createFlow('Price')
    flow.runAt = 'server'
    const step = createStep('compute', 'total')
    step.logic = { '*': [{ var: 'input.qty' }, 25] }
    flow.steps.push(step)
    project.flows.push(flow)
    await call(`/api/projects/${project.id}`, {
      method: 'PUT',
      admin: true,
      body: JSON.stringify(project),
    })
    await publishAll(project)
    const result = await (
      await call(`/api/sites/${project.id}/flows/${flow.id}/run`, {
        method: 'POST',
        body: JSON.stringify({ input: { qty: 4 } }),
      })
    ).json()
    expect(result.status).toBe('success')
    expect(result.output).toBe(100)
    expect(result.steps.total.output).toBeUndefined()
  })

  it('refuses to run browser flows on the server', async () => {
    const project = createProject()
    const flow = createFlow('Client')
    project.flows.push(flow)
    const response = await call(
      `/api/projects/${project.id}/flows/${flow.id}/test`,
      { method: 'POST', admin: true, body: JSON.stringify({ project }) },
    )
    expect(response.status).toBe(400)
  })
})

describe('credentials API', () => {
  it('is read-only without OpenBao and never returns values', async () => {
    env['APP_SECRET_WEATHER_KEY'] = 'abcd1234'
    const project = createProject()
    const list = await (
      await call(`/api/projects/${project.id}/secrets`, { admin: true })
    ).json()
    expect(list).toEqual({
      provider: 'env',
      writable: false,
      names: ['WEATHER_KEY'],
    })
    const put = await call(`/api/projects/${project.id}/secrets/NEW_KEY`, {
      method: 'PUT',
      admin: true,
      body: JSON.stringify({ value: 'x' }),
    })
    expect(put.status).toBe(503)
  })

  it('injects secrets into server flows and redacts them from results', async () => {
    env['APP_SECRET_TOKEN'] = 'super-secret-value'
    const project = createProject()
    const flow = createFlow('Echo')
    flow.runAt = 'server'
    const step = createStep('compute', 'echo')
    step.logic = { cat: ['token=', { var: 'secrets.TOKEN' }] }
    flow.steps.push(step)
    project.flows.push(flow)
    const result = await (
      await call(`/api/projects/${project.id}/flows/${flow.id}/test`, {
        method: 'POST',
        admin: true,
        body: JSON.stringify({ project }),
      })
    ).json()
    expect(result.status).toBe('success')
    expect(result.output).toBe('token=••••••')
  })

  it('reports which storage and secrets providers are active', async () => {
    const health = await (await call('/api/health')).json()
    expect(health).toMatchObject({
      ok: true,
      database: 'kv',
      secrets: 'env',
      adminConfigured: true,
    })
  })

  it('with CREDENTIALS_KEY, saves credentials encrypted in the app database and uses them in flows', async () => {
    env.CREDENTIALS_KEY = 'k'.repeat(40)
    const project = createProject('Encrypted')
    await call(`/api/projects/${project.id}`, {
      method: 'PUT',
      admin: true,
      body: JSON.stringify(project),
    })
    const put = await call(`/api/projects/${project.id}/secrets/SCHOOL_TOKEN`, {
      method: 'PUT',
      admin: true,
      body: JSON.stringify({ value: 'tok-123456' }),
    })
    expect(put.status).toBe(200)
    expect(
      await (
        await call(`/api/projects/${project.id}/secrets`, { admin: true })
      ).json(),
    ).toEqual({ provider: 'database', writable: true, names: ['SCHOOL_TOKEN'] })
    // Only ciphertext reaches storage.
    const stored = (env.PROJECTS as MemoryKV).data.get(
      `secrets:${project.id}`,
    )!.value
    expect(stored).not.toContain('tok-123456')
    expect(JSON.parse(stored).SCHOOL_TOKEN).toMatch(/^v1:/)

    const flow = createFlow('Echo')
    flow.runAt = 'server'
    const step = createStep('compute', 'echo')
    step.logic = {
      cat: [
        'token=',
        { var: 'secrets.SCHOOL_TOKEN' },
        ' length=',
        { var: 'secrets.SCHOOL_TOKEN.length' },
      ],
    }
    flow.steps.push(step)
    project.flows.push(flow)
    const result = await (
      await call(`/api/projects/${project.id}/flows/${flow.id}/test`, {
        method: 'POST',
        admin: true,
        body: JSON.stringify({ project }),
      })
    ).json()
    expect(result.output).toBe('token=•••••• length=10')

    // A different key cannot read the stored values.
    env.CREDENTIALS_KEY = 'z'.repeat(40)
    const other = await (
      await call(`/api/projects/${project.id}/flows/${flow.id}/test`, {
        method: 'POST',
        admin: true,
        body: JSON.stringify({ project }),
      })
    ).json()
    expect(other.output).toBe('token=null length=null')

    expect(
      (
        await call(`/api/projects/${project.id}/secrets/SCHOOL_TOKEN`, {
          method: 'DELETE',
          admin: true,
        })
      ).status,
    ).toBe(200)
    expect(
      (
        await (
          await call(`/api/projects/${project.id}/secrets`, { admin: true })
        ).json()
      ).names,
    ).toEqual([])
  })
})

describe('web addresses come from app names', () => {
  const save = (project: ReturnType<typeof createProject>) =>
    call(`/api/projects/${project.id}`, {
      method: 'PUT',
      admin: true,
      body: JSON.stringify(project),
    })
  const publish = (id: string) => publishAll(projects.get(id)!)
  const projects = new Map<string, ReturnType<typeof createProject>>()

  it('gives each app name to one app only', async () => {
    const a = createProject('Greenfield School')
    expect((await (await save(a)).json()).slug).toBe('greenfield-school')
    // Same name, or one that gives the same address, is refused and nothing is created.
    const b = createProject('greenfield  school!')
    const clash = await save(b)
    expect(clash.status).toBe(409)
    expect((await clash.json()).error).toMatch(/already called/)
    expect((await call(`/api/projects/${b.id}`, { admin: true })).status).toBe(
      404,
    )
    // Renaming moves the address and frees the old one.
    expect(
      (await (await save({ ...a, name: 'Greenfield Academy' })).json()).slug,
    ).toBe('greenfield-academy')
    expect((await save(b)).status).toBe(200)
    const renameClash = await save({ ...a, name: 'Greenfield School' })
    expect(renameClash.status).toBe(409)
  })

  it('publishes at the name address and serves each app separately', async () => {
    const a = createProject('Alpha')
    const b = createProject('Beta')
    projects.set(a.id, a).set(b.id, b)
    await save(a)
    await save(b)
    expect(await (await publish(a.id)).json()).toMatchObject({
      slug: 'alpha',
      url: 'https://site.test/alpha',
    })
    await publish(b.id)
    expect((await (await call('/api/s/alpha')).json()).name).toBe('Alpha')
    expect((await (await call('/api/s/beta')).json()).name).toBe('Beta')
    expect((await call('/api/s/gamma')).status).toBe(404)
    expect(await (await call('/api/s/alpha/me')).json()).toMatchObject({
      signedIn: false,
    })
  })

  it('keeps app names clear of the platform’s own addresses', async () => {
    const api = createProject('API')
    expect((await (await save(api)).json()).slug).toBe('api-app')
  })

  it('reports whether an app name is free', async () => {
    const a = createProject('Alpha')
    await save(a)
    expect(
      await (await call('/api/names?name=alpha', { admin: true })).json(),
    ).toMatchObject({ slug: 'alpha', available: false })
    expect(
      await (
        await call(`/api/names?name=Alpha&project=${a.id}`, { admin: true })
      ).json(),
    ).toMatchObject({ available: true, mine: true })
    expect(
      await (await call('/api/names?name=Free%20One', { admin: true })).json(),
    ).toMatchObject({ slug: 'free-one', available: true })
    expect((await call('/api/names?name=alpha')).status).toBe(401)
  })
})

describe('versions and members', () => {
  it('invites people by email with one of the app’s own roles', async () => {
    const project = createProject('Members')
    project.auth = {
      enabled: true,
      allowSignUp: false,
      defaultRole: 'parent',
      roles: [
        { id: 'parent', name: 'Parent', description: '' },
        { id: 'teacher', name: 'Teacher', description: '' },
      ],
    }
    await call(`/api/projects/${project.id}`, {
      method: 'PUT',
      admin: true,
      body: JSON.stringify(project),
    })
    const add = (body: object) =>
      call(`/api/projects/${project.id}/members`, {
        method: 'POST',
        admin: true,
        body: JSON.stringify(body),
      })
    expect((await add({ email: 'not-an-email', role: 'teacher' })).status).toBe(
      400,
    )
    expect(
      (await add({ email: 'a@school.edu', role: 'principal' })).status,
    ).toBe(400)
    expect((await add({ email: 'A@School.edu', role: 'teacher' })).status).toBe(
      201,
    )
    const members = await (
      await call(`/api/projects/${project.id}/members`, { admin: true })
    ).json()
    expect(members).toMatchObject([
      { userId: 'invite:a@school.edu', email: 'a@school.edu', role: 'teacher' },
    ])
    const id = encodeURIComponent('invite:a@school.edu')
    expect(
      (
        await call(`/api/projects/${project.id}/members/${id}`, {
          method: 'PUT',
          admin: true,
          body: JSON.stringify({ role: 'parent' }),
        })
      ).status,
    ).toBe(200)
    expect(
      (
        await (
          await call(`/api/projects/${project.id}/members`, { admin: true })
        ).json()
      )[0].role,
    ).toBe('parent')
  })
})

describe('who may edit which app', () => {
  const author = (id: string) => ({
    id,
    email: `${id}@school.edu`,
    role: 'author' as const,
    via: 'access' as const,
  })
  const admin = {
    id: 'boss',
    email: 'boss@school.edu',
    role: 'admin' as const,
    via: 'access' as const,
  }
  const storeWith = (projects: { id: string; owner: string | null }[]) =>
    ({
      getDraft: async (id: string) =>
        projects.some((item) => item.id === id) ? createProject() : null,
      owner: async (id: string) =>
        projects.find((item) => item.id === id)?.owner ?? null,
      list: async (ownerId?: string) =>
        projects.filter((item) => !ownerId || item.owner === ownerId),
    }) as unknown as Parameters<typeof canEdit>[0]

  it('lets authors edit only their own app, and admins edit every app', async () => {
    const store = storeWith([
      { id: 'mine', owner: 'ann' },
      { id: 'theirs', owner: 'bob' },
      { id: 'old', owner: null },
    ])
    await expect(canEdit(store, author('ann'), 'mine', 'PUT')).resolves.toBe(
      false,
    )
    await expect(
      canEdit(store, author('ann'), 'theirs', 'GET'),
    ).rejects.toThrow(/someone else/)
    await expect(canEdit(store, author('ann'), 'old', 'PUT')).rejects.toThrow(
      /someone else/,
    )
    for (const id of ['mine', 'theirs', 'old'])
      await expect(canEdit(store, admin, id, 'PUT')).resolves.toBe(false)
  })

  it('lets an author create one app, and admins any number', async () => {
    await expect(
      canEdit(storeWith([]), author('ann'), 'new', 'PUT'),
    ).resolves.toBe(true)
    const owning = storeWith([{ id: 'mine', owner: 'ann' }])
    await expect(
      canEdit(owning, author('ann'), 'second', 'PUT'),
    ).rejects.toThrow(/one app/)
    await expect(canEdit(owning, author('cat'), 'first', 'PUT')).resolves.toBe(
      true,
    )
    await expect(canEdit(owning, admin, 'another', 'PUT')).resolves.toBe(true)
    await expect(
      canEdit(owning, author('ann'), 'missing', 'GET'),
    ).rejects.toThrow(/not found/)
  })
})

describe('publishing pages, components and the app separately', () => {
  type Status = {
    kind: string
    id: string
    name: string
    state: string
    versions: { version: number; status: string }[]
    reasons: string[]
    usedBy: string[]
  }
  const save = (project: ReturnType<typeof createProject>) =>
    call(`/api/projects/${project.id}`, {
      method: 'PUT',
      admin: true,
      body: JSON.stringify(project),
    })
  const act = (
    project: { id: string },
    action: 'publish' | 'unpublish' | 'restore',
    body: object,
  ) =>
    call(`/api/projects/${project.id}/${action}`, {
      method: 'POST',
      admin: true,
      body: JSON.stringify(body),
    })
  const status = async (
    project: { id: string },
    kind: string,
    id: string,
  ): Promise<Status> =>
    (
      (
        await (
          await call(`/api/projects/${project.id}/publishing`, { admin: true })
        ).json()
      ).statuses as Status[]
    ).find((item) => item.kind === kind && item.id === id)!
  const live = async (project: { id: string }) =>
    (await call(`/api/sites/${project.id}`)).json()

  /** An app with a home page and an about page; the home page shows a "Notice" component. */
  function schoolApp() {
    const project = createProject('Riverside School')
    const heading = { ...createBlock('heading'), text: 'Term starts Monday' }
    project.components = [{ id: 'notice', name: 'Notice', blocks: [heading] }]
    project.pages[0].blocks = [
      { ...createBlock('component'), componentId: 'notice' },
    ]
    project.pages.push({
      id: 'about',
      name: 'About',
      path: 'about',
      blocks: [{ ...createBlock('text'), text: 'Founded 1950' }],
    })
    return project
  }

  it('publishes page by page, then the app; unpublished pages are not served', async () => {
    const project = schoolApp()
    await save(project)
    expect((await act(project, 'publish', { kind: 'app' })).status).toBe(409)
    expect(
      (await act(project, 'publish', { kind: 'page', id: 'about' })).status,
    ).toBe(200)
    expect((await act(project, 'publish', { kind: 'app' })).status).toBe(200)
    const site = await live(project)
    expect(site.pages.map((page: { id: string }) => page.id)).toEqual(['about'])
    expect((await status(project, 'page', project.pages[0].id)).state).toBe(
      'draft',
    )
    expect((await status(project, 'page', 'about')).state).toBe('live')
  })

  it('needs a component published before the pages that use it, and fills it into the live page', async () => {
    const project = schoolApp()
    const home = project.pages[0].id
    await save(project)
    const early = await act(project, 'publish', { kind: 'page', id: home })
    expect(early.status).toBe(409)
    expect((await early.json()).error).toMatch(
      /Publish the component “Notice” first/,
    )
    await act(project, 'publish', { kind: 'component', id: 'notice' })
    await act(project, 'publish', { kind: 'page', id: home })
    await act(project, 'publish', { kind: 'app' })
    const site = await live(project)
    const instance = site.pages[0].blocks[0]
    expect(instance.type).toBe('component')
    expect(instance.children[0].text).toBe('Term starts Monday')
    expect(instance.children[0].id).toBe(
      `${instance.id}_${project.components![0].blocks[0].id}`,
    )
    expect((await status(project, 'component', 'notice')).usedBy).toEqual([
      'Home',
    ])
  })

  it('moves pages using a changed component to review, and keeps the live page until they are republished', async () => {
    const project = schoolApp()
    const home = project.pages[0].id
    await save(project)
    await act(project, 'publish', { kind: 'component', id: 'notice' })
    await act(project, 'publish', { kind: 'page', id: home })
    await act(project, 'publish', { kind: 'app' })

    project.components![0].blocks[0].text = 'Term starts Tuesday'
    await save(project)
    expect((await status(project, 'component', 'notice')).state).toBe('changed')
    const page = await status(project, 'page', home)
    expect(page.state).toBe('review')
    expect(page.reasons[0]).toMatch(/“Notice” changed/)
    // Live content is unchanged until things are published again.
    expect((await live(project)).pages[0].blocks[0].children[0].text).toBe(
      'Term starts Monday',
    )
    // The page cannot be republished before the component is.
    expect(
      (await act(project, 'publish', { kind: 'page', id: home })).status,
    ).toBe(409)
    await act(project, 'publish', { kind: 'component', id: 'notice' })
    // Publishing the component alone does not change live pages.
    expect((await live(project)).pages[0].blocks[0].children[0].text).toBe(
      'Term starts Monday',
    )
    await act(project, 'publish', { kind: 'page', id: home })
    expect((await live(project)).pages[0].blocks[0].children[0].text).toBe(
      'Term starts Tuesday',
    )
    expect((await status(project, 'page', home)).state).toBe('live')
  })

  it('keeps one live version and only the last two versions of each part', async () => {
    const project = schoolApp()
    await save(project)
    await act(project, 'publish', { kind: 'page', id: 'about' })
    for (const text of ['Founded 1951', 'Founded 1952', 'Founded 1953']) {
      project.pages[1].blocks[0].text = text
      await save(project)
    }
    const about = await status(project, 'page', 'about')
    expect(about.state).toBe('changed')
    // Versions 3 and 4 are the newest; version 1 stays because it is live.
    expect(about.versions.map((item) => [item.version, item.status])).toEqual([
      [4, 'draft'],
      [3, 'draft'],
      [1, 'published'],
    ])
    await act(project, 'publish', { kind: 'page', id: 'about' })
    const after = await status(project, 'page', 'about')
    expect(
      after.versions
        .filter((item) => item.status === 'published')
        .map((item) => item.version),
    ).toEqual([4])
    expect(after.versions).toHaveLength(2)
  })

  it('restores an older version into the draft', async () => {
    const project = schoolApp()
    await save(project)
    project.pages[1].blocks[0].text = 'Founded 1999'
    await save(project)
    const restored = await (
      await act(project, 'restore', { kind: 'page', id: 'about', version: 1 })
    ).json()
    expect(restored.pages[1].blocks[0].text).toBe('Founded 1950')
    expect(
      (
        await (
          await call(`/api/projects/${project.id}`, { admin: true })
        ).json()
      ).pages[1].blocks[0].text,
    ).toBe('Founded 1950')
  })

  it('refuses duplicate page or component names in one app', async () => {
    const project = schoolApp()
    project.pages[1].name = 'home'
    const response = await save(project)
    expect(response.status).toBe(422)
    expect((await response.json()).error).toMatch(/Two pages are called/)
    const second = schoolApp()
    second.name = 'Another School'
    second.components!.push({ id: 'notice-2', name: 'NOTICE', blocks: [] })
    expect((await save(second)).status).toBe(422)
  })

  it('will not take down a component that live pages still show', async () => {
    const project = schoolApp()
    await save(project)
    await act(project, 'publish', { kind: 'component', id: 'notice' })
    await act(project, 'publish', { kind: 'page', id: project.pages[0].id })
    const response = await act(project, 'unpublish', {
      kind: 'component',
      id: 'notice',
    })
    expect(response.status).toBe(409)
    expect((await response.json()).error).toMatch(
      /Live pages still show this component: “Home”/,
    )
  })
})
