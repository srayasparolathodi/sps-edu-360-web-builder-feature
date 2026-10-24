/**
 * Reusable APIs: defined once per app (optionally for one page), called from any journey.
 *
 * A definition holds the address, parameters, headers, body and authorization. A journey's
 * "api" step only supplies the parameter values ("args"), which can come from anything —
 * another API's or query's result, a form, variables, the route or the signed-in user — so
 * chained calls (login → token → data, or list → id → details) need no special support.
 *
 * Requests are always built and sent by the server, so secrets (keys, tokens, passwords)
 * never reach the browser.
 */
import { Logic, evaluate, isLogic } from './logic'
import type { AccessRule } from './access'

export type ApiMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
export type ParamPlace = 'path' | 'query' | 'header' | 'body' | 'none'

export interface ApiParam {
  name: string
  /** path: replaces {name} in the address; query: ?name=; header: a request header; body: a field of the JSON/form body;
   *  none: not sent, only used by the authorization or the body shape (e.g. a token from a login step). */
  in: ParamPlace
  required: boolean
  /** Used when the caller does not pass a value. */
  default?: unknown
  description?: string
}

export type AuthType =
  'none' | 'apiKey' | 'bearer' | 'basic' | 'oauth2' | 'hmac' | 'custom'

export interface ApiAuth {
  type: AuthType
  // apiKey: a key sent in a header (e.g. X-API-Key) or a query parameter (e.g. ?api_key=).
  keyName?: string
  keyIn?: 'header' | 'query'
  /** Credential name (secrets.NAME) holding the key, token or HMAC secret. */
  secret?: string
  /** bearer: logic producing the token instead of a credential, e.g. {"var":"args.token"} from a login step. */
  token?: Logic
  // basic: credential names for the user name and password.
  username?: string
  password?: string
  // oauth2 (client credentials): token endpoint and credential names.
  tokenUrl?: string
  clientId?: string
  clientSecret?: string
  scope?: string
  audience?: string
  /** How the client authenticates at the token endpoint. */
  clientAuth?: 'body' | 'basic'
  // hmac: signs the request with the credential in `secret`.
  hmacHeader?: string
  hmacAlgorithm?: 'SHA-256' | 'SHA-1' | 'SHA-512'
  hmacEncoding?: 'hex' | 'base64'
  /** Text put before the signature, e.g. "sha256=". */
  hmacPrefix?: string
  /** What is signed; gets method, path, query, body, timestamp and args. Defaults to the body. */
  hmacMessage?: Logic
  /** Also send the signing time (Unix seconds) in this header. */
  hmacTimestampHeader?: string
  /** custom: logic producing an object of extra headers; can use secrets.NAME and args. */
  headers?: Logic
}

export interface ApiDef {
  id: string
  name: string
  description: string
  /** Set to make this an API of one page; otherwise it belongs to the whole app. */
  pageId?: string
  method: ApiMethod
  /** Full address with {param} placeholders, e.g. https://api.school.edu/v1/students/{studentId}. */
  url: string
  params: ApiParam[]
  /** Fixed headers sent with every call. */
  headers: Record<string, string>
  bodyType: 'json' | 'form' | 'text' | 'none'
  /** Optional body template (logic using args.*); otherwise body params form a flat object. */
  body?: Logic
  auth: ApiAuth
  responseType: 'json' | 'text'
  /** Let pages (browser journeys) call it through the server; false = server journeys only. */
  browser: boolean
  /** Who may call it from a published app. */
  access?: AccessRule
  /** Values used by the builder's Test button. */
  sample?: Record<string, unknown>
}

export interface ApiRequest {
  method: ApiMethod
  url: string
  headers: Record<string, string>
  body?: string
}

export const AUTH_TYPES: {
  type: AuthType
  label: string
  description: string
}[] = [
  { type: 'none', label: 'No authorization', description: 'Public API.' },
  {
    type: 'apiKey',
    label: 'API key',
    description: 'A key sent in a header or query parameter.',
  },
  {
    type: 'bearer',
    label: 'Bearer token',
    description:
      'Authorization: Bearer <token>, from a credential or from an earlier step (e.g. a login API).',
  },
  {
    type: 'basic',
    label: 'Basic (user name and password)',
    description: 'Authorization: Basic …',
  },
  {
    type: 'oauth2',
    label: 'OAuth 2.0 client credentials',
    description:
      'Gets an access token from the token endpoint, reuses it until it expires.',
  },
  {
    type: 'hmac',
    label: 'HMAC signature',
    description:
      'Signs each request with a shared secret (webhook-style APIs).',
  },
  {
    type: 'custom',
    label: 'Custom headers',
    description: 'Any headers built with logic from credentials and arguments.',
  },
]

const PARAM_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/
const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/
const SECRET_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/
const ID = /^[a-zA-Z0-9-]{1,80}$/

export function createApi(name = 'New API'): ApiDef {
  return {
    id: crypto.randomUUID(),
    name,
    description: '',
    method: 'GET',
    url: 'https://jsonplaceholder.typicode.com/users/{id}',
    params: [{ name: 'id', in: 'path', required: true, default: 1 }],
    headers: {},
    bodyType: 'none',
    auth: { type: 'none' },
    responseType: 'json',
    browser: true,
  }
}

/** Placeholders used in the address, e.g. "students/{id}" → ["id"]. */
export function placeholders(url: string): string[] {
  return [...url.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map(
    (match) => match[1],
  )
}

/** Problems with a definition, in plain words. */
export function validateApi(api: ApiDef): string[] {
  const problems: string[] = []
  const where = `API "${api?.name ?? '?'}"`
  if (
    !api ||
    typeof api !== 'object' ||
    !ID.test(api.id) ||
    typeof api.name !== 'string' ||
    !api.name.trim()
  )
    return [`${where} needs an id and a name.`]
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(api.method))
    problems.push(`${where}: choose GET, POST, PUT, PATCH or DELETE.`)
  if (typeof api.url !== 'string' || !/^https?:\/\/[^\s/]+/i.test(api.url))
    problems.push(
      `${where}: the address must start with https:// (or http://).`,
    )
  if (!Array.isArray(api.params) || api.params.length > 50)
    problems.push(`${where}: invalid parameters.`)
  const names = new Set<string>()
  for (const param of Array.isArray(api.params) ? api.params : []) {
    if (!param || !PARAM_NAME.test(param.name ?? ''))
      problems.push(
        `${where}: parameter names use letters, digits and _ (e.g. studentId).`,
      )
    else if (names.has(param.name))
      problems.push(`${where}: two parameters are called "${param.name}".`)
    else if (!['path', 'query', 'header', 'body', 'none'].includes(param.in))
      problems.push(
        `${where}: parameter "${param.name}" needs a place (path, query, header, body or not sent).`,
      )
    names.add(param?.name)
  }
  for (const name of typeof api.url === 'string' ? placeholders(api.url) : [])
    if (
      !api.params?.some((param) => param.name === name && param.in === 'path')
    )
      problems.push(
        `${where}: the address uses {${name}}; add a path parameter called "${name}".`,
      )
  if (
    !api.headers ||
    typeof api.headers !== 'object' ||
    Array.isArray(api.headers) ||
    Object.keys(api.headers).some((name) => !HEADER_NAME.test(name))
  )
    problems.push(`${where}: header names use letters, digits and -.`)
  if (!['json', 'form', 'text', 'none'].includes(api.bodyType))
    problems.push(`${where}: invalid body type.`)
  if (!['json', 'text'].includes(api.responseType))
    problems.push(`${where}: invalid response type.`)
  if (typeof api.browser !== 'boolean')
    problems.push(`${where}: invalid "browser" setting.`)
  const auth = api.auth
  if (!auth || !AUTH_TYPES.some((item) => item.type === auth.type))
    return [...problems, `${where}: choose an authorization type.`]
  const needSecret = (field: keyof ApiAuth, label: string) => {
    if (!SECRET_NAME.test(String(auth[field] ?? '')))
      problems.push(`${where}: choose the credential holding the ${label}.`)
  }
  if (auth.type === 'apiKey') {
    if (
      !HEADER_NAME.test(auth.keyName ?? '') &&
      !PARAM_NAME.test(auth.keyName ?? '')
    )
      problems.push(
        `${where}: give the API key's header or parameter name (e.g. X-API-Key).`,
      )
    if (!['header', 'query'].includes(auth.keyIn ?? ''))
      problems.push(`${where}: send the API key in a header or the query.`)
    needSecret('secret', 'API key')
  }
  if (auth.type === 'bearer' && auth.token === undefined)
    needSecret('secret', 'token')
  if (auth.type === 'basic') {
    needSecret('username', 'user name')
    needSecret('password', 'password')
  }
  if (auth.type === 'oauth2') {
    if (!/^https:\/\/[^\s/]+/i.test(auth.tokenUrl ?? ''))
      problems.push(`${where}: the token address must start with https://.`)
    needSecret('clientId', 'client id')
    needSecret('clientSecret', 'client secret')
  }
  if (auth.type === 'hmac') {
    needSecret('secret', 'signing secret')
    if (!HEADER_NAME.test(auth.hmacHeader ?? ''))
      problems.push(
        `${where}: give the header that carries the signature (e.g. X-Signature).`,
      )
    if (auth.hmacTimestampHeader && !HEADER_NAME.test(auth.hmacTimestampHeader))
      problems.push(`${where}: invalid timestamp header name.`)
  }
  if (auth.type === 'custom' && auth.headers === undefined)
    problems.push(`${where}: custom authorization needs header logic.`)
  return problems
}

const text = (value: unknown): string =>
  value === undefined || value === null
    ? ''
    : typeof value === 'object'
      ? JSON.stringify(value)
      : String(value)
const base64 = (value: string) =>
  btoa(String.fromCharCode(...new TextEncoder().encode(value)))

async function sign(
  secret: string,
  message: string,
  algorithm: ApiAuth['hmacAlgorithm'] = 'SHA-256',
  encoding: ApiAuth['hmacEncoding'] = 'hex',
): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: algorithm },
    false,
    ['sign'],
  )
  const bytes = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message)),
  )
  return encoding === 'base64'
    ? btoa(String.fromCharCode(...bytes))
    : [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly retryable = false,
  ) {
    super(message)
  }
}

/**
 * Builds the HTTP request for one call: fills the address, query, headers and body from the
 * arguments, then applies the authorization. `oauthToken` fetches (and caches) OAuth tokens.
 */
export async function buildApiRequest(
  api: ApiDef,
  args: Record<string, unknown>,
  context: {
    secrets: Record<string, string>
    oauthToken?: (api: ApiDef) => Promise<string>
  },
): Promise<ApiRequest> {
  const values: Record<string, unknown> = {}
  for (const param of api.params) {
    const value =
      args[param.name] !== undefined &&
      args[param.name] !== null &&
      args[param.name] !== ''
        ? args[param.name]
        : param.default
    if (
      (value === undefined || value === null || value === '') &&
      param.required
    )
      throw new ApiError(`${api.name}: "${param.name}" is required.`)
    if (value !== undefined && value !== null && value !== '')
      values[param.name] = value
  }
  const secret = (name: string | undefined, label: string): string => {
    const value = name ? context.secrets[name] : undefined
    if (!value)
      throw new ApiError(
        `${api.name}: the credential ${name || `for the ${label}`} is not saved on the server.`,
      )
    return value
  }
  const data = { args: values, secrets: context.secrets }

  let url = api.url.replace(
    /\{([A-Za-z_][A-Za-z0-9_]*)\}/g,
    (_, name: string) => {
      if (values[name] === undefined)
        throw new ApiError(
          `${api.name}: "${name}" is required for the address.`,
        )
      return encodeURIComponent(text(values[name]))
    },
  )
  const query = new URLSearchParams()
  const headers: Record<string, string> = { ...api.headers }
  const bodyFields: Record<string, unknown> = {}
  for (const param of api.params) {
    const value = values[param.name]
    if (value === undefined) continue
    if (param.in === 'query')
      (Array.isArray(value) ? value : [value]).forEach((item) =>
        query.append(param.name, text(item)),
      )
    if (param.in === 'header') headers[param.name] = text(value)
    if (param.in === 'body') bodyFields[param.name] = value
  }

  let body: string | undefined
  if (api.method !== 'GET' && api.bodyType !== 'none') {
    const value =
      api.body !== undefined && isLogic(api.body)
        ? evaluate(api.body, data)
        : api.body !== undefined
          ? api.body
          : bodyFields
    if (api.bodyType === 'json') {
      body = JSON.stringify(value ?? {})
      headers['Content-Type'] ??= 'application/json'
    } else if (api.bodyType === 'form') {
      const form = new URLSearchParams()
      if (value && typeof value === 'object')
        for (const [name, item] of Object.entries(value))
          form.append(name, text(item))
      body = form.toString()
      headers['Content-Type'] ??= 'application/x-www-form-urlencoded'
    } else {
      body = text(value)
      headers['Content-Type'] ??= 'text/plain'
    }
  }

  const auth = api.auth
  switch (auth.type) {
    case 'apiKey':
      if (auth.keyIn === 'query')
        query.set(auth.keyName!, secret(auth.secret, 'API key'))
      else headers[auth.keyName!] = secret(auth.secret, 'API key')
      break
    case 'bearer': {
      const token =
        auth.token !== undefined
          ? text(isLogic(auth.token) ? evaluate(auth.token, data) : auth.token)
          : secret(auth.secret, 'token')
      if (!token)
        throw new ApiError(
          `${api.name}: no token to send (the token logic gave an empty value).`,
        )
      headers['Authorization'] = `Bearer ${token}`
      break
    }
    case 'basic':
      headers['Authorization'] =
        `Basic ${base64(`${secret(auth.username, 'user name')}:${secret(auth.password, 'password')}`)}`
      break
    case 'oauth2':
      if (!context.oauthToken)
        throw new ApiError(
          `${api.name}: OAuth tokens can only be fetched on the server.`,
        )
      headers['Authorization'] = `Bearer ${await context.oauthToken(api)}`
      break
    case 'custom': {
      const extra = isLogic(auth.headers)
        ? evaluate(auth.headers!, data)
        : auth.headers
      if (extra && typeof extra === 'object' && !Array.isArray(extra))
        for (const [name, value] of Object.entries(extra))
          if (HEADER_NAME.test(name)) headers[name] = text(value)
      break
    }
  }
  const search = query.toString()
  if (search) url += (url.includes('?') ? '&' : '?') + search
  // HMAC signs the final request, so it comes last.
  if (auth.type === 'hmac') {
    const parsed = new URL(url)
    const timestamp = String(Math.floor(Date.now() / 1000))
    const message =
      auth.hmacMessage !== undefined && isLogic(auth.hmacMessage)
        ? text(
            evaluate(auth.hmacMessage, {
              ...data,
              method: api.method,
              path: parsed.pathname,
              query: parsed.search.slice(1),
              body: body ?? '',
              timestamp,
            }),
          )
        : (body ?? '')
    headers[auth.hmacHeader!] =
      `${auth.hmacPrefix ?? ''}${await sign(secret(auth.secret, 'signing secret'), message, auth.hmacAlgorithm, auth.hmacEncoding)}`
    if (auth.hmacTimestampHeader) headers[auth.hmacTimestampHeader] = timestamp
  }
  return { method: api.method, url, headers, body }
}

/** APIs a page may use: the app's own plus that page's. */
export function apisFor(apis: ApiDef[] | undefined, pageId?: string): ApiDef[] {
  return (apis ?? []).filter((api) => !api.pageId || api.pageId === pageId)
}
