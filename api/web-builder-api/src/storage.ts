import { neon } from '@neondatabase/serverless'
import type { EntityKind, EntityVersion } from '@spsedu360/engine/publishing'
import { Project } from '@spsedu360/engine/model'
import type { AssetRecord } from './assets'
import type { BuilderRole } from './identity'

export interface UserRecord {
  id: string
  email: string
  role: BuilderRole
  createdAt: string
}

export interface MemberRecord {
  siteId: string
  userId: string
  email: string
  role: string
  createdAt: string
}

export interface ProjectSummary {
  id: string
  name: string
  ownerId?: string | null
  updatedAt: string
  publishedAt: string | null
  /** The site's web address, once claimed. */
  slug?: string | null
  pages: number
  flows: number
}

export type RunSource = 'site' | 'test' | 'queue' | 'schedule'

export interface FlowRunRecord {
  projectId: string
  flowId: string
  source: RunSource
  status: string
  durationMs: number
  error: string | null
}

/** Where projects, published sites and flow logic are kept. */
export interface ProjectStore {
  readonly kind: 'neon' | 'kv'
  /** All projects, or only those owned by `ownerId`. */
  list(ownerId?: string): Promise<ProjectSummary[]>
  getDraft(id: string): Promise<Project | null>
  /** Who created the project (null for projects made before ownership existed). */
  owner(id: string): Promise<string | null>
  /** Saves the draft; keeps the existing published date and owner. */
  saveDraft(project: Project, ownerId?: string): Promise<ProjectSummary>
  remove(id: string): Promise<void>
  publish(id: string): Promise<ProjectSummary>
  unpublish(id: string): Promise<ProjectSummary>
  getSite(id: string): Promise<Project | null>
  /**
   * Reserves `slug` for site `id` and releases the site's previous slug.
   * Returns false when another site already holds it. A slug stays with its site
   * after unpublishing, and is freed only when the project is deleted.
   */
  claimSlug(id: string, slug: string): Promise<boolean>
  /** The site id holding a slug, or null. */
  slugOwner(slug: string): Promise<string | null>
  slugOf(id: string): Promise<string | null>
  /** Admin only: hands a project to another builder user. */
  setOwner(id: string, ownerId: string): Promise<void>
  /** Versions of the app settings, pages and components (no content). */
  listEntityVersions(projectId: string): Promise<EntityVersion[]>
  getEntityData(
    projectId: string,
    kind: EntityKind,
    entityId: string,
    version: number,
  ): Promise<unknown | null>
  addEntityVersion(record: EntityVersion, data: unknown): Promise<void>
  /** Changes status and pins of existing versions. */
  updateEntityVersions(changes: EntityVersion[]): Promise<void>
  deleteEntityVersions(records: EntityVersion[]): Promise<void>
  /** Stores the assembled live app; returns the publish time. */
  saveSite(id: string, site: Project): Promise<string>
  /** Encrypted credentials (see secrets.ts); values are ciphertext. */
  secretRows(projectId: string): Promise<Record<string, string>>
  putSecretRow(projectId: string, name: string, value: string): Promise<void>
  removeSecretRow(projectId: string, name: string): Promise<void>
  logRun(run: FlowRunRecord): Promise<void>
  listAssets(projectId: string): Promise<AssetRecord[]>
  addAsset(asset: AssetRecord): Promise<void>
  getAsset(projectId: string, id: string): Promise<AssetRecord | null>
  removeAsset(projectId: string, id: string): Promise<void>
  upsertUser(id: string, email: string): Promise<BuilderRole>
  listUsers(): Promise<UserRecord[]>
  setUserRole(id: string, role: BuilderRole): Promise<void>
  listMembers(siteId: string): Promise<MemberRecord[]>
  getMember(siteId: string, userId: string): Promise<MemberRecord | null>
  upsertMember(member: MemberRecord): Promise<void>
  removeMember(siteId: string, userId: string): Promise<void>
}

export class NotFoundError extends Error {}

const summarize = (
  project: Project,
  publishedAt: string | null,
): ProjectSummary => ({
  id: project.id,
  name: project.name,
  updatedAt: project.updatedAt,
  publishedAt,
  pages: project.pages.length,
  flows: project.flows.length,
})

// ---------------------------------------------------------------------------
// Neon Postgres (preferred): set DATABASE_URL as a Worker secret.
// ---------------------------------------------------------------------------

/** Minimal SQL surface used here, so tests can provide a fake. */
export interface SqlClient {
  query(text: string, params?: unknown[]): Promise<Record<string, unknown>[]>
  transaction(queries: Promise<unknown>[]): Promise<unknown>
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS ps_projects (
     id text PRIMARY KEY,
     name text NOT NULL,
     data jsonb NOT NULL,
     pages integer NOT NULL DEFAULT 0,
     flows integer NOT NULL DEFAULT 0,
     updated_at timestamptz NOT NULL DEFAULT now(),
     published_at timestamptz
   )`,
  `CREATE TABLE IF NOT EXISTS ps_sites (
     id text PRIMARY KEY REFERENCES ps_projects(id) ON DELETE CASCADE,
     data jsonb NOT NULL,
     published_at timestamptz NOT NULL DEFAULT now()
   )`,
  // Each flow's logic is also stored as its own row so it can be queried and audited.
  `CREATE TABLE IF NOT EXISTS ps_flows (
     project_id text NOT NULL REFERENCES ps_projects(id) ON DELETE CASCADE,
     flow_id text NOT NULL,
     name text NOT NULL,
     run_at text NOT NULL,
     trigger text NOT NULL,
     definition jsonb NOT NULL,
     updated_at timestamptz NOT NULL DEFAULT now(),
     PRIMARY KEY (project_id, flow_id)
   )`,
  `CREATE TABLE IF NOT EXISTS ps_flow_runs (
     id bigserial PRIMARY KEY,
     project_id text NOT NULL,
     flow_id text NOT NULL,
     source text NOT NULL,
     status text NOT NULL,
     duration_ms integer NOT NULL,
     error text,
     created_at timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS ps_flow_runs_lookup ON ps_flow_runs (project_id, flow_id, created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS ps_assets (
     id text PRIMARY KEY,
     project_id text NOT NULL,
     key text NOT NULL,
     name text NOT NULL,
     type text NOT NULL,
     size bigint NOT NULL,
     url text NOT NULL,
     created_at timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS ps_assets_project ON ps_assets (project_id, created_at DESC)`,
  `ALTER TABLE ps_projects ADD COLUMN IF NOT EXISTS owner_id text`,
  `CREATE TABLE IF NOT EXISTS ps_users (
     id text PRIMARY KEY,
     email text NOT NULL,
     role text NOT NULL,
     created_at timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS ps_site_members (
     site_id text NOT NULL,
     user_id text NOT NULL,
     email text NOT NULL,
     role text NOT NULL,
     created_at timestamptz NOT NULL DEFAULT now(),
     PRIMARY KEY (site_id, user_id)
   )`,
  // One row per address; the primary key makes each address unique across all sites.
  `CREATE TABLE IF NOT EXISTS ps_slugs (
     slug text PRIMARY KEY,
     site_id text NOT NULL REFERENCES ps_projects(id) ON DELETE CASCADE,
     created_at timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS ps_slugs_site ON ps_slugs (site_id)`,
  `CREATE TABLE IF NOT EXISTS ps_entity_versions (
     project_id text NOT NULL REFERENCES ps_projects(id) ON DELETE CASCADE,
     kind text NOT NULL,
     entity_id text NOT NULL,
     version integer NOT NULL,
     name text NOT NULL,
     hash text NOT NULL,
     status text NOT NULL,
     pins jsonb,
     data jsonb NOT NULL,
     created_by text,
     created_at timestamptz NOT NULL DEFAULT now(),
     PRIMARY KEY (project_id, kind, entity_id, version)
   )`,
  // Credentials, encrypted by the Worker with CREDENTIALS_KEY before they get here.
  `CREATE TABLE IF NOT EXISTS ps_secrets (
     project_id text NOT NULL REFERENCES ps_projects(id) ON DELETE CASCADE,
     name text NOT NULL,
     value text NOT NULL,
     updated_at timestamptz NOT NULL DEFAULT now(),
     PRIMARY KEY (project_id, name)
   )`,
]

const iso = (value: unknown): string | null =>
  value === null || value === undefined
    ? null
    : value instanceof Date
      ? value.toISOString()
      : new Date(String(value)).toISOString()

const toAsset = (row: Record<string, unknown>): AssetRecord => ({
  id: String(row['id']),
  projectId: String(row['project_id']),
  key: String(row['key']),
  name: String(row['name']),
  type: String(row['type']),
  size: Number(row['size']),
  url: String(row['url']),
  createdAt: iso(row['created_at']) ?? '',
})

const toMember = (row: Record<string, unknown>): MemberRecord => ({
  siteId: String(row['site_id']),
  userId: String(row['user_id']),
  email: String(row['email']),
  role: String(row['role']),
  createdAt: iso(row['created_at']) ?? '',
})

const toEntityVersion = (row: Record<string, unknown>): EntityVersion => ({
  projectId: String(row['project_id']),
  kind: String(row['kind']) as EntityKind,
  entityId: String(row['entity_id']),
  version: Number(row['version']),
  name: String(row['name']),
  hash: String(row['hash']),
  status: row['status'] === 'published' ? 'published' : 'draft',
  ...(row['pins']
    ? {
        pins: (typeof row['pins'] === 'string'
          ? JSON.parse(row['pins'])
          : row['pins']) as Record<string, number>,
      }
    : {}),
  createdBy: row['created_by'] ? String(row['created_by']) : null,
  createdAt: iso(row['created_at']) ?? '',
})

const LIST_SQL = `SELECT id, name, pages, flows, updated_at, published_at, owner_id,
  (SELECT slug FROM ps_slugs WHERE ps_slugs.site_id = ps_projects.id ORDER BY created_at DESC LIMIT 1) AS slug FROM ps_projects`

const parse = (value: unknown): Project =>
  (typeof value === 'string' ? JSON.parse(value) : value) as Project

export class NeonStore implements ProjectStore {
  readonly kind = 'neon' as const
  private ready: Promise<void> | undefined

  constructor(private readonly sql: SqlClient) {}

  static fromUrl(url: string): NeonStore {
    const sql = neon(url)
    return new NeonStore({
      query: (text, params) =>
        sql.query(text, params) as Promise<Record<string, unknown>[]>,
      transaction: (queries) => sql.transaction(queries as never),
    })
  }

  /** Creates the tables on first use in each Worker isolate. */
  private migrate(): Promise<void> {
    this.ready ??= (async () => {
      for (const statement of SCHEMA) await this.sql.query(statement)
    })().catch((error) => {
      this.ready = undefined
      throw error
    })
    return this.ready
  }

  async list(ownerId?: string): Promise<ProjectSummary[]> {
    await this.migrate()
    const rows = ownerId
      ? await this.sql.query(
          `${LIST_SQL} WHERE owner_id = $1 ORDER BY updated_at DESC LIMIT 1000`,
          [ownerId],
        )
      : await this.sql.query(`${LIST_SQL} ORDER BY updated_at DESC LIMIT 1000`)
    return rows.map((row) => ({
      id: String(row['id']),
      name: String(row['name']),
      ownerId:
        row['owner_id'] === null || row['owner_id'] === undefined
          ? null
          : String(row['owner_id']),
      pages: Number(row['pages']),
      flows: Number(row['flows']),
      updatedAt: iso(row['updated_at']) ?? '',
      publishedAt: iso(row['published_at']),
      slug: row['slug'] ? String(row['slug']) : null,
    }))
  }

  async getDraft(id: string): Promise<Project | null> {
    await this.migrate()
    const [row] = await this.sql.query(
      'SELECT data FROM ps_projects WHERE id = $1',
      [id],
    )
    return row ? parse(row['data']) : null
  }

  async owner(id: string): Promise<string | null> {
    await this.migrate()
    const [row] = await this.sql.query(
      'SELECT owner_id FROM ps_projects WHERE id = $1',
      [id],
    )
    return row?.['owner_id'] ? String(row['owner_id']) : null
  }

  async saveDraft(project: Project, ownerId?: string): Promise<ProjectSummary> {
    await this.migrate()
    const data = JSON.stringify(project)
    const statements: Promise<unknown>[] = [
      // The owner is set when the project is first saved and never changed afterwards.
      this.sql.query(
        `INSERT INTO ps_projects (id, name, data, pages, flows, updated_at, owner_id)
         VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7)
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, data = EXCLUDED.data, pages = EXCLUDED.pages,
           flows = EXCLUDED.flows, updated_at = EXCLUDED.updated_at`,
        [
          project.id,
          project.name,
          data,
          project.pages.length,
          project.flows.length,
          project.updatedAt,
          ownerId ?? null,
        ],
      ),
      this.sql.query('DELETE FROM ps_flows WHERE project_id = $1', [
        project.id,
      ]),
      ...project.flows.map((flow) =>
        this.sql.query(
          `INSERT INTO ps_flows (project_id, flow_id, name, run_at, trigger, definition, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
          [
            project.id,
            flow.id,
            flow.name,
            flow.runAt,
            flow.trigger,
            JSON.stringify(flow),
            project.updatedAt,
          ],
        ),
      ),
    ]
    await this.sql.transaction(statements)
    const [row] = await this.sql.query(
      'SELECT published_at FROM ps_projects WHERE id = $1',
      [project.id],
    )
    return {
      ...summarize(project, iso(row?.['published_at'])),
      slug: await this.slugOf(project.id),
    }
  }

  async remove(id: string): Promise<void> {
    await this.migrate()
    await this.sql.query('DELETE FROM ps_projects WHERE id = $1', [id])
  }

  async publish(id: string): Promise<ProjectSummary> {
    const project = await this.getDraft(id)
    if (!project) throw new NotFoundError('Project not found.')
    const publishedAt = new Date().toISOString()
    await this.sql.transaction([
      this.sql.query(
        `INSERT INTO ps_sites (id, data, published_at) VALUES ($1, $2::jsonb, $3)
         ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, published_at = EXCLUDED.published_at`,
        [id, JSON.stringify(project), publishedAt],
      ),
      this.sql.query('UPDATE ps_projects SET published_at = $2 WHERE id = $1', [
        id,
        publishedAt,
      ]),
    ])
    return { ...summarize(project, publishedAt), slug: await this.slugOf(id) }
  }

  async unpublish(id: string): Promise<ProjectSummary> {
    const project = await this.getDraft(id)
    if (!project) throw new NotFoundError('Project not found.')
    await this.sql.transaction([
      this.sql.query('DELETE FROM ps_sites WHERE id = $1', [id]),
      this.sql.query(
        'UPDATE ps_projects SET published_at = NULL WHERE id = $1',
        [id],
      ),
    ])
    return { ...summarize(project, null), slug: await this.slugOf(id) }
  }

  async getSite(id: string): Promise<Project | null> {
    await this.migrate()
    const [row] = await this.sql.query(
      'SELECT data FROM ps_sites WHERE id = $1',
      [id],
    )
    return row ? parse(row['data']) : null
  }

  async claimSlug(id: string, slug: string): Promise<boolean> {
    await this.migrate()
    // The insert either takes the address or leaves it with its current holder: no race window.
    await this.sql.query(
      'INSERT INTO ps_slugs (slug, site_id) VALUES ($1, $2) ON CONFLICT (slug) DO NOTHING',
      [slug, id],
    )
    if ((await this.slugOwner(slug)) !== id) return false
    await this.sql.query(
      'DELETE FROM ps_slugs WHERE site_id = $1 AND slug <> $2',
      [id, slug],
    )
    return true
  }

  async slugOwner(slug: string): Promise<string | null> {
    await this.migrate()
    const [row] = await this.sql.query(
      'SELECT site_id FROM ps_slugs WHERE slug = $1',
      [slug],
    )
    return row ? String(row['site_id']) : null
  }

  async setOwner(id: string, ownerId: string): Promise<void> {
    await this.migrate()
    await this.sql.query('UPDATE ps_projects SET owner_id = $2 WHERE id = $1', [
      id,
      ownerId,
    ])
  }

  async secretRows(projectId: string): Promise<Record<string, string>> {
    await this.migrate()
    const rows = await this.sql.query(
      'SELECT name, value FROM ps_secrets WHERE project_id = $1',
      [projectId],
    )
    return Object.fromEntries(
      rows.map((row) => [String(row['name']), String(row['value'])]),
    )
  }

  async putSecretRow(
    projectId: string,
    name: string,
    value: string,
  ): Promise<void> {
    await this.migrate()
    await this.sql.query(
      `INSERT INTO ps_secrets (project_id, name, value, updated_at) VALUES ($1, $2, $3, now())
       ON CONFLICT (project_id, name) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [projectId, name, value],
    )
  }

  async removeSecretRow(projectId: string, name: string): Promise<void> {
    await this.migrate()
    await this.sql.query(
      'DELETE FROM ps_secrets WHERE project_id = $1 AND name = $2',
      [projectId, name],
    )
  }

  async listEntityVersions(projectId: string): Promise<EntityVersion[]> {
    await this.migrate()
    const rows = await this.sql.query(
      'SELECT project_id, kind, entity_id, version, name, hash, status, pins, created_by, created_at FROM ps_entity_versions WHERE project_id = $1 ORDER BY kind, entity_id, version DESC',
      [projectId],
    )
    return rows.map(toEntityVersion)
  }

  async getEntityData(
    projectId: string,
    kind: EntityKind,
    entityId: string,
    version: number,
  ): Promise<unknown | null> {
    await this.migrate()
    const [row] = await this.sql.query(
      'SELECT data FROM ps_entity_versions WHERE project_id = $1 AND kind = $2 AND entity_id = $3 AND version = $4',
      [projectId, kind, entityId, version],
    )
    return row
      ? typeof row['data'] === 'string'
        ? JSON.parse(row['data'])
        : row['data']
      : null
  }

  async addEntityVersion(record: EntityVersion, data: unknown): Promise<void> {
    await this.migrate()
    await this.sql.query(
      `INSERT INTO ps_entity_versions (project_id, kind, entity_id, version, name, hash, status, pins, data, created_by, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11)`,
      [
        record.projectId,
        record.kind,
        record.entityId,
        record.version,
        record.name,
        record.hash,
        record.status,
        record.pins ? JSON.stringify(record.pins) : null,
        JSON.stringify(data),
        record.createdBy,
        record.createdAt,
      ],
    )
  }

  async updateEntityVersions(changes: EntityVersion[]): Promise<void> {
    if (!changes.length) return
    await this.migrate()
    await this.sql.transaction(
      changes.map((change) =>
        this.sql.query(
          'UPDATE ps_entity_versions SET status = $5, pins = $6::jsonb WHERE project_id = $1 AND kind = $2 AND entity_id = $3 AND version = $4',
          [
            change.projectId,
            change.kind,
            change.entityId,
            change.version,
            change.status,
            change.pins ? JSON.stringify(change.pins) : null,
          ],
        ),
      ),
    )
  }

  async deleteEntityVersions(records: EntityVersion[]): Promise<void> {
    if (!records.length) return
    await this.migrate()
    await this.sql.transaction(
      records.map((record) =>
        this.sql.query(
          'DELETE FROM ps_entity_versions WHERE project_id = $1 AND kind = $2 AND entity_id = $3 AND version = $4',
          [record.projectId, record.kind, record.entityId, record.version],
        ),
      ),
    )
  }

  async saveSite(id: string, site: Project): Promise<string> {
    await this.migrate()
    const publishedAt = new Date().toISOString()
    await this.sql.transaction([
      this.sql.query(
        `INSERT INTO ps_sites (id, data, published_at) VALUES ($1, $2::jsonb, $3)
         ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, published_at = EXCLUDED.published_at`,
        [id, JSON.stringify(site), publishedAt],
      ),
      this.sql.query('UPDATE ps_projects SET published_at = $2 WHERE id = $1', [
        id,
        publishedAt,
      ]),
    ])
    return publishedAt
  }

  async slugOf(id: string): Promise<string | null> {
    await this.migrate()
    const [row] = await this.sql.query(
      'SELECT slug FROM ps_slugs WHERE site_id = $1 ORDER BY created_at DESC LIMIT 1',
      [id],
    )
    return row ? String(row['slug']) : null
  }

  async listAssets(projectId: string): Promise<AssetRecord[]> {
    await this.migrate()
    const rows = await this.sql.query(
      'SELECT * FROM ps_assets WHERE project_id = $1 ORDER BY created_at DESC LIMIT 1000',
      [projectId],
    )
    return rows.map(toAsset)
  }

  async addAsset(asset: AssetRecord): Promise<void> {
    await this.migrate()
    await this.sql.query(
      'INSERT INTO ps_assets (id, project_id, key, name, type, size, url, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
      [
        asset.id,
        asset.projectId,
        asset.key,
        asset.name,
        asset.type,
        asset.size,
        asset.url,
        asset.createdAt,
      ],
    )
  }

  async getAsset(projectId: string, id: string): Promise<AssetRecord | null> {
    await this.migrate()
    const [row] = await this.sql.query(
      'SELECT * FROM ps_assets WHERE project_id = $1 AND id = $2',
      [projectId, id],
    )
    return row ? toAsset(row) : null
  }

  async removeAsset(projectId: string, id: string): Promise<void> {
    await this.migrate()
    await this.sql.query(
      'DELETE FROM ps_assets WHERE project_id = $1 AND id = $2',
      [projectId, id],
    )
  }

  async upsertUser(id: string, email: string): Promise<BuilderRole> {
    await this.migrate()
    const [existing] = await this.sql.query(
      'SELECT role FROM ps_users WHERE id = $1',
      [id],
    )
    if (existing) {
      await this.sql.query(
        'UPDATE ps_users SET email = $2 WHERE id = $1 AND email <> $2',
        [id, email],
      )
      return existing['role'] as BuilderRole
    }
    // The very first person to sign in becomes the admin.
    const [count] = await this.sql.query(
      'SELECT COUNT(*)::int AS n FROM ps_users',
    )
    const role: BuilderRole =
      Number(count?.['n'] ?? 0) === 0 ? 'admin' : 'author'
    await this.sql.query(
      'INSERT INTO ps_users (id, email, role) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING',
      [id, email, role],
    )
    return role
  }

  async listUsers(): Promise<UserRecord[]> {
    await this.migrate()
    const rows = await this.sql.query(
      'SELECT id, email, role, created_at FROM ps_users ORDER BY created_at',
    )
    return rows.map((row) => ({
      id: String(row['id']),
      email: String(row['email']),
      role: row['role'] as BuilderRole,
      createdAt: iso(row['created_at']) ?? '',
    }))
  }

  async setUserRole(id: string, role: BuilderRole): Promise<void> {
    await this.migrate()
    await this.sql.query('UPDATE ps_users SET role = $2 WHERE id = $1', [
      id,
      role,
    ])
  }

  async listMembers(siteId: string): Promise<MemberRecord[]> {
    await this.migrate()
    const rows = await this.sql.query(
      'SELECT * FROM ps_site_members WHERE site_id = $1 ORDER BY created_at LIMIT 5000',
      [siteId],
    )
    return rows.map(toMember)
  }

  async getMember(
    siteId: string,
    userId: string,
  ): Promise<MemberRecord | null> {
    await this.migrate()
    const [row] = await this.sql.query(
      'SELECT * FROM ps_site_members WHERE site_id = $1 AND user_id = $2',
      [siteId, userId],
    )
    return row ? toMember(row) : null
  }

  async upsertMember(member: MemberRecord): Promise<void> {
    await this.migrate()
    await this.sql.query(
      `INSERT INTO ps_site_members (site_id, user_id, email, role) VALUES ($1, $2, $3, $4)
       ON CONFLICT (site_id, user_id) DO UPDATE SET role = EXCLUDED.role, email = EXCLUDED.email`,
      [member.siteId, member.userId, member.email, member.role],
    )
  }

  async removeMember(siteId: string, userId: string): Promise<void> {
    await this.migrate()
    await this.sql.query(
      'DELETE FROM ps_site_members WHERE site_id = $1 AND user_id = $2',
      [siteId, userId],
    )
  }

  async logRun(run: FlowRunRecord): Promise<void> {
    await this.migrate()
    await this.sql.query(
      'INSERT INTO ps_flow_runs (project_id, flow_id, source, status, duration_ms, error) VALUES ($1, $2, $3, $4, $5, $6)',
      [
        run.projectId,
        run.flowId,
        run.source,
        run.status,
        Math.round(run.durationMs),
        run.error?.slice(0, 1000) ?? null,
      ],
    )
  }
}

// ---------------------------------------------------------------------------
// Workers KV (fallback when no database is configured).
// ---------------------------------------------------------------------------

/** The subset of Workers KV used here (kept small so tests can fake it). */
export interface KVLike {
  get(key: string): Promise<string | null>
  getWithMetadata(
    key: string,
  ): Promise<{ value: string | null; metadata: unknown }>
  put(
    key: string,
    value: string,
    options?: { metadata?: unknown },
  ): Promise<void>
  delete(key: string): Promise<void>
  list(options: { prefix: string; cursor?: string; limit?: number }): Promise<{
    keys: { name: string; metadata?: unknown }[]
    list_complete: boolean
    cursor?: string
  }>
}

const DRAFT = 'draft:'
const SITE = 'site:'
const SLUG_KEY = 'slug:'

export class KvStore implements ProjectStore {
  readonly kind = 'kv' as const
  constructor(private readonly kv: KVLike) {}

  async list(ownerId?: string): Promise<ProjectSummary[]> {
    const summaries: ProjectSummary[] = []
    let cursor: string | undefined
    do {
      const page = await this.kv.list({ prefix: DRAFT, cursor, limit: 1000 })
      for (const key of page.keys) {
        const meta = (key.metadata ?? {}) as Partial<ProjectSummary>
        summaries.push({
          id: key.name.slice(DRAFT.length),
          name: meta.name ?? 'Untitled',
          updatedAt: meta.updatedAt ?? '',
          publishedAt: meta.publishedAt ?? null,
          pages: meta.pages ?? 0,
          flows: meta.flows ?? 0,
          ownerId: meta.ownerId ?? null,
          slug: meta.slug ?? null,
        })
      }
      cursor = page.list_complete ? undefined : page.cursor
    } while (cursor)
    return summaries
      .filter((item) => !ownerId || item.ownerId === ownerId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  async getDraft(id: string): Promise<Project | null> {
    const raw = await this.kv.get(DRAFT + id)
    return raw ? (JSON.parse(raw) as Project) : null
  }

  async owner(id: string): Promise<string | null> {
    const { metadata } = await this.kv.getWithMetadata(DRAFT + id)
    return ((metadata ?? {}) as Partial<ProjectSummary>).ownerId ?? null
  }

  private async write(
    project: Project,
    publishedAt: string | null,
    ownerId: string | null = null,
    slug?: string | null,
  ): Promise<ProjectSummary> {
    const summary = {
      ...summarize(project, publishedAt),
      ownerId,
      slug: slug === undefined ? await this.slugOf(project.id) : slug,
    }
    await this.kv.put(DRAFT + project.id, JSON.stringify(project), {
      metadata: summary,
    })
    return summary
  }

  async saveDraft(project: Project, ownerId?: string): Promise<ProjectSummary> {
    // getWithMetadata avoids list operations, which are limited on the free plan.
    const { metadata } = await this.kv.getWithMetadata(DRAFT + project.id)
    const meta = (metadata ?? {}) as Partial<ProjectSummary>
    return this.write(
      project,
      meta.publishedAt ?? null,
      meta.ownerId ?? ownerId ?? null,
    )
  }

  async remove(id: string): Promise<void> {
    const slug = await this.slugOf(id)
    await Promise.all([
      this.kv.delete(DRAFT + id),
      this.kv.delete(SITE + id),
      this.kv.delete(`secrets:${id}`),
      slug ? this.kv.delete(SLUG_KEY + slug) : null,
    ])
  }

  // KV has no transactions; two authors claiming the same new address in the same instant
  // could both succeed, so production should use Neon (DATABASE_URL), whose primary key prevents it.
  async claimSlug(id: string, slug: string): Promise<boolean> {
    const holder = await this.slugOwner(slug)
    if (holder && holder !== id) return false
    const previous = await this.slugOf(id)
    if (!holder) await this.kv.put(SLUG_KEY + slug, id)
    if (previous && previous !== slug) await this.kv.delete(SLUG_KEY + previous)
    const project = await this.getDraft(id)
    if (project) {
      const { metadata } = await this.kv.getWithMetadata(DRAFT + id)
      const meta = (metadata ?? {}) as Partial<ProjectSummary>
      await this.write(
        project,
        meta.publishedAt ?? null,
        meta.ownerId ?? null,
        slug,
      )
    }
    return true
  }

  async slugOwner(slug: string): Promise<string | null> {
    return this.kv.get(SLUG_KEY + slug)
  }

  async setOwner(id: string, ownerId: string): Promise<void> {
    const project = await this.getDraft(id)
    if (!project) throw new NotFoundError('Project not found.')
    const { metadata } = await this.kv.getWithMetadata(DRAFT + id)
    await this.write(
      project,
      ((metadata ?? {}) as Partial<ProjectSummary>).publishedAt ?? null,
      ownerId,
    )
  }

  async secretRows(projectId: string): Promise<Record<string, string>> {
    const raw = await this.kv.get(`secrets:${projectId}`)
    return raw ? (JSON.parse(raw) as Record<string, string>) : {}
  }

  async putSecretRow(
    projectId: string,
    name: string,
    value: string,
  ): Promise<void> {
    await this.kv.put(
      `secrets:${projectId}`,
      JSON.stringify({ ...(await this.secretRows(projectId)), [name]: value }),
    )
  }

  async removeSecretRow(projectId: string, name: string): Promise<void> {
    const { [name]: _removed, ...rest } = await this.secretRows(projectId)
    await this.kv.put(`secrets:${projectId}`, JSON.stringify(rest))
  }

  async listEntityVersions(projectId: string): Promise<EntityVersion[]> {
    const raw = await this.kv.get(`ev:${projectId}`)
    return raw ? (JSON.parse(raw) as EntityVersion[]) : []
  }

  async getEntityData(
    projectId: string,
    kind: EntityKind,
    entityId: string,
    version: number,
  ): Promise<unknown | null> {
    const raw = await this.kv.get(
      `evd:${projectId}:${kind}:${entityId}:${version}`,
    )
    return raw ? JSON.parse(raw) : null
  }

  async addEntityVersion(record: EntityVersion, data: unknown): Promise<void> {
    await this.kv.put(
      `evd:${record.projectId}:${record.kind}:${record.entityId}:${record.version}`,
      JSON.stringify(data),
    )
    await this.kv.put(
      `ev:${record.projectId}`,
      JSON.stringify([
        ...(await this.listEntityVersions(record.projectId)),
        record,
      ]),
    )
  }

  async updateEntityVersions(changes: EntityVersion[]): Promise<void> {
    if (!changes.length) return
    const same = (a: EntityVersion, b: EntityVersion) =>
      a.kind === b.kind && a.entityId === b.entityId && a.version === b.version
    const list = (await this.listEntityVersions(changes[0].projectId)).map(
      (item) => changes.find((change) => same(change, item)) ?? item,
    )
    await this.kv.put(`ev:${changes[0].projectId}`, JSON.stringify(list))
  }

  async deleteEntityVersions(records: EntityVersion[]): Promise<void> {
    if (!records.length) return
    const gone = new Set(
      records.map(
        (record) => `${record.kind}:${record.entityId}:${record.version}`,
      ),
    )
    const list = (await this.listEntityVersions(records[0].projectId)).filter(
      (item) => !gone.has(`${item.kind}:${item.entityId}:${item.version}`),
    )
    await this.kv.put(`ev:${records[0].projectId}`, JSON.stringify(list))
    await Promise.all(
      records.map((record) =>
        this.kv.delete(
          `evd:${record.projectId}:${record.kind}:${record.entityId}:${record.version}`,
        ),
      ),
    )
  }

  async saveSite(id: string, site: Project): Promise<string> {
    const project = await this.getDraft(id)
    if (!project) throw new NotFoundError('Project not found.')
    const publishedAt = new Date().toISOString()
    await this.kv.put(SITE + id, JSON.stringify(site))
    await this.write(project, publishedAt, await this.owner(id))
    return publishedAt
  }

  async slugOf(id: string): Promise<string | null> {
    const { metadata } = await this.kv.getWithMetadata(DRAFT + id)
    return ((metadata ?? {}) as Partial<ProjectSummary>).slug ?? null
  }

  async publish(id: string): Promise<ProjectSummary> {
    const project = await this.getDraft(id)
    if (!project) throw new NotFoundError('Project not found.')
    await this.kv.put(SITE + id, JSON.stringify(project))
    return this.write(project, new Date().toISOString(), await this.owner(id))
  }

  async unpublish(id: string): Promise<ProjectSummary> {
    const project = await this.getDraft(id)
    if (!project) throw new NotFoundError('Project not found.')
    await this.kv.delete(SITE + id)
    return this.write(project, null, await this.owner(id))
  }

  async getSite(id: string): Promise<Project | null> {
    const raw = await this.kv.get(SITE + id)
    return raw ? (JSON.parse(raw) as Project) : null
  }

  async logRun(): Promise<void> {
    // KV writes are limited (1,000/day free), so run history needs the database.
  }

  async listAssets(projectId: string): Promise<AssetRecord[]> {
    const raw = await this.kv.get(`assets:${projectId}`)
    return raw ? (JSON.parse(raw) as AssetRecord[]) : []
  }

  async addAsset(asset: AssetRecord): Promise<void> {
    const assets = await this.listAssets(asset.projectId)
    await this.kv.put(
      `assets:${asset.projectId}`,
      JSON.stringify([asset, ...assets].slice(0, 1000)),
    )
  }

  async getAsset(projectId: string, id: string): Promise<AssetRecord | null> {
    return (
      (await this.listAssets(projectId)).find((asset) => asset.id === id) ??
      null
    )
  }

  async removeAsset(projectId: string, id: string): Promise<void> {
    const assets = await this.listAssets(projectId)
    await this.kv.put(
      `assets:${projectId}`,
      JSON.stringify(assets.filter((asset) => asset.id !== id)),
    )
  }

  async listUsers(): Promise<UserRecord[]> {
    const raw = await this.kv.get('users')
    return raw ? (JSON.parse(raw) as UserRecord[]) : []
  }

  async upsertUser(id: string, email: string): Promise<BuilderRole> {
    const users = await this.listUsers()
    const existing = users.find((user) => user.id === id)
    if (existing) return existing.role
    const role: BuilderRole = users.length ? 'author' : 'admin'
    await this.kv.put(
      'users',
      JSON.stringify([
        ...users,
        { id, email, role, createdAt: new Date().toISOString() },
      ]),
    )
    return role
  }

  async setUserRole(id: string, role: BuilderRole): Promise<void> {
    const users = await this.listUsers()
    await this.kv.put(
      'users',
      JSON.stringify(
        users.map((user) => (user.id === id ? { ...user, role } : user)),
      ),
    )
  }

  async listMembers(siteId: string): Promise<MemberRecord[]> {
    const raw = await this.kv.get(`members:${siteId}`)
    return raw ? (JSON.parse(raw) as MemberRecord[]) : []
  }

  async getMember(
    siteId: string,
    userId: string,
  ): Promise<MemberRecord | null> {
    return (
      (await this.listMembers(siteId)).find(
        (member) => member.userId === userId,
      ) ?? null
    )
  }

  async upsertMember(member: MemberRecord): Promise<void> {
    const members = (await this.listMembers(member.siteId)).filter(
      (item) => item.userId !== member.userId,
    )
    await this.kv.put(
      `members:${member.siteId}`,
      JSON.stringify([...members, member]),
    )
  }

  async removeMember(siteId: string, userId: string): Promise<void> {
    const members = await this.listMembers(siteId)
    await this.kv.put(
      `members:${siteId}`,
      JSON.stringify(members.filter((member) => member.userId !== userId)),
    )
  }
}

let cached: { url: string; store: NeonStore } | undefined

/** Neon when DATABASE_URL is set, otherwise KV, otherwise nothing. */
export function createStore(env: {
  DATABASE_URL?: string
  PROJECTS?: KVLike
}): ProjectStore | null {
  if (env.DATABASE_URL) {
    if (cached?.url !== env.DATABASE_URL)
      cached = {
        url: env.DATABASE_URL,
        store: NeonStore.fromUrl(env.DATABASE_URL),
      }
    return cached.store
  }
  return env.PROJECTS ? new KvStore(env.PROJECTS) : null
}
