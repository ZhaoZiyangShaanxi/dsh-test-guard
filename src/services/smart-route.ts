import type {
  IntelligentRouter,
  ProviderMetrics,
  ProviderState,
  SmartRouteOptions,
  SmartRouteTransport,
} from '../router/index.js'
import type { ProviderConfig } from '../types/index.js'

const HEALTH_CHECK_INTERVAL_MS = 60_000
const REQUEST_TIMEOUT_MS = 30_000
const PING_TIMEOUT_MS = 5_000

/** Default transport for OpenAI-compatible JSON endpoints. */
export const fetchTransport: SmartRouteTransport = {
  async execute(provider, requestParams) {
    const response = await fetch(provider.endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${provider.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ ...(requestParams ?? {}), model: provider.model }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (!response.ok) throw new Error(`${provider.name}: HTTP ${response.status}`)
    return response.json()
  },
  async ping(provider) {
    const endpoint = new URL(provider.healthCheckEndpoint ?? provider.endpoint)
    if (!provider.healthCheckEndpoint) {
      endpoint.pathname = endpoint.pathname.replace(/\/chat\/completions\/?$/, '/models')
    }
    const headers: Record<string, string> = {}
    if (endpoint.origin === new URL(provider.endpoint).origin) {
      headers.authorization = `Bearer ${provider.apiKey}`
    }
    const response = await fetch(endpoint, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(PING_TIMEOUT_MS),
    })
    if (response.ok) return
    if (!provider.healthCheckEndpoint && [404, 405, 501].includes(response.status)) {
      const chat = await fetch(provider.endpoint, {
        method: 'POST',
        headers: { authorization: `Bearer ${provider.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: provider.model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 }),
        signal: AbortSignal.timeout(PING_TIMEOUT_MS),
      })
      if (chat.ok) return
      throw new Error(`${provider.name}: health chat HTTP ${chat.status}`)
    }
    throw new Error(`${provider.name}: health HTTP ${response.status}`)
  },
}

export class SmartRoute implements IntelligentRouter {
  private readonly providers: readonly ProviderConfig[]
  private readonly states = new Map<string, ProviderState>()
  private readonly revisions = new Map<string, number>()
  private readonly transport: SmartRouteTransport
  private readonly failureThreshold: number
  private readonly now: () => number
  private healthTimer: ReturnType<typeof setInterval> | undefined
  private healthCheckRunning = false

  constructor(providers: readonly ProviderConfig[], options: SmartRouteOptions = {}) {
    this.providers = providers.map(provider => ({ ...provider, taskTypes: [...provider.taskTypes] }))
    this.transport = options.transport ?? fetchTransport
    this.failureThreshold = options.failureThreshold ?? 3
    this.now = options.now ?? Date.now
    if (!Number.isInteger(this.failureThreshold) || this.failureThreshold < 1) {
      throw new Error('failureThreshold 必须是正整数')
    }
    for (const provider of this.providers) {
      if (this.states.has(provider.name)) throw new Error(`Provider 名称重复: ${provider.name}`)
      this.states.set(provider.name, {
        isHealthy: true,
        lastActiveTime: 0,
        recentLatencies: [],
        consecutiveFailures: 0,
      })
      this.revisions.set(provider.name, 0)
    }
  }

  async routeAndExecute(taskType: string, requestParams: any): Promise<any> {
    const attempted = new Set<string>()
    let lastError: unknown

    while (true) {
      const provider = this.providers
        .filter(candidate => candidate.enabled
          && candidate.taskTypes.includes(taskType as ProviderConfig['taskTypes'][number])
          && this.states.get(candidate.name)?.isHealthy
          && !attempted.has(candidate.name))
        .sort((a, b) => {
          if (a.priority !== b.priority) return a.priority - b.priority
          const aLatency = this.averageLatency(a.name)
          const bLatency = this.averageLatency(b.name)
          return aLatency === bLatency ? 0 : aLatency < bLatency ? -1 : 1
        })[0]

      if (!provider) {
        throw new Error(`所有可用 Provider 均已失效（任务类型: ${taskType}）`, { cause: lastError })
      }

      attempted.add(provider.name)
      const state = this.states.get(provider.name)!
      state.lastActiveTime = this.now()
      this.bumpRevision(provider.name)
      const startedAt = this.now()

      try {
        const result = await this.transport.execute(provider, requestParams)
        const latency = Math.max(0, this.now() - startedAt)
        state.recentLatencies.push(latency)
        if (state.recentLatencies.length > 10) state.recentLatencies.shift()
        state.consecutiveFailures = 0
        state.isHealthy = true
        this.bumpRevision(provider.name)
        return result
      } catch (error) {
        lastError = error
        state.consecutiveFailures += 1
        if (state.consecutiveFailures >= this.failureThreshold) state.isHealthy = false
        this.bumpRevision(provider.name)
      }
    }
  }

  startHealthCheck(): void {
    if (this.healthTimer) return
    this.healthTimer = setInterval(() => {
      if (this.healthCheckRunning) return
      this.healthCheckRunning = true
      void this.checkHealth()
        .catch(() => undefined)
        .finally(() => { this.healthCheckRunning = false })
    }, HEALTH_CHECK_INTERVAL_MS)
  }

  stopHealthCheck(): void {
    if (this.healthTimer) clearInterval(this.healthTimer)
    this.healthTimer = undefined
  }

  async checkHealth(providerName?: string): Promise<ProviderMetrics[]> {
    const providers = providerName === undefined
      ? this.providers
      : this.providers.filter(provider => provider.name === providerName)
    if (providerName !== undefined && providers.length === 0) {
      throw new Error(`未知 Provider: ${providerName}`)
    }

    await Promise.all(providers.map(async provider => {
      const revision = this.revisions.get(provider.name)!
      try {
        await this.transport.ping(provider)
        if (this.revisions.get(provider.name) !== revision) return
        const state = this.states.get(provider.name)!
        state.isHealthy = true
        state.consecutiveFailures = 0
        this.bumpRevision(provider.name)
      } catch {
        if (this.revisions.get(provider.name) !== revision) return
        this.states.get(provider.name)!.isHealthy = false
        this.bumpRevision(provider.name)
      }
    }))
    return this.getProviderMetrics()
  }

  getProviderState(providerName: string): ProviderState | undefined {
    const state = this.states.get(providerName)
    return state && { ...state, recentLatencies: [...state.recentLatencies] }
  }

  getProviderMetrics(): ProviderMetrics[] {
    return this.providers.map(provider => {
      const state = this.getProviderState(provider.name)!
      const sorted = [...state.recentLatencies].sort((a, b) => a - b)
      return {
        providerName: provider.name,
        ...state,
        averageLatencyMs: sorted.length ? sorted.reduce((sum, n) => sum + n, 0) / sorted.length : null,
        p95LatencyMs: sorted.length ? sorted[Math.ceil(sorted.length * 0.95) - 1] : null,
      }
    })
  }

  private averageLatency(providerName: string): number {
    const latencies = this.states.get(providerName)!.recentLatencies
    return latencies.length
      ? latencies.reduce((sum, n) => sum + n, 0) / latencies.length
      : Number.POSITIVE_INFINITY
  }

  private bumpRevision(providerName: string): void {
    this.revisions.set(providerName, this.revisions.get(providerName)! + 1)
  }
}
