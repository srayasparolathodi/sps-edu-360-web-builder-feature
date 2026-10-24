export interface RetryPolicy {
  /** Total tries including the first one (1 = no retry). */
  attempts: number
  delayMs: number
  backoff: 'fixed' | 'exponential'
  maxDelayMs: number
}

export interface BreakerPolicy {
  enabled: boolean
  /** Consecutive failures that open the circuit. */
  failureThreshold: number
  /** How long the circuit stays open before one trial call is allowed. */
  cooldownMs: number
}

export const DEFAULT_RETRY: RetryPolicy = {
  attempts: 1,
  delayMs: 500,
  backoff: 'exponential',
  maxDelayMs: 10_000,
}

export const DEFAULT_BREAKER: BreakerPolicy = {
  enabled: false,
  failureThreshold: 5,
  cooldownMs: 30_000,
}

/** Error carrying an HTTP status, so retry rules can tell 4xx from 5xx. */
export class StepError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryable = true,
  ) {
    super(message)
  }
}

export class TimeoutError extends StepError {
  constructor(ms: number) {
    super(`Timed out after ${Math.round(ms / 100) / 10}s.`, undefined, true)
  }
}

export class CircuitOpenError extends StepError {
  constructor(readonly retryAt: number) {
    super(
      'Temporarily paused after repeated failures. It will be tried again shortly.',
      undefined,
      false,
    )
  }
}

export type CircuitState = 'closed' | 'open' | 'half-open'

export interface CircuitRecord {
  state: CircuitState
  failures: number
  openedAt: number
}

/**
 * Tracks circuits by key. One registry is kept per browser tab or Worker
 * isolate, so a failing dependency stops being called for everyone using it.
 */
export class BreakerRegistry {
  private readonly circuits = new Map<string, CircuitRecord>()

  constructor(private readonly now: () => number = Date.now) {}

  state(key: string, policy: BreakerPolicy): CircuitState {
    const record = this.circuits.get(key)
    if (!record) return 'closed'
    if (
      record.state === 'open' &&
      this.now() - record.openedAt >= policy.cooldownMs
    )
      record.state = 'half-open'
    return record.state
  }

  /** Throws CircuitOpenError when the call must not be attempted. */
  before(key: string, policy: BreakerPolicy): void {
    if (!policy.enabled) return
    if (this.state(key, policy) === 'open') {
      const record = this.circuits.get(key)!
      throw new CircuitOpenError(record.openedAt + policy.cooldownMs)
    }
  }

  success(key: string): void {
    this.circuits.delete(key)
  }

  failure(key: string, policy: BreakerPolicy): void {
    if (!policy.enabled) return
    const record = this.circuits.get(key) ?? {
      state: 'closed' as CircuitState,
      failures: 0,
      openedAt: 0,
    }
    record.failures++
    // A failed trial call re-opens immediately.
    if (
      record.state === 'half-open' ||
      record.failures >= policy.failureThreshold
    ) {
      record.state = 'open'
      record.openedAt = this.now()
    }
    this.circuits.set(key, record)
  }

  /** Circuit records whose key starts with `prefix`, for sharing between servers. */
  snapshot(prefix: string): Record<string, CircuitRecord> {
    const result: Record<string, CircuitRecord> = {}
    for (const [key, record] of this.circuits)
      if (key.startsWith(prefix)) result[key] = { ...record }
    return result
  }

  /** Loads records from another server, keeping whichever saw the latest failure. */
  restore(records: Record<string, CircuitRecord>): void {
    for (const [key, record] of Object.entries(records)) {
      const local = this.circuits.get(key)
      if (
        !local ||
        record.openedAt > local.openedAt ||
        record.failures > local.failures
      )
        this.circuits.set(key, { ...record })
    }
  }

  reset(key?: string): void {
    if (key) this.circuits.delete(key)
    else this.circuits.clear()
  }
}

export function retryDelay(policy: RetryPolicy, attempt: number): number {
  const base =
    policy.backoff === 'exponential'
      ? policy.delayMs * 2 ** (attempt - 1)
      : policy.delayMs
  // Full jitter keeps many clients from retrying in lock step.
  const capped = Math.min(base, policy.maxDelayMs)
  return Math.round(capped / 2 + (Math.random() * capped) / 2)
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted)
      return reject(new StepError('Cancelled.', undefined, false))
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(new StepError('Cancelled.', undefined, false))
      },
      { once: true },
    )
  })
}

/** Runs `task` with a timeout; the task receives a signal it should honour. */
export async function withTimeout<T>(
  task: (signal: AbortSignal) => Promise<T>,
  ms: number,
  outer?: AbortSignal,
): Promise<T> {
  const controller = new AbortController()
  const abort = () => controller.abort()
  outer?.addEventListener('abort', abort, { once: true })
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const timeout = new Promise<never>((_, reject) => {
      if (ms > 0)
        timer = setTimeout(() => {
          controller.abort()
          reject(new TimeoutError(ms))
        }, ms)
    })
    return await Promise.race([task(controller.signal), timeout])
  } finally {
    clearTimeout(timer)
    outer?.removeEventListener('abort', abort)
  }
}

/** Runs `task` with retries, a per-attempt timeout and a circuit breaker. */
export async function callWithPolicy<T>(
  task: (signal: AbortSignal) => Promise<T>,
  options: {
    key: string
    registry: BreakerRegistry
    retry?: Partial<RetryPolicy>
    breaker?: Partial<BreakerPolicy>
    timeoutMs?: number
    signal?: AbortSignal
  },
): Promise<T> {
  const retry = { ...DEFAULT_RETRY, ...options.retry }
  const breaker = { ...DEFAULT_BREAKER, ...options.breaker }
  for (let attempt = 1; ; attempt++) {
    options.registry.before(options.key, breaker)
    try {
      const result = await withTimeout(
        task,
        options.timeoutMs ?? 0,
        options.signal,
      )
      options.registry.success(options.key)
      return result
    } catch (error) {
      options.registry.failure(options.key, breaker)
      if (!isRetryable(error) || attempt >= retry.attempts) throw error
      await sleep(retryDelay(retry, attempt), options.signal)
    }
  }
}

/** Default rule: retry network errors, timeouts, 408, 429 and 5xx. */
export function isRetryable(error: unknown): boolean {
  if (error instanceof StepError) {
    if (!error.retryable) return false
    if (error.status === undefined) return true
    return error.status === 408 || error.status === 429 || error.status >= 500
  }
  return true
}
