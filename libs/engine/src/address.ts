/**
 * Site addresses. A published site lives at <origin>/<slug>/<page path…>?<query>.
 * The slug is the app's name in URL form ("Greenfield School" → greenfield-school), so app
 * names are unique across the server; page paths and path variables are matched only inside that app.
 */

/** 3–40 lowercase letters, numbers and single hyphens; no dots, so it never matches a static file. */
export const SLUG = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){2,39}$/

/** First path segments the app itself uses, or that people would mistake for the platform. */
export const RESERVED_SLUGS = new Set([
  'api',
  'site',
  'sites',
  's',
  'builder',
  'admin',
  'auth',
  'login',
  'logout',
  'signin',
  'signup',
  'sign-in',
  'sign-up',
  'assets',
  'static',
  'files',
  'media',
  'public',
  'app',
  'apps',
  'www',
  'help',
  'docs',
  'status',
  'health',
  'settings',
  'account',
  'dashboard',
  'new',
  'edit',
  'preview',
  'cdn-cgi',
  'favicon',
  'robots',
  'sitemap',
  'well-known',
])

/** Why a slug cannot be used, or '' when it can. */
export function slugProblem(slug: string): string {
  if (!slug) return 'Choose a web address for the site.'
  if (slug.length < 3 || slug.length > 40) return 'Use 3 to 40 characters.'
  if (!SLUG.test(slug))
    return 'Use lowercase letters, numbers and single hyphens, starting and ending with a letter or number.'
  if (RESERVED_SLUGS.has(slug))
    return `“${slug}” is used by Page Studio itself. Choose another address.`
  return ''
}

/**
 * The address for an app name, e.g. "Greenfield School!" → "greenfield-school". Always the same for the
 * same name. Names with no Latin letters or digits fall back to an address built from the app id.
 */
export function slugForName(name: string, fallbackId = ''): string {
  let slug = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '')
  if (!slug)
    slug = `app-${
      fallbackId
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '')
        .slice(0, 8) || 'site'
    }`
  if (slug.length < 3) slug = `${slug}-app`
  return RESERVED_SLUGS.has(slug) ? `${slug}-app` : slug
}

/** The full public address of a page on a published site. */
export function siteUrl(origin: string, slug: string, path = ''): string {
  const tail = path.replace(/^\/+/, '')
  return `${origin.replace(/\/+$/, '')}/${slug}${tail ? `/${tail}` : ''}`
}
