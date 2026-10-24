/**
 * Who may see or run what. Shared by the browser (preview, hiding) and the
 * Worker (enforcement): the server strips what a visitor may not access
 * before the site is sent, so hidden content never reaches their browser.
 */

export interface AccessRule {
  /** public: everyone. signedIn: any signed-in visitor. roles: only the listed roles. */
  mode: 'public' | 'signedIn' | 'roles'
  roles?: string[]
}

export interface Visitor {
  signedIn: boolean
  id: string | null
  email: string | null
  name: string | null
  /** Role ids for this site. */
  roles: string[]
}

export const ANONYMOUS: Visitor = {
  signedIn: false,
  id: null,
  email: null,
  name: null,
  roles: [],
}

export interface SiteRole {
  id: string
  name: string
  description: string
}

/** Sign-in and roles for a published site. */
export interface SiteAuth {
  enabled: boolean
  /** Let visitors create their own accounts. */
  allowSignUp: boolean
  /** Role given to visitors who sign up. */
  defaultRole: string
  roles: SiteRole[]
}

export function defaultSiteAuth(): SiteAuth {
  return {
    enabled: false,
    allowSignUp: true,
    defaultRole: 'member',
    roles: [
      { id: 'member', name: 'Member', description: 'Anyone who signed up' },
      { id: 'staff', name: 'Staff', description: 'Teachers and office staff' },
      { id: 'admin', name: 'Site admin', description: 'Manages the site' },
    ],
  }
}

export function allows(
  rule: AccessRule | undefined,
  visitor: Visitor,
): boolean {
  if (!rule || rule.mode === 'public') return true
  if (!visitor.signedIn) return false
  if (rule.mode === 'signedIn') return true
  return (rule.roles ?? []).some((role) => visitor.roles.includes(role))
}

interface Accessible {
  access?: AccessRule
}
interface BlockLike extends Accessible {
  children: BlockLike[]
}
interface PageLike extends Accessible {
  blocks: BlockLike[]
  locked?: boolean
}
interface ProjectLike {
  auth?: SiteAuth
  pages: PageLike[]
  flows: (Accessible & { id: string; runAt: string })[]
}

/**
 * Copy of the project with only what this visitor may access. Locked pages
 * keep their name and path (so links and sign-in prompts work) but no content.
 */
export function forVisitor<T extends ProjectLike>(
  project: T,
  visitor: Visitor,
): T {
  // Server-only APIs (and any the visitor may not call) are never sent to the browser.
  const apis = (
    project as { apis?: { browser: boolean; access?: AccessRule }[] }
  ).apis
  const visibleApis = apis?.filter(
    (api) =>
      api.browser && (!project.auth?.enabled || allows(api.access, visitor)),
  )
  if (!project.auth?.enabled)
    return apis ? { ...project, apis: visibleApis } : project
  const prune = (blocks: BlockLike[]): BlockLike[] =>
    blocks
      .filter((block) => allows(block.access, visitor))
      .map((block) => ({ ...block, children: prune(block.children) }))
  return {
    ...project,
    pages: project.pages.map((page) =>
      allows(page.access, visitor)
        ? { ...page, blocks: prune(page.blocks) }
        : { ...page, blocks: [], locked: true },
    ),
    // Flows the visitor can't use are removed, so their logic (and any API addresses) stays private.
    flows: project.flows.filter((flow) => allows(flow.access, visitor)),
    ...(apis ? { apis: visibleApis } : {}),
  }
}
