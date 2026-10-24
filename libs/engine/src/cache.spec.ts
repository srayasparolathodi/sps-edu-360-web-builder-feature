import { describe, expect, it } from 'vitest'
import {
  FlowHooks,
  HttpResponse,
  createFlow,
  createStep,
  runFlow,
  validateFlow,
} from './flow'

/** A browser-like cache: one map per scope, entries expire like the runtime's. */
function cacheHooks(now: () => number) {
  const stores: Record<
    string,
    Map<string, { value: unknown; expires: number }>
  > = { vars: new Map(), session: new Map(), local: new Map() }
  const hooks: Pick<FlowHooks, 'cacheGet' | 'cacheSet'> = {
    cacheGet: (scope, key) => {
      const entry = stores[scope].get(key)
      return entry && entry.expires > now()
        ? { found: true, value: entry.value }
        : { found: false }
    },
    cacheSet: (scope, key, value, ttl) =>
      void stores[scope].set(key, { value, expires: now() + ttl * 1000 }),
  }
  return { hooks, stores }
}

function cachedApiFlow() {
  const flow = createFlow('Student')
  const step = createStep('api', 'get')
  step.apiId = 'student'
  step.args = { id: { var: 'input.id' } }
  step.cache = { scope: 'session', ttlSeconds: 600 }
  flow.steps.push(step)
  return flow
}

describe('reusing step results', () => {
  it('answers repeat calls with the same inputs from the cache, and new inputs from the API', async () => {
    let clock = 0
    const { hooks, stores } = cacheHooks(() => clock)
    const calls: unknown[] = []
    const all: FlowHooks = {
      http: async () => ({ status: 200, ok: true, body: null }),
      callApi: async (_id, args): Promise<HttpResponse> => (
        calls.push(args),
        {
          status: 200,
          ok: true,
          body: { id: args['id'], name: `Student ${args['id']}` },
        }
      ),
      ...hooks,
    }
    const flow = cachedApiFlow()
    const run = (id: number) =>
      runFlow(flow, { input: { id } }, all, { side: 'client' })
    expect((await run(1)).output).toEqual({ id: 1, name: 'Student 1' })
    expect((await run(1)).output).toEqual({ id: 1, name: 'Student 1' })
    expect(calls).toEqual([{ id: 1 }])
    await run(2)
    expect(calls).toEqual([{ id: 1 }, { id: 2 }])
    expect(stores['session'].size).toBe(2)
    // After the time is up, the API is asked again.
    clock += 601_000
    await run(1)
    expect(calls).toHaveLength(3)
  })

  it('does not keep "no data" answers', async () => {
    const { hooks, stores } = cacheHooks(() => 0)
    const flow = cachedApiFlow()
    await runFlow(
      flow,
      { input: { id: 1 } },
      {
        http: async () => ({ status: 200, ok: true, body: null }),
        callApi: async () => ({ status: 200, ok: true, body: [] }),
        ...hooks,
      },
      { side: 'client' },
    )
    expect(stores['session'].size).toBe(0)
  })

  it('runs normally where no cache is available (e.g. on the server)', async () => {
    const flow = cachedApiFlow()
    let calls = 0
    const hooks: FlowHooks = {
      http: async () => ({ status: 200, ok: true, body: null }),
      callApi: async () => (
        calls++,
        { status: 200, ok: true, body: { ok: 1 } }
      ),
    }
    await runFlow(flow, { input: { id: 1 } }, hooks, { side: 'server' })
    await runFlow(flow, { input: { id: 1 } }, hooks, { side: 'server' })
    expect(calls).toBe(2)
  })

  it('checks the cache settings', () => {
    const flow = cachedApiFlow()
    flow.steps[0].cache = { scope: 'session', ttlSeconds: 0 }
    expect(validateFlow(flow).join()).toMatch(/between 1 second and 30 days/)
  })
})
