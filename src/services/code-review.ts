import { execFile } from 'node:child_process'
import { statSync } from 'node:fs'
import { lstat, readFile, readdir, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import type { TestContextManager } from '../context/index.js'
import type {
  ChangeItem,
  CodeReviewer,
  CodeReviewOptions,
  GateCheckResult,
  LoadedCoverageReport,
  ReviewIssue,
  ReviewResult,
} from '../review/index.js'
import type { IntelligentRouter } from '../router/index.js'

const execFileAsync = promisify(execFile)
const TEST_FILE = /(?:^|[\\/])__tests__[\\/].*\.[cm]?[jt]sx?$|\.(?:test|spec)\.[cm]?[jt]sx?$/i
const CODE_FILE = /\.[cm]?[jt]sx?$/i
const CONFIG_FILE = /(?:^|[\\/])(?:vitest|jest|playwright|vite|webpack)\.config\.[cm]?[jt]s$/i
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', 'coverage', '.next'])

const REVIEW_INSTRUCTIONS = `你是测试开发代码审查员。只输出一个严格 JSON 对象，字段必须是 summary、issues、affectedTests。
issues 的每项只能有 line（正整数）、severity（critical/warning/info）、category（logic/test-missing/assertion-weak）、message、suggestion。
逐项检查七个维度：
1. 安全：SQL 注入、XSS、硬编码密钥等；2. 性能：N+1 查询、内存泄漏等；3. 逻辑与质量：边界条件、空值、异常处理、命名、函数长度和可维护性。
4. 测试覆盖：以提供的真实覆盖率数据为准，检查新增 if/else 等分支；未覆盖时使用 category=test-missing，并在 message 标记 MISSING_COVERAGE。未知覆盖率不能视为已覆盖。
5. 回归影响：根据 Import/Require 关系列出必须重跑的已有测试文件，填入 affectedTests。
6. 缺陷防御：critical/warning 问题若现有断言无法捕获，使用 category=assertion-weak，并在 message 标记 WEAK_ASSERTION，suggestion 给出补充回归测试的建议。
7. 断言有效性：新增测试用例必须有能检查返回值或异常的 expect/assert 断言，空跑测试使用 category=assertion-weak。
每条 issue 必须给出 filePath（相对仓库根目录）和 line。常规安全、性能和逻辑问题统一使用 category=logic。不要输出 Markdown、代码围栏或额外字段。`

interface CoverageFile {
  filePath: string
  lineHits: Map<number, number>
  uncoveredBranchLines: Set<number>
}

interface CoverageSnapshot {
  root: string
  files: Map<string, CoverageFile>
  report: LoadedCoverageReport
  reportMtimeMs: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function coverageKey(root: string, path: string): string {
  const absolute = resolve(root, path)
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute
}

function insideRoot(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel))
}

function parseCoverageReport(raw: unknown, root: string): CoverageSnapshot {
  if (!isRecord(raw)) throw new Error('覆盖率报告必须是 Istanbul JSON 对象')
  const files = new Map<string, CoverageFile>()
  let coveredLines = 0
  let totalLines = 0

  for (const [reportPath, rawEntry] of Object.entries(raw)) {
    const entry = isRecord(rawEntry) && isRecord(rawEntry.data) ? rawEntry.data : rawEntry
    if (!isRecord(entry) || !isRecord(entry.statementMap) || !isRecord(entry.s)) {
      throw new Error(`无效的覆盖率文件数据: ${reportPath}`)
    }
    const filePath = typeof entry.path === 'string' ? entry.path : reportPath
    const absolute = resolve(root, filePath)
    if (!insideRoot(root, absolute)) continue
    const lineHits = new Map<number, number>()
    for (const [id, hits] of Object.entries(entry.s)) {
      const statement = entry.statementMap[id]
      const start = isRecord(statement) ? statement.start : undefined
      const line = isRecord(start) ? start.line : undefined
      if (!Number.isInteger(line) || (line as number) < 1
        || typeof hits !== 'number' || !Number.isFinite(hits) || hits < 0) {
        throw new Error(`无效的语句覆盖率数据: ${reportPath}#${id}`)
      }
      lineHits.set(line as number, Math.max(lineHits.get(line as number) ?? 0, hits))
    }

    const uncoveredBranchLines = new Set<number>()
    if (isRecord(entry.branchMap) && isRecord(entry.b)) {
      for (const [id, counts] of Object.entries(entry.b)) {
        const branch = entry.branchMap[id]
        const loc = isRecord(branch) ? branch.loc : undefined
        const start = isRecord(loc) ? loc.start : undefined
        const line = isRecord(branch) && Number.isInteger(branch.line)
          ? branch.line : isRecord(start) ? start.line : undefined
        if (!Number.isInteger(line) || (line as number) < 1 || !Array.isArray(counts)
          || !counts.every(count => typeof count === 'number' && Number.isFinite(count) && count >= 0)) {
          throw new Error(`无效的分支覆盖率数据: ${reportPath}#${id}`)
        }
        if (counts.some(count => count === 0)) uncoveredBranchLines.add(line as number)
      }
    }

    const normalizedPath = normalizePath(relative(root, absolute))
    files.set(coverageKey(root, absolute), { filePath: normalizedPath, lineHits, uncoveredBranchLines })
  }

  for (const file of files.values()) {
    totalLines += file.lineHits.size
    coveredLines += [...file.lineHits.values()].filter(hits => hits > 0).length
  }
  const report: LoadedCoverageReport = {
    files: [...files.values()].map(file => ({
      filePath: file.filePath,
      lines: Object.fromEntries(file.lineHits),
      uncoveredBranchLines: [...file.uncoveredBranchLines].sort((a, b) => a - b),
    })),
    coveredLines,
    totalLines,
    lineCoverage: totalLines ? coveredLines / totalLines : 0,
  }
  return { root, files, report, reportMtimeMs: 0 }
}

interface FileGraph {
  testContent: Map<string, string>
  impacted(change: ChangeItem): string[]
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/')
}

function isReviewableFile(path: string): boolean {
  return CODE_FILE.test(path) && !/(?:^|[\\/])(?:\.env(?:\.|$)|node_modules[\\/])/.test(path)
}

function changeItem(filePath: string, oldContent: string, newContent: string, addedLines: number[]): ChangeItem {
  return { filePath: normalizePath(filePath), oldContent, newContent, addedLines, isTestFile: TEST_FILE.test(filePath) }
}

function safePath(root: string, filePath: string): string {
  const absolute = resolve(root, filePath)
  if (absolute !== root && !absolute.startsWith(root + sep)) {
    throw new Error(`变更文件超出工作区: ${filePath}`)
  }
  return absolute
}

function addedLineNumbers(diff: string): number[] {
  const lines: number[] = []
  let current = 0
  let inHunk = false
  for (const line of diff.split(/\r?\n/)) {
    const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
    if (header) {
      current = Number(header[1])
      inHunk = true
    } else if (inHunk && line.startsWith('+') && !line.startsWith('+++')) {
      lines.push(current++)
    } else if (inHunk && line.startsWith(' ')) {
      current++
    }
  }
  return [...new Set(lines)]
}

function allLineNumbers(content: string): number[] {
  if (!content) return []
  const count = content.split(/\r?\n/).length - (content.endsWith('\n') ? 1 : 0)
  return Array.from({ length: count }, (_, index) => index + 1)
}

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  })
  return stdout
}

async function readTextFile(root: string, filePath: string): Promise<string> {
  const absolute = safePath(root, filePath)
  try {
    if (!(await lstat(absolute)).isFile()) return ''
    return await readFile(absolute, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw error
  }
}

async function listCodeFiles(root: string): Promise<string[]> {
  const files: string[] = []
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) await walk(join(directory, entry.name))
      } else if (entry.isFile() && CODE_FILE.test(entry.name)) {
        files.push(join(directory, entry.name))
      }
    }
  }
  await walk(root)
  return files
}

function fileKey(path: string): string {
  return path.replace(/\.[cm]?[jt]sx?$/i, '')
}

function imports(content: string): string[] {
  const results: string[] = []
  const pattern = /\b(?:from\s*|require\s*\(\s*|import\s*\(\s*|import\s*)['"](\.[^'"]+)['"]/g
  for (const match of content.matchAll(pattern)) results.push(match[1])
  return results
}

async function buildFileGraph(root: string): Promise<FileGraph> {
  const paths = await listCodeFiles(root)
  const actualByKey = new Map<string, string>()
  for (const path of paths) {
    actualByKey.set(fileKey(path), path)
    if (/[/\\]index\.[cm]?[jt]sx?$/i.test(path)) actualByKey.set(dirname(path), path)
  }

  const reverse = new Map<string, Set<string>>()
  const testContent = new Map<string, string>()
  for (const path of paths) {
    const content = await readFile(path, 'utf8')
    if (TEST_FILE.test(path)) testContent.set(normalizePath(relative(root, path)), content)
    for (const specifier of imports(content)) {
      const target = actualByKey.get(fileKey(resolve(dirname(path), specifier)))
      if (!target) continue
      const dependents = reverse.get(target) ?? new Set<string>()
      dependents.add(path)
      reverse.set(target, dependents)
    }
  }

  return {
    testContent,
    impacted(change) {
      const absolute = safePath(root, change.filePath)
      const queue = [actualByKey.get(fileKey(absolute)) ?? absolute]
      const visited = new Set<string>()
      const affected = new Set<string>()
      while (queue.length) {
        const current = queue.shift()!
        if (visited.has(current)) continue
        visited.add(current)
        if (TEST_FILE.test(current)) affected.add(normalizePath(relative(root, current)))
        for (const dependent of reverse.get(current) ?? []) queue.push(dependent)
      }
      const matchingName = fileKey(absolute)
      for (const testPath of testContent.keys()) {
        const testAbsolute = resolve(root, testPath)
        if (fileKey(testAbsolute).replace(/\.(?:test|spec)$/i, '') === matchingName) affected.add(testPath)
      }
      return [...affected].sort()
    },
  }
}

function parseReviewResult(raw: unknown): ReviewResult {
  let value: unknown = raw
  if (typeof value === 'object' && value !== null && 'choices' in value) {
    const choices = (value as { choices?: Array<{ message?: { content?: unknown } }> }).choices
    value = choices?.[0]?.message?.content
  }
  if (typeof value === 'string') {
    const text = value.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
    try {
      value = JSON.parse(text)
    } catch {
      const start = text.indexOf('{')
      const end = text.lastIndexOf('}')
      if (start < 0 || end <= start) throw new Error('代码审查模型未返回有效 JSON')
      try { value = JSON.parse(text.slice(start, end + 1)) }
      catch { throw new Error('代码审查模型未返回有效 JSON') }
    }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('代码审查结果必须是 JSON 对象')
  }
  const record = value as Record<string, unknown>
  if (typeof record.summary !== 'string' || !Array.isArray(record.issues)
    || !Array.isArray(record.affectedTests)
    || !record.affectedTests.every(test => typeof test === 'string')) {
    throw new Error('代码审查结果字段无效')
  }
  const issues = record.issues.map((item: unknown): ReviewIssue => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) throw new Error('代码审查 issue 无效')
    const issue = item as Record<string, unknown>
    if (!Number.isInteger(issue.line) || (issue.line as number) < 1
      || !['critical', 'warning', 'info'].includes(issue.severity as string)
      || !['logic', 'test-missing', 'assertion-weak'].includes(issue.category as string)
      || typeof issue.message !== 'string' || typeof issue.suggestion !== 'string'
      || (issue.filePath !== undefined && typeof issue.filePath !== 'string')) {
      throw new Error('代码审查 issue 字段无效')
    }
    return {
      ...(typeof issue.filePath === 'string' ? { filePath: normalizePath(issue.filePath) } : {}),
      line: issue.line as number,
      severity: issue.severity as ReviewIssue['severity'],
      category: issue.category as ReviewIssue['category'],
      message: issue.message,
      suggestion: issue.suggestion,
    }
  })
  return { summary: record.summary, issues, affectedTests: record.affectedTests as string[] }
}

export class CodeReview implements CodeReviewer {
  private readonly workspaceRoot: string
  private readonly maxPromptTokens: number
  private readonly minLineCoverage: number
  private readonly reviewListeners = new Set<(result: ReviewResult, changes: readonly ChangeItem[]) => void>()
  private coverage: CoverageSnapshot | undefined

  constructor(
    private readonly router: IntelligentRouter,
    private readonly context: TestContextManager,
    private readonly options: CodeReviewOptions = {},
  ) {
    this.workspaceRoot = resolve(options.workspaceRoot ?? process.cwd())
    this.maxPromptTokens = options.maxPromptTokens ?? 24_000
    this.minLineCoverage = options.minLineCoverage ?? 0.8
    if (!Number.isFinite(this.minLineCoverage) || this.minLineCoverage < 0 || this.minLineCoverage > 1) {
      throw new Error('minLineCoverage 必须在 0 到 1 之间')
    }
  }

  onReviewed(listener: (result: ReviewResult, changes: readonly ChangeItem[]) => void): () => void {
    this.reviewListeners.add(listener)
    return () => this.reviewListeners.delete(listener)
  }

  private publish(result: ReviewResult, changes: readonly ChangeItem[]): ReviewResult {
    for (const listener of this.reviewListeners) {
      try { listener(result, changes) } catch (error) { console.error('Review panel update failed:', error) }
    }
    return result
  }

  async loadCoverageReport(path: string): Promise<LoadedCoverageReport> {
    this.coverage = undefined
    const root = await git(['rev-parse', '--show-toplevel'], this.workspaceRoot)
      .then(value => resolve(value.trim()), () => this.workspaceRoot)
    const reportPath = resolve(this.workspaceRoot, path)
    const raw: unknown = JSON.parse(await readFile(reportPath, 'utf8'))
    const snapshot = parseCoverageReport(raw, root)
    snapshot.reportMtimeMs = (await stat(reportPath)).mtimeMs
    this.coverage = snapshot
    this.context.updateCoverageData(snapshot.report)
    return snapshot.report
  }

  private coverageStatus(filePath: string | undefined, line: number): 'covered' | 'uncovered' | 'branch-uncovered' | 'unknown' {
    if (!this.coverage || !filePath) return 'unknown'
    const absolute = resolve(this.coverage.root, filePath)
    if (!insideRoot(this.coverage.root, absolute)) return 'unknown'
    const file = this.coverage.files.get(coverageKey(this.coverage.root, absolute))
    if (!file) return 'unknown'
    if (this.isStaleCoverageFile(absolute)) return 'unknown'
    if (file.uncoveredBranchLines.has(line)) return 'branch-uncovered'
    const hits = file.lineHits.get(line)
    return hits === undefined ? 'unknown' : hits > 0 ? 'covered' : 'uncovered'
  }

  private isStaleCoverageFile(absolute: string): boolean {
    if (!this.coverage) return true
    try { return statSync(absolute).mtimeMs > this.coverage.reportMtimeMs }
    catch { return true }
  }

  async getCurrentCodeChanges(): Promise<ChangeItem[]> {
    try {
      const root = resolve((await git(['rev-parse', '--show-toplevel'], this.workspaceRoot)).trim())
      return await this.getGitChanges(root)
    } catch (error) {
      const provider = this.options.ideChangeProvider?.()
      if (!provider) throw new Error('Git 变更读取失败，且未提供 IDE Diff API', { cause: error })
      console.warn(`Git 变更读取失败，改用 IDE Diff API: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`)
      return (await provider.getRecentFileDiffs()).filter(diff => isReviewableFile(diff.filePath)).map(diff => changeItem(
        relative(this.workspaceRoot, safePath(this.workspaceRoot, diff.filePath)),
        diff.oldContent, diff.newContent, addedLineNumbers(diff.diff),
      ))
    }
  }

  private async getGitChanges(root: string): Promise<ChangeItem[]> {
    let hasHead = true
    try { await git(['rev-parse', '--verify', 'HEAD'], root) } catch { hasHead = false }
    if (!hasHead) {
      const paths = (await git(['ls-files', '-z', '--cached', '--others', '--exclude-standard'], root))
        .split('\0').filter(Boolean)
      const changes: ChangeItem[] = []
      for (const filePath of [...new Set(paths)]) {
        if (!isReviewableFile(filePath)) continue
        const newContent = await readTextFile(root, filePath)
        if (!newContent.includes('\0')) {
          changes.push(changeItem(filePath, '', newContent, allLineNumbers(newContent)))
        }
      }
      return changes
    }

    const names = (await git(['diff', '--name-status', '-z', '--find-renames', 'HEAD'], root))
      .split('\0').filter(Boolean)
    const changes: ChangeItem[] = []
    for (let i = 0; i < names.length;) {
      const status = names[i++]
      const oldPath = names[i++]
      const filePath = /^[RC]/.test(status) ? names[i++] : oldPath
      if (!filePath) throw new Error('Git diff 文件列表格式无效')
      if (!isReviewableFile(filePath)) continue
      const oldContent = status.startsWith('A') ? ''
        : await git(['show', `HEAD:${oldPath}`], root)
      const newContent = status.startsWith('D') ? '' : await readTextFile(root, filePath)
      if (oldContent.includes('\0') || newContent.includes('\0')) continue
      const diff = await git(['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--unified=0', 'HEAD', '--', filePath], root)
      changes.push(changeItem(filePath, oldContent, newContent, addedLineNumbers(diff)))
    }
    const untracked = (await git(['ls-files', '--others', '--exclude-standard', '-z'], root))
      .split('\0').filter(Boolean)
    for (const filePath of untracked) {
      if (!isReviewableFile(filePath)) continue
      const newContent = await readTextFile(root, filePath)
      if (!newContent.includes('\0')) {
        changes.push(changeItem(filePath, '', newContent, allLineNumbers(newContent)))
      }
    }
    return changes
  }

  async review(changes: readonly ChangeItem[]): Promise<ReviewResult> {
    if (changes.some(change => !isReviewableFile(change.filePath))) {
      throw new Error('代码审查只接受 TypeScript/JavaScript 源码与测试文件')
    }
    if (!changes.length) return this.publish({ summary: '共发现 0 个问题，建议重跑 0 个测试', issues: [], affectedTests: [] }, changes)

    // Git diffs use repository-relative paths, including when the plugin starts in a subdirectory.
    const reviewRoot = await git(['rev-parse', '--show-toplevel'], this.workspaceRoot)
      .then(path => resolve(path.trim()), () => this.workspaceRoot)
    const graph = await buildFileGraph(reviewRoot)
    const impactedByFile = new Map(changes.map(change => [change.filePath, graph.impacted(change)]))
    const affectedTests = [...new Set([...impactedByFile.values()].flat())].sort()
    const contextItems = [
      ...changes.map(change => ({
        kind: 'source-code' as const,
        filePath: change.filePath,
        isRecentlyModified: true,
        content: `文件: ${change.filePath}\n新增行: ${change.addedLines.join(', ')}\n\n旧代码:\n${change.oldContent}\n\n新代码:\n${change.newContent}`,
      })),
      ...affectedTests.map(filePath => ({
        kind: 'test-code' as const,
        filePath,
        content: graph.testContent.get(filePath) ?? '',
      })),
    ]
    const compacted = this.context.compressContext(contextItems, this.maxPromptTokens)
    const coverageEvidence = changes.map(change => {
      const lines = change.addedLines.map(line => `${line}:${this.coverageStatus(change.filePath, line)}`)
      return `${change.filePath} => ${lines.join(', ') || '无新增行'}`
    }).join('\n')
    const requestParams = {
      messages: [
        { role: 'system', content: REVIEW_INSTRUCTIONS },
        { role: 'user', content: `已有测试影响列表: ${JSON.stringify(affectedTests)}\n覆盖率证据（unknown 表示报告无该行，不能当作未覆盖）:\n${coverageEvidence}\n\n${compacted.map(item => item.content).join('\n\n---\n\n')}` },
      ],
      response_format: { type: 'json_object' },
      temperature: 0,
    }
    const modelResult = parseReviewResult(await this.router.routeAndExecute('review', requestParams))
    const changedPaths = changes.map(change => change.filePath)
    const matchChangedPath = (candidate: string | undefined): string | undefined => {
      if (!candidate) return changedPaths.length === 1 ? changedPaths[0] : undefined
      const absolute = resolve(reviewRoot, candidate)
      if (!insideRoot(reviewRoot, absolute)) return undefined
      const normalized = normalizePath(relative(reviewRoot, absolute))
      return changedPaths.includes(normalized) ? normalized : undefined
    }
    const issues = modelResult.issues.map(issue => {
      const filePath = matchChangedPath(issue.filePath)
      const normalized: ReviewIssue = { ...issue }
      delete normalized.filePath
      if (filePath) normalized.filePath = filePath
      return normalized
    })
      .filter(issue => issue.category !== 'test-missing' || !this.coverage
        || this.coverageStatus(issue.filePath, issue.line) !== 'covered')

    for (const change of changes) {
      if (!CODE_FILE.test(change.filePath) || change.isTestFile
        || CONFIG_FILE.test(change.filePath) || !change.addedLines.length || !this.coverage) continue
      const hasFile = this.coverage.files.has(coverageKey(this.coverage.root, change.filePath))
      const riskLines = hasFile
        ? change.addedLines.filter(line => ['uncovered', 'branch-uncovered'].includes(this.coverageStatus(change.filePath, line)))
        : [change.addedLines[0]]
      for (const line of riskLines) {
        if (issues.some(issue => issue.category === 'test-missing'
          && issue.filePath === change.filePath && issue.line === line)) continue
        const status = this.coverageStatus(change.filePath, line)
        issues.push({
          filePath: change.filePath,
          line,
          severity: 'warning',
          category: 'test-missing',
          message: status === 'branch-uncovered'
            ? `MISSING_COVERAGE: ${change.filePath}:${line} 存在未执行的分支`
            : status === 'uncovered'
              ? `MISSING_COVERAGE: ${change.filePath}:${line} 在覆盖率报告中执行次数为 0`
              : `MISSING_COVERAGE: 覆盖率报告未包含 ${change.filePath}，无法确认新增代码已覆盖`,
          suggestion: `为 ${change.filePath}:${line} 补充 Vitest 用例并重新生成覆盖率报告。`,
        })
      }
    }

    for (const change of changes) {
      if (!change.isTestFile || !change.addedLines.length || !/\b(?:it|test)\s*\(/.test(change.newContent)
        || /\b(?:expect|assert)\s*\(|\bassert\./.test(change.newContent)) continue
      const sourceLines = change.newContent.split(/\r?\n/)
      const line = change.addedLines.find(number => /\b(?:it|test)\s*\(/.test(sourceLines[number - 1] ?? ''))
        ?? change.addedLines[0]
      issues.push({
        filePath: change.filePath,
        line,
        severity: 'warning',
        category: 'assertion-weak',
        message: `WEAK_ASSERTION: ${change.filePath} 的新增测试未发现 expect/assert 断言`,
        suggestion: '为新增用例添加针对返回值、状态或异常的明确断言。',
      })
    }

    if (affectedTests.length && !affectedTests.some(path => /\b(?:expect|assert)\s*\(|\bassert\./.test(graph.testContent.get(path) ?? ''))) {
      for (const issue of modelResult.issues) {
        if (issue.category !== 'logic' || issue.severity === 'info') continue
        const filePath = matchChangedPath(issue.filePath)
        issues.push({
          ...(filePath ? { filePath } : {}),
          line: issue.line,
          severity: 'warning',
          category: 'assertion-weak',
          message: `WEAK_ASSERTION: 现有测试无法通过断言捕获第 ${issue.line} 行的问题`,
          suggestion: '为受影响测试增加针对实际返回值或异常的 expect/assert 断言。',
        })
      }
    }

    const confirmedTests = modelResult.affectedTests.filter(path => graph.testContent.has(normalizePath(path)))
    const rerun = [...new Set([...affectedTests, ...confirmedTests])].sort()
    return this.publish({
      summary: `共发现 ${issues.length} 个问题，建议重跑 ${rerun.length} 个测试`,
      issues,
      affectedTests: rerun,
    }, changes)
  }

  gateCheck(result: ReviewResult): GateCheckResult {
    const lineCoverage = this.coverage?.report.lineCoverage ?? null
    const critical = result.issues.filter(issue => issue.severity === 'critical')
    if (lineCoverage === null || this.coverage?.report.totalLines === 0) {
      return {
        status: 'blocked', allowed: false, message: '未加载有效的行覆盖率报告，无法放行提交',
        lineCoverage, minLineCoverage: this.minLineCoverage, blockingIssues: critical,
      }
    }

    const staleFiles = [...this.coverage!.files.keys()].filter(path => this.isStaleCoverageFile(path))
    if (staleFiles.length) {
      return {
        status: 'blocked', allowed: false, message: `覆盖率报告早于 ${staleFiles.length} 个源码文件的修改，请重新运行测试并生成报告`,
        lineCoverage, minLineCoverage: this.minLineCoverage, blockingIssues: critical,
      }
    }

    const unverifiedCritical = critical.filter(issue => this.coverageStatus(issue.filePath, issue.line) !== 'covered')
    if (unverifiedCritical.length) {
      return {
        status: 'blocked', allowed: false, message: `存在 ${unverifiedCritical.length} 个严重问题位于未覆盖或无法确认覆盖的代码行`,
        lineCoverage, minLineCoverage: this.minLineCoverage, blockingIssues: unverifiedCritical,
      }
    }
    if (lineCoverage < this.minLineCoverage) {
      return {
        status: 'blocked', allowed: false,
        message: `行覆盖率 ${(lineCoverage * 100).toFixed(1)}% 低于门槛 ${(this.minLineCoverage * 100).toFixed(1)}%`,
        lineCoverage, minLineCoverage: this.minLineCoverage, blockingIssues: [],
      }
    }
    if (critical.length || result.issues.some(issue => issue.severity === 'warning')) {
      return {
        status: 'warning', allowed: true, message: critical.length
          ? '严重问题所在行已有覆盖，但仍需人工确认问题'
          : '存在警告级别问题，请确认后提交',
        lineCoverage, minLineCoverage: this.minLineCoverage, blockingIssues: [],
      }
    }
    return {
      status: 'passed', allowed: true, message: '覆盖率达标，未发现严重或警告级别问题',
      lineCoverage, minLineCoverage: this.minLineCoverage, blockingIssues: [],
    }
  }
}
