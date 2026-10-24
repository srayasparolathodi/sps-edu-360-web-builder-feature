/**
 * Upstash integrations, each optional:
 *   Redis   (UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN): circuit breakers shared by
 *           every Worker isolate, rate limiting for public flow runs, cache of published sites.
 *   QStash  (QSTASH_TOKEN + QSTASH_CURRENT_SIGNING_KEY + QSTASH_NEXT_SIGNING_KEY, and QSTASH_URL for
 *           a regional QStash): background server-flow runs with delivery retries, and cron
 *           schedules for scheduled flows. QStash calls back POST /api/queue/run. When the Worker is
 *           behind Cloudflare Access, set CF_ACCESS_CLIENT_ID + CF_ACCESS_CLIENT_SECRET (an Access
 *           service token with a "Service Auth" policy): QStash then sends them on every call so
 *           Access lets the call through. Each call is also checked against the QStash signature.
 */
import { Redis } from '@upstash/redis/cloudflare'
import { Client, Receiver } from '@upstash/qstash'
import { Project } from '@spsedu360/engine/model'
import { BreakerRegistry, CircuitRecord } from '@spsedu360/engine/resilience'

/** Small Redis surface used here, so tests can fake it. */
export interface RedisLike {
  get<T>(key: string): Promise<T | null>
  set(key: string, value: unknown, options?: { ex: number }): Promise<unknown>
  del(...keys: string[]): Promise<unknown>
  incr(key: string): Promise<number>
  expire(key: string, seconds: number): Promise<unknown>
}

export interface QueueLike {
  publish(
    destination: string,
    body: unknown,
    options: { retries: number; delaySeconds?: number },
  ): Promise<string>
  upsertSchedule(
    id: string,
    destination: string,
    cron: string,
    body: unknown,
  ): Promise<void>
  schedules(prefix: string): Promise<string[]>
  deleteSchedule(id: string): Promise<void>
  verify(signature: string, body: string, url: string): Promise<boolean>
}

export interface Platform {
  redis: RedisLike | null
  queue: QueueLike | null
}

const str = (env: Record<string, unknown>, key: string): string =>
  typeof env[key] === 'string' ? (env[key] as string) : ''

export function createPlatform(env: Record<string, unknown>): Platform {
  const redisUrl = str(env, 'UPSTASH_REDIS_REST_URL')
  const redisToken = str(env, 'UPSTASH_REDIS_REST_TOKEN')
  const qstashToken = str(env, 'QSTASH_TOKEN')
  const current = str(env, 'QSTASH_CURRENT_SIGNING_KEY')
  const next = str(env, 'QSTASH_NEXT_SIGNING_KEY')
  const redis =
    redisUrl && redisToken
      ? (new Redis({
          url: redisUrl,
          token: redisToken,
        }) as unknown as RedisLike)
      : null
  let queue: QueueLike | null = null
  if (qstashToken && current && next) {
    const client = new Client({
      token: qstashToken,
      baseUrl: str(env, 'QSTASH_URL') || undefined,
    })
    // Sent with every QStash delivery so Cloudflare Access admits it (service token).
    const accessId = str(env, 'CF_ACCESS_CLIENT_ID')
    const accessSecret = str(env, 'CF_ACCESS_CLIENT_SECRET')
    const accessHeaders: Record<string, string> =
      accessId && accessSecret
        ? {
            'CF-Access-Client-Id': accessId,
            'CF-Access-Client-Secret': accessSecret,
          }
        : {}
    const receiver = new Receiver({
      currentSigningKey: current,
      nextSigningKey: next,
    })
    queue = {
      async publish(destination, body, options) {
        const result = await client.publishJSON({
          url: destination,
          body,
          headers: accessHeaders,
          retries: options.retries,
          delay: options.delaySeconds,
        })
        return 'messageId' in result ? String(result.messageId) : ''
      },
      async upsertSchedule(id, destination, cron, body) {
        await client.schedules.create({
          scheduleId: id,
          destination,
          cron,
          body: JSON.stringify(body),
          headers: { 'Content-Type': 'application/json', ...accessHeaders },
          retries: 3,
        })
      },
      async schedules(prefix) {
        return (await client.schedules.list())
          .map((schedule) => schedule.scheduleId)
          .filter((id) => id.startsWith(prefix))
      },
      async deleteSchedule(id) {
        await client.schedules.delete(id)
      },
      async verify(signature, body, url) {
        try {
          return await receiver.verify({ signature, body, url })
        } catch {
          return false
        }
      },
    }
  }
  return { redis, queue }
}

// ---- Shared circuit breakers ------------------------------------------------

const breakerKey = (projectId: string) => `ps:breakers:${projectId}`

/** Loads circuit state other isolates recorded, so a failing API is paused everywhere. */
export async function loadBreakers(
  redis: RedisLike | null,
  registry: BreakerRegistry,
  projectId: string,
): Promise<void> {
  if (!redis) return
  try {
    const records = await redis.get<Record<string, CircuitRecord>>(
      breakerKey(projectId),
    )
    if (records) registry.restore(records)
  } catch (error) {
    console.warn('Redis unavailable for breakers:', error)
  }
}

export async function saveBreakers(
  redis: RedisLike | null,
  registry: BreakerRegistry,
  projectId: string,
): Promise<void> {
  if (!redis) return
  try {
    const records = registry.snapshot(`${projectId}:`)
    if (Object.keys(records).length)
      await redis.set(breakerKey(projectId), records, { ex: 3600 })
    else await redis.del(breakerKey(projectId))
  } catch (error) {
    console.warn('Redis unavailable for breakers:', error)
  }
}

// ---- Rate limiting ----------------------------------------------------------

/** Fixed-window limiter; returns false when the caller is over the limit. Fails open if Redis is down. */
export async function allow(
  redis: RedisLike | null,
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<boolean> {
  if (!redis) return true
  try {
    const bucket = `ps:rate:${key}:${Math.floor(Date.now() / 1000 / windowSeconds)}`
    const count = await redis.incr(bucket)
    if (count === 1) await redis.expire(bucket, windowSeconds)
    return count <= limit
  } catch {
    return true
  }
}

// ---- Published site cache ---------------------------------------------------

const siteKey = (id: string) => `ps:site:${id}`

export async function cachedSite(
  redis: RedisLike | null,
  id: string,
): Promise<Project | null> {
  if (!redis) return null
  try {
    return await redis.get<Project>(siteKey(id))
  } catch {
    return null
  }
}

export async function cacheSite(
  redis: RedisLike | null,
  id: string,
  project: Project | null,
): Promise<void> {
  if (!redis) return
  try {
    if (project) await redis.set(siteKey(id), project, { ex: 300 })
    else await redis.del(siteKey(id))
  } catch {
    /* cache is best effort */
  }
}

// ---- Schedules ----------------------------------------------------------------

export const schedulePrefix = (projectId: string) => `ps-${projectId}-`

/** Makes QStash schedules match the published project's scheduled server flows. */
export async function syncSchedules(
  queue: QueueLike | null,
  origin: string,
  project: Project | null,
  projectId: string,
): Promise<string[]> {
  if (!queue) return []
  const wanted = new Map(
    (project?.flows ?? [])
      .filter(
        (flow) =>
          flow.runAt === 'server' &&
          flow.trigger === 'schedule' &&
          flow.schedule,
      )
      .map((flow) => [`${schedulePrefix(projectId)}${flow.id}`, flow]),
  )
  if (wanted.size && !origin.startsWith('https://')) {
    console.warn('Schedules need a public https address; skipped for', origin)
    return []
  }
  for (const id of await queue.schedules(schedulePrefix(projectId)))
    if (!wanted.has(id)) await queue.deleteSchedule(id)
  for (const [id, flow] of wanted)
    await queue.upsertSchedule(
      id,
      `${origin}/api/queue/run`,
      flow.schedule!.trim(),
      { projectId, flowId: flow.id, input: {}, source: 'schedule' },
    )
  return [...wanted.keys()]
}

// ---- Roles of signed-in app users -----------------------------------------------------

/** One entry per app and user: the user's role in that app, or "" for no membership. */
const roleKey = (siteId: string, userId: string) =>
  `ps:role:${siteId}:${userId}`
/** Roles are re-read from the database at least this often, even without a change. */
export const ROLE_TTL_SECONDS = 600

/** The cached role: a role id, "" when the user has no role here, or undefined when not cached. */
export async function cachedRole(
  redis: RedisLike | null,
  siteId: string,
  userId: string,
): Promise<string | undefined> {
  if (!redis) return undefined
  try {
    const value = await redis.get<string>(roleKey(siteId, userId))
    return typeof value === 'string' ? value : undefined
  } catch {
    return undefined
  }
}

export async function cacheRole(
  redis: RedisLike | null,
  siteId: string,
  userId: string,
  role: string,
): Promise<void> {
  if (!redis) return
  try {
    await redis.set(roleKey(siteId, userId), role, { ex: ROLE_TTL_SECONDS })
  } catch {
    /* the database stays the source of truth */
  }
}

/** Called whenever an author or admin changes or removes someone's role. */
export async function forgetRole(
  redis: RedisLike | null,
  siteId: string,
  userId: string,
): Promise<void> {
  if (!redis) return
  try {
    await redis.del(roleKey(siteId, userId))
  } catch {
    /* expires on its own within ROLE_TTL_SECONDS */
  }
}
