# Page Studio (web-builder)

No-code app builder for SPS EDU 360. Authors build apps from pages, reusable
components and journeys (flows); the backend runs on the same Cloudflare Worker
that serves the app.

Page Studio is three projects in this monorepo:

| Project | Package | What it is |
| ------- | ------- | ---------- |
| [`apps/web-builder`](.) | `@spsedu360/web-builder` | Front end (Angular 22 + Material): landing, builder, flow editor, live apps |
| [`api/web-builder-api`](../../api/web-builder-api) | `@spsedu360/web-builder-api` | Backend (Cloudflare Worker): `/api/*` routes, Neon storage, publishing, server flows, MySQL/Postgres, OpenBao, Upstash, S3, Cloudflare Access, Better Auth |
| [`libs/engine`](../../libs/engine) | `@spsedu360/engine` | Engines and the project model, used by both: JSON Logic, flows, retries and circuit breakers, JSON-to-SQL queries, access rules, publishing |

Both the front end and the backend import the engines as `@spsedu360/engine/<name>`,
for example `@spsedu360/engine/query`. The builder's preview and test runs use the same
engines as the live backend, so they behave the same.

## Run locally

From the repository root:

```bash
pnpm install
pnpm dev:web-builder        # backend on :8787 and the app on http://localhost:3002
```

Open http://localhost:3002 and enter the `ADMIN_TOKEN` from `.dev.vars` (repository root)
to connect. Locally there is no Cloudflare Access, so the token stands in for it.
Local data is kept by Wrangler in `.wrangler/` (a stand-in for Workers KV) unless
`DATABASE_URL` is set in `.dev.vars`.

`pnpm --filter @spsedu360/web-builder dev` starts only the front end; without the
backend the app falls back to "This device only" and hides server features.

```bash
pnpm test:web-builder                              # tests of all three projects (Vitest)
pnpm --filter @spsedu360/engine test              # engines only
pnpm --filter @spsedu360/web-builder-api test     # backend only
pnpm --filter @spsedu360/web-builder lint         # type-check the front end (also: web-builder-api, engine)
```

## Deploy (Cloudflare Workers)

Deployment is configured in [`wrangler.jsonc`](../../wrangler.jsonc) at the repository
root: it serves the built front end (`apps/web-builder/dist/browser`) and runs
`api/web-builder-api/src/index.ts` for `/api/*`.

```bash
pnpm deploy:web-builder
```

Cloudflare Workers Builds settings:

| Setting        | Value                  |
| -------------- | ---------------------- |
| Root directory | `/` (repository root)  |
| Build command  | `pnpm build:web-builder` |
| Deploy command | `npx wrangler deploy`  |

## Settings and secrets

Set secrets with `npx wrangler secret put NAME` (never commit them). For local
development put the same names in `.dev.vars` at the repository root. Every service
is optional: features that need a missing one are switched off, and `/api/health`
shows what is configured.

| Name | Kind | Used for |
| ---- | ---- | -------- |
| `DATABASE_URL` | secret | Neon Postgres connection string (database `web_bulder_config`). Stores apps, versions, live apps, flow runs, users, members, file records. Without it, the `PROJECTS` KV binding is used. |
| `CF_ACCESS_TEAM_DOMAIN` | variable | Cloudflare Access team domain, e.g. `yourteam.cloudflareaccess.com`. Identifies builder users. |
| `CF_ACCESS_AUD` | variable | Application Audience (AUD) tag of the Access application. |
| `ADMIN_TOKEN` | secret | Admin sign-in when Cloudflare Access is not set up (local development, emergencies). |
| `BETTER_AUTH_SECRET` | secret | Signs app users' sessions (sign-in on published apps). Needs `DATABASE_URL`. |
| `CREDENTIALS_KEY` | secret | Encrypts the credentials authors save in the builder (AES-256-GCM); they are stored encrypted in Neon. At least 32 random characters; never change it once credentials are saved. |
| `OPENBAO_ADDR` | variable | Optional, instead of `CREDENTIALS_KEY`: address of an OpenBao server you run on another host (Workers cannot run OpenBao). |
| `OPENBAO_TOKEN` | secret | OpenBao token allowed to read and write `secret/page-studio/*`. |
| `OPENBAO_MOUNT` | variable | KV v2 mount (default `secret`, set in `wrangler.jsonc`). |
| `OPENBAO_NAMESPACE` | variable | Only for OpenBao namespaces. |
| `APP_SECRET_<NAME>` | secret | Read-only credentials set on the Worker itself; flows see them as `secrets.<NAME>`. |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | secret | Shared circuit breakers, rate limits and the live-app cache. |
| `QSTASH_TOKEN` | secret | Background runs and scheduled journeys. |
| `QSTASH_CURRENT_SIGNING_KEY` / `QSTASH_NEXT_SIGNING_KEY` | secret | Verifies QStash calls to `/api/queue/run`. |
| `QSTASH_URL` | variable | Only for a regional QStash endpoint. |
| `AWS_ENDPOINT_URL_S3` | variable | Neon Object Storage endpoint of your branch, for file and image uploads. |
| `AWS_REGION` | variable | Its region, e.g. `us-east-2` (read from the endpoint when not set). |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | secret | Neon storage credential: `token_id` / `s3_secret_access_key`. |
| `S3_BUCKET` | variable | Bucket name, `web-bulder-config-s3` (set in `wrangler.jsonc`). |
| `S3_PUBLIC_URL` | variable | Optional public base URL for files; otherwise files are served through signed links. |

Files go to Neon Object Storage (any S3-compatible store works; `S3_ENDPOINT`,
`S3_REGION`, `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY` are accepted too). Uploads go
straight from the browser to the bucket; on the first upload from a domain, the backend
adds that domain to the bucket's CORS rules itself. Keep the bucket private: files are
served through signed links.

## Who can do what

- **Admins** (the first person to sign in, then anyone an admin promotes in *People*)
  can open and change every app and reassign owners.
- **Authors** own one app; it can have any number of pages, components, journeys and versions.
- **App users** sign in on a published app; each app defines its own roles, and authors
  choose which pages, blocks and journeys each role can use (enforced on the server).

## Publishing

Apps are published in parts: components, then the pages that use them, then the app
settings (journeys, variables, sign-in, page order). Each save creates a draft version;
each part keeps its last two versions, and one version is live. A live app is at
`<domain>/<app-name>/<page path>?<query>`, where the app name is unique.
