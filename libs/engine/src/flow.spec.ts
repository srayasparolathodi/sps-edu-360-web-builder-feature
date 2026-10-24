import { describe, expect, it, vi } from 'vitest'
import {
  Flow,
  FlowHooks,
  HttpResponse,
  createFlow,
  createStep,
  runFlow,
  validateFlow,
} from './flow'
import { BreakerRegistry } from './resilience'

function flowWith(...steps: ReturnType<typeof createStep>[]): Flow {
  return { ...createFlow('test'), steps }
}
const quick = (step: ReturnType<typeof createStep>) => {
  step.retry = {
    attempts: step.retry.attempts,
    delayMs: 1,
    backoff: 'fixed',
    maxDelayMs: 1,
  }
  return step
}
const hooks = (http?: FlowHooks['http']): FlowHooks => ({
  http: http ?? (async () => ({ status: 200, ok: true, body: [1] })),
})
const ok = (body: unknown): HttpResponse => ({ status: 200, ok: true, body })

describe('runFlow', () => {
  it('passes outputs between dependent steps', async () => {
    const a = createStep('compute', 'a')
    a.logic = { '*': [{ var: 'input.price' }, 2] }
    const b = createStep('compute', 'b')
    b.after = ['a']
    b.logic = { '+': [{ var: 'steps.a' }, 1] }
    const result = await runFlow(
      flowWith(a, b),
      { input: { price: 10 } },
      hooks(),
      { side: 'client' },
    )
    expect(result.status).toBe('success')
    expect(result.output).toBe(21)
  })

  it('runs independent steps in parallel and sequential steps in order', async () => {
    const order: string[] = []
    const http: FlowHooks['http'] = async (request) => {
      order.push(`start ${request.url}`)
      await new Promise((resolve) => setTimeout(resolve, 20))
      order.push(`end ${request.url}`)
      return ok([request.url])
    }
    const a = createStep('http', 'a')
    a.url = '/a'
    const b = createStep('http', 'b')
    b.url = '/b'
    const parallel = await runFlow(flowWith(a, b), {}, hooks(http), {
      side: 'client',
    })
    expect(parallel.status).toBe('success')
    expect(order.slice(0, 2)).toEqual(['start /a', 'start /b'])

    order.length = 0
    const sequential = { ...flowWith(a, b), mode: 'sequential' as const }
    await runFlow(sequential, {}, hooks(http), { side: 'client' })
    expect(order).toEqual(['start /a', 'end /a', 'start /b', 'end /b'])
  })

  it('retries failures with backoff, then succeeds', async () => {
    const http = vi
      .fn()
      .mockResolvedValueOnce({ status: 503, ok: false, body: null })
      .mockRejectedValueOnce(new TypeError('network'))
      .mockResolvedValueOnce(ok({ id: 1 }))
    const step = quick(createStep('http', 'a'))
    const result = await runFlow(flowWith(step), {}, hooks(http), {
      side: 'client',
    })
    expect(result.status).toBe('success')
    expect(result.steps['a'].attempts).toBe(3)
  })

  it('does not retry client errors such as 404', async () => {
    const http = vi
      .fn()
      .mockResolvedValue({ status: 404, ok: false, body: null })
    const step = quick(createStep('http', 'a'))
    const result = await runFlow(flowWith(step), {}, hooks(http), {
      side: 'client',
    })
    expect(result.status).toBe('error')
    expect(http).toHaveBeenCalledTimes(1)
    expect(result.error).toContain('404')
  })

  it('uses a fallback value and notifies on failure', async () => {
    const step = quick(createStep('http', 'a'))
    step.retry.attempts = 1
    step.onError = {
      action: 'fallback',
      fallback: { cat: ['offline: ', { var: 'error.status' }] },
      notify: true,
      message: 'Using saved data ({error})',
    }
    const notify = vi.fn()
    const result = await runFlow(
      flowWith(step),
      {},
      { http: async () => ({ status: 500, ok: false, body: null }), notify },
      { side: 'client' },
    )
    expect(result.status).toBe('success')
    expect(result.output).toBe('offline: 500')
    expect(result.steps['a'].recovered).toBe(true)
    expect(notify).toHaveBeenCalledWith(
      'error',
      expect.stringContaining('Using saved data'),
    )
  })

  it('continues past a failed step when told to', async () => {
    const a = quick(createStep('http', 'a'))
    a.retry.attempts = 1
    a.onError = { ...a.onError, action: 'continue', notify: false }
    const b = createStep('compute', 'b')
    b.after = ['a']
    b.logic = { '??': [{ var: 'steps.a' }, 'default'] }
    const result = await runFlow(
      flowWith(a, b),
      {},
      hooks(async () => ({ status: 500, ok: false, body: null })),
      { side: 'client' },
    )
    expect(result.status).toBe('success')
    expect(result.output).toBe('default')
  })

  it('stops the flow and skips dependants when a step fails', async () => {
    const a = quick(createStep('http', 'a'))
    a.retry.attempts = 1
    a.onError.notify = false
    const b = createStep('compute', 'b')
    b.after = ['a']
    const result = await runFlow(
      flowWith(a, b),
      {},
      hooks(async () => ({ status: 500, ok: false, body: null })),
      { side: 'client' },
    )
    expect(result.status).toBe('error')
    expect(result.steps['b'].status).toBe('skipped')
  })

  it('opens the circuit after repeated failures and fails fast', async () => {
    const breakers = new BreakerRegistry()
    const http = vi
      .fn()
      .mockResolvedValue({ status: 500, ok: false, body: null })
    const step = quick(createStep('http', 'a'))
    step.retry.attempts = 1
    step.onError.notify = false
    step.breaker = { enabled: true, failureThreshold: 2, cooldownMs: 60_000 }
    const flow = flowWith(step)
    await runFlow(flow, {}, hooks(http), { side: 'client', breakers })
    await runFlow(flow, {}, hooks(http), { side: 'client', breakers })
    const third = await runFlow(flow, {}, hooks(http), {
      side: 'client',
      breakers,
    })
    expect(http).toHaveBeenCalledTimes(2)
    expect(third.error).toMatch(/paused/)
  })

  it('times out slow steps', async () => {
    const step = quick(createStep('http', 'a'))
    step.retry.attempts = 1
    step.timeoutMs = 20
    step.onError.notify = false
    const result = await runFlow(
      flowWith(step),
      {},
      hooks(
        (_, signal) =>
          new Promise((resolve, reject) => {
            const timer = setTimeout(() => resolve(ok([1])), 500)
            signal.addEventListener('abort', () => {
              clearTimeout(timer)
              reject(new Error('aborted'))
            })
          }),
      ),
      { side: 'client' },
    )
    expect(result.status).toBe('error')
    expect(result.error).toMatch(/Timed out/)
  })

  it('reports no data for empty responses', async () => {
    const step = createStep('http', 'a')
    const result = await runFlow(
      flowWith(step),
      {},
      hooks(async () => ok([])),
      { side: 'client' },
    )
    expect(result.status).toBe('empty')
    expect(result.emptyMessage).toBe('Nothing to show yet.')
  })

  it('skips steps whose condition is false and writes variables', async () => {
    const a = createStep('setVariable', 'a')
    a.variable = 'greeting'
    a.value = { cat: ['Hello ', { var: 'params.name' }] }
    const b = createStep('notify', 'b')
    b.when = { '==': [1, 2] }
    const c = createStep('compute', 'c')
    c.after = ['a']
    c.logic = { var: 'vars.greeting' }
    const setVariable = vi.fn()
    const result = await runFlow(
      flowWith(a, b, c),
      { params: { name: 'Ravi' } },
      { ...hooks(), setVariable },
      { side: 'client' },
    )
    expect(result.steps['b'].status).toBe('skipped')
    expect(result.output).toBe('Hello Ravi')
    expect(result.variables.vars).toEqual({ greeting: 'Hello Ravi' })
    expect(setVariable).toHaveBeenCalledWith('vars', 'greeting', 'Hello Ravi')
  })
})

describe('validateFlow', () => {
  it('detects dependency loops and wrong-side steps', () => {
    const a = createStep('compute', 'a')
    const b = createStep('compute', 'b')
    a.after = ['b']
    b.after = ['a']
    expect(validateFlow(flowWith(a, b)).join()).toMatch(/loop/)
    const nav = createStep('navigate', 'n')
    expect(validateFlow({ ...flowWith(nav), runAt: 'server' }).join()).toMatch(
      /can't run on the server/,
    )
  })
})
