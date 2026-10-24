import { afterEach, describe, expect, it, vi } from 'vitest'
import { createProject } from '@spsedu360/engine/model'
import { createFlow } from '@spsedu360/engine/flow'
import { BreakerRegistry } from '@spsedu360/engine/resilience'
import {
  QueueLike,
  RedisLike,
  allow,
  createPlatform,
  cacheSite,
  cachedSite,
  loadBreakers,
  saveBreakers,
  syncSchedules,
} from './upstash'

function fakeRedis(): RedisLike & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>()
  return {
    data,
    async get<T>(key: string) {
      return (data.has(key) ? structuredClone(data.get(key)) : null) as T | null
    },
    async set(key, value) {
      data.set(key, structuredClone(value))
      return 'OK'
    },
    async del(...keys) {
      keys.forEach((key) => data.delete(key))
      return keys.length
    },
    async incr(key) {
      const next = Number(data.get(key) ?? 0) + 1
      data.set(key, next)
      return next
    },
    async expire() {
      return 1
    },
  }
}

describe('shared circuit breakers', () => {
  it('lets one isolate see a circuit another isolate opened', async () => {
    const redis = fakeRedis()
    const policy = { enabled: true, failureThreshold: 1, cooldownMs: 60_000 }
    const first = new BreakerRegistry()
    first.failure('p1:flow:step', policy)
    await saveBreakers(redis, first, 'p1')
    const second = new BreakerRegistry()
    await loadBreakers(redis, second, 'p1')
    expect(second.state('p1:flow:step', policy)).toBe('open')
    // Recovery clears the shared record.
    second.success('p1:flow:step')
    await saveBreakers(redis, second, 'p1')
    expect(redis.data.has('ps:breakers:p1')).toBe(false)
  })
})

describe('rate limiting and caching', () => {
  it('allows up to the limit per window and fails open without Redis', async () => {
    const redis = fakeRedis()
    const results = await Promise.all(
      [1, 2, 3].map(() => allow(redis, 'ip', 2, 60)),
    )
    expect(results.filter(Boolean)).toHaveLength(2)
    expect(await allow(null, 'ip', 0, 60)).toBe(true)
  })

  it('caches published sites and clears them', async () => {
    const redis = fakeRedis()
    const project = createProject('Cached')
    await cacheSite(redis, project.id, project)
    expect((await cachedSite(redis, project.id))?.name).toBe('Cached')
    await cacheSite(redis, project.id, null)
    expect(await cachedSite(redis, project.id)).toBeNull()
  })
})

describe('schedules', () => {
  it('creates schedules for scheduled server flows and removes stale ones', async () => {
    const schedules = new Map<string, { destination: string; cron: string }>([
      ['ps-p1-old', { destination: 'x', cron: '* * * * *' }],
    ])
    const queue: QueueLike = {
      publish: async () => 'msg',
      upsertSchedule: async (id, destination, cron) =>
        void schedules.set(id, { destination, cron }),
      schedules: async (prefix) =>
        [...schedules.keys()].filter((id) => id.startsWith(prefix)),
      deleteSchedule: async (id) => void schedules.delete(id),
      verify: async () => true,
    }
    const project = { ...createProject(), id: 'p1' }
    const nightly = {
      ...createFlow('Nightly'),
      runAt: 'server' as const,
      trigger: 'schedule' as const,
      schedule: '0 2 * * *',
    }
    project.flows.push(nightly, createFlow('Manual'))
    expect(
      await syncSchedules(queue, 'https://site.example', project, 'p1'),
    ).toEqual([`ps-p1-${nightly.id}`])
    expect([...schedules.keys()]).toEqual([`ps-p1-${nightly.id}`])
    expect(schedules.get(`ps-p1-${nightly.id}`)).toEqual({
      destination: 'https://site.example/api/queue/run',
      cron: '0 2 * * *',
    })
    await syncSchedules(queue, 'https://site.example', null, 'p1')
    expect(schedules.size).toBe(0)
  })
})

describe('QStash behind Cloudflare Access', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('sends the Access service token with every delivery and schedule', async () => {
    const sent: Headers[] = []
    vi.stubGlobal(
      'fetch',
      async (input: RequestInfo | URL, init?: RequestInit) => {
        sent.push(
          new Headers(
            init?.headers ??
              (input instanceof Request ? input.headers : undefined),
          ),
        )
        return new Response(
          JSON.stringify({ messageId: 'm1', scheduleId: 's1' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      },
    )
    const { queue } = createPlatform({
      QSTASH_TOKEN: 'qstash-token',
      QSTASH_CURRENT_SIGNING_KEY: 'sig-current',
      QSTASH_NEXT_SIGNING_KEY: 'sig-next',
      CF_ACCESS_CLIENT_ID: 'client-id.access',
      CF_ACCESS_CLIENT_SECRET: 'client-secret',
    })
    await queue!.publish(
      'https://app.example.workers.dev/api/queue/run',
      { a: 1 },
      { retries: 3 },
    )
    await queue!.upsertSchedule(
      'ps-1',
      'https://app.example.workers.dev/api/queue/run',
      '0 7 * * *',
      { a: 1 },
    )
    expect(sent).toHaveLength(2)
    for (const headers of sent) {
      expect(headers.get('Upstash-Forward-CF-Access-Client-Id')).toBe(
        'client-id.access',
      )
      expect(headers.get('Upstash-Forward-CF-Access-Client-Secret')).toBe(
        'client-secret',
      )
    }
  })
})
