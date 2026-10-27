import type { CoverageReport, ReviewSeverity } from '../types/index.js'

export type ContextKind =
  | 'test-code'
  | 'assertion'
  | 'source-code'
  | 'config-file'
  | 'coverage-report'
  | 'test-output'
  | 'test-failure'
  | 'review-result'
  | 'tool-result'
  | 'file-reference'
  | 'skill-definition'
  | 'conversation'

/** Text messages can carry editor and file metadata when the host provides it. */
export interface ContextMessage {
  content: string
  kind?: ContextKind
  filePath?: string
  /** One-based source line for a single-line or focused snippet. */
  lineNumber?: number
  isActiveFile?: boolean
  isSelectedFile?: boolean
  isRecentlyModified?: boolean
  sourceId?: string
  invoked?: boolean
}

export interface ContextEntry extends ContextMessage {
  id: string
  kind: ContextKind
  createdAt: number
  /** Used to detect repeated tool results and stale file references. */
  lastReferencedAt?: number
  coverage?: CoverageReport
  severity?: ReviewSeverity
}

/** Preserves test evidence while compacting lower-priority conversation and tool data. */
export interface TestContextManager {
  compressContext<T extends ContextMessage>(messages: readonly T[], maxTokens: number): T[]
  updateCoverageData(coverageMap: unknown): void
}
