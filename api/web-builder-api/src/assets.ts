/**
 * Files and images authors upload for their apps, kept in Neon Object Storage
 * (S3-compatible; any S3-compatible store works). The browser uploads directly to
 * the bucket with a short-lived signed URL, so files never pass through the Worker.
 *
 * Settings, using the names Neon gives you (S3_* names work too):
 *   AWS_ENDPOINT_URL_S3   branch endpoint, e.g. https://br-xxx.storage.c-2.us-east-2.aws.neon.tech
 *   AWS_REGION            e.g. us-east-2 (read from a Neon endpoint when not set)
 *   AWS_ACCESS_KEY_ID     Neon credential token_id            (secret)
 *   AWS_SECRET_ACCESS_KEY Neon credential s3_secret_access_key (secret)
 *   S3_BUCKET             bucket name (wrangler.jsonc)
 *   S3_PUBLIC_URL         optional public base URL for reading files
 */
import { createHash } from 'node:crypto'
import { AwsClient } from 'aws4fetch'

export interface AssetRecord {
  id: string
  projectId: string
  key: string
  name: string
  type: string
  size: number
  createdAt: string
  /** Stable link to use in pages: /api/files/<projectId>/<file>. */
  url: string
}

export interface BucketConfig {
  endpoint: string
  region: string
  bucket: string
  accessKeyId: string
  secretAccessKey: string
  publicUrl?: string
}

export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024

/** File types authors can upload; everything else is refused. */
const ALLOWED_TYPES: RegExp[] = [
  /^image\/(png|jpe?g|gif|webp|avif|svg\+xml)$/,
  /^video\/(mp4|webm|quicktime)$/,
  /^audio\/(mpeg|mp4|ogg|wav|webm)$/,
  /^application\/pdf$/,
  /^text\/(plain|csv)$/,
  /^application\/(vnd\.openxmlformats-officedocument\.(wordprocessingml\.document|spreadsheetml\.sheet|presentationml\.presentation)|msword|vnd\.ms-excel)$/,
]

export class AssetError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

/** Region inside a Neon storage endpoint, e.g. ...storage.c-2.us-east-2.aws.neon.tech → us-east-2. */
const neonRegion = (endpoint: string) =>
  /\.storage\.[^.]+\.([a-z0-9-]+)\.aws\.neon\.tech$/.exec(
    new URL(endpoint).hostname,
  )?.[1] ?? ''

export function bucketConfig(
  env: Record<string, unknown>,
): BucketConfig | null {
  const read = (...names: string[]) => {
    for (const name of names)
      if (typeof env[name] === 'string' && env[name]) return env[name] as string
    return ''
  }
  const endpoint = read('S3_ENDPOINT', 'AWS_ENDPOINT_URL_S3').replace(
    /\/+$/,
    '',
  )
  let region = read('S3_REGION', 'AWS_REGION')
  if (!region && endpoint) {
    try {
      region = neonRegion(endpoint)
    } catch {
      // Not a URL; the check below reports the bucket as not configured.
    }
  }
  const config = {
    endpoint,
    region: region || 'auto',
    bucket: read('S3_BUCKET'),
    accessKeyId: read('S3_ACCESS_KEY_ID', 'AWS_ACCESS_KEY_ID'),
    secretAccessKey: read('S3_SECRET_ACCESS_KEY', 'AWS_SECRET_ACCESS_KEY'),
    publicUrl: read('S3_PUBLIC_URL').replace(/\/+$/, '') || undefined,
  }
  return config.endpoint &&
    config.bucket &&
    config.accessKeyId &&
    config.secretAccessKey
    ? config
    : null
}

/** Safe object name: keeps letters, numbers, dots and dashes. */
export function safeFileName(name: string): string {
  const cleaned = name
    .normalize('NFKD')
    .replace(/[^\w.-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
  return (cleaned || 'file').slice(-80)
}

export function checkUpload(name: string, type: string, size: number): void {
  if (!name || typeof name !== 'string')
    throw new AssetError(400, 'The file needs a name.')
  if (!ALLOWED_TYPES.some((pattern) => pattern.test(type)))
    throw new AssetError(
      415,
      `Files of type "${type || 'unknown'}" can't be uploaded. Use images, video, audio, PDF, CSV or Office documents.`,
    )
  if (!Number.isFinite(size) || size <= 0)
    throw new AssetError(400, 'The file is empty.')
  if (size > MAX_UPLOAD_BYTES)
    throw new AssetError(
      413,
      `Files can be at most ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.`,
    )
}

export class Bucket {
  private readonly client: AwsClient

  constructor(private readonly config: BucketConfig) {
    this.client = new AwsClient({
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      service: 's3',
      region: config.region,
    })
  }

  private objectUrl(key: string): string {
    return `${this.config.endpoint}/${encodeURIComponent(this.config.bucket)}/${key.split('/').map(encodeURIComponent).join('/')}`
  }

  /** Signed URL the browser PUTs the file to; valid for `seconds`. */
  async uploadUrl(key: string, type: string, seconds = 600): Promise<string> {
    const url = new URL(this.objectUrl(key))
    url.searchParams.set('X-Amz-Expires', String(seconds))
    const signed = await this.client.sign(
      new Request(url, { method: 'PUT', headers: { 'Content-Type': type } }),
      { aws: { signQuery: true, allHeaders: true } },
    )
    return signed.url
  }

  async downloadUrl(key: string, seconds = 3600): Promise<string> {
    if (this.config.publicUrl)
      return `${this.config.publicUrl}/${key.split('/').map(encodeURIComponent).join('/')}`
    const url = new URL(this.objectUrl(key))
    url.searchParams.set('X-Amz-Expires', String(seconds))
    const signed = await this.client.sign(new Request(url, { method: 'GET' }), {
      aws: { signQuery: true },
    })
    return signed.url
  }

  /** Size and type of an uploaded object, or null when it isn't there. */
  async head(key: string): Promise<{ size: number; type: string } | null> {
    const response = await this.client.fetch(this.objectUrl(key), {
      method: 'HEAD',
    })
    if (response.status === 404) return null
    if (!response.ok)
      throw new AssetError(502, `The file store answered ${response.status}.`)
    return {
      size: Number(response.headers.get('content-length') ?? 0),
      type: response.headers.get('content-type') ?? '',
    }
  }

  /**
   * Makes sure the bucket lets browsers on `origin` upload and read files directly.
   * Adds the origin to the bucket's CORS rules when it is missing; other origins are kept.
   */
  async allowOrigin(origin: string): Promise<void> {
    const corsUrl = `${this.config.endpoint}/${encodeURIComponent(this.config.bucket)}?cors`
    const current = await this.client.fetch(corsUrl, { method: 'GET' })
    if (!current.ok && current.status !== 404)
      throw new AssetError(
        502,
        `The file store answered ${current.status} when reading its CORS rules.`,
      )
    const origins = current.ok
      ? [
          ...(await current.text()).matchAll(
            /<AllowedOrigin>([^<]+)<\/AllowedOrigin>/g,
          ),
        ].map((match) => match[1])
      : []
    if (origins.includes(origin) || origins.includes('*')) return
    const tag = (name: string, value: string) =>
      `<${name}>${value.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</${name}>`
    const body =
      '<CORSConfiguration><CORSRule>' +
      [...origins, origin].map((item) => tag('AllowedOrigin', item)).join('') +
      ['GET', 'PUT', 'HEAD']
        .map((item) => tag('AllowedMethod', item))
        .join('') +
      tag('AllowedHeader', '*') +
      tag('ExposeHeader', 'ETag') +
      tag('MaxAgeSeconds', '3600') +
      '</CORSRule></CORSConfiguration>'
    const response = await this.client.fetch(corsUrl, {
      method: 'PUT',
      body,
      // S3 requires an MD5 of the CORS document.
      headers: {
        'Content-Type': 'application/xml',
        'Content-MD5': createHash('md5').update(body).digest('base64'),
      },
    })
    if (!response.ok)
      throw new AssetError(
        502,
        `The file store refused the CORS rules (${response.status}).`,
      )
  }

  async remove(key: string): Promise<void> {
    const response = await this.client.fetch(this.objectUrl(key), {
      method: 'DELETE',
    })
    if (!response.ok && response.status !== 404)
      throw new AssetError(502, `The file store answered ${response.status}.`)
  }
}

export const assetKey = (projectId: string, fileName: string) =>
  `projects/${projectId}/${fileName}`
export const assetUrl = (projectId: string, fileName: string) =>
  `/api/files/${projectId}/${encodeURIComponent(fileName)}`
