# Page Studio (web-builder)

Angular 22 drag-and-drop page builder for SPS EDU 360. It runs fully in the
browser and is deployed to Cloudflare Workers as static assets.

## Development

From the repository root:

```bash
pnpm install
pnpm --filter @spsedu360/web-builder dev    # http://localhost:3002
pnpm --filter @spsedu360/web-builder test   # builder-model unit tests
pnpm --filter @spsedu360/web-builder lint   # type-check
```

## Build

```bash
pnpm build:web-builder
```

Output goes to `apps/web-builder/dist/browser`.

## Deploy (Cloudflare Workers)

Deployment is configured in [`wrangler.jsonc`](../../wrangler.jsonc) at the
repository root. `wrangler deploy` runs the build first, then uploads
`dist/browser` as a static-assets Worker with single-page-app fallback.

```bash
pnpm deploy:web-builder
```

Cloudflare Workers Builds settings:

| Setting        | Value                |
| -------------- | -------------------- |
| Root directory | `/` (repository root) |
| Build command  | _(leave empty)_      |
| Deploy command | `npx wrangler deploy` |
