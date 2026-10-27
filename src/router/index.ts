import type { ProviderConfig } from '../types/index.js'

/** Mutable state is owned by SmartRoute; callers receive snapshots only. */
export interface ProviderState {
  isHealthy: boolean
  lastActiveTime: number
  recentLatencies: number[]
  consecutiveFailures: number
}

export interface ProviderMetrics extends ProviderState {
  providerName: string
  averageLatencyMs: number | null
  p95LatencyMs: number | null
}

/** Swap this boundary in tests or for non-OpenAI-compatible APIs. */
export interface SmartRouteTransport {
  execute(provider: ProviderConfig, requestParams: any): Promise<any>
  ping(provider: ProviderConfig): Promise<void>
}

export interface SmartRouteOptions {
  transport?: SmartRouteTransport
  failureThreshold?: number
  /** Millisecond clock, injectable for deterministic latency tests. */
  now?: () => number
}

/** The only LLM request entry point for dsh-test-guard modules. */
export interface IntelligentRouter {
  routeAndExecute(taskType: string, requestParams: any): Promise<any>
  startHealthCheck(): void
  stopHealthCheck(): void
  checkHealth(providerName?: string): Promise<ProviderMetrics[]>
  getProviderState(providerName: string): ProviderState | undefined
  getProviderMetrics(): ProviderMetrics[]
}
