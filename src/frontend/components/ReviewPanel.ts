import type { ContextMessage, TestContextManager } from '../../context/index.js'
import type { ChangeItem, CodeReviewer, ReviewIssue, ReviewResult } from '../../review/index.js'
import type { IntelligentRouter } from '../../router/index.js'

export interface ReviewPanelServices {
  codeReview: CodeReviewer
  smartRoute: IntelligentRouter
  testAwareContext: TestContextManager
}

/** The host IDE supplies editor navigation, gutter decorations, and test-file I/O. */
export interface ReviewPanelIde {
  openFileAtLine(filePath: string, line: number): Promise<void> | void
  highlightLine(filePath: string, line: number): void
  markGutter(filePath: string, line: number, marker: 'droplet'): () => void
  readTestFile(sourcePath: string): Promise<{ filePath: string; content: string } | null>
  writeTestFile(filePath: string, content: string): Promise<void>
}

const styles = `
.dsh-review-panel{font:14px/1.5 system-ui,sans-serif;color:#18212f;background:#fff;border:1px solid #d7dce5;border-radius:10px;padding:16px;max-width:760px}
.dsh-review-panel header{display:flex;align-items:center;justify-content:space-between;gap:16px}
.dsh-review-panel h2,.dsh-review-panel h3{margin:0 0 8px}
.dsh-review-panel .badge{border-radius:99px;padding:3px 10px;font-weight:700}
.dsh-review-panel .badge.blocked,.dsh-review-panel article.critical{background:#fff1f2;color:#a5162b;border-color:#ef9aa6}
.dsh-review-panel .badge.warning,.dsh-review-panel article.warning{background:#fff7e9;color:#8a4b00;border-color:#efc17a}
.dsh-review-panel .badge.passed,.dsh-review-panel article.info{background:#edf8f1;color:#176238;border-color:#a9d9b9}
.dsh-review-panel article{border:1px solid;border-radius:8px;padding:12px;margin:10px 0}
.dsh-review-panel article p{margin:5px 0}.dsh-review-panel button{cursor:pointer;margin:4px 8px 4px 0}
.dsh-review-panel .line-link{font:inherit;text-decoration:underline}.dsh-review-panel pre{white-space:pre-wrap;overflow:auto;background:#f4f6f8;padding:10px}
.dsh-review-panel textarea{width:100%;min-height:130px;box-sizing:border-box;font:12px/1.4 monospace}
`

function modelText(raw: unknown): string {
  let value: unknown = raw
  if (typeof value === 'object' && value !== null && 'choices' in value) {
    value = (value as { choices?: Array<{ message?: { content?: unknown } }> }).choices?.[0]?.message?.content
  }
  if (typeof value !== 'string') throw new Error('测试生成模型没有返回文本')
  const code = value.trim().replace(/^```(?:typescript|ts|javascript|js)?\s*/i, '').replace(/\s*```$/, '').trim()
  if (!/\b(?:test|it|describe)\s*\(/.test(code)) throw new Error('模型没有返回可识别的测试代码')
  return code + '\n'
}

function replacementDiff(filePath: string, before: string, after: string): string {
  const lines = (text: string): string[] => {
    const normalized = text.replace(/\r\n/g, '\n').replace(/\n$/, '')
    return normalized ? normalized.split('\n') : []
  }
  const oldLines = lines(before)
  const newLines = lines(after)
  return [`--- ${filePath}`, `+++ ${filePath}`,
    `@@ -${oldLines.length ? 1 : 0},${oldLines.length} +${newLines.length ? 1 : 0},${newLines.length} @@`,
    ...oldLines.map(line => '-' + line), ...newLines.map(line => '+' + line)].join('\n')
}

/** Mount once; reviews from any caller of codeReview.review() appear automatically. */
export class ReviewPanel {
  private readonly root: HTMLElement
  private readonly diffArea: HTMLElement
  private readonly disposeReviewListener: () => void
  private readonly markerDisposers: Array<() => void> = []
  private changes: readonly ChangeItem[] = []
  private generationId = 0
  private disposed = false

  constructor(
    private readonly services: ReviewPanelServices,
    private readonly container: HTMLElement,
    private readonly ide: ReviewPanelIde,
  ) {
    const doc = container.ownerDocument
    this.root = doc.createElement('section')
    this.root.className = 'dsh-review-panel'
    this.root.setAttribute('role', 'region')
    this.root.setAttribute('aria-live', 'polite')
    this.root.setAttribute('aria-label', '测试感知代码审查')
    this.root.hidden = true
    this.diffArea = doc.createElement('div')
    this.diffArea.setAttribute('data-testid', 'test-diff')
    this.diffArea.hidden = true
    container.append(this.root)
    this.disposeReviewListener = services.codeReview.onReviewed((result, changes) => this.show(result, changes))
  }

  private element<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] {
    const element = this.container.ownerDocument.createElement(tag)
    if (text !== undefined) element.textContent = text
    return element
  }

  private sourcePath(issue: ReviewIssue): string | undefined {
    return issue.filePath ?? (this.changes.length === 1 ? this.changes[0].filePath : undefined)
  }

  private sourceSnippet(filePath: string, line: number): string {
    const change = this.changes.find(item => item.filePath === filePath)
    if (!change) throw new Error(`找不到 ${filePath} 的代码变更`)
    const lines = change.newContent.split(/\r?\n/)
    if (line < 1 || line > lines.length) throw new Error(`问题行号超出 ${filePath} 的范围`)
    const start = Math.max(0, line - 6)
    return lines.slice(start, line + 5).map((text, index) => `${start + index + 1}: ${text}`).join('\n')
  }

  private show(result: ReviewResult, changes: readonly ChangeItem[]): void {
    if (this.disposed) return
    this.generationId++
    for (const dispose of this.markerDisposers.splice(0)) dispose()
    this.changes = changes
    const gate = this.services.codeReview.gateCheck(result)
    const style = this.element('style', styles)
    const header = this.element('header')
    const title = this.element('h2', result.summary)
    const badge = this.element('span', gate.status === 'blocked' ? '拦截' : gate.status === 'warning' ? '警告' : '通过')
    badge.className = `badge ${gate.status}`
    header.append(title, badge)

    const list = this.element('div')
    list.setAttribute('data-testid', 'issue-list')
    for (const [index, issue] of result.issues.entries()) {
      const card = this.element('article')
      card.className = issue.severity
      card.setAttribute('data-testid', `issue-${index}`)
      const filePath = this.sourcePath(issue)
      const lineButton = this.element('button', `💧 ${filePath ?? '未知文件'}:${issue.line}`)
      lineButton.className = 'line-link'
      lineButton.setAttribute('type', 'button')
      lineButton.setAttribute('aria-label', `跳转到 ${filePath ?? '未知文件'} 第 ${issue.line} 行`)
      lineButton.addEventListener('click', () => {
        if (filePath) void this.jumpToCode(filePath, issue.line).catch(error => this.showError(error))
      })
      card.append(lineButton, this.element('p', issue.message), this.element('p', `建议：${issue.suggestion}`))
      if (filePath) this.markerDisposers.push(this.ide.markGutter(filePath, issue.line, 'droplet'))

      if (issue.category === 'test-missing' || issue.category === 'assertion-weak') {
        const generate = this.element('button', '✨ 自动生成测试代码')
        generate.setAttribute('type', 'button')
        generate.setAttribute('data-testid', `generate-${index}`)
        generate.addEventListener('click', () => { void this.generate(issue, generate) })
        card.append(generate)
      }
      list.append(card)
    }
    this.diffArea.replaceChildren()
    this.diffArea.hidden = true
    this.root.replaceChildren(style, header, list, this.diffArea)
    this.root.hidden = false
  }

  async jumpToCode(filePath: string, line: number): Promise<void> {
    await this.ide.openFileAtLine(filePath, line)
    this.ide.highlightLine(filePath, line)
  }

  private showError(error: unknown): void {
    this.diffArea.replaceChildren(this.element('p', error instanceof Error ? error.message : String(error)))
    this.diffArea.setAttribute('role', 'alert')
    this.diffArea.hidden = false
  }

  private async generate(issue: ReviewIssue, button: HTMLButtonElement): Promise<void> {
    const generation = ++this.generationId
    button.disabled = true
    try {
      const sourcePath = this.sourcePath(issue)
      if (!sourcePath) throw new Error('无法确定问题所在文件')
      const snippet = this.sourceSnippet(sourcePath, issue.line)
      const existing = await this.ide.readTestFile(sourcePath)
      const targetPath = existing?.filePath ?? sourcePath.replace(/\.[cm]?[jt]sx?$/i, '.test.ts')
      const context: ContextMessage[] = [
        { kind: 'source-code', filePath: sourcePath, isRecentlyModified: true, isSelectedFile: true, content: snippet },
        { kind: 'test-code', filePath: targetPath, content: existing?.content ?? '' },
      ]
      const compacted = this.services.testAwareContext.compressContext(context, 8_000)
      const response = await this.services.smartRoute.routeAndExecute('test-gen', {
        messages: [
          { role: 'system', content: '生成完整、可直接运行的 TypeScript Vitest 测试文件。针对给定问题补充有效断言。只输出代码，不要 Markdown。' },
          { role: 'user', content: `问题：${issue.message}\n修复建议：${issue.suggestion}\n目标测试文件：${targetPath}\n\n${compacted.map(item => item.content).join('\n\n现有测试：\n')}` },
        ],
        temperature: 0.2,
      })
      const generated = modelText(response)
      if (generation !== this.generationId || this.disposed) return
      this.showDiff(targetPath, existing?.content ?? '', generated)
    } catch (error) {
      if (generation === this.generationId && !this.disposed) this.showError(error)
    } finally {
      button.disabled = false
    }
  }

  private showDiff(filePath: string, before: string, generated: string): void {
    const title = this.element('h3', `测试代码差异：${filePath}`)
    const diff = this.element('pre', replacementDiff(filePath, before, generated))
    const editor = this.element('textarea')
    editor.value = generated
    editor.readOnly = true
    editor.setAttribute('aria-label', '生成的测试代码')
    editor.addEventListener('input', () => { diff.textContent = replacementDiff(filePath, before, editor.value) })
    const edit = this.element('button', '手动编辑')
    edit.setAttribute('type', 'button')
    edit.addEventListener('click', () => { editor.readOnly = false; editor.focus() })
    const confirm = this.element('button', '确认替换')
    confirm.setAttribute('type', 'button')
    confirm.addEventListener('click', () => {
      confirm.disabled = true
      void this.ide.writeTestFile(filePath, editor.value)
        .then(() => { title.textContent = `已写入测试文件：${filePath}` })
        .catch(error => this.showError(error))
        .finally(() => { confirm.disabled = false })
    })
    this.diffArea.replaceChildren(title, diff, editor, edit, confirm)
    this.diffArea.hidden = false
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.generationId++
    this.disposeReviewListener()
    for (const dispose of this.markerDisposers.splice(0)) dispose()
    this.root.remove()
  }
}
