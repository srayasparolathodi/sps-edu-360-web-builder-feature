import { afterEach, describe, expect, it, vi } from 'vitest'
import { Bucket, bucketConfig, checkUpload, safeFileName } from './assets'
import { createProject } from '@spsedu360/engine/model'
import worker, { Env } from './index'

const config = {
  endpoint: 'https://s3.example.com',
  region: 'auto',
  bucket: 'web-bulder-config-s3',
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'secret',
}

describe('asset rules', () => {
  it('sanitises file names and checks type and size', () => {
    expect(safeFileName('../../Report Card (Term 1).pdf')).toBe(
      'Report-Card-Term-1-.pdf',
    )
    expect(() => checkUpload('a.exe', 'application/x-msdownload', 10)).toThrow(
      /can't be uploaded/,
    )
    expect(() => checkUpload('a.png', 'image/png', 60 * 1024 * 1024)).toThrow(
      /at most 50 MB/,
    )
    expect(() => checkUpload('a.png', 'image/png', 1000)).not.toThrow()
    expect(bucketConfig({})).toBeNull()
    // The names Neon Object Storage gives you work as they are; the region comes from the endpoint.
    expect(
      bucketConfig({
        AWS_ENDPOINT_URL_S3:
          'https://br-winter-pond-aptw82ef.storage.c-2.us-east-2.aws.neon.tech/',
        AWS_ACCESS_KEY_ID: 'nak_live_x',
        AWS_SECRET_ACCESS_KEY: 'nsk_live_y',
        S3_BUCKET: 'web-bulder-config-s3',
      }),
    ).toMatchObject({
      endpoint:
        'https://br-winter-pond-aptw82ef.storage.c-2.us-east-2.aws.neon.tech',
      region: 'us-east-2',
      accessKeyId: 'nak_live_x',
      bucket: 'web-bulder-config-s3',
    })
  })

  it('signs upload and download URLs for the bucket', async () => {
    const bucket = new Bucket(config)
    const upload = new URL(
      await bucket.uploadUrl('projects/p1/abcd1234-logo.png', 'image/png'),
    )
    expect(upload.origin + upload.pathname).toBe(
      'https://s3.example.com/web-bulder-config-s3/projects/p1/abcd1234-logo.png',
    )
    expect(upload.searchParams.get('X-Amz-Expires')).toBe('600')
    expect(upload.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/)
    const publicBucket = new Bucket({
      ...config,
      publicUrl: 'https://cdn.example.com',
    })
    expect(
      await publicBucket.downloadUrl('projects/p1/abcd1234-logo.png'),
    ).toBe('https://cdn.example.com/projects/p1/abcd1234-logo.png')
  })

  it('adds the site to the bucket CORS rules once, keeping other origins', async () => {
    let rules =
      '<CORSConfiguration><CORSRule><AllowedOrigin>http://localhost:3002</AllowedOrigin></CORSRule></CORSConfiguration>'
    const puts: { body: string; md5: string | null }[] = []
    vi.stubGlobal('fetch', async (input: Request) => {
      expect(new URL(input.url).search).toBe('?cors')
      if (input.method === 'GET') return new Response(rules, { status: 200 })
      const body = await input.text()
      puts.push({ body, md5: input.headers.get('Content-MD5') })
      rules = body
      return new Response(null, { status: 200 })
    })
    const bucket = new Bucket(config)
    await bucket.allowOrigin('https://studio.school.edu')
    await bucket.allowOrigin('https://studio.school.edu')
    expect(puts).toHaveLength(1)
    expect(puts[0].body).toContain(
      '<AllowedOrigin>http://localhost:3002</AllowedOrigin><AllowedOrigin>https://studio.school.edu</AllowedOrigin>',
    )
    expect(puts[0].body).toContain('<AllowedMethod>PUT</AllowedMethod>')
    expect(puts[0].md5).toMatch(/^[A-Za-z0-9+/]{22}==$/)
  })
})

describe('asset API', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('issues upload links, confirms uploads, lists, serves and deletes files', async () => {
    const objects = new Map<string, { size: number; type: string }>()
    // The fake bucket answers HEAD/DELETE the way S3 does.
    vi.stubGlobal(
      'fetch',
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request =
          input instanceof Request ? input : new Request(String(input), init)
        const key = new URL(request.url).pathname.replace(
          '/web-bulder-config-s3/',
          '',
        )
        if (request.method === 'HEAD') {
          const object = objects.get(key)
          return object
            ? new Response(null, {
                headers: {
                  'content-length': String(object.size),
                  'content-type': object.type,
                },
              })
            : new Response(null, { status: 404 })
        }
        if (request.method === 'DELETE') {
          objects.delete(key)
          return new Response(null, { status: 204 })
        }
        return new Response(null, { status: 400 })
      },
    )
    const kv = new Map<string, string>()
    const env: Env = {
      ASSETS: { fetch: async () => new Response('asset') },
      PROJECTS: {
        get: async (key) => kv.get(key) ?? null,
        getWithMetadata: async (key) => ({
          value: kv.get(key) ?? null,
          metadata: null,
        }),
        put: async (key, value) => void kv.set(key, value),
        delete: async (key) => void kv.delete(key),
        list: async () => ({ keys: [], list_complete: true }),
      },
      ADMIN_TOKEN: 't',
      S3_ENDPOINT: config.endpoint,
      S3_BUCKET: config.bucket,
      S3_ACCESS_KEY_ID: config.accessKeyId,
      S3_SECRET_ACCESS_KEY: config.secretAccessKey,
    }
    const call = (path: string, init: RequestInit = {}) =>
      worker.fetch(
        new Request(`https://site.test${path}`, {
          ...init,
          headers: { Authorization: 'Bearer t', ...(init.headers as object) },
        }),
        env,
      )
    const project = createProject()

    const refused = await call(`/api/projects/${project.id}/assets/upload`, {
      method: 'POST',
      body: JSON.stringify({
        name: 'x.exe',
        type: 'application/x-msdownload',
        size: 5,
      }),
    })
    expect(refused.status).toBe(415)

    const issued = await (
      await call(`/api/projects/${project.id}/assets/upload`, {
        method: 'POST',
        body: JSON.stringify({
          name: 'School Logo.png',
          type: 'image/png',
          size: 2048,
        }),
      })
    ).json()
    expect(issued.fileName).toMatch(/^[0-9a-f]{8}-School-Logo\.png$/)

    // Confirming before the browser uploaded is refused.
    expect(
      (
        await call(`/api/projects/${project.id}/assets/complete`, {
          method: 'POST',
          body: JSON.stringify({
            fileName: issued.fileName,
            name: 'School Logo.png',
          }),
        })
      ).status,
    ).toBe(409)

    objects.set(issued.key, { size: 2048, type: 'image/png' })
    const asset = await (
      await call(`/api/projects/${project.id}/assets/complete`, {
        method: 'POST',
        body: JSON.stringify({
          fileName: issued.fileName,
          name: 'School Logo.png',
        }),
      })
    ).json()
    expect(asset).toMatchObject({
      name: 'School Logo.png',
      size: 2048,
      type: 'image/png',
      url: `/api/files/${project.id}/${issued.fileName}`,
    })

    const list = await (await call(`/api/projects/${project.id}/assets`)).json()
    expect(list).toHaveLength(1)

    const served = await call(asset.url)
    expect(served.status).toBe(302)
    expect(served.headers.get('Location')).toContain(
      `/web-bulder-config-s3/${issued.key}`,
    )

    expect(
      (
        await call(`/api/projects/${project.id}/assets/${asset.id}`, {
          method: 'DELETE',
        })
      ).status,
    ).toBe(200)
    expect(objects.size).toBe(0)
    expect(
      await (await call(`/api/projects/${project.id}/assets`)).json(),
    ).toEqual([])
  })
})
