/**
 * Sends calls to an app's saved APIs. The request is built by the shared engine
 * (libs/engine/src/api.ts) with the app's credentials, which never leave the server.
 * OAuth 2.0 access tokens are fetched once and reused until shortly before they expire.
 */
import { ApiDef, ApiError, buildApiRequest } from '@spsedu360/engine/api'
import type { HttpResponse } from '@spsedu360/engine/flow'
import { StepError } from '@spsedu360/engine/resilience'

/** Access tokens per token endpoint and client, kept by this Worker isolate. */
const tokens = new Map<string, { token: string; expires: number }>()

const MAX_RESPONSE = 5_000_000

export interface ApiCallOptions {
  secrets: Record<string, string>
  signal?: AbortSignal
  fetch?: typeof fetch
}

async function oauthToken(
  api: ApiDef,
  options: ApiCallOptions,
): Promise<string> {
  const auth = api.auth
  const clientId = options.secrets[auth.clientId ?? '']
  const clientSecret = options.secrets[auth.clientSecret ?? '']
  if (!clientId || !clientSecret)
    throw new ApiError(
      `${api.name}: save the client id and client secret credentials first.`,
    )
  const key = `${auth.tokenUrl}|${clientId}|${auth.scope ?? ''}|${auth.audience ?? ''}`
  const cached = tokens.get(key)
  if (cached && cached.expires > Date.now()) return cached.token
  const form = new URLSearchParams({ grant_type: 'client_credentials' })
  if (auth.scope) form.set('scope', auth.scope)
  if (auth.audience) form.set('audience', auth.audience)
  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
    Accept: 'application/json',
  }
  if (auth.clientAuth === 'basic')
    headers['Authorization'] =
      `Basic ${btoa(`${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`)}`
  else {
    form.set('client_id', clientId)
    form.set('client_secret', clientSecret)
  }
  const response = await (options.fetch ?? fetch)(auth.tokenUrl!, {
    method: 'POST',
    headers,
    body: form.toString(),
    signal: options.signal,
  })
  const body = (await response.json().catch(() => null)) as {
    access_token?: string
    expires_in?: number
    error_description?: string
    error?: string
  } | null
  if (!response.ok || !body?.access_token)
    throw new StepError(
      `${api.name}: the token endpoint refused the client (${response.status}${body?.error_description || body?.error ? `: ${body.error_description || body.error}` : ''}).`,
      response.status,
      response.status >= 500,
    )
  // Renew a minute early; tokens without an expiry are reused for 5 minutes.
  tokens.set(key, {
    token: body.access_token,
    expires: Date.now() + Math.max(30, (body.expires_in ?? 360) - 60) * 1000,
  })
  return body.access_token
}

/** Calls a saved API; errors in the definition or credentials are not retried. */
export async function callApi(
  api: ApiDef,
  args: Record<string, unknown>,
  options: ApiCallOptions,
): Promise<HttpResponse> {
  let request
  try {
    request = await buildApiRequest(api, args, {
      secrets: options.secrets,
      oauthToken: (def) => oauthToken(def, options),
    })
  } catch (error) {
    if (error instanceof ApiError)
      throw new StepError(error.message, undefined, false)
    throw error
  }
  let response: Response
  try {
    response = await (options.fetch ?? fetch)(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      signal: options.signal,
      redirect: 'follow',
    })
  } catch (error) {
    if (options.signal?.aborted) throw error
    throw new StepError(`${api.name}: the API could not be reached.`)
  }
  // A rejected token is dropped so the next call fetches a fresh one.
  if (response.status === 401 && api.auth.type === 'oauth2')
    for (const key of tokens.keys())
      if (key.startsWith(`${api.auth.tokenUrl}|`)) tokens.delete(key)
  const text = await response.text()
  if (text.length > MAX_RESPONSE)
    throw new StepError(
      `${api.name}: the answer is larger than 5 MB.`,
      undefined,
      false,
    )
  let body: unknown = text
  if (api.responseType === 'json' && text.trim()) {
    try {
      body = JSON.parse(text)
    } catch {
      body = text
    }
  } else if (!text.trim()) body = null
  return { status: response.status, ok: response.ok, body }
}

/** The address with credentials in its query blanked, for showing in the builder. */
export function safeUrl(url: string, secrets: Record<string, string>): string {
  let result = url
  for (const value of Object.values(secrets))
    if (value.length >= 4)
      result = result
        .split(encodeURIComponent(value))
        .join('••••••')
        .split(value)
        .join('••••••')
  return result
}
