/** The task tags used to select an LLM provider. */
export type TaskType =
  | 'review'
  | 'code-review'
  | 'complex-logic'
  | 'test-generation'
  | 'test-gen'
  | 'chat'
  | 'text-formatting'
  | 'context-analysis'
  | 'summarization'
  | 'coverage-analysis'
  | 'regression-analysis'

export type ReviewSeverity = 'critical' | 'high' | 'medium' | 'low'

export interface ProviderConfig {
  name: string
  endpoint: string
  healthCheckEndpoint?: string
  apiKey: string
  model: string
  enabled: boolean
  priority: number
  taskTypes: TaskType[]
}

export interface PluginConfig {
  providers: ProviderConfig[]
  /** Tool output beyond this length is shortened to head + tail. */
  toolResultLimit: number
  toolResultHeadChars: number
  toolResultTailChars: number
  /** Fractions from 0 to 1. Only regions below this level survive context compaction. */
  lowCoverageThreshold: number
  minLineCoverage: number
  minBranchCoverage: number
  blockSeverities: ReviewSeverity[]
}

export interface SourceChange {
  filePath: string
  source: 'git-diff' | 'file-save'
  diff: string
  previousContent?: string
  currentContent?: string
}

export interface TestReference {
  id: string
  filePath: string
  name: string
  command?: string
}

export interface CoverageRegion {
  startLine: number
  endLine: number
  lineCoverage: number
  branchCoverage?: number
}

export interface FileCoverage {
  filePath: string
  lineCoverage: number
  branchCoverage?: number
  regions: CoverageRegion[]
}

export interface CoverageReport {
  format: 'lcov' | 'istanbul'
  files: FileCoverage[]
}

export interface RegressionSelection {
  test: TestReference
  affectedBy: string[]
  reason: string
}

export interface RegressionPlan {
  testsToRerun: RegressionSelection[]
}

export interface QualityGateResult {
  passed: boolean
  coveragePassed: boolean
  blockingFindingIds: string[]
  lineCoverage: number
  branchCoverage?: number
}
