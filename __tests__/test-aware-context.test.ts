import { describe, expect, it } from 'vitest'
import { TestAwareContext } from '../src/services/test-aware-context.js'

const manager = new TestAwareContext()

describe('TestAwareContext', () => {
  it('drops excessive chat while preserving a complete test failure and assertion', () => {
    const critical = [
      '```ts',
      "describe('payment', () => {",
      "  it('rejects invalid amount', () => {",
      '    expect(validate(-1)).toBe(false)',
      '  })',
      '})',
      '```',
      'AssertionError: expected true to be false',
      '    at tests/payment.test.ts:12:5',
    ].join('\n')
    const messages = [
      { role: 'user', kind: 'conversation', content: '今天只是随便聊聊。'.repeat(2_000) },
      { role: 'tool', kind: 'test-failure', content: critical },
    ] as const

    const compressed = manager.compressContext(messages, 80)
    expect(compressed.some(message => message.content === critical)).toBe(true)
    expect(compressed.map(message => message.content).join('').length)
      .toBeLessThan(messages[0].content.length / 4)
  })

  it('preserves a test block and stack trace embedded inside one long message', () => {
    const code = "```ts\nit('works', () => {\n  expect(1 + 1).toBe(2)\n})\n```"
    const error = 'TypeError: broken\n    at src/example.ts:4:2\n'
    const messages = [{
      role: 'user',
      content: 'ordinary chat '.repeat(500) + '\n\n' + code + '\n\n' + error + '\n' + 'more chat '.repeat(500),
    }]

    const [compressed] = manager.compressContext(messages, 80)
    expect(compressed.content).toContain(code)
    expect(compressed.content).toContain(error)
    expect(compressed.content.length).toBeLessThan(messages[0].content.length / 3)
  })

  it('never trims the active file even when protected content exceeds the budget', () => {
    const active = { filePath: 'src/active.ts', isActiveFile: true, content: 'X'.repeat(6_000) }
    const compressed = manager.compressContext([
      { kind: 'conversation', content: 'unimportant '.repeat(1_000) },
      active,
    ], 10)
    expect(compressed).toEqual([active])
  })

  it('keeps the first 2000 and last 1000 characters of a long non-test source file', () => {
    const source = { filePath: 'src/service.ts', kind: 'source-code', content: 'A'.repeat(2_500) + 'M'.repeat(1_000) + 'Z'.repeat(2_500) }
    const [compressed] = manager.compressContext([source], 900)
    expect(compressed.content).toBe('A'.repeat(2_000)
      + '\n... (context truncated for brevity) ...\n' + 'Z'.repeat(1_000))
  })

  it('removes low-value documentation before project configuration', () => {
    const docs = { kind: 'conversation', content: '# Notes\n' + 'D'.repeat(2_000) }
    const config = { filePath: 'vitest.config.ts', content: 'C'.repeat(1_800) }
    expect(manager.compressContext([docs, config], 470)).toEqual([config])
  })

  it('prefers the newest copy of a repeated tool result', () => {
    const content = 'result '.repeat(400)
    const messages = [
      { id: 'old', kind: 'tool-result', content },
      { id: 'new', kind: 'tool-result', content },
    ]
    expect(manager.compressContext(messages, 750)).toEqual([messages[1]])
  })

  it('returns unchanged messages when already within budget and accepts coverage updates', () => {
    const messages = [{ content: 'short conversation' }]
    expect(manager.compressContext(messages, 100)).toEqual(messages)
    expect(() => manager.updateCoverageData({})).not.toThrow()
  })

  it('prioritizes low-coverage source and never trims a focused uncovered line', () => {
    const aware = new TestAwareContext(0.8)
    aware.updateCoverageData({ files: [{ filePath: 'src/low.ts', lines: { 1: 1, 2: 0 }, uncoveredBranchLines: [] }] })
    const covered = { kind: 'source-code', filePath: 'src/covered.ts', content: 'C'.repeat(1_800) } as const
    const low = { kind: 'source-code', filePath: 'src/low.ts', content: 'L'.repeat(1_800) } as const
    expect(aware.compressContext([covered, low], 470)).toEqual([low])
    const focused = { kind: 'source-code', filePath: 'src/low.ts', lineNumber: 2, content: 'U'.repeat(5_000) } as const
    expect(aware.compressContext([covered, focused], 10)).toEqual([focused])
  })
})
