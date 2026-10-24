import { Injectable, computed, signal } from '@angular/core'
import { Project, parseProject } from '@spsedu360/engine/model'
import type { FlowResult } from '@spsedu360/engine/flow'
import type { Visitor } from '@spsedu360/engine/access'
import type { EntityKind, EntityStatus } from '@spsedu360/engine/publishing'
import {
  BreakerRegistry,
  StepError,
  callWithPolicy,
} from '@spsedu360/engine/resilience'

export interface AssetRecord {
  id: string
  projectId: string
  key: string
  name: string
  type: string
  size: number
  createdAt: string
  url: string
}

export interface BuilderUser {
  id: string
  email: string
  role: 'admin' | 'author'
  via: 'access' | 'token'
}

export interface MemberRecord {
  siteId: string
  userId: string
  email: string
  role: string
  createdAt: string
}

export interface PublishResult extends ProjectSummary {
  url: string
  live: boolean
  statuses: EntityStatus[]
}

export interface ProjectSummary {
  id: string
  name: string
  updatedAt: string
  publishedAt: string | null
  /** The site's web address once published: <origin>/<slug>/… */
  slug?: string | null
  url?: string
  /** Builder user who owns the app (admins see everyone's). */
  ownerId?: string | null
  pages: number
  flows: number
}

const sitePath = (key: string, bySlug: boolean) =>
  bySlug
    ? `/api/s/${encodeURIComponent(key)}`
    : `/api/sites/${encodeURIComponent(key)}`

/** cloud: saved through the Worker into KV. local: saved in this browser only. */
export type StorageMode = 'checking' | 'cloud' | 'local'

const TOKEN_KEY = 'ps-admin-token'
const LOCAL_KEY = 'ps-projects'
const LEGACY_KEY = 'page-studio-project'
const DRAFT_KEY = 'ps-draft:'

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}
function writeStorage(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, value)
  } catch {
    throw new Error(
      'This browser blocked local storage. Export your project to keep it.',
    )
  }
}

const summarize = (
  project: Project,
  publishedAt: string | null = null,
): ProjectSummary => ({
  id: project.id,
  name: project.name,
  updatedAt: project.updatedAt,
  publishedAt,
  pages: project.pages.length,
  flows: project.flows.length,
})

@Injectable({ providedIn: 'root' })
export class ApiService {
  readonly mode = signal<StorageMode>('checking')
  /** Why cloud storage is unavailable, shown on the landing page. */
  readonly cloudIssue = signal('')
  readonly adminConfigured = signal(false)
  /** Active backend providers, shown to admins. */
  readonly database = signal<'neon' | 'kv' | 'none'>('none')
  readonly secretsProvider = signal<'openbao' | 'database' | 'env'>('env')
  /** Whether the Worker has a file bucket configured. */
  readonly filesEnabled = signal(false)
  /** How the builder signs people in: Cloudflare Access, an admin token, or not set up. */
  readonly builderAuth = signal<'access' | 'token' | 'none'>('none')
  readonly siteAuth = signal(false)
  /** The signed-in builder user. */
  readonly user = signal<BuilderUser | null>(null)
  readonly token = signal(readStorage(TOKEN_KEY) ?? '')
  readonly isCloud = computed(() => this.mode() === 'cloud')
  /** Shared by every server call made from this tab. */
  readonly breakers = new BreakerRegistry()
  private checked: Promise<StorageMode> | undefined

  constructor() {
    this.migrateLegacy()
  }

  /** Detects whether the Worker API is reachable and the token is valid. */
  connect(force = false): Promise<StorageMode> {
    if (!this.checked || force) this.checked = this.detect()
    return this.checked
  }

  private async detect(): Promise<StorageMode> {
    this.mode.set('checking')
    try {
      const response = await fetch('/api/health', { cache: 'no-store' })
      const health =
        response.ok &&
        (response.headers.get('content-type') ?? '').includes('json')
          ? ((await response.json()) as {
              storage: boolean
              adminConfigured: boolean
              database: 'neon' | 'kv' | 'none'
              secrets: 'openbao' | 'database' | 'env'
            })
          : null
      if (!health)
        return this.useLocal('The cloud API is not reachable from here.')
      this.adminConfigured.set(health.adminConfigured)
      this.database.set(health.database ?? 'none')
      this.secretsProvider.set(health.secrets ?? 'env')
      this.filesEnabled.set(!!(health as { files?: boolean }).files)
      const extra = health as {
        builderAuth?: 'access' | 'token' | 'none'
        siteAuth?: boolean
      }
      this.builderAuth.set(extra.builderAuth ?? 'none')
      this.siteAuth.set(!!extra.siteAuth)
      if (!health.storage)
        return this.useLocal('Cloud storage (KV) is not configured yet.')
      if (!health.adminConfigured)
        return this.useLocal(
          'The admin token has not been set on the server yet.',
        )
      // Behind Cloudflare Access the browser's Access session identifies the user; no token needed.
      if (!this.token() && this.builderAuth() !== 'access')
        return this.useLocal('Enter the admin token to use cloud storage.')
      const me = await fetch('/api/me', {
        headers: this.headers(),
        credentials: 'same-origin',
      })
      if (me.status === 401)
        return this.useLocal(
          this.builderAuth() === 'access'
            ? 'Your Cloudflare Access sign-in expired. Reload the page.'
            : 'The saved admin token is not correct.',
        )
      if (!me.ok) return this.useLocal('The cloud API answered with an error.')
      this.user.set((await me.json()) as BuilderUser)
      this.cloudIssue.set('')
      this.mode.set('cloud')
      return 'cloud'
    } catch {
      return this.useLocal('You appear to be offline.')
    }
  }

  private useLocal(reason: string): StorageMode {
    this.cloudIssue.set(reason)
    this.mode.set('local')
    return 'local'
  }

  async signIn(token: string): Promise<boolean> {
    this.token.set(token.trim())
    writeStorage(TOKEN_KEY, token.trim() || null)
    return (await this.connect(true)) === 'cloud'
  }

  signOut(): void {
    this.token.set('')
    writeStorage(TOKEN_KEY, null)
    void this.connect(true)
  }

  private headers(json = false): Record<string, string> {
    return {
      ...(this.token() ? { Authorization: `Bearer ${this.token()}` } : {}),
      ...(json ? { 'Content-Type': 'application/json' } : {}),
    }
  }

  private async request<T>(
    path: string,
    init: RequestInit = {},
    key = path,
  ): Promise<T> {
    return callWithPolicy(
      async (signal) => {
        const response = await fetch(path, {
          ...init,
          signal,
          headers: {
            ...this.headers(!!init.body),
            ...(init.headers as object),
          },
        })
        const body = (response.headers.get('content-type') ?? '').includes(
          'json',
        )
          ? await response.json()
          : null
        if (!response.ok)
          throw new StepError(
            (body as { error?: string } | null)?.error ??
              `Request failed (${response.status}).`,
            response.status,
          )
        return body as T
      },
      {
        key: `api:${init.method ?? 'GET'}:${key}`,
        registry: this.breakers,
        // Only reads are retried automatically; writes are retried by the user.
        retry: {
          attempts: !init.method || init.method === 'GET' ? 3 : 1,
          delayMs: 400,
        },
        breaker: { enabled: true, failureThreshold: 5, cooldownMs: 15_000 },
        timeoutMs: 20_000,
      },
    )
  }

  // ---- Projects (cloud or local) -------------------------------------------

  async list(): Promise<ProjectSummary[]> {
    if ((await this.connect()) === 'cloud')
      return this.request<ProjectSummary[]>('/api/projects')
    return Object.values(this.localProjects())
      .map((entry) => summarize(entry))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  async get(id: string): Promise<Project> {
    if ((await this.connect()) === 'cloud')
      return parseProject(
        JSON.stringify(await this.request<Project>(`/api/projects/${id}`)),
      )
    const project = this.localProjects()[id]
    if (!project) throw new Error('Project not found on this device.')
    return project
  }

  async save(project: Project): Promise<ProjectSummary> {
    const copy: Project = { ...project, updatedAt: new Date().toISOString() }
    if ((await this.connect()) === 'cloud') {
      const summary = await this.request<ProjectSummary>(
        `/api/projects/${project.id}`,
        {
          method: 'PUT',
          body: JSON.stringify(copy),
        },
      )
      this.clearDraft(project.id)
      return summary
    }
    const projects = this.localProjects()
    projects[copy.id] = copy
    writeStorage(LOCAL_KEY, JSON.stringify(projects))
    this.clearDraft(project.id)
    return summarize(copy)
  }

  async remove(id: string): Promise<void> {
    if ((await this.connect()) === 'cloud')
      await this.request(`/api/projects/${id}`, { method: 'DELETE' })
    const projects = this.localProjects()
    delete projects[id]
    writeStorage(LOCAL_KEY, JSON.stringify(projects))
    this.clearDraft(id)
  }

  /** Where the app settings, each page and each component stand against what is live. */
  async publishing(
    projectId: string,
  ): Promise<{ statuses: EntityStatus[]; slug: string | null }> {
    if ((await this.connect()) !== 'cloud')
      throw new Error('Connect cloud storage to publish a live site.')
    return this.request(
      `/api/projects/${projectId}/publishing`,
      {},
      `publishing:${projectId}:${Date.now()}`,
    )
  }

  /** Publishes or unpublishes one part: the app settings, a page or a component. */
  async publishPart(
    projectId: string,
    action: 'publish' | 'unpublish',
    kind: EntityKind,
    id = 'app',
  ): Promise<PublishResult> {
    if ((await this.connect()) !== 'cloud')
      throw new Error('Connect cloud storage to publish a live site.')
    return this.request(
      `/api/projects/${projectId}/${action}`,
      { method: 'POST', body: JSON.stringify({ kind, id }) },
      `${action}:${projectId}:${Date.now()}`,
    )
  }

  /** Puts an older version of one part back into the draft; returns the whole draft. */
  async restorePart(
    projectId: string,
    kind: EntityKind,
    id: string,
    version: number,
  ): Promise<Project> {
    const project = await this.request<Project>(
      `/api/projects/${projectId}/restore`,
      { method: 'POST', body: JSON.stringify({ kind, id, version }) },
      `restore:${projectId}:${Date.now()}`,
    )
    return parseProject(JSON.stringify(project))
  }

  /** Whether an app name (and so its web address) is free, or already this project's. */
  async nameAvailable(
    name: string,
    projectId: string,
  ): Promise<{ slug: string; available: boolean; reason: string }> {
    return this.request(
      `/api/names?name=${encodeURIComponent(name)}&project=${encodeURIComponent(projectId)}`,
      {},
      `name:${name}:${Date.now()}`,
    )
  }

  // ---- Published sites (public) ---------------------------------------------

  /** A published site by internal id, or by its web address when `bySlug` is set. */
  async site(id: string, bySlug = false): Promise<Project> {
    try {
      // Fetched directly (not cached by retries) so it always reflects the visitor's current sign-in.
      const response = await fetch(sitePath(id, bySlug), {
        credentials: 'same-origin',
        cache: 'no-store',
      })
      if (!response.ok)
        throw new StepError(
          (
            (await response.json().catch(() => null)) as {
              error?: string
            } | null
          )?.error ?? `Request failed (${response.status}).`,
          response.status,
        )
      return parseProject(JSON.stringify(await response.json()))
    } catch (error) {
      // Projects kept on this device can still be viewed locally.
      const local = bySlug
        ? Object.values(this.localProjects()).find(
            (project) => project.slug === id,
          )
        : this.localProjects()[id]
      if (local) return local
      throw error
    }
  }

  /** Runs a server flow: the published copy for live sites, or the unsaved copy while building. */
  async runServerFlow(
    project: Project,
    flowId: string,
    body: { input: unknown; params: unknown; query: unknown },
    draft: boolean,
    signal?: AbortSignal,
  ): Promise<FlowResult> {
    const path = draft
      ? `/api/projects/${project.id}/flows/${flowId}/test`
      : `/api/sites/${project.id}/flows/${flowId}/run`
    if (draft && (await this.connect()) !== 'cloud')
      throw new StepError(
        'Server flows run in the cloud. Connect cloud storage to test them.',
        undefined,
        false,
      )
    return this.request<FlowResult>(
      path,
      {
        method: 'POST',
        body: JSON.stringify(draft ? { ...body, project } : body),
        signal,
      },
      `flow:${project.id}:${flowId}`,
    )
  }

  /** Queues a server flow to run in the background (QStash); drafts run straight away. */
  async enqueueFlow(
    project: Project,
    flowId: string,
    body: { input: unknown; params: unknown; query: unknown },
    draft: boolean,
    signal?: AbortSignal,
  ): Promise<string> {
    if (draft) {
      const result = await this.runServerFlow(
        project,
        flowId,
        body,
        true,
        signal,
      )
      if (result.status === 'error')
        throw new StepError(
          result.error ?? 'The background flow failed.',
          undefined,
          false,
        )
      return 'preview-run'
    }
    const response = await this.request<{ messageId: string }>(
      `/api/sites/${project.id}/flows/${flowId}/enqueue`,
      { method: 'POST', body: JSON.stringify(body), signal },
      `enqueue:${project.id}:${flowId}`,
    )
    return response.messageId
  }

  /** Reads tables and columns from an author's database (uses the unsaved project). */
  async loadSchema(
    project: Project,
    dataSourceId: string,
  ): Promise<Record<string, string[]>> {
    if ((await this.connect()) !== 'cloud')
      throw new Error('Connect cloud storage to use databases.')
    const result = await this.request<{ schema: Record<string, string[]> }>(
      `/api/projects/${project.id}/datasources/${dataSourceId}/schema`,
      { method: 'POST', body: JSON.stringify({ project }) },
      `schema:${project.id}:${dataSourceId}`,
    )
    return result.schema
  }

  // ---- People: builder users and site members ------------------------------------

  async users(): Promise<(BuilderUser & { createdAt: string })[]> {
    return this.request('/api/users')
  }
  async setUserRole(id: string, role: 'admin' | 'author'): Promise<void> {
    await this.request(`/api/users/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify({ role }),
    })
  }
  async setOwner(projectId: string, userId: string): Promise<void> {
    await this.request(
      `/api/projects/${projectId}/owner`,
      { method: 'PUT', body: JSON.stringify({ userId }) },
      `owner:${projectId}:${Date.now()}`,
    )
  }

  /** Gives an email address a role on a site; it applies when that person signs in. */
  async addMember(
    projectId: string,
    email: string,
    role: string,
  ): Promise<void> {
    await this.request(
      `/api/projects/${projectId}/members`,
      { method: 'POST', body: JSON.stringify({ email, role }) },
      `member:${projectId}:${Date.now()}`,
    )
  }

  async members(projectId: string): Promise<MemberRecord[]> {
    return this.request(`/api/projects/${projectId}/members`)
  }
  async setMemberRole(
    projectId: string,
    userId: string,
    role: string,
  ): Promise<void> {
    await this.request(
      `/api/projects/${projectId}/members/${encodeURIComponent(userId)}`,
      { method: 'PUT', body: JSON.stringify({ role }) },
    )
  }
  async removeMember(projectId: string, userId: string): Promise<void> {
    await this.request(
      `/api/projects/${projectId}/members/${encodeURIComponent(userId)}`,
      { method: 'DELETE' },
    )
  }

  // ---- Visitors of published sites (Better Auth) ----------------------------------

  async visitor(siteId: string, bySlug = false): Promise<Visitor> {
    const response = await fetch(`${sitePath(siteId, bySlug)}/me`, {
      credentials: 'same-origin',
      cache: 'no-store',
    }).catch(() => null)
    return response?.ok
      ? ((await response.json()) as Visitor)
      : { signedIn: false, id: null, email: null, name: null, roles: [] }
  }

  /** Sign in, sign up or sign out a site visitor; returns an error message or ''. */
  async visitorAuth(
    action: 'sign-in' | 'sign-up' | 'sign-out',
    body: { email?: string; password?: string; name?: string } = {},
  ): Promise<string> {
    const path =
      action === 'sign-out' ? '/api/auth/sign-out' : `/api/auth/${action}/email`
    try {
      const response = await fetch(path, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          action === 'sign-up'
            ? { ...body, name: body.name || body.email }
            : body,
        ),
      })
      if (response.ok) return ''
      const error = (await response.json().catch(() => null)) as {
        message?: string
        error?: string
      } | null
      return (
        error?.message ||
        error?.error ||
        (response.status === 401
          ? 'Wrong email or password.'
          : `Sign-in failed (${response.status}).`)
      )
    } catch {
      return 'You appear to be offline.'
    }
  }

  // ---- Files (S3-compatible bucket) ---------------------------------------------

  async assets(projectId: string): Promise<AssetRecord[]> {
    if ((await this.connect()) !== 'cloud')
      throw new Error('Connect cloud storage to upload files.')
    return this.request<AssetRecord[]>(`/api/projects/${projectId}/assets`)
  }

  /** Uploads straight to the bucket with a signed URL; reports progress from 0 to 1. */
  async uploadAsset(
    projectId: string,
    file: File,
    progress: (fraction: number) => void = () => undefined,
  ): Promise<AssetRecord> {
    const type = file.type || 'application/octet-stream'
    const issued = await this.request<{ uploadUrl: string; fileName: string }>(
      `/api/projects/${projectId}/assets/upload`,
      {
        method: 'POST',
        body: JSON.stringify({ name: file.name, type, size: file.size }),
      },
      `upload:${projectId}`,
    )
    // XMLHttpRequest, because fetch can't report upload progress.
    await new Promise<void>((resolve, reject) => {
      const xhr = new XMLHttpRequest()
      xhr.open('PUT', issued.uploadUrl)
      xhr.setRequestHeader('Content-Type', type)
      xhr.upload.onprogress = (event) =>
        event.lengthComputable && progress(event.loaded / event.total)
      xhr.onload = () =>
        xhr.status >= 200 && xhr.status < 300
          ? resolve()
          : reject(
              new Error(
                `The file store refused the upload (${xhr.status}). Check the bucket's CORS settings.`,
              ),
            )
      xhr.onerror = () =>
        reject(
          new Error(
            "Couldn't reach the file store. Check the bucket's CORS settings allow this site.",
          ),
        )
      xhr.send(file)
    })
    progress(1)
    return this.request<AssetRecord>(
      `/api/projects/${projectId}/assets/complete`,
      {
        method: 'POST',
        body: JSON.stringify({
          fileName: issued.fileName,
          name: file.name,
          type,
        }),
      },
      `complete:${projectId}`,
    )
  }

  async deleteAsset(projectId: string, assetId: string): Promise<void> {
    await this.request(`/api/projects/${projectId}/assets/${assetId}`, {
      method: 'DELETE',
    })
  }

  // ---- Credentials (stored encrypted by the server; values never come back) ------

  async secrets(
    projectId: string,
  ): Promise<{
    provider: 'openbao' | 'database' | 'env'
    writable: boolean
    names: string[]
  }> {
    if ((await this.connect()) !== 'cloud')
      throw new Error('Connect cloud storage to manage credentials.')
    return this.request(`/api/projects/${projectId}/secrets`)
  }

  async saveSecret(
    projectId: string,
    name: string,
    value: string,
  ): Promise<void> {
    await this.request(
      `/api/projects/${projectId}/secrets/${encodeURIComponent(name)}`,
      { method: 'PUT', body: JSON.stringify({ value }) },
    )
  }

  async deleteSecret(projectId: string, name: string): Promise<void> {
    await this.request(
      `/api/projects/${projectId}/secrets/${encodeURIComponent(name)}`,
      { method: 'DELETE' },
    )
  }

  // ---- Unsaved drafts kept on this device ------------------------------------

  saveDraft(project: Project): void {
    try {
      writeStorage(DRAFT_KEY + project.id, JSON.stringify(project))
    } catch {
      /* drafts are best effort */
    }
  }
  draft(id: string): Project | null {
    const raw = readStorage(DRAFT_KEY + id)
    if (!raw) return null
    try {
      return parseProject(raw)
    } catch {
      return null
    }
  }
  clearDraft(id: string): void {
    try {
      writeStorage(DRAFT_KEY + id, null)
    } catch {
      /* ignore */
    }
  }

  private localProjects(): Record<string, Project> {
    const raw = readStorage(LOCAL_KEY)
    if (!raw) return {}
    try {
      const stored = JSON.parse(raw) as Record<string, unknown>
      const projects: Record<string, Project> = {}
      for (const value of Object.values(stored)) {
        try {
          const project = parseProject(JSON.stringify(value))
          projects[project.id] = project
        } catch {
          /* skip damaged entries */
        }
      }
      return projects
    } catch {
      return {}
    }
  }

  /** Moves the single project saved by the first version into the project list. */
  private migrateLegacy(): void {
    const legacy = readStorage(LEGACY_KEY)
    if (!legacy) return
    try {
      const project = parseProject(legacy)
      const projects = this.localProjects()
      projects[project.id] = project
      writeStorage(LOCAL_KEY, JSON.stringify(projects))
      writeStorage(LEGACY_KEY, null)
    } catch {
      /* leave it in place if it can't be read */
    }
  }
}
