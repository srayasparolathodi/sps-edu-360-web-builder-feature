import { describe, expect, it } from 'vitest'
import { createProject } from '@spsedu360/engine/model'
import { createFlow, createStep } from '@spsedu360/engine/flow'
import { ANONYMOUS } from '@spsedu360/engine/access'
import { runServerFlow, systemUser } from './compute'
import { visitorFor } from './site-auth'
import { RedisLike, forgetRole } from './upstash'
import type { ProjectStore, MemberRecord } from './storage'
import type { SecretStore } from './secrets'

const secrets = {
  kind: 'env',
  writable: false,
  names: async () => [],
  put: async () => {},
  remove: async () => {},
  values: async () => ({}),
} as unknown as SecretStore
const store = { logRun: async () => {} } as unknown as ProjectStore

function fakeRedis(): RedisLike & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>()
  return {
    data,
    async get<T>(key: string) {
      return (data.has(key) ? data.get(key) : null) as T | null
    },
    async set(key: string, value: unknown) {
      data.set(key, value)
      return 'OK'
    },
    async del(...keys: string[]) {
      keys.forEach((key) => data.delete(key))
      return keys.length
    },
    async incr() {
      return 1
    },
    async expire() {
      return 1
    },
  }
}

function serverApp(access?: { mode: 'roles'; roles: string[] }) {
  const project = createProject('Data app')
  project.auth = {
    enabled: true,
    allowSignUp: true,
    defaultRole: 'parent',
    roles: [
      { id: 'parent', name: 'Parent', description: '' },
      { id: 'admin', name: 'Admin', description: '' },
    ],
  }
  const flow = createFlow('Report')
  flow.runAt = 'server'
  if (access) flow.access = access
  const step = createStep('compute', 'out')
  step.logic = {
    cat: [
      { var: 'vars.term' },
      '|',
      { var: 'session.studentId' },
      '|',
      { var: 'local.theme' },
      '|',
      { var: 'user.id' },
    ],
  }
  flow.steps.push(step)
  project.flows.push(flow)
  return { project, flow }
}

describe('server journeys and browser data', () => {
  it("use the visitor's variables, session and device values sent by the page", async () => {
    const { project, flow } = serverApp()
    const result = await runServerFlow({
      project,
      flowId: flow.id,
      request: {
        input: {},
        state: {
          vars: { term: 'T2' },
          session: { studentId: 42 },
          local: { theme: 'dark' },
        },
      },
      origin: 'https://app.test',
      secrets,
      store,
      source: 'site',
      user: {
        signedIn: true,
        id: 'u1',
        email: 'a@b.c',
        name: 'A',
        roles: ['parent'],
      },
    })
    expect(result.output).toBe('T2|42|dark|u1')
  })
})

describe('who a run is checked against', () => {
  const base = { origin: 'https://app.test', secrets, store, request: {} }

  it('checks live calls on every run', async () => {
    const { project, flow } = serverApp({ mode: 'roles', roles: ['admin'] })
    await expect(
      runServerFlow({
        ...base,
        project,
        flowId: flow.id,
        source: 'site',
        user: ANONYMOUS,
      }),
    ).rejects.toThrow(/sign in/)
    await expect(
      runServerFlow({
        ...base,
        project,
        flowId: flow.id,
        source: 'site',
        user: {
          signedIn: true,
          id: 'p',
          email: null,
          name: null,
          roles: ['parent'],
        },
      }),
    ).rejects.toThrow(/do not have access/)
  })

  it('runs scheduled jobs as the system, without a user check', async () => {
    const { project, flow } = serverApp({ mode: 'roles', roles: ['admin'] })
    const result = await runServerFlow({
      ...base,
      project,
      flowId: flow.id,
      source: 'schedule',
      user: systemUser(project),
      system: true,
    })
    expect(result.status).toBe('success')
    expect(String(result.output).endsWith('|system')).toBe(true)
    expect(systemUser(project).roles).toEqual(['parent', 'admin'])
  })

  it('runs background jobs as the person who triggered them, without checking again', async () => {
    const { project, flow } = serverApp({ mode: 'roles', roles: ['admin'] })
    // Their role changed after queuing; the job still completes as queued.
    const result = await runServerFlow({
      ...base,
      project,
      flowId: flow.id,
      source: 'queue',
      user: { signedIn: true, id: 'u9', email: null, name: null, roles: [] },
      system: true,
    })
    expect(String(result.output).endsWith('|u9')).toBe(true)
  })
})

describe('roles of signed-in app users', () => {
  const settings = {
    enabled: true,
    allowSignUp: false,
    defaultRole: 'parent',
    roles: [
      { id: 'parent', name: 'Parent', description: '' },
      { id: 'teacher', name: 'Teacher', description: '' },
    ],
  }
  const handle = {
    auth: {
      api: {
        getSession: async () => ({
          user: { id: 'u1', email: 'asha@school.edu', name: 'Asha' },
        }),
      },
    },
  } as never
  const request = new Request('https://app.test/api/sites/s1/me')

  function memberStore(role: string | null) {
    let reads = 0
    const store = {
      getMember: async (
        _site: string,
        userId: string,
      ): Promise<MemberRecord | null> => {
        reads++
        return role && userId === 'u1'
          ? {
              siteId: 's1',
              userId: 'u1',
              email: 'asha@school.edu',
              role,
              createdAt: '',
            }
          : null
      },
      upsertMember: async () => {},
      removeMember: async () => {},
    } as unknown as ProjectStore
    return { store, reads: () => reads }
  }

  it("keeps each user's role in Redis under the app and user, and reads the database only on a miss", async () => {
    const redis = fakeRedis()
    const { store, reads } = memberStore('teacher')
    expect(
      (await visitorFor(request, handle, 's1', settings, store, redis)).roles,
    ).toEqual(['teacher'])
    expect(redis.data.get('ps:role:s1:u1')).toBe('teacher')
    expect(
      (await visitorFor(request, handle, 's1', settings, store, redis)).roles,
    ).toEqual(['teacher'])
    // One database read on the first request; the second is answered from Redis.
    expect(reads()).toBe(1)
  })

  it('reads the database again after a role change clears the entry', async () => {
    const redis = fakeRedis()
    await visitorFor(
      request,
      handle,
      's1',
      settings,
      memberStore('teacher').store,
      redis,
    )
    await forgetRole(redis, 's1', 'u1')
    expect(
      (
        await visitorFor(
          request,
          handle,
          's1',
          settings,
          memberStore('parent').store,
          redis,
        )
      ).roles,
    ).toEqual(['parent'])
  })

  it('ignores a role the app no longer defines', async () => {
    const redis = fakeRedis()
    redis.data.set('ps:role:s1:u1', 'principal')
    expect(
      (
        await visitorFor(
          request,
          handle,
          's1',
          settings,
          memberStore(null).store,
          redis,
        )
      ).roles,
    ).toEqual([])
  })
})
