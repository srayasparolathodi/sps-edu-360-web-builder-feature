import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { ApiDef, buildApiRequest, createApi, validateApi } from './api'
import {
  HttpResponse,
  createFlow,
  createStep,
  runFlow,
  validateFlow,
} from './flow'
import { createProject, parseProject } from './model'

const api = (patch: Partial<ApiDef>): ApiDef => ({
  ...createApi('Students'),
  id: 'students',
  ...patch,
})
const secrets = {
  KEY: 'k-123',
  TOKEN: 't-456',
  USER: 'asha',
  PASS: 'p@ss',
  SIGN: 'shh',
}

describe('building API requests', () => {
  it('fills path, query, header and body parameters, with defaults and required checks', async () => {
    const def = api({
      method: 'POST',
      url: 'https://api.school.edu/v1/classes/{classId}/students',
      params: [
        { name: 'classId', in: 'path', required: true },
        { name: 'page', in: 'query', required: false, default: 1 },
        { name: 'tags', in: 'query', required: false },
        { name: 'X-Tenant', in: 'header', required: false, default: 'north' },
        { name: 'name', in: 'body', required: true },
        { name: 'grade', in: 'body', required: false },
      ],
      bodyType: 'json',
    })
    const request = await buildApiRequest(
      def,
      { classId: '8 A', tags: ['new', 'transfer'], name: 'Asha', grade: 8 },
      { secrets },
    )
    expect(request.url).toBe(
      'https://api.school.edu/v1/classes/8%20A/students?page=1&tags=new&tags=transfer',
    )
    expect(request.headers).toMatchObject({
      'X-Tenant': 'north',
      'Content-Type': 'application/json',
    })
    expect(JSON.parse(request.body!)).toEqual({ name: 'Asha', grade: 8 })
    await expect(
      buildApiRequest(def, { classId: '8A' }, { secrets }),
    ).rejects.toThrow(/"name" is required/)
  })

  it('uses a body template built from the arguments', async () => {
    const def = api({
      method: 'POST',
      url: 'https://x.test/search',
      params: [{ name: 'q', in: 'body', required: true }],
      bodyType: 'json',
      body: { object: [] } as never,
    })
    def.body = { cat: ['{"query":"', { var: 'args.q' }, '"}'] }
    const request = await buildApiRequest(
      { ...def, bodyType: 'text' },
      { q: 'maths' },
      { secrets },
    )
    expect(request.body).toBe('{"query":"maths"}')
  })

  it('applies every kind of authorization', async () => {
    const plain = { url: 'https://x.test/data', params: [] }
    const key = await buildApiRequest(
      api({
        ...plain,
        auth: {
          type: 'apiKey',
          keyName: 'X-API-Key',
          keyIn: 'header',
          secret: 'KEY',
        },
      }),
      {},
      { secrets },
    )
    expect(key.headers['X-API-Key']).toBe('k-123')
    const keyQuery = await buildApiRequest(
      api({
        ...plain,
        auth: {
          type: 'apiKey',
          keyName: 'api_key',
          keyIn: 'query',
          secret: 'KEY',
        },
      }),
      {},
      { secrets },
    )
    expect(keyQuery.url).toBe('https://x.test/data?api_key=k-123')
    const bearer = await buildApiRequest(
      api({ ...plain, auth: { type: 'bearer', secret: 'TOKEN' } }),
      {},
      { secrets },
    )
    expect(bearer.headers['Authorization']).toBe('Bearer t-456')
    // Token handed over by an earlier step (e.g. a login API), passed as an argument.
    const dynamic = await buildApiRequest(
      api({
        url: 'https://x.test/data',
        params: [{ name: 'token', in: 'none', required: true }],
        auth: { type: 'bearer', token: { var: 'args.token' } },
      }),
      { token: 'from-login' },
      { secrets },
    )
    expect(dynamic.headers['Authorization']).toBe('Bearer from-login')
    expect(dynamic.url).toBe('https://x.test/data')
    expect(dynamic.body).toBeUndefined()
    const basic = await buildApiRequest(
      api({
        ...plain,
        auth: { type: 'basic', username: 'USER', password: 'PASS' },
      }),
      {},
      { secrets },
    )
    expect(basic.headers['Authorization']).toBe(
      `Basic ${Buffer.from('asha:p@ss').toString('base64')}`,
    )
    const oauth = await buildApiRequest(
      api({
        ...plain,
        auth: {
          type: 'oauth2',
          tokenUrl: 'https://auth.test/token',
          clientId: 'USER',
          clientSecret: 'PASS',
        },
      }),
      {},
      { secrets, oauthToken: async () => 'oauth-token' },
    )
    expect(oauth.headers['Authorization']).toBe('Bearer oauth-token')
    const custom = await buildApiRequest(
      api({
        ...plain,
        auth: {
          type: 'custom',
          headers: {
            'X-Key': { var: 'secrets.KEY' },
            'X-Mode': 'live',
          } as never,
        },
      }),
      {},
      { secrets },
    )
    expect(custom.headers).toMatchObject({ 'X-Key': 'k-123', 'X-Mode': 'live' })
  })

  it('signs requests with HMAC over the body', async () => {
    const def = api({
      method: 'POST',
      url: 'https://x.test/hook',
      params: [{ name: 'event', in: 'body', required: true }],
      bodyType: 'json',
      auth: {
        type: 'hmac',
        secret: 'SIGN',
        hmacHeader: 'X-Signature',
        hmacPrefix: 'sha256=',
        hmacTimestampHeader: 'X-Timestamp',
      },
    })
    const request = await buildApiRequest(def, { event: 'paid' }, { secrets })
    const expected = createHmac('sha256', 'shh')
      .update(request.body!)
      .digest('hex')
    expect(request.headers['X-Signature']).toBe(`sha256=${expected}`)
    expect(request.headers['X-Timestamp']).toMatch(/^\d{10}$/)
  })

  it('names the missing credential instead of sending a broken request', async () => {
    await expect(
      buildApiRequest(
        api({
          url: 'https://x.test',
          params: [],
          auth: { type: 'bearer', secret: 'MISSING' },
        }),
        {},
        { secrets },
      ),
    ).rejects.toThrow(/credential MISSING is not saved/)
  })
})

describe('validating APIs', () => {
  it('explains what is wrong', () => {
    expect(validateApi(api({}))).toEqual([])
    expect(validateApi(api({ url: 'ftp://x' }))[0]).toMatch(
      /must start with https/,
    )
    expect(
      validateApi(api({ url: 'https://x.test/{id}', params: [] }))[0],
    ).toMatch(/add a path parameter called "id"/)
    expect(
      validateApi(
        api({ auth: { type: 'apiKey', keyIn: 'header', keyName: 'X-Key' } }),
      )[0],
    ).toMatch(/credential holding the API key/)
    expect(
      validateApi(
        api({
          auth: {
            type: 'oauth2',
            tokenUrl: 'http://insecure',
            clientId: 'A',
            clientSecret: 'B',
          },
        }),
      )[0],
    ).toMatch(/token address must start with https/)
  })

  it('checks APIs and the steps that call them when an app is loaded', () => {
    const project = createProject('Apis')
    project.apis = [api({})]
    const flow = createFlow('Load')
    const step = createStep('api', 'load')
    step.apiId = 'students'
    flow.steps.push(step)
    project.flows.push(flow)
    expect(() => parseProject(JSON.stringify(project))).not.toThrow()
    step.apiId = 'gone'
    expect(() => parseProject(JSON.stringify(project))).toThrow(
      /calls an API that no longer exists/,
    )
  })
})

describe('api steps in journeys', () => {
  it("chains calls: one API result decides the next call's arguments", async () => {
    const flow = createFlow('Chain')
    flow.mode = 'sequential'
    const login = createStep('api', 'login')
    login.apiId = 'login'
    login.args = { user: { var: 'input.user' } }
    const details = createStep('api', 'details')
    details.apiId = 'details'
    details.args = {
      id: { var: 'steps.login.studentId' },
      token: { var: 'steps.login.token' },
    }
    flow.steps.push(login, details)
    const calls: { apiId: string; args: Record<string, unknown> }[] = []
    const result = await runFlow(
      flow,
      { input: { user: 'asha' } },
      {
        http: async () => ({ status: 200, ok: true, body: null }),
        callApi: async (apiId, args): Promise<HttpResponse> => {
          calls.push({ apiId, args })
          return apiId === 'login'
            ? { status: 200, ok: true, body: { token: 'abc', studentId: 42 } }
            : { status: 200, ok: true, body: { id: args['id'], name: 'Asha' } }
        },
      },
      { side: 'client' },
    )
    expect(result.status).toBe('success')
    expect(calls).toEqual([
      { apiId: 'login', args: { user: 'asha' } },
      { apiId: 'details', args: { id: 42, token: 'abc' } },
    ])
    expect(result.output).toEqual({ id: 42, name: 'Asha' })
  })

  it('treats rejected calls as errors that can be retried', async () => {
    const flow = createFlow('Fail')
    const step = createStep('api', 'call')
    step.apiId = 'x'
    step.retry = { ...step.retry, attempts: 2, delayMs: 1, maxDelayMs: 1 }
    flow.steps.push(step)
    let attempts = 0
    const result = await runFlow(
      flow,
      {},
      {
        http: async () => ({ status: 200, ok: true, body: null }),
        callApi: async () => (
          attempts++,
          { status: 503, ok: false, body: null }
        ),
      },
      { side: 'client' },
    )
    expect(result.status).toBe('error')
    expect(attempts).toBe(2)
    expect(result.error).toMatch(/503/)
  })

  it('accepts a real cron schedule (regression: the check rejected every schedule)', () => {
    const flow = createFlow('Nightly')
    flow.runAt = 'server'
    flow.trigger = 'schedule'
    flow.schedule = '0 2 * * *'
    expect(validateFlow(flow)).toEqual([])
    flow.schedule = 'every night'
    expect(validateFlow(flow).join()).toMatch(/5 parts/)
  })
})
