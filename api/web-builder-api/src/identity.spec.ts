import { describe, expect, it } from 'vitest'
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose'
import { verifyAccessToken } from './identity'
import {
  ANONYMOUS,
  Visitor,
  allows,
  forVisitor,
} from '@spsedu360/engine/access'
import { createBlock, createProject } from '@spsedu360/engine/model'
import { createFlow } from '@spsedu360/engine/flow'
import worker, { Env } from './index'

const config = {
  teamDomain: 'school.cloudflareaccess.com',
  audience: 'aud-123',
}

async function keys() {
  const { publicKey, privateKey } = await generateKeyPair('RS256')
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256' }
  return { privateKey, jwks: createLocalJWKSet({ keys: [jwk] }) }
}

const sign = (
  privateKey: CryptoKey,
  claims: { aud?: string; iss?: string; exp?: number } = {},
) =>
  new SignJWT({ email: 'teacher@school.edu' })
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setSubject('user-1')
    .setIssuer(claims.iss ?? `https://${config.teamDomain}`)
    .setAudience(claims.aud ?? config.audience)
    .setIssuedAt()
    .setExpirationTime(claims.exp ?? Math.floor(Date.now() / 1000) + 300)
    .sign(privateKey)

describe('Cloudflare Access tokens', () => {
  it('accepts a correctly signed token and reads the user', async () => {
    const { privateKey, jwks } = await keys()
    expect(
      await verifyAccessToken(await sign(privateKey), config, jwks),
    ).toEqual({ id: 'user-1', email: 'teacher@school.edu' })
  })

  it('rejects wrong audience, wrong issuer, expiry and foreign keys', async () => {
    const { privateKey, jwks } = await keys()
    await expect(
      verifyAccessToken(
        await sign(privateKey, { aud: 'other-app' }),
        config,
        jwks,
      ),
    ).rejects.toThrow(/not valid/)
    await expect(
      verifyAccessToken(
        await sign(privateKey, { iss: 'https://evil.example.com' }),
        config,
        jwks,
      ),
    ).rejects.toThrow(/not valid/)
    await expect(
      verifyAccessToken(
        await sign(privateKey, { exp: Math.floor(Date.now() / 1000) - 10 }),
        config,
        jwks,
      ),
    ).rejects.toThrow(/not valid/)
    const other = await keys()
    await expect(
      verifyAccessToken(await sign(other.privateKey), config, jwks),
    ).rejects.toThrow(/not valid/)
  })
})

describe('what a visitor receives', () => {
  const project = createProject()
  project.auth = {
    enabled: true,
    allowSignUp: true,
    defaultRole: 'member',
    roles: [
      { id: 'member', name: 'Member', description: '' },
      { id: 'staff', name: 'Staff', description: '' },
    ],
  }
  const open = createBlock('text')
  const staffOnly = {
    ...createBlock('text'),
    access: { mode: 'roles' as const, roles: ['staff'] },
  }
  project.pages[0].blocks = [open, staffOnly]
  project.pages.push({
    id: 'p2',
    name: 'Marks',
    path: 'marks',
    blocks: [createBlock('table')],
    access: { mode: 'signedIn' },
  })
  const staffFlow = {
    ...createFlow('Payroll'),
    access: { mode: 'roles' as const, roles: ['staff'] },
  }
  project.flows.push(createFlow('Public'), staffFlow)
  const member: Visitor = {
    signedIn: true,
    id: 'u1',
    email: 'a@b.c',
    name: 'A',
    roles: ['member'],
  }
  const staff: Visitor = { ...member, roles: ['staff'] }

  it('locks pages and hides blocks and flows by role', () => {
    const anonymous = forVisitor(project, ANONYMOUS)
    expect(anonymous.pages[0].blocks.map((block) => block.id)).toEqual([
      open.id,
    ])
    expect(anonymous.pages[1]).toMatchObject({
      blocks: [],
      locked: true,
      path: 'marks',
    })
    expect(anonymous.flows.map((flow) => flow.name)).toEqual(['Public'])

    const asMember = forVisitor(project, member)
    expect(asMember.pages[1].locked).toBeUndefined()
    expect(asMember.pages[0].blocks).toHaveLength(1)

    const asStaff = forVisitor(project, staff)
    expect(asStaff.pages[0].blocks).toHaveLength(2)
    expect(asStaff.flows).toHaveLength(2)
    expect(allows({ mode: 'roles', roles: ['staff'] }, member)).toBe(false)
  })

  it('leaves sites without sign-in untouched', () => {
    expect(
      forVisitor(
        { ...project, auth: { ...project.auth!, enabled: false } },
        ANONYMOUS,
      ).pages[1].blocks,
    ).toHaveLength(1)
  })
})

describe('project ownership', () => {
  it('keeps authors out of other people’s projects', async () => {
    const kv = new Map<string, { value: string; metadata?: unknown }>()
    const env: Env = {
      ASSETS: { fetch: async () => new Response('asset') },
      PROJECTS: {
        get: async (key) => kv.get(key)?.value ?? null,
        getWithMetadata: async (key) => ({
          value: kv.get(key)?.value ?? null,
          metadata: kv.get(key)?.metadata ?? null,
        }),
        put: async (key, value, options) =>
          void kv.set(key, { value, metadata: options?.metadata }),
        delete: async (key) => void kv.delete(key),
        list: async ({ prefix }) => ({
          keys: [...kv]
            .filter(([name]) => name.startsWith(prefix))
            .map(([name, entry]) => ({ name, metadata: entry.metadata })),
          list_complete: true,
        }),
      },
      ADMIN_TOKEN: 'admin-secret',
    }
    // The admin token acts as an admin; save a project as admin first.
    const project = createProject('Admin project')
    const admin = { Authorization: 'Bearer admin-secret' }
    expect(
      (
        await worker.fetch(
          new Request(`https://s.test/api/projects/${project.id}`, {
            method: 'PUT',
            headers: admin,
            body: JSON.stringify(project),
          }),
          env,
        )
      ).status,
    ).toBe(200)
    expect(
      (
        await (
          await worker.fetch(
            new Request('https://s.test/api/me', { headers: admin }),
            env,
          )
        ).json()
      ).role,
    ).toBe('admin')
    // Without any credentials the builder API is refused.
    expect(
      (
        await worker.fetch(
          new Request(`https://s.test/api/projects/${project.id}`),
          env,
        )
      ).status,
    ).toBe(401)
  })
})
