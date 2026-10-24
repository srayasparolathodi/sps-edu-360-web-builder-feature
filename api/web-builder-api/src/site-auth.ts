/**
 * Sign-in for visitors of published sites, using Better Auth inside the Worker.
 * Accounts are shared across sites on this domain; roles are per site and kept
 * in ps_site_members, so each author defines their own roles.
 *
 *   DATABASE_URL        Postgres for Better Auth's tables (user, session, account, verification)
 *   BETTER_AUTH_SECRET  long random string used to sign sessions (Worker secret)
 */
import { RedisLike, cacheRole, cachedRole } from './upstash'
import { betterAuth } from 'better-auth'
import { getMigrations } from 'better-auth/db/migration'
import { Pool } from 'pg'
import { ANONYMOUS, SiteAuth, Visitor } from '@spsedu360/engine/access'
import type { ProjectStore } from './storage'

/** The parts of Better Auth used here. */
interface Auth {
  handler(request: Request): Promise<Response>
  api: {
    getSession(options: {
      headers: Headers
    }): Promise<{ user?: unknown } | null>
  }
}

export interface SiteAuthHandle {
  auth: Auth
  /** Releases the database connection; call when the request is done. */
  close(): Promise<void>
}

let tablesReady: Promise<void> | undefined

export function siteAuthConfigured(env: Record<string, unknown>): boolean {
  return (
    typeof env['DATABASE_URL'] === 'string' &&
    typeof env['BETTER_AUTH_SECRET'] === 'string' &&
    (env['BETTER_AUTH_SECRET'] as string).length >= 32
  )
}

/** A Better Auth instance for this request (Workers can't share connections between requests). */
export async function openSiteAuth(
  env: Record<string, unknown>,
  origin: string,
): Promise<SiteAuthHandle | null> {
  if (!siteAuthConfigured(env)) return null
  const pool = new Pool({
    connectionString: env['DATABASE_URL'] as string,
    max: 1,
  })
  const options = {
    database: pool,
    secret: env['BETTER_AUTH_SECRET'] as string,
    baseURL: origin,
    basePath: '/api/auth',
    trustedOrigins: [origin],
    emailAndPassword: { enabled: true, minPasswordLength: 8, autoSignIn: true },
    advanced: {
      defaultCookieAttributes: {
        sameSite: 'lax' as const,
        secure: origin.startsWith('https://'),
      },
    },
  }
  const auth = betterAuth(options) as unknown as Auth
  // Better Auth's own tables are created once per isolate.
  tablesReady ??= getMigrations(options as never)
    .then(({ runMigrations }) => runMigrations())
    .catch((error) => {
      tablesReady = undefined
      throw error
    })
  await tablesReady
  return { auth, close: () => pool.end().catch(() => undefined) }
}

/**
 * Who is visiting a site and with which roles. Signed-in visitors who aren't
 * members yet join with the site's default role when sign-up is allowed.
 */
export async function visitorFor(
  request: Request,
  handle: SiteAuthHandle | null,
  siteId: string,
  settings: SiteAuth | undefined,
  store: ProjectStore,
  redis: RedisLike | null = null,
): Promise<Visitor> {
  if (!settings?.enabled || !handle) return ANONYMOUS
  const session = await handle.auth.api
    .getSession({ headers: request.headers })
    .catch(() => null)
  const user = session?.user as
    { id: string; email: string; name?: string } | undefined
  if (!user) return ANONYMOUS
  // Only roles the app still defines count, even if an old membership names another one.
  const known = (role: string | undefined) =>
    role && settings.roles.some((item) => item.id === role) ? [role] : []
  const visitor = (roles: string[]): Visitor => ({
    signedIn: true,
    id: user.id,
    email: user.email,
    name: user.name ?? null,
    roles,
  })
  const cached = await cachedRole(redis, siteId, user.id)
  if (cached !== undefined) return visitor(known(cached))
  let member = await store.getMember(siteId, user.id)
  const invite = member
    ? null
    : await store.getMember(siteId, `invite:${user.email.toLowerCase()}`)
  if (invite) {
    member = { ...invite, userId: user.id, email: user.email }
    await store.upsertMember(member)
    await store.removeMember(siteId, invite.userId)
  }
  if (!member && settings.allowSignUp) {
    member = {
      siteId,
      userId: user.id,
      email: user.email,
      role: settings.defaultRole,
      createdAt: new Date().toISOString(),
    }
    await store.upsertMember(member)
  }
  await cacheRole(redis, siteId, user.id, member?.role ?? '')
  return visitor(known(member?.role))
}
