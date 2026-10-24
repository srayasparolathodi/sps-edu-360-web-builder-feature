/**
 * Credentials (API keys, tokens, database passwords) that authors enter in the builder.
 * Values are write-only from the builder: only names are ever returned to the browser.
 *
 * Where they are kept, in order of preference:
 *   1. OpenBao (OPENBAO_ADDR + OPENBAO_TOKEN), at <mount>/data/page-studio/<projectId>/<NAME>,
 *      when you run an OpenBao server.
 *   2. The app database (Neon, or KV), encrypted with AES-256-GCM using CREDENTIALS_KEY, a
 *      Worker secret. The database only ever holds ciphertext; without the key it is unreadable.
 *   3. Read-only Worker variables named APP_SECRET_<NAME>.
 */

export const SECRET_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/

export interface SecretStore {
  readonly kind: 'openbao' | 'database' | 'env'
  readonly writable: boolean
  names(projectId: string): Promise<string[]>
  put(projectId: string, name: string, value: string): Promise<void>
  remove(projectId: string, name: string): Promise<void>
  /** All values for a project, for server flows only. */
  values(projectId: string): Promise<Record<string, string>>
}

export class SecretsUnavailableError extends Error {}

export interface OpenBaoConfig {
  addr: string
  token: string
  mount?: string
  namespace?: string
  fetch?: typeof fetch
}

const CACHE_MS = 60_000

export class OpenBaoSecrets implements SecretStore {
  readonly kind = 'openbao' as const
  readonly writable = true
  private readonly cache = new Map<
    string,
    { at: number; values: Record<string, string> }
  >()
  private readonly base: string
  private readonly http: typeof fetch

  constructor(private readonly config: OpenBaoConfig) {
    this.base = `${config.addr.replace(/\/+$/, '')}/v1/${encodeURIComponent(config.mount ?? 'secret')}`
    this.http = config.fetch ?? ((input, init) => fetch(input, init))
  }

  private path(
    kind: 'data' | 'metadata',
    projectId: string,
    name?: string,
  ): string {
    return `${this.base}/${kind}/page-studio/${encodeURIComponent(projectId)}${name ? `/${encodeURIComponent(name)}` : ''}`
  }

  private async call(url: string, init: RequestInit = {}): Promise<Response> {
    let response: Response
    try {
      response = await this.http(url, {
        ...init,
        headers: {
          'X-Vault-Token': this.config.token,
          ...(this.config.namespace
            ? { 'X-Vault-Namespace': this.config.namespace }
            : {}),
          ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        },
        signal: AbortSignal.timeout(8000),
      })
    } catch {
      throw new SecretsUnavailableError('OpenBao could not be reached.')
    }
    if (response.status === 403)
      throw new SecretsUnavailableError(
        'OpenBao refused the token (403). Check OPENBAO_TOKEN and its policy.',
      )
    if (!response.ok && response.status !== 404)
      throw new SecretsUnavailableError(`OpenBao answered ${response.status}.`)
    return response
  }

  async names(projectId: string): Promise<string[]> {
    const response = await this.call(
      `${this.path('metadata', projectId)}?list=true`,
    )
    if (response.status === 404) return []
    const body = (await response.json()) as { data?: { keys?: string[] } }
    return (body.data?.keys ?? []).filter((key) => !key.endsWith('/')).sort()
  }

  async put(projectId: string, name: string, value: string): Promise<void> {
    await this.call(this.path('data', projectId, name), {
      method: 'POST',
      body: JSON.stringify({ data: { value } }),
    })
    this.cache.delete(projectId)
  }

  async remove(projectId: string, name: string): Promise<void> {
    await this.call(this.path('metadata', projectId, name), {
      method: 'DELETE',
    })
    this.cache.delete(projectId)
  }

  async values(projectId: string): Promise<Record<string, string>> {
    const hit = this.cache.get(projectId)
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.values
    const names = await this.names(projectId)
    const entries = await Promise.all(
      names.map(async (name) => {
        const response = await this.call(this.path('data', projectId, name))
        if (response.status === 404) return null
        const body = (await response.json()) as {
          data?: { data?: { value?: unknown } }
        }
        const value = body.data?.data?.value
        return typeof value === 'string' ? ([name, value] as const) : null
      }),
    )
    const values = Object.fromEntries(
      entries.filter((entry): entry is readonly [string, string] => !!entry),
    )
    this.cache.set(projectId, { at: Date.now(), values })
    return values
  }
}

/** Fallback: read-only secrets from Worker variables named APP_SECRET_<NAME>. */
export class EnvSecrets implements SecretStore {
  readonly kind = 'env' as const
  readonly writable = false
  constructor(private readonly env: Record<string, unknown>) {}
  all(): Record<string, string> {
    const result: Record<string, string> = {}
    for (const [key, value] of Object.entries(this.env))
      if (key.startsWith('APP_SECRET_') && typeof value === 'string')
        result[key.slice(11)] = value
    return result
  }
  async names(): Promise<string[]> {
    return Object.keys(this.all()).sort()
  }
  async put(): Promise<void> {
    throw new SecretsUnavailableError(
      'Set CREDENTIALS_KEY on the Worker (a random text of at least 32 characters) to save credentials from the builder.',
    )
  }
  async remove(): Promise<void> {
    throw new SecretsUnavailableError(
      'These credentials come from Worker variables; remove them in Cloudflare.',
    )
  }
  async values(): Promise<Record<string, string>> {
    return this.all()
  }
}

/** Where encrypted credentials are kept (see ProjectStore). */
export interface SecretRows {
  secretRows(projectId: string): Promise<Record<string, string>>
  putSecretRow(projectId: string, name: string, value: string): Promise<void>
  removeSecretRow(projectId: string, name: string): Promise<void>
}

/** Minimum length of CREDENTIALS_KEY. */
export const MIN_KEY_LENGTH = 32

/**
 * Credentials encrypted with AES-256-GCM and stored in the app database. Each value is bound to
 * its app and name (additional data), so a value copied to another app or name will not decrypt.
 * Worker variables named APP_SECRET_<NAME> are offered too, read-only.
 */
export class DatabaseSecrets implements SecretStore {
  readonly kind = 'database' as const
  readonly writable = true
  private key: Promise<CryptoKey> | undefined

  constructor(
    private readonly rows: SecretRows,
    private readonly secret: string,
    private readonly env: Record<string, unknown> = {},
  ) {}

  private cryptoKey(): Promise<CryptoKey> {
    this.key ??= crypto.subtle
      .digest('SHA-256', new TextEncoder().encode(this.secret))
      .then((raw) =>
        crypto.subtle.importKey('raw', raw, 'AES-GCM', false, [
          'encrypt',
          'decrypt',
        ]),
      )
    return this.key
  }

  private async encrypt(
    projectId: string,
    name: string,
    value: string,
  ): Promise<string> {
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const data = new TextEncoder().encode(`${projectId}:${name}`)
    const sealed = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv, additionalData: data },
        await this.cryptoKey(),
        new TextEncoder().encode(value),
      ),
    )
    const bytes = new Uint8Array(iv.length + sealed.length)
    bytes.set(iv)
    bytes.set(sealed, iv.length)
    return `v1:${btoa(String.fromCharCode(...bytes))}`
  }

  private async decrypt(
    projectId: string,
    name: string,
    stored: string,
  ): Promise<string | null> {
    if (!stored.startsWith('v1:')) return null
    try {
      const bytes = Uint8Array.from(atob(stored.slice(3)), (char) =>
        char.charCodeAt(0),
      )
      const data = new TextEncoder().encode(`${projectId}:${name}`)
      const plain = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: bytes.slice(0, 12), additionalData: data },
        await this.cryptoKey(),
        bytes.slice(12),
      )
      return new TextDecoder().decode(plain)
    } catch {
      // Wrong key (CREDENTIALS_KEY changed) or tampered value.
      return null
    }
  }

  private fromEnv(): Record<string, string> {
    return new EnvSecrets(this.env).all()
  }

  async names(projectId: string): Promise<string[]> {
    return [
      ...new Set([
        ...Object.keys(this.fromEnv()),
        ...Object.keys(await this.rows.secretRows(projectId)),
      ]),
    ].sort()
  }

  async put(projectId: string, name: string, value: string): Promise<void> {
    await this.rows.putSecretRow(
      projectId,
      name,
      await this.encrypt(projectId, name, value),
    )
  }

  async remove(projectId: string, name: string): Promise<void> {
    await this.rows.removeSecretRow(projectId, name)
  }

  async values(projectId: string): Promise<Record<string, string>> {
    const result = this.fromEnv()
    for (const [name, stored] of Object.entries(
      await this.rows.secretRows(projectId),
    )) {
      const value = await this.decrypt(projectId, name, stored)
      if (value === null)
        console.warn(
          `Credential ${name} could not be decrypted; was CREDENTIALS_KEY changed?`,
        )
      else result[name] = value
    }
    return result
  }
}

let cached: { key: string; store: OpenBaoSecrets } | undefined

export function createSecrets(
  env: Record<string, unknown>,
  rows?: SecretRows | null,
): SecretStore {
  const addr =
    typeof env['OPENBAO_ADDR'] === 'string' ? env['OPENBAO_ADDR'] : ''
  const token =
    typeof env['OPENBAO_TOKEN'] === 'string' ? env['OPENBAO_TOKEN'] : ''
  const credentialsKey =
    typeof env['CREDENTIALS_KEY'] === 'string' ? env['CREDENTIALS_KEY'] : ''
  if ((!addr || !token) && rows && credentialsKey.length >= MIN_KEY_LENGTH)
    return new DatabaseSecrets(rows, credentialsKey, env)
  if (!addr || !token) return new EnvSecrets(env)
  const mount =
    typeof env['OPENBAO_MOUNT'] === 'string' ? env['OPENBAO_MOUNT'] : 'secret'
  const namespace =
    typeof env['OPENBAO_NAMESPACE'] === 'string'
      ? env['OPENBAO_NAMESPACE']
      : undefined
  const key = `${addr}|${mount}|${namespace}|${token}`
  if (cached?.key !== key)
    cached = {
      key,
      store: new OpenBaoSecrets({ addr, token, mount, namespace }),
    }
  return cached.store
}

/** Replaces any secret value found in `value` (deeply) with a mask. */
export function redact<T>(value: T, secrets: Record<string, string>): T {
  const needles = Object.values(secrets).filter((secret) => secret.length >= 4)
  if (!needles.length) return value
  const scrub = (item: unknown): unknown => {
    if (typeof item === 'string')
      return needles.reduce(
        (text, secret) => text.split(secret).join('••••••'),
        item,
      )
    if (Array.isArray(item)) return item.map(scrub)
    if (item && typeof item === 'object')
      return Object.fromEntries(
        Object.entries(item).map(([k, v]) => [k, scrub(v)]),
      )
    return item
  }
  return scrub(value) as T
}
