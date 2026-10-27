import { afterEach, describe, expect, it, vi } from 'vitest'
import { SmartRoute, fetchTransport } from '../src/services/smart-route.js'
import type { SmartRouteTransport } from '../src/router/index.js'
import type { ProviderConfig, TaskType } from '../src/types/index.js'

function provider(name: string, priority: number, taskTypes: TaskType[], enabled = true): ProviderConfig {
  return {
    name,
    endpoint: `https://${name}.example.test/chat/completions`,
    apiKey: 'test-key',
    model: name,
    enabled,
    priority,
    taskTypes,
  }
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('SmartRoute', () => {
  it('selects the lowest priority number before latency, then the lowest mean latency on a tie', async () => {
    let clock = 1_000
    const transport: SmartRouteTransport = {
      execute: vi.fn(async candidate => {
        clock += candidate.name === 'slow' ? 100 : candidate.name === 'quick' ? 10 : 1
        return candidate.name
      }),
      ping: vi.fn(async () => {}),
    }
    const router = new SmartRoute([
      provider('slow', 1, ['code-review', 'context-analysis']),
      provider('quick', 1, ['code-review', 'test-generation']),
      provider('cheap', 2, ['code-review', 'text-formatting']),
    ], { transport, now: () => clock })

    await router.routeAndExecute('context-analysis', {}) // slow: 100 ms
    await router.routeAndExecute('test-generation', {}) // quick: 10 ms
    await router.routeAndExecute('text-formatting', {}) // cheap: 1 ms
    expect(await router.routeAndExecute('code-review', {})).toBe('quick')
    expect((transport.execute as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0].name).toBe('quick')
    expect(router.getProviderMetrics().find(item => item.providerName === 'quick')).toMatchObject({
      averageLatencyMs: 10,
      p95LatencyMs: 10,
    })
  })

  it('falls back on a failed provider and ignores disabled providers', async () => {
    const calls: string[] = []
    const transport: SmartRouteTransport = {
      execute: async candidate => {
        calls.push(candidate.name)
        if (candidate.name === 'primary') throw new Error('network down')
        return { provider: candidate.name }
      },
      ping: async () => {},
    }
    const router = new SmartRoute([
      provider('primary', 1, ['test-generation']),
      provider('disabled', 0, ['test-generation'], false),
      provider('backup', 2, ['test-generation']),
    ], { transport })

    await expect(router.routeAndExecute('test-generation', { prompt: 'test' }))
      .resolves.toEqual({ provider: 'backup' })
    expect(calls).toEqual(['primary', 'backup'])
    expect(router.getProviderState('primary')).toMatchObject({
      isHealthy: true,
      consecutiveFailures: 1,
    })
  })

  it('opens the circuit after three consecutive failures and recovers after a successful ping', async () => {
    const calls: string[] = []
    let primaryFails = true
    const transport: SmartRouteTransport = {
      execute: async candidate => {
        calls.push(candidate.name)
        if (candidate.name === 'primary' && primaryFails) throw new Error('timeout')
        return candidate.name
      },
      ping: async () => {},
    }
    const router = new SmartRoute([
      provider('primary', 1, ['code-review']),
      provider('backup', 2, ['code-review']),
    ], { transport })

    for (let i = 0; i < 3; i++) {
      expect(await router.routeAndExecute('code-review', {})).toBe('backup')
    }
    expect(router.getProviderState('primary')).toMatchObject({
      isHealthy: false,
      consecutiveFailures: 3,
    })
    expect(await router.routeAndExecute('code-review', {})).toBe('backup')
    expect(calls).toEqual(['primary', 'backup', 'primary', 'backup', 'primary', 'backup', 'backup'])

    primaryFails = false
    await router.checkHealth('primary')
    expect(router.getProviderState('primary')).toMatchObject({
      isHealthy: true,
      consecutiveFailures: 0,
    })
    expect(await router.routeAndExecute('code-review', {})).toBe('primary')
  })

  it('keeps only ten latency samples and reports a clear error when every provider fails', async () => {
    let clock = 0
    let latency = 0
    const transport: SmartRouteTransport = {
      execute: async () => {
        clock += ++latency
        return latency
      },
      ping: async () => {},
    }
    const router = new SmartRoute([provider('only', 1, ['summarization'])], {
      transport,
      now: () => clock,
    })
    for (let i = 0; i < 11; i++) await router.routeAndExecute('summarization', {})
    expect(router.getProviderState('only')?.recentLatencies).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
    expect(router.getProviderMetrics()[0]).toMatchObject({
      averageLatencyMs: 6.5,
      p95LatencyMs: 11,
    })

    const failed = new SmartRoute([provider('down', 1, ['summarization'])], {
      transport: { execute: async () => { throw new Error('HTTP 500') }, ping: async () => {} },
    })
    await expect(failed.routeAndExecute('summarization', {}))
      .rejects.toThrow('所有可用 Provider 均已失效')
  })

  it('runs health checks every 60 seconds and stops the timer', async () => {
    vi.useFakeTimers()
    const ping = vi.fn(async () => {})
    const router = new SmartRoute([provider('one', 1, ['context-analysis'])], {
      transport: { execute: async () => null, ping },
    })
    router.startHealthCheck()
    router.startHealthCheck()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(ping).toHaveBeenCalledTimes(1)
    router.stopHealthCheck()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(ping).toHaveBeenCalledTimes(1)
  })

  it('does not let a stale successful ping erase a newer request failure', async () => {
    let finishPing!: () => void
    const router = new SmartRoute([provider('one', 1, ['code-review'])], {
      failureThreshold: 1,
      transport: {
        execute: async () => { throw new Error('request failed') },
        ping: () => new Promise<void>(resolve => { finishPing = resolve }),
      },
    })
    const checking = router.checkHealth()
    await expect(router.routeAndExecute('code-review', {})).rejects.toThrow('所有可用 Provider 均已失效')
    finishPing()
    await checking
    expect(router.getProviderState('one')?.isHealthy).toBe(false)
  })

  it('retains the latest ten samples after concurrent completions', async () => {
    const resolveRequests: Array<(value: number) => void> = []
    const router = new SmartRoute([provider('one', 1, ['test-generation'])], {
      transport: {
        execute: () => new Promise<number>(resolve => { resolveRequests.push(resolve) }),
        ping: async () => {},
      },
    })
    const requests = Array.from({ length: 20 }, () => router.routeAndExecute('test-generation', {}))
    resolveRequests.forEach((resolve, index) => resolve(index))
    expect(await Promise.all(requests)).toEqual(Array.from({ length: 20 }, (_, index) => index))
    expect(router.getProviderState('one')?.recentLatencies).toHaveLength(10)
  })

  it('treats an HTTP error from the default fetch transport as a failure', async () => {
    const fetchMock = vi.fn(async () => new Response('unavailable', { status: 503 }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(fetchTransport.execute(provider('one', 1, ['code-review']), {}))
      .rejects.toThrow('HTTP 503')
  })

  it('pings the lightweight models endpoint for a chat-completions provider', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    await fetchTransport.ping(provider('one', 1, ['code-review']))
    expect(fetchMock.mock.calls[0]?.[0].toString()).toBe('https://one.example.test/models')
  })

  it('falls back to a minimal chat request when the models endpoint is unsupported', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 404 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    await fetchTransport.ping(provider('one', 1, ['chat']))
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[0][0].toString()).toBe('https://one.example.test/models')
    expect(fetchMock.mock.calls[1][0].toString()).toBe('https://one.example.test/chat/completions')
    expect(fetchMock.mock.calls[1][1].method).toBe('POST')
  })
})
