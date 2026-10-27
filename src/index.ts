import type { Context } from '@deepseek-ai/cordis'
import { Config } from './config.js'
import { SmartRoute } from './services/smart-route.js'
import { TestAwareContext } from './services/test-aware-context.js'
import { CodeReview } from './services/code-review.js'
import type { IntelligentRouter } from './router/index.js'
import type { TestContextManager } from './context/index.js'
import type { CodeReviewer, IdeChangeProvider } from './review/index.js'
import type { PluginConfig } from './types/index.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    smartRoute: IntelligentRouter
    testAwareContext: TestContextManager
    codeReview: CodeReviewer
    testGuardIdeChanges: IdeChangeProvider
  }
}

export const name = 'dsh-test-guard'
export { Config }
export { SmartRoute }
export { TestAwareContext }
export { CodeReview }
export { applyGateToControls, toGateViewModel } from './frontend/gate-status.js'
export type { GateControls, GateViewModel } from './frontend/gate-status.js'
export { ReviewPanel } from './frontend/components/ReviewPanel.js'
export type { ReviewPanelIde, ReviewPanelServices } from './frontend/components/ReviewPanel.js'
export type { PluginConfig }
export type * from './types/index.js'
export type * from './router/index.js'
export type * from './context/index.js'
export type * from './review/index.js'
export type * from './generator/index.js'

/** Cordis entry point. LLM calls from the review service always use smartRoute. */
export function apply(ctx: Context, config: PluginConfig): void {
  const router = new SmartRoute(config.providers)
  const context = new TestAwareContext(config.lowCoverageThreshold)
  ctx.provide('smartRoute', router)
  ctx.provide('testAwareContext', context)
  ctx.provide('codeReview', new CodeReview(router, context, {
    ideChangeProvider: () => ctx.get('testGuardIdeChanges'),
    minLineCoverage: config.minLineCoverage,
  }))
  ctx.effect(() => {
    router.startHealthCheck()
    return () => router.stopHealthCheck()
  }, 'smart-route health check')
}
