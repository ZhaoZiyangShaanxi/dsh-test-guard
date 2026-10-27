import type { CoverageReport, SourceChange } from '../types/index.js'
import type { ReviewIssue } from '../review/index.js'

export type GenerationMode = 'incremental' | 'completion'
export type TestKind = 'unit' | 'api'

export interface TestGenerationInput {
  mode: GenerationMode
  kind: TestKind
  changes: SourceChange[]
  coverage?: CoverageReport
  reviewFindings: ReviewIssue[]
}

export interface GeneratedTest {
  id: string
  sourceFilePath: string
  testFilePath: string
  /** Runnable TypeScript source using Vitest. */
  code: string
  relatedFindingIds: string[]
}

export interface TestGenerationResult {
  tests: GeneratedTest[]
}

export interface TestGenerator {
  generate(input: TestGenerationInput): Promise<TestGenerationResult>
}
