/** Full file contents plus line numbers added by the current diff. */
export interface ChangeItem {
  filePath: string
  oldContent: string
  newContent: string
  addedLines: number[]
  isTestFile: boolean
}

export interface ReviewIssue {
  /** Repository-relative path; required to locate an issue in a multi-file review. */
  filePath?: string
  line: number
  severity: 'critical' | 'warning' | 'info'
  category: 'logic' | 'test-missing' | 'assertion-weak'
  message: string
  suggestion: string
}

/** Strict JSON shape returned to the UI. */
export interface ReviewResult {
  summary: string
  issues: ReviewIssue[]
  affectedTests: string[]
}

export interface LineCoverageReport {
  filePath: string
  /** Istanbul line hits, keyed by one-based source line. */
  lines: Record<number, number>
  uncoveredBranchLines: number[]
}

export interface LoadedCoverageReport {
  files: LineCoverageReport[]
  coveredLines: number
  totalLines: number
  /** Fraction from 0 to 1. */
  lineCoverage: number
}

export interface GateCheckResult {
  status: 'blocked' | 'warning' | 'passed'
  /** Whether the front end may enable its submit action. */
  allowed: boolean
  message: string
  lineCoverage: number | null
  minLineCoverage: number
  blockingIssues: ReviewIssue[]
}

/** IDE integration supplies recent saved-file diffs when Git is unavailable. */
export interface IdeFileDiff {
  filePath: string
  oldContent: string
  newContent: string
  diff: string
}

export interface IdeChangeProvider {
  getRecentFileDiffs(): Promise<readonly IdeFileDiff[]>
}

export interface CodeReviewOptions {
  workspaceRoot?: string
  /** Read lazily so a Cordis IDE service may mount after this plugin. */
  ideChangeProvider?: () => IdeChangeProvider | undefined
  maxPromptTokens?: number
  /** Fraction from 0 to 1. Defaults to 0.8. */
  minLineCoverage?: number
}

export interface CodeReviewer {
  getCurrentCodeChanges(): Promise<ChangeItem[]>
  loadCoverageReport(path: string): Promise<LoadedCoverageReport>
  review(changes: readonly ChangeItem[]): Promise<ReviewResult>
  gateCheck(result: ReviewResult): GateCheckResult
  onReviewed(listener: (result: ReviewResult, changes: readonly ChangeItem[]) => void): () => void
}
