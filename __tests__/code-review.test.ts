import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CodeReview } from '../src/services/code-review.js'
import { TestAwareContext } from '../src/services/test-aware-context.js'
import { applyGateToControls, toGateViewModel } from '../src/frontend/gate-status.js'
import type { IntelligentRouter } from '../src/router/index.js'

const workspaces: string[] = []

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-code-review-'))
  workspaces.push(root)
  return root
}

function git(root: string, ...args: string[]): void {
  execFileSync('git', args, { cwd: root, windowsHide: true })
}

afterEach(async () => {
  for (const root of workspaces.splice(0)) {
    const tempRoot = resolve(tmpdir())
    if (!resolve(root).startsWith(tempRoot + sep) || !relative(tempRoot, root).startsWith('dsh-code-review-')) {
      throw new Error(`Refusing to remove unexpected test directory: ${root}`)
    }
    await rm(root, { recursive: true, force: true })
  }
})

describe('CodeReview', () => {
  it('marks changed test files and reports newly added tests without assertions', async () => {
    const root = await workspace()
    await mkdir(join(root, '__tests__'))
    const newContent = "test('smoke', () => { runPayment() })\n"
    await writeFile(join(root, '__tests__', 'payment.test.ts'), newContent)
    const routeAndExecute = vi.fn(async () => 'Result: {"summary":"checked","issues":[],"affectedTests":[]}')
    const reviewer = new CodeReview({ routeAndExecute } as unknown as IntelligentRouter, new TestAwareContext(), {
      workspaceRoot: root,
      ideChangeProvider: () => ({ getRecentFileDiffs: async () => [{
        filePath: '__tests__/payment.test.ts', oldContent: '', newContent,
        diff: "@@ -0,0 +1 @@\n+test('smoke', () => { runPayment() })\n",
      }] }),
    })
    const changes = await reviewer.getCurrentCodeChanges()
    expect(changes[0]).toMatchObject({ isTestFile: true, addedLines: [1] })
    const result = await reviewer.review(changes)
    expect(result.issues).toEqual([expect.objectContaining({
      category: 'assertion-weak', filePath: '__tests__/payment.test.ts', line: 1,
      message: expect.stringContaining('WEAK_ASSERTION'),
    })])
  })

  it('fails closed when the review model returns unrecoverable JSON', async () => {
    const root = await workspace()
    await mkdir(join(root, 'src'))
    await writeFile(join(root, 'src', 'broken.ts'), 'export const broken = true\n')
    const reviewer = new CodeReview({ routeAndExecute: vi.fn(async () => 'not a JSON result') } as unknown as IntelligentRouter,
      new TestAwareContext(), { workspaceRoot: root })
    await expect(reviewer.review([{ filePath: 'src/broken.ts', oldContent: '',
      newContent: 'export const broken = true\n', addedLines: [1], isTestFile: false }]))
      .rejects.toThrow('代码审查模型未返回有效 JSON')
  })

  it('falls back to IDE diff when Git exists but reading the index fails', async () => {
    const root = await workspace()
    git(root, 'init', '-q')
    await writeFile(join(root, '.git', 'index'), 'corrupt index')
    await mkdir(join(root, 'src'))
    await writeFile(join(root, 'src', 'fallback.ts'), 'export const value = 1\n')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const reviewer = new CodeReview({ routeAndExecute: vi.fn() } as unknown as IntelligentRouter,
        new TestAwareContext(), { workspaceRoot: root, ideChangeProvider: () => ({ getRecentFileDiffs: async () => [{
          filePath: 'src/fallback.ts', oldContent: '', newContent: 'export const value = 1\n',
          diff: '@@ -0,0 +1 @@\n+export const value = 1\n',
        }] }) })
      expect(await reviewer.getCurrentCodeChanges()).toEqual([expect.objectContaining({
        filePath: 'src/fallback.ts', isTestFile: false, addedLines: [1],
      })])
      expect(warn).toHaveBeenCalledOnce()
    } finally {
      warn.mockRestore()
    }
  })

  it('uses IDE diffs without Git and flags changed logic with no related tests', async () => {
    const root = await workspace()
    await mkdir(join(root, 'src'))
    const oldContent = 'export function canPay(amount: number) { return amount > 0 }\n'
    const newContent = 'export function canPay(amount: number) {\n  if (amount = 0) return true\n  return amount > 0\n}\n'
    await writeFile(join(root, 'src', 'payment.ts'), newContent)
    const routeAndExecute = vi.fn(async (_taskType: string, _params: unknown) => JSON.stringify({
      summary: '发现逻辑错误',
      issues: [{
        line: 2,
        severity: 'critical',
        category: 'logic',
        message: '条件使用了赋值操作',
        suggestion: '改为 === 并补充边界测试',
      }],
      affectedTests: [],
    }))
    const reviewer = new CodeReview({ routeAndExecute } as unknown as IntelligentRouter, new TestAwareContext(), {
      workspaceRoot: root,
      ideChangeProvider: () => ({
        getRecentFileDiffs: async () => [{
          filePath: 'src/payment.ts', oldContent, newContent,
          diff: '@@ -1 +1,4 @@\n-export function canPay(amount: number) { return amount > 0 }\n+export function canPay(amount: number) {\n+  if (amount = 0) return true\n+  return amount > 0\n+}\n',
        }],
      }),
    })
    const reviewed = vi.fn()
    const unsubscribe = reviewer.onReviewed(reviewed)

    const changes = await reviewer.getCurrentCodeChanges()
    expect(changes).toEqual([{ filePath: 'src/payment.ts', oldContent, newContent, addedLines: [1, 2, 3, 4], isTestFile: false }])
    await mkdir(join(root, 'coverage'))
    await writeFile(join(root, 'coverage', 'coverage-final.json'), JSON.stringify({
      [join(root, 'src', 'payment.ts')]: {
        path: join(root, 'src', 'payment.ts'),
        statementMap: { 0: { start: { line: 1 } }, 1: { start: { line: 2 } }, 2: { start: { line: 3 } } },
        s: { 0: 1, 1: 0, 2: 1 }, branchMap: {}, b: {}, fnMap: {}, f: {},
      },
    }))
    await reviewer.loadCoverageReport('coverage/coverage-final.json')
    const result = await reviewer.review(changes)
    expect(reviewed).toHaveBeenCalledWith(result, changes)
    unsubscribe()

    expect(routeAndExecute).toHaveBeenCalledOnce()
    expect(routeAndExecute.mock.calls[0][0]).toBe('review')
    const prompt = (routeAndExecute.mock.calls[0][1] as { messages: Array<{ content: string }> }).messages
    expect(prompt[0].content).toContain('MISSING_COVERAGE')
    expect(prompt[0].content).toContain('WEAK_ASSERTION')
    expect(prompt[1].content).toContain('if (amount = 0)')
    expect(prompt[1].content).toContain('2:uncovered')
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: 'logic', severity: 'critical', line: 2 }),
      expect.objectContaining({ category: 'test-missing', line: 2, message: expect.stringContaining('MISSING_COVERAGE') }),
    ]))
    expect(result.issues.some(issue => issue.category === 'test-missing' && issue.line === 1)).toBe(false)
    expect(result.affectedTests).toEqual([])
    expect(Object.keys(result).sort()).toEqual(['affectedTests', 'issues', 'summary'])
  })

  it('reads Git working-tree changes and identifies tests importing the changed source', async () => {
    const root = await workspace()
    git(root, 'init', '-q')
    git(root, 'config', 'user.name', 'Test')
    git(root, 'config', 'user.email', 'test@example.invalid')
    await mkdir(join(root, 'src'))
    await mkdir(join(root, '__tests__'))
    const source = join(root, 'src', 'calc.ts')
    await writeFile(source, 'export const add = (a: number, b: number) => a + b\n')
    await writeFile(join(root, '__tests__', 'calc.test.ts'),
      "import { add } from '../src/calc.js'\ntest('add', () => { expect(add(1, 2)).toBe(3) })\n")
    git(root, 'add', '.')
    git(root, 'commit', '-qm', 'baseline')
    await writeFile(source, 'export const add = (a: number, b: number) => {\n  if (a === 0) return b\n  return a + b\n}\n')
    const routeAndExecute = vi.fn(async () => ({ summary: '无问题', issues: [], affectedTests: [] }))
    const reviewer = new CodeReview({ routeAndExecute } as unknown as IntelligentRouter, new TestAwareContext(), {
      workspaceRoot: join(root, 'src'),
    })

    const changes = await reviewer.getCurrentCodeChanges()
    expect(changes).toEqual([expect.objectContaining({
      filePath: 'src/calc.ts',
      addedLines: [1, 2, 3, 4],
    })])
    git(root, 'add', 'src/calc.ts')
    expect(await reviewer.getCurrentCodeChanges()).toEqual(changes)
    const result = await reviewer.review(changes)
    expect(result.affectedTests).toEqual(['__tests__/calc.test.ts'])
    expect(result.issues.some(issue => issue.category === 'test-missing')).toBe(false)
    const prompt = (routeAndExecute.mock.calls[0][1] as { messages: Array<{ content: string }> }).messages
    expect(prompt[1].content).toContain("expect(add(1, 2)).toBe(3)")
  })

  it('does not send tracked secrets or non-code files to the review model', async () => {
    const root = await workspace()
    git(root, 'init', '-q')
    await mkdir(join(root, 'src'))
    await writeFile(join(root, '.env'), 'API_KEY=private-value\n')
    await writeFile(join(root, 'notes.txt'), 'private notes\n')
    await writeFile(join(root, 'src', 'safe.ts'), 'export const safe = true\n')
    const reviewer = new CodeReview({ routeAndExecute: vi.fn() } as unknown as IntelligentRouter,
      new TestAwareContext(), { workspaceRoot: root })
    expect((await reviewer.getCurrentCodeChanges()).map(change => change.filePath)).toEqual(['src/safe.ts'])
    await expect(reviewer.review([{ filePath: '.env', oldContent: '', newContent: 'API_KEY=private-value',
      addedLines: [1], isTestFile: false }])).rejects.toThrow('只接受 TypeScript/JavaScript')
  })

  it('blocks when the coverage report predates a source change', async () => {
    const root = await workspace()
    await mkdir(join(root, 'src'))
    await mkdir(join(root, 'coverage'))
    const sourcePath = join(root, 'src', 'stale.ts')
    const reportPath = join(root, 'coverage', 'coverage-final.json')
    await writeFile(sourcePath, 'export const stale = true\n')
    await writeFile(reportPath, JSON.stringify({ [sourcePath]: {
      path: sourcePath, statementMap: { 0: { start: { line: 1 } } }, s: { 0: 1 },
    } }))
    const reviewer = new CodeReview({ routeAndExecute: vi.fn() } as unknown as IntelligentRouter,
      new TestAwareContext(), { workspaceRoot: root })
    await reviewer.loadCoverageReport(reportPath)
    const later = new Date(Date.now() + 60_000)
    await utimes(sourcePath, later, later)
    expect(reviewer.gateCheck({ summary: '', issues: [], affectedTests: [] })).toMatchObject({
      status: 'blocked', allowed: false, message: expect.stringContaining('请重新运行测试'),
    })
  })

  it('blocks a critical bug on an uncovered line even when a test imports the source', async () => {
    const root = await workspace()
    await mkdir(join(root, 'src'))
    await mkdir(join(root, '__tests__'))
    await mkdir(join(root, 'coverage'))
    const sourcePath = join(root, 'src', 'price.ts')
    const source = 'export function price(value: number) {\n  if (value < 0) return value * -1\n  return value\n}\n'
    await writeFile(sourcePath, source)
    await writeFile(join(root, '__tests__', 'price.test.ts'),
      "import { price } from '../src/price.js'\ntest('positive', () => expect(price(2)).toBe(2))\n")
    await writeFile(join(root, 'coverage', 'coverage-final.json'), JSON.stringify({
      [sourcePath]: {
        path: sourcePath,
        statementMap: {
          0: { start: { line: 1, column: 0 }, end: { line: 1, column: 40 } },
          1: { start: { line: 2, column: 2 }, end: { line: 2, column: 34 } },
          2: { start: { line: 3, column: 2 }, end: { line: 3, column: 14 } },
          3: { start: { line: 4, column: 0 }, end: { line: 4, column: 1 } },
        },
        s: { 0: 1, 1: 0, 2: 1, 3: 1 },
        fnMap: {}, f: {}, branchMap: {}, b: {},
      },
    }))
    const routeAndExecute = vi.fn(async () => ({
      summary: '负数逻辑错误',
      issues: [{ filePath: 'src/price.ts', line: 2, severity: 'critical', category: 'logic',
        message: '负数价格被转成正数', suggestion: '拒绝负数并补充断言' }],
      affectedTests: ['__tests__/price.test.ts'],
    }))
    const reviewer = new CodeReview({ routeAndExecute } as unknown as IntelligentRouter, new TestAwareContext(), {
      workspaceRoot: root, minLineCoverage: 0.7,
    })
    const coverage = await reviewer.loadCoverageReport('coverage/coverage-final.json')
    expect(coverage).toMatchObject({ coveredLines: 3, totalLines: 4, lineCoverage: 0.75 })
    expect(coverage.files[0].lines[2]).toBe(0)
    const result = await reviewer.review([{ filePath: 'src/price.ts', oldContent: '', newContent: source, addedLines: [2], isTestFile: false }])
    expect(result.affectedTests).toEqual(['__tests__/price.test.ts'])
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: 'test-missing', filePath: 'src/price.ts', line: 2 }),
    ]))

    const gate = reviewer.gateCheck(result)
    expect(gate).toMatchObject({ status: 'blocked', allowed: false, lineCoverage: 0.75 })
    expect(gate.blockingIssues).toEqual([expect.objectContaining({ severity: 'critical', line: 2 })])
    expect(toGateViewModel(gate)).toMatchObject({
      status: 'blocked', submitDisabled: true, blockingLocations: ['src/price.ts:2'],
    })
    const controls = { submitButton: { disabled: false }, statusText: { textContent: null as string | null } }
    applyGateToControls(gate, controls)
    expect(controls.submitButton.disabled).toBe(true)
    expect(controls.statusText.textContent).toContain('src/price.ts:2')
    expect(reviewer.gateCheck({ summary: '', affectedTests: [], issues: [
      { filePath: 'src/price.ts', line: 2, severity: 'warning', category: 'logic', message: '', suggestion: '' },
    ] }).status).toBe('warning')
    const passed = reviewer.gateCheck({ summary: '', affectedTests: [], issues: [] })
    expect(passed.status).toBe('passed')
    applyGateToControls(passed, controls)
    expect(controls.submitButton.disabled).toBe(false)
    const strictReviewer = new CodeReview({ routeAndExecute } as unknown as IntelligentRouter, new TestAwareContext(), {
      workspaceRoot: root, minLineCoverage: 0.8,
    })
    await strictReviewer.loadCoverageReport('coverage/coverage-final.json')
    expect(strictReviewer.gateCheck({ summary: '', affectedTests: [], issues: [] })).toMatchObject({
      status: 'blocked', allowed: false,
    })
  })

  it('treats an unexecuted branch as high risk even when its line ran', async () => {
    const root = await workspace()
    await mkdir(join(root, 'src'))
    await mkdir(join(root, 'coverage'))
    const sourcePath = join(root, 'src', 'branch.ts')
    await writeFile(sourcePath, 'export const check = (flag: boolean) => {\n  if (flag) return 1\n  return 0\n}\n')
    await writeFile(join(root, 'coverage', 'coverage-final.json'), JSON.stringify({
      [sourcePath]: {
        path: sourcePath,
        statementMap: { 0: { start: { line: 1 } }, 1: { start: { line: 2 } }, 2: { start: { line: 3 } } },
        s: { 0: 1, 1: 1, 2: 1 }, fnMap: {}, f: {},
        branchMap: { 0: { line: 2, loc: { start: { line: 2 } } } },
        b: { 0: [1, 0] },
      },
    }))
    const routeAndExecute = vi.fn(async () => ({ summary: '', issues: [
      { filePath: 'src/branch.ts', line: 2, severity: 'critical', category: 'logic', message: '遗漏 false 分支', suggestion: '补测 false' },
    ], affectedTests: [] }))
    const reviewer = new CodeReview({ routeAndExecute } as unknown as IntelligentRouter, new TestAwareContext(), {
      workspaceRoot: root,
    })
    const coverage = await reviewer.loadCoverageReport('coverage/coverage-final.json')
    expect(coverage.lineCoverage).toBe(1)
    expect(coverage.files[0].uncoveredBranchLines).toEqual([2])
    const result = await reviewer.review([{ filePath: 'src/branch.ts', oldContent: '', newContent: '', addedLines: [2], isTestFile: false }])
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: 'test-missing', line: 2, message: expect.stringContaining('未执行的分支') }),
    ]))
    expect(reviewer.gateCheck(result).status).toBe('blocked')
  })
})
