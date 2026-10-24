import { describe, expect, it } from 'vitest'
import { createProject } from '@spsedu360/engine/model'
import { createFlow } from '@spsedu360/engine/flow'
import { OpenBaoSecrets, redact } from './secrets'
import { NeonStore, SqlClient } from './storage'

/** Tiny in-memory stand-in for the handful of SQL statements NeonStore issues. */
function fakeSql() {
  const projects = new Map<string, Record<string, unknown>>()
  const sites = new Map<string, Record<string, unknown>>()
  const slugs = new Map<string, string>()
  const flows = new Map<string, Record<string, unknown>>()
  const runs: unknown[][] = []
  const log: string[] = []
  const client: SqlClient = {
    async query(text, params = []) {
      const sql = text.replace(/\s+/g, ' ').trim()
      log.push(sql.split(' ').slice(0, 3).join(' '))
      const [a, b, c, d, e, f] = params as string[]
      if (sql.startsWith('CREATE') || sql.startsWith('ALTER')) return []
      if (sql.startsWith('INSERT INTO ps_slugs')) {
        if (!slugs.has(a)) slugs.set(a, b)
        return []
      }
      if (sql.startsWith('SELECT site_id FROM ps_slugs'))
        return slugs.has(a) ? [{ site_id: slugs.get(a) }] : []
      if (sql.startsWith('SELECT slug FROM ps_slugs'))
        return [...slugs]
          .filter(([, id]) => id === a)
          .map(([slug]) => ({ slug }))
      if (sql.startsWith('DELETE FROM ps_slugs')) {
        for (const [slug, id] of [...slugs])
          if (id === a && slug !== b) slugs.delete(slug)
        return []
      }
      if (sql.startsWith('INSERT INTO ps_slugs')) {
        if (!slugs.has(a)) slugs.set(a, b)
        return []
      }
      if (sql.startsWith('SELECT site_id FROM ps_slugs'))
        return slugs.has(a) ? [{ site_id: slugs.get(a) }] : []
      if (sql.startsWith('SELECT slug FROM ps_slugs'))
        return [...slugs]
          .filter(([, id]) => id === a)
          .map(([slug]) => ({ slug }))
      if (sql.startsWith('DELETE FROM ps_slugs')) {
        for (const [slug, id] of [...slugs])
          if (id === a && slug !== b) slugs.delete(slug)
        return []
      }
      if (sql.startsWith('INSERT INTO ps_projects')) {
        const g = (params as string[])[6]
        projects.set(a, {
          id: a,
          name: b,
          data: JSON.parse(c),
          pages: d,
          flows: e,
          updated_at: f,
          published_at: projects.get(a)?.['published_at'] ?? null,
          owner_id: projects.get(a)?.['owner_id'] ?? g ?? null,
        })
        return []
      }
      if (sql.startsWith('DELETE FROM ps_flows')) {
        for (const key of [...flows.keys()])
          if (key.startsWith(`${a}:`)) flows.delete(key)
        return []
      }
      if (sql.startsWith('INSERT INTO ps_flows')) {
        flows.set(`${a}:${b}`, {
          name: c,
          run_at: d,
          trigger: e,
          definition: JSON.parse(f),
        })
        return []
      }
      if (sql.startsWith('SELECT published_at'))
        return projects.has(a)
          ? [{ published_at: projects.get(a)!['published_at'] }]
          : []
      if (sql.startsWith('SELECT data FROM ps_projects'))
        return projects.has(a) ? [{ data: projects.get(a)!['data'] }] : []
      if (sql.startsWith('SELECT id, name')) return [...projects.values()]
      if (sql.startsWith('INSERT INTO ps_sites')) {
        sites.set(a, { data: JSON.parse(b), published_at: c })
        return []
      }
      if (sql.startsWith('UPDATE ps_projects SET published_at = $2')) {
        projects.get(a)!['published_at'] = b
        return []
      }
      if (sql.startsWith('UPDATE ps_projects SET published_at = NULL')) {
        projects.get(a)!['published_at'] = null
        return []
      }
      if (sql.startsWith('DELETE FROM ps_sites')) {
        sites.delete(a)
        return []
      }
      if (sql.startsWith('SELECT data FROM ps_sites'))
        return sites.has(a) ? [{ data: sites.get(a)!['data'] }] : []
      if (sql.startsWith('DELETE FROM ps_projects')) {
        projects.delete(a)
        sites.delete(a)
        return []
      }
      if (sql.startsWith('INSERT INTO ps_flow_runs')) {
        runs.push(params)
        return []
      }
      throw new Error(`Unexpected SQL: ${sql}`)
    },
    async transaction(queries) {
      return Promise.all(queries)
    },
  }
  return { client, projects, sites, flows, runs, log, slugs }
}

describe('NeonStore', () => {
  it('gives each web address to one site only, and moves a site to a new address', async () => {
    const store = new NeonStore(fakeSql().client)
    const a = createProject('A')
    const b = createProject('B')
    await store.saveDraft(a)
    await store.saveDraft(b)
    expect(await store.claimSlug(a.id, 'greenfield')).toBe(true)
    expect(await store.claimSlug(a.id, 'greenfield')).toBe(true)
    expect(await store.claimSlug(b.id, 'greenfield')).toBe(false)
    expect(await store.slugOwner('greenfield')).toBe(a.id)
    // Moving A frees its old address for B.
    expect(await store.claimSlug(a.id, 'greenfield-school')).toBe(true)
    expect(await store.slugOwner('greenfield')).toBeNull()
    expect(await store.claimSlug(b.id, 'greenfield')).toBe(true)
    expect(await store.slugOf(a.id)).toBe('greenfield-school')
  })

  it('creates tables once, saves drafts with their flows, publishes and logs runs', async () => {
    const db = fakeSql()
    const store = new NeonStore(db.client)
    const project = createProject('Neon site')
    const flow = createFlow('Prices')
    project.flows.push(flow)

    const saved = await store.saveDraft(project)
    expect(saved).toMatchObject({
      id: project.id,
      name: 'Neon site',
      publishedAt: null,
      flows: 1,
    })
    expect(db.flows.get(`${project.id}:${flow.id}`)).toMatchObject({
      name: 'Prices',
      run_at: 'client',
    })
    expect(await store.getDraft(project.id)).toEqual(project)

    const published = await store.publish(project.id)
    expect(published.publishedAt).toBeTruthy()
    expect((await store.getSite(project.id))?.name).toBe('Neon site')
    // Re-saving keeps the published date.
    expect((await store.saveDraft(project)).publishedAt).toBe(
      published.publishedAt,
    )

    await store.logRun({
      projectId: project.id,
      flowId: flow.id,
      source: 'site',
      status: 'success',
      durationMs: 12.6,
      error: null,
    })
    expect(db.runs).toHaveLength(1)
    // projects, sites, flows, flow runs, assets, users, site members, slugs, versions, credentials
    expect(
      db.log.filter((entry) => entry.startsWith('CREATE TABLE')),
    ).toHaveLength(10)

    await store.unpublish(project.id)
    expect(await store.getSite(project.id)).toBeNull()
    await store.remove(project.id)
    expect(await store.getDraft(project.id)).toBeNull()
  })
})

describe('OpenBaoSecrets', () => {
  function fakeBao() {
    const data = new Map<string, string>()
    const calls: string[] = []
    const http = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      const headers = init?.headers as Record<string, string>
      calls.push(`${init?.method ?? 'GET'} ${url.pathname}`)
      if (headers['X-Vault-Token'] !== 'bao-token')
        return new Response('{}', { status: 403 })
      const match =
        /^\/v1\/secret\/(data|metadata)\/page-studio\/([^/]+)\/?([^/]*)$/.exec(
          url.pathname,
        )
      if (!match) return new Response('{}', { status: 404 })
      const [, kind, project, name] = match
      const key = `${project}/${name}`
      if (kind === 'metadata' && url.searchParams.get('list') === 'true') {
        const keys = [...data.keys()]
          .filter((k) => k.startsWith(`${project}/`))
          .map((k) => k.split('/')[1])
        return keys.length
          ? Response.json({ data: { keys } })
          : new Response('{}', { status: 404 })
      }
      if (kind === 'data' && init?.method === 'POST') {
        data.set(key, JSON.parse(String(init.body)).data.value)
        return Response.json({ data: { version: 1 } })
      }
      if (kind === 'data')
        return data.has(key)
          ? Response.json({ data: { data: { value: data.get(key) } } })
          : new Response('{}', { status: 404 })
      if (kind === 'metadata' && init?.method === 'DELETE') {
        data.delete(key)
        return new Response(null, { status: 204 })
      }
      return new Response('{}', { status: 404 })
    }) as typeof fetch
    return { http, data, calls }
  }

  it('writes, lists names, reads values with caching and deletes', async () => {
    const bao = fakeBao()
    const secrets = new OpenBaoSecrets({
      addr: 'https://bao.example.com/',
      token: 'bao-token',
      fetch: bao.http,
    })
    expect(await secrets.names('p1')).toEqual([])
    await secrets.put('p1', 'API_KEY', 'sk-12345')
    await secrets.put('p1', 'OTHER', 'value-2')
    expect(await secrets.names('p1')).toEqual(['API_KEY', 'OTHER'])
    expect(await secrets.values('p1')).toEqual({
      API_KEY: 'sk-12345',
      OTHER: 'value-2',
    })
    const before = bao.calls.length
    await secrets.values('p1')
    expect(bao.calls.length).toBe(before)
    await secrets.remove('p1', 'OTHER')
    expect(await secrets.values('p1')).toEqual({ API_KEY: 'sk-12345' })
  })

  it('explains a rejected token', async () => {
    const bao = fakeBao()
    const secrets = new OpenBaoSecrets({
      addr: 'https://bao.example.com',
      token: 'wrong',
      fetch: bao.http,
    })
    await expect(secrets.names('p1')).rejects.toThrow(/refused the token/)
  })
})

describe('redact', () => {
  it('masks secret values anywhere in a result', () => {
    expect(
      redact(
        { a: 'Bearer sk-12345', b: ['sk-12345'], c: 1 },
        { KEY: 'sk-12345' },
      ),
    ).toEqual({ a: 'Bearer ••••••', b: ['••••••'], c: 1 })
  })
})
