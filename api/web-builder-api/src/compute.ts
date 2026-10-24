/**
 * Backend computation engine. Runs "Server" flows with the same JSON Logic
 * engine and flow runner the browser uses, plus things only the server has:
 * credentials from OpenBao (`secrets.NAME`), no CORS limits, and a shared
 * circuit breaker per Worker isolate.
 */
import { Project } from '@spsedu360/engine/model'
import { FlowResult, fetchHttp, runFlow } from '@spsedu360/engine/flow'
import { BreakerRegistry } from '@spsedu360/engine/resilience'
import { SecretStore, redact } from './secrets'
import { ProjectStore, RunSource } from './storage'
import { RedisLike, loadBreakers, saveBreakers } from './upstash'
import { Connector, connect, runQuery } from './datasources'
import { ANONYMOUS, Visitor, allows } from '@spsedu360/engine/access'
import { callApi as sendApi } from './apis'

// Circuits survive between requests handled by the same isolate.
const breakers = new BreakerRegistry()

export class ComputeError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

export interface ComputeRequest {
  input?: unknown
  params?: unknown
  query?: unknown
  /**
   * The visitor's current variables (this visit, session and device), sent by the browser so server
   * journeys can use them. Supplied by the visitor: fine for preferences and filters, never for
   * deciding access, which must use `user` (from the signed-in session).
   */
  state?: {
    vars?: Record<string, unknown>
    session?: Record<string, unknown>
    local?: Record<string, unknown>
  }
}

export async function runServerFlow(options: {
  project: Project
  flowId: string
  request: ComputeRequest
  origin: string
  secrets: SecretStore
  store: ProjectStore
  source: RunSource
  /** Shares circuit breaker state across isolates when configured. */
  redis?: RedisLike | null
  /** Database connector; replaced in tests. */
  connector?: Connector
  /** Signed-in visitor, from the server session (never from the request body). */
  user?: Visitor
  /**
   * Run by the system rather than a live request: scheduled jobs, and background runs whose
   * trigger was already authorized. Access rules are not checked again.
   */
  system?: boolean
  /** Stores a file an app user sent (the "Save uploaded file" step). */
  storeFile?: (file: {
    name: string
    type: string
    size: number
    dataUrl: string
  }) => Promise<Record<string, unknown>>
}): Promise<FlowResult> {
  const { project, flowId, request } = options
  const flow = project.flows.find((item) => item.id === flowId)
  if (!flow) throw new ComputeError(404, 'Flow not found.')
  if (flow.runAt !== 'server')
    throw new ComputeError(
      400,
      'This flow runs in the browser, not on the server.',
    )
  const user = options.user ?? ANONYMOUS
  // System runs (schedules, and background runs already authorized when they were triggered) skip user checks.
  if (!options.system && !allows(flow.access, user))
    throw new ComputeError(
      user.signedIn ? 403 : 401,
      user.signedIn
        ? 'You do not have access to this.'
        : 'Please sign in first.',
    )

  let secrets: Record<string, string> = {}
  try {
    secrets = await options.secrets.values(project.id)
  } catch (error) {
    // Flows that don't need credentials still run; ones that do will fail with a clear message.
    console.warn(
      'Secrets unavailable:',
      error instanceof Error ? error.message : error,
    )
  }
  const context = {
    input: request.input ?? {},
    params: request.params ?? {},
    query: request.query ?? {},
    vars: {
      ...Object.fromEntries(
        project.variables
          .filter((v) => v.scope === 'vars')
          .map((v) => [v.name, v.initial]),
      ),
      ...(request.state?.vars ?? {}),
    },
    session: request.state?.session ?? {},
    local: request.state?.local ?? {},
    secrets,
    // Trusted: lets queries gather only this visitor's data, e.g. student_id = user.id.
    user,
  }
  await loadBreakers(options.redis ?? null, breakers, project.id)
  const result = await runFlow(
    flow,
    context,
    {
      http: (req, signal) => fetchHttp(req, signal, options.origin),
      query: async (dataSourceId, query, data) => {
        const source = project.dataSources.find(
          (item) => item.id === dataSourceId,
        )
        if (!source)
          throw new ComputeError(400, 'That data source no longer exists.')
        return runQuery(
          source,
          query,
          data,
          secrets,
          options.connector ?? connect,
        )
      },
      callApi: async (apiId, args, signal) => {
        const api = project.apis?.find((item) => item.id === apiId)
        if (!api) throw new ComputeError(400, 'That API no longer exists.')
        if (!options.system && !allows(api.access, user))
          throw new ComputeError(
            user.signedIn ? 403 : 401,
            `You do not have access to ${api.name}.`,
          )
        return sendApi(api, args, { secrets, signal })
      },
      ...(options.storeFile
        ? {
            storeFile: (file: {
              name: string
              type: string
              size: number
              dataUrl: string
            }) => options.storeFile!(file),
          }
        : {}),
    },
    { side: 'server', breakers, key: project.id, concurrency: 6 },
  )
  await saveBreakers(options.redis ?? null, breakers, project.id)
  // Run history is best effort: never fail the visitor's request because logging failed.
  await options.store
    .logRun({
      projectId: project.id,
      flowId,
      source: options.source,
      status: result.status,
      durationMs: result.durationMs,
      error: result.error ?? null,
    })
    .catch((error) => console.warn('Could not record flow run:', error))
  // Only the flow result leaves the server; step outputs may hold secret-derived data.
  return redact(
    {
      ...result,
      steps: Object.fromEntries(
        Object.entries(result.steps).map(([id, step]) => [
          id,
          { ...step, output: undefined },
        ]),
      ),
    },
    secrets,
  )
}

/** Who scheduled jobs run as: the system, with every role of the app, never a real person. */
export function systemUser(project: Project): Visitor {
  return {
    signedIn: true,
    id: 'system',
    email: null,
    name: 'System',
    roles: project.auth?.roles.map((role) => role.id) ?? [],
  }
}
