/**
 * Who is using the builder. The app sits behind Cloudflare Access, which
 * signs every request with a JWT (Cf-Access-Jwt-Assertion). We verify that
 * signature against the team's public keys — never trusting a plain header —
 * and use its subject as the user id.
 *
 *   CF_ACCESS_TEAM_DOMAIN  e.g. yourteam.cloudflareaccess.com
 *   CF_ACCESS_AUD          the Access application's audience (AUD) tag
 *   ADMIN_TOKEN            fallback for local development and automation
 */
import { createRemoteJWKSet, jwtVerify } from 'jose'

export type BuilderRole = 'admin' | 'author'

export interface BuilderUser {
  id: string
  email: string
  role: BuilderRole
  via: 'access' | 'token'
}

export interface UserDirectory {
  /** Records the user (first one becomes admin) and returns their role. */
  upsertUser(id: string, email: string): Promise<BuilderRole>
}

export class AuthError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>()

export interface AccessConfig {
  teamDomain: string
  audience: string
}

export function accessConfig(
  env: Record<string, unknown>,
): AccessConfig | null {
  const team =
    typeof env['CF_ACCESS_TEAM_DOMAIN'] === 'string'
      ? env['CF_ACCESS_TEAM_DOMAIN']
          .replace(/^https?:\/\//, '')
          .replace(/\/+$/, '')
      : ''
  const audience =
    typeof env['CF_ACCESS_AUD'] === 'string' ? env['CF_ACCESS_AUD'] : ''
  return team && audience ? { teamDomain: team, audience } : null
}

/** Verifies a Cloudflare Access token; returns its subject and email. */
export async function verifyAccessToken(
  token: string,
  config: AccessConfig,
  keys?: Parameters<typeof jwtVerify>[1],
): Promise<{ id: string; email: string }> {
  let keySet = keys
  if (!keySet) {
    // The key set is cached per isolate and refreshes itself when Cloudflare rotates keys.
    if (!keySets.has(config.teamDomain))
      keySets.set(
        config.teamDomain,
        createRemoteJWKSet(
          new URL(`https://${config.teamDomain}/cdn-cgi/access/certs`),
        ),
      )
    keySet = keySets.get(config.teamDomain)!
  }
  try {
    const { payload } = await jwtVerify(token, keySet as never, {
      issuer: `https://${config.teamDomain}`,
      audience: config.audience,
    })
    const id = typeof payload.sub === 'string' ? payload.sub : ''
    const email = typeof payload['email'] === 'string' ? payload['email'] : ''
    if (!id) throw new Error('missing subject')
    return { id, email }
  } catch {
    throw new AuthError(
      401,
      'Your Cloudflare Access sign-in is not valid. Reload the page to sign in again.',
    )
  }
}

function equalTokens(a: string, b: string): boolean {
  const left = new TextEncoder().encode(a)
  const right = new TextEncoder().encode(b)
  let diff = left.length ^ right.length
  for (let i = 0; i < Math.max(left.length, right.length); i++)
    diff |= (left[i] ?? 0) ^ (right[i] ?? 0)
  return diff === 0
}

function accessToken(request: Request): string {
  const header = request.headers.get('Cf-Access-Jwt-Assertion')
  if (header) return header
  // Browsers also carry the token in the CF_Authorization cookie.
  const cookie = request.headers.get('Cookie') ?? ''
  return /(?:^|;\s*)CF_Authorization=([^;]+)/.exec(cookie)?.[1] ?? ''
}

/** Identifies the builder user, or throws AuthError. */
export async function authenticate(
  request: Request,
  env: Record<string, unknown>,
  users: UserDirectory,
): Promise<BuilderUser> {
  const adminToken =
    typeof env['ADMIN_TOKEN'] === 'string' ? env['ADMIN_TOKEN'] : ''
  const header = request.headers.get('Authorization') ?? ''
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : ''
  if (bearer && adminToken && equalTokens(bearer, adminToken))
    return { id: 'admin-token', email: 'admin', role: 'admin', via: 'token' }

  const config = accessConfig(env)
  if (config) {
    const token = accessToken(request)
    if (!token)
      throw new AuthError(
        401,
        'Sign in through Cloudflare Access to use the builder.',
      )
    const { id, email } = await verifyAccessToken(token, config)
    return { id, email, role: await users.upsertUser(id, email), via: 'access' }
  }
  if (!adminToken)
    throw new AuthError(
      503,
      'Builder sign-in is not configured. Set CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD, or ADMIN_TOKEN for development.',
    )
  throw new AuthError(401, 'Wrong or missing admin token.')
}
