/**
 * Cloudflare Worker: serves the Angular app and the backend API.
 *
 *   storage.ts      Neon Postgres (DATABASE_URL) or Workers KV (PROJECTS): projects, flow logic, users, members
 *   identity.ts     builder users from Cloudflare Access (verified JWT), roles admin/author
 *   site-auth.ts    Better Auth sign-in for visitors of published sites, roles per site
 *   compute.ts      backend computation engine for server flows
 *   datasources.ts  authors' PostgreSQL/MySQL databases
 *   secrets.ts      OpenBao (OPENBAO_ADDR + OPENBAO_TOKEN) for credentials entered in the builder
 *   assets.ts       uploaded files and images in an S3-compatible bucket
 *   upstash.ts      Redis (shared breakers, rate limits, cache) and QStash (background + scheduled flows)
 */
import { Project, parseProject } from '@spsedu360/engine/model'
import {
  ANONYMOUS,
  Visitor,
  allows,
  forVisitor,
} from '@spsedu360/engine/access'
import { slugForName } from '@spsedu360/engine/address'
import { nameProblems, statuses } from '@spsedu360/engine/publishing'
import {
  PublishError,
  isKind,
  publishEntity,
  recordChanges,
  restoreEntity,
  unpublishEntity,
} from './publishing'
import {
  ComputeError,
  ComputeRequest,
  runServerFlow,
  systemUser,
} from './compute'
import { callApi as sendApi, safeUrl } from './apis'
import {
  SECRET_NAME,
  SecretsUnavailableError,
  createSecrets,
  redact,
} from './secrets'
import { KVLike, NotFoundError, ProjectStore, createStore } from './storage'
import {
  forgetRole,
  allow,
  cacheSite,
  cachedSite,
  createPlatform,
  syncSchedules,
} from './upstash'
import { readSchema } from './datasources'
import {
  storeVisitorFile,
  AssetError,
  AssetRecord,
  Bucket,
  assetKey,
  assetUrl,
  bucketConfig,
  checkUpload,
  safeFileName,
} from './assets'
import { AuthError, BuilderUser, accessConfig, authenticate } from './identity'
import {
  SiteAuthHandle,
  openSiteAuth,
  siteAuthConfigured,
  visitorFor,
} from './site-auth'

export type { KVLike } from './storage'

export interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> }
  /** Neon Postgres connection string (secret). Preferred storage. */
  DATABASE_URL?: string
  /** Workers KV namespace, used when DATABASE_URL is not set. */
  PROJECTS?: KVLike
  /** Cloudflare Access team domain and application audience, for builder sign-in. */
  CF_ACCESS_TEAM_DOMAIN?: string
  CF_ACCESS_AUD?: string
  /** Encrypts credentials kept in the app database (at least 32 characters). Needed unless OpenBao is used. */
  CREDENTIALS_KEY?: string
  /** Fallback builder sign-in for local development and automation. */
  ADMIN_TOKEN?: string
  /** Signs visitor sessions on published sites (Better Auth). */
  BETTER_AUTH_SECRET?: string
  OPENBAO_ADDR?: string
  OPENBAO_TOKEN?: string
  OPENBAO_MOUNT?: string
  OPENBAO_NAMESPACE?: string
  UPSTASH_REDIS_REST_URL?: string
  UPSTASH_REDIS_REST_TOKEN?: string
  /** QStash region endpoint from the Upstash console; defaults to https://qstash.upstash.io. */
  QSTASH_URL?: string
  /** Cloudflare Access service token that QStash sends, so its calls get past Access. */
  CF_ACCESS_CLIENT_ID?: string
  CF_ACCESS_CLIENT_SECRET?: string
  QSTASH_TOKEN?: string
  QSTASH_CURRENT_SIGNING_KEY?: string
  QSTASH_NEXT_SIGNING_KEY?: string
  /** Neon Object Storage (S3-compatible) for uploaded files; S3_* names are also accepted. */
  AWS_ENDPOINT_URL_S3?: string
  AWS_REGION?: string
  AWS_ACCESS_KEY_ID?: string
  AWS_SECRET_ACCESS_KEY?: string
  S3_BUCKET?: string
  S3_PUBLIC_URL?: string
  [name: string]: unknown
}

const MAX_BODY = 2_000_000
/** A 10 MB file as a base64 data URL, plus the request around it. */
const MAX_FILE_BODY = 14_500_000
/** Origins whose bucket CORS rule was checked in this isolate. */
const corsReady = new Set<string>()
const ID = /^[a-zA-Z0-9-]{1,80}$/
/** Member ids for people invited by email who have not signed in yet. */
const INVITE = 'invite:'

const nameTaken = (name: string) =>
  `Another app is already called “${name}” (or a name that gives the same web address). Choose a different name.`
const slugPattern = (key: string) => /^[a-z0-9-]{3,40}$/.test(key)

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

const json = (
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...headers,
    },
  })

async function readBody(
  request: Request,
  max = MAX_BODY,
): Promise<Record<string, unknown>> {
  const length = Number(request.headers.get('Content-Length') ?? 0)
  if (length > max) throw new HttpError(413, 'Request is too large.')
  const text = await request.text()
  if (text.length > max) throw new HttpError(413, 'Request is too large.')
  try {
    const body = text ? JSON.parse(text) : {}
    return body && typeof body === 'object' ? body : {}
  } catch {
    throw new HttpError(400, 'Request body must be JSON.')
  }
}

function validProject(value: unknown, id: string): Project {
  let project: Project
  try {
    project = parseProject(JSON.stringify(value))
  } catch (error) {
    throw new HttpError(
      422,
      error instanceof Error ? error.message : 'Invalid project.',
    )
  }
  if (project.id !== id)
    throw new HttpError(422, 'Project id does not match the address.')
  return project
}

async function found<T>(
  value: Promise<T | null>,
  message = 'Project not found.',
): Promise<T> {
  const result = await value
  if (!result) throw new HttpError(404, message)
  return result
}

const plainObject = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined

const computeRequest = (body: Record<string, unknown>): ComputeRequest => {
  const state = plainObject(body['state'])
  return {
    input: body['input'],
    params: body['params'],
    query: body['query'],
    ...(state
      ? {
          state: {
            vars: plainObject(state['vars']),
            session: plainObject(state['session']),
            local: plainObject(state['local']),
          },
        }
      : {}),
  }
}

/** Authors may only touch their own projects; admins may touch all. */
/** Authors build one app (with any number of pages, journeys and versions); admins have no limit. */
const AUTHOR_PROJECT_LIMIT = 1

/**
 * Admins may edit every project. Authors may edit only projects they own, and may create
 * a project only while they own fewer than AUTHOR_PROJECT_LIMIT. Returns whether the project is new.
 */
/**
 * Saves a draft: names must be unique (the app name across the server, page and component names
 * within the app), and every changed page, component or app setting becomes a new draft version.
 */
async function saveProject(
  store: ProjectStore,
  project: Project,
  userId: string,
  isNew: boolean,
) {
  const problems = nameProblems(project)
  if (problems.length) throw new HttpError(422, problems[0])
  project.updatedAt = new Date().toISOString()
  project.slug = slugForName(project.name, project.id)
  if (isNew) {
    // Claim the name before the first save, so a name taken by someone else never creates a project.
    if ((await store.slugOwner(project.slug)) !== null)
      throw new HttpError(409, nameTaken(project.name))
    const summary = await store.saveDraft(project, userId)
    if (!(await store.claimSlug(project.id, project.slug))) {
      await store.remove(project.id)
      throw new HttpError(409, nameTaken(project.name))
    }
    await recordChanges(store, project, userId)
    return { ...summary, slug: project.slug }
  }
  if (!(await store.claimSlug(project.id, project.slug)))
    throw new HttpError(409, nameTaken(project.name))
  const summary = await store.saveDraft(project, userId)
  await recordChanges(store, project, userId)
  return summary
}

export async function canEdit(
  store: ProjectStore,
  user: BuilderUser,
  projectId: string,
  method: string,
): Promise<boolean> {
  const exists = !!(await store.getDraft(projectId))
  if (!exists) {
    if (method !== 'PUT') {
      if (user.role === 'admin') return false
      throw new NotFoundError('Project not found.')
    }
    if (
      user.role !== 'admin' &&
      (await store.list(user.id)).length >= AUTHOR_PROJECT_LIMIT
    )
      throw new HttpError(
        403,
        'Authors can have one app. Add pages, journeys and versions to it, or ask an admin for another.',
      )
    return true
  }
  if (user.role === 'admin') return false
  // Projects without an owner (made before ownership existed) are admin-only.
  if ((await store.owner(projectId)) !== user.id)
    throw new HttpError(403, 'This project belongs to someone else.')
  return false
}

export async function handleApi(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url)
  const parts = url.pathname
    .replace(/^\/api\/?/, '')
    .split('/')
    .filter(Boolean)
  const method = request.method
  const platform = createPlatform(env)
  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown'
  let siteAuth: SiteAuthHandle | null = null
  try {
    const store: ProjectStore | null = createStore(env)
    const secrets = createSecrets(env, store)
    if (parts[0] === 'health' && method === 'GET')
      return json({
        ok: true,
        storage: !!store,
        database: store?.kind ?? 'none',
        secrets: secrets.kind,
        redis: !!platform.redis,
        queue: !!platform.queue,
        files: !!bucketConfig(env),
        builderAuth: accessConfig(env)
          ? 'access'
          : env.ADMIN_TOKEN
            ? 'token'
            : 'none',
        siteAuth: siteAuthConfigured(env),
        adminConfigured: !!(accessConfig(env) || env.ADMIN_TOKEN),
      })
    if (!store)
      throw new HttpError(
        503,
        'No storage configured. Set the DATABASE_URL secret (Neon) or bind a KV namespace as PROJECTS.',
      )

    // ---- Visitor sign-in (Better Auth) --------------------------------------
    if (parts[0] === 'auth') {
      siteAuth = await openSiteAuth(env, url.origin)
      if (!siteAuth)
        throw new HttpError(
          503,
          'Site sign-in needs DATABASE_URL and BETTER_AUTH_SECRET (32+ characters).',
        )
      return await siteAuth.auth.handler(request)
    }

    // ---- Builder: who am I, users ------------------------------------------
    if (parts[0] === 'me' && method === 'GET')
      return json(await authenticate(request, env, store))
    if (parts[0] === 'users') {
      const user = await authenticate(request, env, store)
      if (user.role !== 'admin')
        throw new HttpError(403, 'Only admins can manage people.')
      if (parts.length === 1 && method === 'GET')
        return json(await store.listUsers())
      if (parts[1] && method === 'PUT') {
        const role = (await readBody(request))['role']
        if (role !== 'admin' && role !== 'author')
          throw new HttpError(400, 'Role must be admin or author.')
        if (parts[1] === user.id && role !== 'admin')
          throw new HttpError(400, "You can't remove your own admin role.")
        await store.setUserRole(parts[1], role)
        return json({ ok: true })
      }
    }

    // ---- Builder API: projects -----------------------------------------------
    // Is this app name free? Answers with the address the name would get.
    if (parts[0] === 'names' && method === 'GET') {
      await authenticate(request, env, store)
      const name = (url.searchParams.get('name') ?? '').trim()
      const projectId = url.searchParams.get('project') ?? ''
      if (!name)
        return json({
          slug: '',
          available: false,
          mine: false,
          reason: 'Give the app a name.',
        })
      const slug = slugForName(name, projectId)
      const holder = await store.slugOwner(slug)
      const mine = !!holder && holder === projectId
      return json({
        slug,
        available: !holder || mine,
        mine,
        reason: holder && !mine ? nameTaken(name) : '',
      })
    }

    if (parts[0] === 'projects') {
      const user = await authenticate(request, env, store)
      const id = parts[1]
      if (!id) {
        if (method === 'GET')
          return json(
            await store.list(user.role === 'admin' ? undefined : user.id),
          )
        throw new HttpError(405, 'Method not allowed.')
      }
      if (!ID.test(id)) throw new HttpError(400, 'Invalid project id.')
      const isNew = await canEdit(
        store,
        user,
        id,
        parts.length === 2 ? method : 'GET',
      )
      if (parts.length === 2) {
        if (method === 'GET') return json(await found(store.getDraft(id)))
        if (method === 'PUT')
          return json(
            await saveProject(
              store,
              validProject(await readBody(request), id),
              user.id,
              isNew,
            ),
          )
        if (method === 'DELETE') {
          await store.remove(id)
          await cacheSite(platform.redis, id, null)
          await syncSchedules(platform.queue, url.origin, null, id).catch(
            () => [],
          )
          return json({ ok: true })
        }
      }
      // Publishing, one part at a time: { kind: 'app' | 'page' | 'component', id }.
      if (parts[2] === 'publishing' && method === 'GET') {
        const draft = await found(store.getDraft(id))
        return json({
          statuses: await statuses(draft, await store.listEntityVersions(id)),
          slug: draft.slug ?? null,
        })
      }
      if (
        (parts[2] === 'publish' ||
          parts[2] === 'unpublish' ||
          parts[2] === 'restore') &&
        method === 'POST'
      ) {
        const body = await readBody(request).catch(
          () => ({}) as Record<string, unknown>,
        )
        const kind = body['kind'] ?? 'app'
        const entityId = kind === 'app' ? 'app' : String(body['id'] ?? '')
        if (!isKind(kind) || !ID.test(entityId))
          throw new HttpError(
            400,
            'Say which page, component or app to publish.',
          )
        const draft = await found(store.getDraft(id))
        if (parts[2] === 'restore') {
          const version = Number(body['version'])
          if (!Number.isInteger(version) || version < 1)
            throw new HttpError(400, 'Invalid version.')
          const restored = validProject(
            await restoreEntity(store, draft, kind, entityId, version),
            id,
          )
          await saveProject(store, restored, user.id, false)
          return json(restored)
        }
        // Projects saved before addresses existed claim theirs here.
        const slug = slugForName(draft.name, id)
        if (!(await store.claimSlug(id, slug)))
          throw new HttpError(409, nameTaken(draft.name))
        const site =
          parts[2] === 'publish'
            ? (await publishEntity(store, draft, kind, entityId, user.id)).site
            : await unpublishEntity(store, draft, kind, entityId)
        await cacheSite(platform.redis, id, site)
        const schedules = await syncSchedules(
          platform.queue,
          url.origin,
          site,
          id,
        ).catch((error) => {
          console.warn('Could not sync schedules:', error)
          return []
        })
        const summary = (await store.list()).find((item) => item.id === id)
        return json({
          ...summary,
          slug,
          url: `${url.origin}/${slug}`,
          live: !!site,
          schedules: schedules.length,
          statuses: await statuses(draft, await store.listEntityVersions(id)),
        })
      }

      if (parts[2] === 'owner' && method === 'PUT') {
        if (user.role !== 'admin')
          throw new HttpError(403, 'Only admins can change who owns an app.')
        const ownerId = String((await readBody(request))['userId'] ?? '')
        if (!(await store.listUsers()).some((item) => item.id === ownerId))
          throw new HttpError(400, 'That builder user does not exist.')
        await store.setOwner(id, ownerId)
        return json({ ok: true })
      }

      // Site members and their roles. People can be invited by email before they create an account.
      if (parts[2] === 'members') {
        if (parts.length === 3 && method === 'GET')
          return json(await store.listMembers(id))
        if (parts.length === 3 && method === 'POST') {
          const body = await readBody(request)
          const project = await found(store.getDraft(id))
          const email = String(body['email'] ?? '')
            .trim()
            .toLowerCase()
          const role = String(body['role'] ?? '')
          if (!/^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/.test(email))
            throw new HttpError(400, 'Enter a valid email address.')
          if (!project.auth?.roles.some((item) => item.id === role))
            throw new HttpError(400, 'That role does not exist on this site.')
          const existing = (await store.listMembers(id)).find(
            (member) => member.email.toLowerCase() === email,
          )
          await store.upsertMember({
            siteId: id,
            userId: existing?.userId ?? `${INVITE}${email}`,
            email,
            role,
            createdAt: existing?.createdAt ?? new Date().toISOString(),
          })
          if (existing) await forgetRole(platform.redis, id, existing.userId)
          return json({ ok: true }, 201)
        }
        if (parts[3]) parts[3] = decodeURIComponent(parts[3])
        if (parts[3] && method === 'PUT') {
          const body = await readBody(request)
          const project = await found(store.getDraft(id))
          const role = String(body['role'] ?? '')
          if (!project.auth?.roles.some((item) => item.id === role))
            throw new HttpError(400, 'That role does not exist on this site.')
          const existing = await store.getMember(id, parts[3])
          await store.upsertMember({
            siteId: id,
            userId: parts[3],
            email: existing?.email ?? String(body['email'] ?? ''),
            role,
            createdAt: existing?.createdAt ?? new Date().toISOString(),
          })
          await forgetRole(platform.redis, id, parts[3])
          return json({ ok: true })
        }
        if (parts[3] && method === 'DELETE') {
          await store.removeMember(id, parts[3])
          await forgetRole(platform.redis, id, parts[3])
          return json({ ok: true })
        }
      }

      // Credentials: names only ever leave the server.
      if (parts[2] === 'secrets') {
        const name = parts[3]
        if (!name && method === 'GET')
          return json({
            provider: secrets.kind,
            writable: secrets.writable,
            names: await secrets.names(id),
          })
        if (name) {
          if (!SECRET_NAME.test(name))
            throw new HttpError(
              400,
              'Use letters, numbers and _ for credential names.',
            )
          if (method === 'PUT') {
            const value = (await readBody(request))['value']
            if (typeof value !== 'string' || !value || value.length > 10_000)
              throw new HttpError(
                400,
                'Enter the credential value (up to 10,000 characters).',
              )
            await secrets.put(id, name, value)
            return json({ ok: true })
          }
          if (method === 'DELETE') {
            await secrets.remove(id, name)
            return json({ ok: true })
          }
        }
      }

      // Files: signed upload, confirm, list, delete.
      if (parts[2] === 'assets') {
        const config = bucketConfig(env)
        if (!config)
          throw new HttpError(
            503,
            'File uploads need the Neon Object Storage settings (AWS_ENDPOINT_URL_S3, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY) on the Worker.',
          )
        const bucket = new Bucket(config)
        if (parts.length === 3 && method === 'GET')
          return json(await store.listAssets(id))
        if (parts[3] === 'upload' && method === 'POST') {
          const body = await readBody(request)
          const name = String(body['name'] ?? '')
          const type = String(body['type'] ?? '')
          const size = Number(body['size'])
          checkUpload(name, type, size)
          const fileName = `${crypto.randomUUID().slice(0, 8)}-${safeFileName(name)}`
          const key = assetKey(id, fileName)
          // Browsers upload straight to the bucket, so it must allow this site's origin (checked once per origin).
          const origin = request.headers.get('Origin') ?? url.origin
          if (!corsReady.has(origin)) {
            await bucket
              .allowOrigin(origin)
              .catch((error) =>
                console.warn('Could not update bucket CORS rules:', error),
              )
            corsReady.add(origin)
          }
          return json({
            uploadUrl: await bucket.uploadUrl(key, type),
            key,
            fileName,
          })
        }
        if (parts[3] === 'complete' && method === 'POST') {
          const body = await readBody(request)
          const fileName = String(body['fileName'] ?? '')
          if (!/^[0-9a-f]{8}-[\w.-]{1,80}$/.test(fileName))
            throw new HttpError(400, 'Invalid file.')
          const key = assetKey(id, fileName)
          const stored = await bucket.head(key)
          if (!stored)
            throw new HttpError(
              409,
              'The upload did not finish. Please try again.',
            )
          checkUpload(
            String(body['name'] ?? fileName),
            stored.type || String(body['type'] ?? ''),
            stored.size,
          )
          const asset: AssetRecord = {
            id: crypto.randomUUID(),
            projectId: id,
            key,
            name: String(body['name'] ?? fileName).slice(0, 200),
            type: stored.type || String(body['type'] ?? ''),
            size: stored.size,
            createdAt: new Date().toISOString(),
            url: assetUrl(id, fileName),
          }
          await store.addAsset(asset)
          return json(asset)
        }
        if (parts[3] && parts.length === 4 && method === 'DELETE') {
          const asset = await found(
            store.getAsset(id, parts[3]),
            'File not found.',
          )
          await bucket.remove(asset.key)
          await store.removeAsset(id, asset.id)
          return json({ ok: true })
        }
      }

      // Load a data source's tables and columns (uses the unsaved copy of the project).
      if (
        parts[2] === 'datasources' &&
        parts[3] &&
        parts[4] === 'schema' &&
        method === 'POST'
      ) {
        const body = await readBody(request)
        const project = validProject(body['project'], id)
        const source = project.dataSources.find((item) => item.id === parts[3])
        if (!source) throw new HttpError(404, 'Data source not found.')
        try {
          return json({
            schema: await readSchema(source, await secrets.values(id)),
          })
        } catch (error) {
          throw new HttpError(
            502,
            error instanceof Error
              ? error.message
              : 'Could not read the database.',
          )
        }
      }

      // Test a saved API against the unsaved copy of the project; shows status, answer and the address used.
      if (
        parts[2] === 'apis' &&
        parts[3] &&
        parts[4] === 'test' &&
        method === 'POST'
      ) {
        const body = await readBody(request)
        const project = validProject(body['project'], id)
        const api = project.apis?.find((item) => item.id === parts[3])
        if (!api) throw new HttpError(404, 'That API is not in the project.')
        const values = await secrets
          .values(id)
          .catch(() => ({}) as Record<string, string>)
        const args =
          body['args'] && typeof body['args'] === 'object'
            ? (body['args'] as Record<string, unknown>)
            : {}
        const started = Date.now()
        try {
          const response = await sendApi(api, args, { secrets: values })
          return json({
            ...redact(response, values),
            durationMs: Date.now() - started,
            request: { method: api.method, url: safeUrl(api.url, values) },
          })
        } catch (error) {
          return json({
            ok: false,
            status: (error as { status?: number }).status ?? 0,
            error: redact(
              error instanceof Error ? error.message : 'The call failed.',
              values,
            ),
            durationMs: Date.now() - started,
          })
        }
      }
      // Store a file the way a journey's "Save uploaded file" step does, for testing in the builder.
      if (parts[2] === 'files' && parts[3] === 'store' && method === 'POST') {
        const body = await readBody(request, MAX_FILE_BODY)
        return json(
          await storeVisitorFile(
            env,
            url.origin,
            id,
            (body['file'] ?? {}) as Record<string, unknown>,
          ),
        )
      }
      // Test a server flow against the unsaved copy of the project, as an all-roles visitor.
      if (
        parts[2] === 'flows' &&
        parts[3] &&
        parts[4] === 'test' &&
        method === 'POST'
      ) {
        const body = await readBody(request)
        const project = validProject(body['project'], id)
        const tester: Visitor = {
          signedIn: true,
          id: `builder:${user.id}`,
          email: user.email,
          name: user.email,
          roles: project.auth?.roles.map((role) => role.id) ?? [],
        }
        return json(
          await runServerFlow({
            project,
            flowId: parts[3],
            request: computeRequest(body),
            origin: url.origin,
            secrets,
            store,
            source: 'test',
            redis: platform.redis,
            user: tester,
          }),
        )
      }
      throw new HttpError(404, 'Unknown API address.')
    }

    // ---- Queue callbacks (QStash) ------------------------------------------
    if (parts[0] === 'queue' && parts[1] === 'run' && method === 'POST') {
      if (!platform.queue)
        throw new HttpError(
          503,
          'Background runs need QStash to be configured.',
        )
      const text = await request.text()
      const signature = request.headers.get('Upstash-Signature') ?? ''
      if (
        !signature ||
        !(await platform.queue.verify(signature, text, request.url))
      )
        throw new HttpError(401, 'Invalid queue signature.')
      const job = JSON.parse(text || '{}') as {
        projectId?: string
        flowId?: string
        source?: string
        user?: Visitor
      } & Record<string, unknown>
      if (!job.projectId || !ID.test(job.projectId) || !job.flowId)
        throw new HttpError(400, 'Invalid job.')
      const project = await found(store.getSite(job.projectId))
      // The job body is signed by QStash. Scheduled jobs run as the system; background runs keep the
      // identity of the person who triggered them, whose access was checked when they queued it.
      const scheduled = job.source === 'schedule'
      const result = await runServerFlow({
        project,
        flowId: job.flowId,
        request: computeRequest(job),
        origin: url.origin,
        secrets,
        store,
        source: scheduled ? 'schedule' : 'queue',
        redis: platform.redis,
        user: scheduled ? systemUser(project) : (job.user ?? ANONYMOUS),
        system: true,
      })
      // A failed run answers 502 so QStash delivers it again with its own retries.
      return json(
        { status: result.status, error: result.error },
        result.status === 'error' ? 502 : 200,
      )
    }

    // ---- Public file links: /api/files/<projectId>/<file> → bucket ----------
    if (
      parts[0] === 'files' &&
      parts[1] &&
      ID.test(parts[1]) &&
      parts[2] &&
      method === 'GET'
    ) {
      const config = bucketConfig(env)
      if (!config) throw new HttpError(404, 'File not found.')
      const fileName = decodeURIComponent(parts[2])
      if (!/^[0-9a-f]{8}-[\w.-]{1,80}$/.test(fileName))
        throw new HttpError(404, 'File not found.')
      const target = await new Bucket(config).downloadUrl(
        assetKey(parts[1], fileName),
      )
      return new Response(null, {
        status: 302,
        headers: { Location: target, 'Cache-Control': 'public, max-age=3000' },
      })
    }

    // ---- Public API: published sites ---------------------------------------
    const siteKey =
      parts[0] === 'sites' && parts[1] && ID.test(parts[1])
        ? parts[1]
        : parts[0] === 's' && parts[1] && slugPattern(parts[1])
          ? ((await store.slugOwner(parts[1])) ?? undefined)
          : undefined
    if (parts[0] === 's' && parts[1] && !siteKey)
      throw new HttpError(404, 'No site uses this address.')
    if (siteKey) {
      const siteId = siteKey
      const loadSite = async () => {
        const cached = await cachedSite(platform.redis, siteId)
        if (cached) return cached
        const site = await found(store.getSite(siteId))
        await cacheSite(platform.redis, siteId, site)
        return site
      }
      const project = await loadSite()
      const protectedSite = !!project.auth?.enabled
      if (protectedSite) siteAuth = await openSiteAuth(env, url.origin)
      const visitor = await visitorFor(
        request,
        siteAuth,
        siteId,
        project.auth,
        store,
        platform.redis,
      )

      if (parts.length === 2 && method === 'GET')
        // Only what this visitor may see leaves the server.
        return json(forVisitor(project, visitor), 200, {
          'Cache-Control': protectedSite
            ? 'private, no-store'
            : 'public, max-age=30',
        })
      if (parts[2] === 'me' && method === 'GET') return json(visitor)
      if (
        parts[2] === 'apis' &&
        parts[3] &&
        parts[4] === 'call' &&
        method === 'POST'
      ) {
        if (!(await allow(platform.redis, `api:${ip}`, 120, 60)))
          throw new HttpError(
            429,
            'Too many requests. Please wait a moment and try again.',
          )
        const api = project.apis?.find((item) => item.id === parts[3])
        // Server-only APIs cannot be called from pages.
        if (!api || !api.browser)
          throw new HttpError(404, 'This API is not available to pages.')
        if (!allows(api.access, visitor))
          throw new HttpError(
            visitor.signedIn ? 403 : 401,
            visitor.signedIn
              ? 'You do not have access to this.'
              : 'Please sign in first.',
          )
        const body = await readBody(request)
        const args =
          body['args'] && typeof body['args'] === 'object'
            ? (body['args'] as Record<string, unknown>)
            : {}
        const values = await secrets
          .values(project.id)
          .catch(() => ({}) as Record<string, string>)
        try {
          return json(
            redact(await sendApi(api, args, { secrets: values }), values),
          )
        } catch (error) {
          throw new HttpError(
            (error as { retryable?: boolean }).retryable === false ? 400 : 502,
            redact(
              error instanceof Error ? error.message : 'The call failed.',
              values,
            ),
          )
        }
      }
      if (parts[2] === 'files' && parts[3] === 'store' && method === 'POST') {
        if (!(await allow(platform.redis, `file:${ip}`, 20, 60)))
          throw new HttpError(
            429,
            'Too many uploads. Please wait a moment and try again.',
          )
        const body = await readBody(request, MAX_FILE_BODY)
        // Only journeys that really save files can store them, and only for visitors allowed to run them.
        const flow = project.flows.find((item) => item.id === body['flowId'])
        if (!flow || !flow.steps.some((step) => step.type === 'storeFile'))
          throw new HttpError(403, 'This page cannot store files.')
        if (!allows(flow.access, visitor))
          throw new HttpError(
            visitor.signedIn ? 403 : 401,
            visitor.signedIn
              ? 'You do not have access to this.'
              : 'Please sign in first.',
          )
        return json(
          await storeVisitorFile(
            env,
            url.origin,
            project.id,
            (body['file'] ?? {}) as Record<string, unknown>,
          ),
        )
      }
      if (
        parts[2] === 'flows' &&
        parts[3] &&
        (parts[4] === 'run' || parts[4] === 'enqueue') &&
        method === 'POST'
      ) {
        if (!(await allow(platform.redis, `run:${ip}`, 120, 60)))
          throw new HttpError(
            429,
            'Too many requests. Please wait a moment and try again.',
          )
        const body = await readBody(request)
        const flow = project.flows.find((item) => item.id === parts[3])
        if (flow && !allows(flow.access, visitor))
          throw new HttpError(
            visitor.signedIn ? 403 : 401,
            visitor.signedIn
              ? 'You do not have access to this.'
              : 'Please sign in first.',
          )
        if (parts[4] === 'enqueue') {
          if (!platform.queue)
            throw new HttpError(
              503,
              'Background runs need QStash to be configured.',
            )
          if (!flow || flow.runAt !== 'server')
            throw new HttpError(
              400,
              'Only server flows can run in the background.',
            )
          const messageId = await platform.queue.publish(
            `${url.origin}/api/queue/run`,
            {
              ...computeRequest(body),
              projectId: project.id,
              flowId: flow.id,
              source: 'queue',
              user: visitor,
            },
            { retries: 3 },
          )
          return json({ queued: true, messageId }, 202)
        }
        return json(
          await runServerFlow({
            project,
            flowId: parts[3],
            request: computeRequest(body),
            origin: url.origin,
            secrets,
            store,
            source: 'site',
            storeFile: (file) =>
              storeVisitorFile(env, url.origin, project.id, file),
            redis: platform.redis,
            user: visitor,
          }),
        )
      }
    }
    throw new HttpError(404, 'Unknown API address.')
  } catch (error) {
    if (
      error instanceof HttpError ||
      error instanceof ComputeError ||
      error instanceof AuthError ||
      error instanceof AssetError ||
      error instanceof PublishError
    )
      return json({ error: error.message }, error.status)
    if (error instanceof NotFoundError)
      return json({ error: error.message }, 404)
    if (error instanceof SecretsUnavailableError)
      return json({ error: error.message }, 503)
    console.error(error)
    return json({ error: 'Unexpected server error.' }, 500)
  } finally {
    await siteAuth?.close()
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === '/api' || url.pathname.startsWith('/api/'))
      return handleApi(request, env)
    return env.ASSETS.fetch(request)
  },
}
