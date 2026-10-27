import { describe, expect, it, vi } from 'vitest'
import { ReviewPanel } from '../src/frontend/components/ReviewPanel.js'
import { TestAwareContext } from '../src/services/test-aware-context.js'
import type { ChangeItem, CodeReviewer, ReviewResult } from '../src/review/index.js'
import type { IntelligentRouter } from '../src/router/index.js'

class FakeElement {
  children: FakeElement[] = []
  parent: FakeElement | undefined
  className = ''
  hidden = false
  disabled = false
  readOnly = false
  value = ''
  private ownText = ''
  private readonly attributes = new Map<string, string>()
  private readonly listeners = new Map<string, Array<() => void>>()

  constructor(readonly ownerDocument: FakeDocument, readonly tag: string) {}

  get textContent(): string { return this.ownText + this.children.map(child => child.textContent).join('') }
  set textContent(value: string | null) { this.ownText = value ?? ''; this.children = [] }
  append(...children: FakeElement[]): void {
    for (const child of children) { child.parent = this; this.children.push(child) }
  }
  replaceChildren(...children: FakeElement[]): void {
    this.ownText = ''
    this.children = []
    this.append(...children)
  }
  remove(): void {
    if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this)
  }
  setAttribute(name: string, value: string): void { this.attributes.set(name, value) }
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null }
  addEventListener(name: string, listener: () => void): void {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener])
  }
  click(): void { for (const listener of this.listeners.get('click') ?? []) listener() }
  input(): void { for (const listener of this.listeners.get('input') ?? []) listener() }
  focus(): void {}
  find(predicate: (element: FakeElement) => boolean): FakeElement | undefined {
    if (predicate(this)) return this
    for (const child of this.children) {
      const found = child.find(predicate)
      if (found) return found
    }
    return undefined
  }
  findAll(predicate: (element: FakeElement) => boolean): FakeElement[] {
    return [...(predicate(this) ? [this] : []), ...this.children.flatMap(child => child.findAll(predicate))]
  }
}

class FakeDocument {
  createElement(tag: string): FakeElement { return new FakeElement(this, tag) }
}

describe('ReviewPanel', () => {
  it('shows three issues after review, navigates to code, and generates editable test diff via smartRoute', async () => {
    const doc = new FakeDocument()
    const container = doc.createElement('div')
    const result: ReviewResult = {
      summary: '共发现 3 个问题，建议重跑 1 个测试',
      issues: [
        { filePath: 'src/price.ts', line: 2, severity: 'critical', category: 'logic', message: '负数处理错误', suggestion: '拒绝负数' },
        { filePath: 'src/price.ts', line: 3, severity: 'warning', category: 'test-missing', message: '分支未覆盖', suggestion: '补充分支用例' },
        { filePath: 'src/price.ts', line: 4, severity: 'info', category: 'assertion-weak', message: '断言太弱', suggestion: '检查返回值' },
      ],
      affectedTests: ['src/price.test.ts'],
    }
    const changes: ChangeItem[] = [{
      filePath: 'src/price.ts', oldContent: '',
      newContent: 'export function price(value: number) {\n  if (value < 0) return 0\n  return value\n}\n',
      addedLines: [2, 3, 4],
      isTestFile: false,
    }]
    const listeners = new Set<(value: ReviewResult, items: readonly ChangeItem[]) => void>()
    const codeReview = {
      review: vi.fn(async (items: readonly ChangeItem[]) => {
        for (const listener of listeners) listener(result, items)
        return result
      }),
      gateCheck: vi.fn(() => ({ status: 'blocked', allowed: false, message: '严重问题未覆盖',
        lineCoverage: 0.75, minLineCoverage: 0.8, blockingIssues: [result.issues[0]] })),
      onReviewed: (listener: (value: ReviewResult, items: readonly ChangeItem[]) => void) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
    } as unknown as CodeReviewer
    const routeAndExecute = vi.fn(async () => ({ choices: [{ message: { content:
      "```ts\nimport { test, expect } from 'vitest'\ntest('rejects negatives', () => { expect(price(-1)).toBe(0) })\n```" } }] }))
    const smartRoute = { routeAndExecute } as unknown as IntelligentRouter
    const markerDispose = vi.fn()
    const ide = {
      openFileAtLine: vi.fn(async () => {}),
      highlightLine: vi.fn(),
      markGutter: vi.fn(() => markerDispose),
      readTestFile: vi.fn(async () => ({ filePath: 'src/price.test.ts', content: "test('old', () => {})\n" })),
      writeTestFile: vi.fn(async () => {}),
    }
    const panel = new ReviewPanel({ codeReview, smartRoute, testAwareContext: new TestAwareContext() },
      container as unknown as HTMLElement, ide)
    const region = container.children[0]
    expect(region.hidden).toBe(true)

    await codeReview.review(changes)
    expect(region.hidden).toBe(false)
    expect(region.textContent).toContain(result.summary)
    expect(region.textContent).toContain('拦截')
    const cards = region.findAll(element => element.tag === 'article')
    expect(cards).toHaveLength(3)
    expect(cards.map(card => card.className)).toEqual(['critical', 'warning', 'info'])
    expect(cards[0].textContent).toContain('负数处理错误')
    expect(cards[0].textContent).toContain('建议：拒绝负数')
    expect(region.findAll(element => element.getAttribute('data-testid')?.startsWith('generate-') ?? false)).toHaveLength(2)
    expect(ide.markGutter).toHaveBeenCalledTimes(3)
    expect(ide.markGutter).toHaveBeenCalledWith('src/price.ts', 2, 'droplet')

    region.find(element => element.getAttribute('aria-label') === '跳转到 src/price.ts 第 2 行')!.click()
    await vi.waitFor(() => expect(ide.openFileAtLine).toHaveBeenCalledWith('src/price.ts', 2))
    expect(ide.highlightLine).toHaveBeenCalledWith('src/price.ts', 2)

    region.find(element => element.getAttribute('data-testid') === 'generate-1')!.click()
    await vi.waitFor(() => expect(routeAndExecute).toHaveBeenCalledOnce())
    expect(routeAndExecute.mock.calls[0][0]).toBe('test-gen')
    const params = routeAndExecute.mock.calls[0][1] as { messages: Array<{ content: string }> }
    expect(params.messages[1].content).toContain('分支未覆盖')
    expect(params.messages[1].content).toContain('3:   return value')
    const diff = region.find(element => element.getAttribute('data-testid') === 'test-diff')!
    await vi.waitFor(() => expect(diff.hidden).toBe(false))
    expect(diff.textContent).toContain("-test('old', () => {})")
    expect(diff.textContent).toContain("+test('rejects negatives'")
    expect(ide.writeTestFile).not.toHaveBeenCalled()

    diff.find(element => element.tag === 'button' && element.textContent === '手动编辑')!.click()
    const editor = diff.find(element => element.tag === 'textarea')!
    expect(editor.readOnly).toBe(false)
    editor.value += "test('zero', () => { expect(price(0)).toBe(0) })\n"
    editor.input()
    expect(diff.textContent).toContain("+test('zero'")
    diff.find(element => element.tag === 'button' && element.textContent === '确认替换')!.click()
    await vi.waitFor(() => expect(ide.writeTestFile).toHaveBeenCalledWith('src/price.test.ts', editor.value))
    panel.dispose()
    expect(markerDispose).toHaveBeenCalledTimes(3)
    expect(container.children).toHaveLength(0)
  })
})
