import type { ContextMessage, TestContextManager } from '../context/index.js'

type Score = 20 | 50 | 80 | 90 | 100
interface Span { start: number; end: number }
interface Fragment {
  messageIndex: number
  text: string
  score: Score
  removed: boolean
}

const TEST_CALL = /\b(?:describe|it|test|expect)\s*\(|\bassert(?:\s*\(|\.)/
const ERROR_LINE = /\b(?:\w*Error|\w*Exception)\s*(?:\[[^\]]+\])?:|Traceback \(most recent call last\)|^\s*at\s+.+:\d+(?::\d+)?\)?|^\s*File "[^"]+", line \d+/i
const SOURCE_FILE = /\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|cs|rb|php|c|cpp|h|hpp)$/i
const CONFIG_FILE = /(?:^|[\\/])(?:vitest|jest|playwright|webpack|vite|eslint)\.config\.[cm]?[jt]s$|(?:^|[\\/])(?:package\.json|tsconfig(?:\.[^\\/]+)?\.json)$/i
const TRUNCATION_MARKER = '\n... (context truncated for brevity) ...\n'

/** Approximation: ASCII text is ~4 chars/token; non-ASCII text is ~1 char/token. */
function estimateTextTokens(text: string): number {
  let nonAscii = 0
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) > 127) nonAscii++
  return Math.ceil((text.length - nonAscii) / 4 + nonAscii)
}

function messageTokens(fragments: readonly Fragment[]): number {
  const kept = fragments.filter(fragment => !fragment.removed)
  return kept.length ? 4 + estimateTextTokens(kept.map(fragment => fragment.text).join('')) : 0
}

function protectedSpans(content: string): Span[] {
  const spans: Span[] = []
  for (const match of content.matchAll(/```[\s\S]*?```/g)) {
    if (TEST_CALL.test(match[0]) || ERROR_LINE.test(match[0])) {
      spans.push({ start: match.index, end: match.index + match[0].length })
    }
  }

  const lines = content.split(/(?<=\n)/)
  const starts: number[] = []
  let offset = 0
  for (const line of lines) {
    starts.push(offset)
    offset += line.length
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line) continue
    const start = starts[i]
    const end = start + line.length
    if (spans.some(span => start >= span.start && end <= span.end)) continue

    if (TEST_CALL.test(line)) {
      let first = i
      let last = i
      while (first > 0 && lines[first - 1].trim()) first--
      while (last + 1 < lines.length && lines[last + 1].trim()) last++
      spans.push({ start: starts[first], end: starts[last] + lines[last].length })
    } else if (ERROR_LINE.test(line)) {
      spans.push({ start, end })
    }
  }

  spans.sort((a, b) => a.start - b.start)
  const merged: Span[] = []
  for (const span of spans) {
    const previous = merged.at(-1)
    if (previous && span.start <= previous.end) previous.end = Math.max(previous.end, span.end)
    else merged.push({ ...span })
  }
  return merged
}

function isLongDocumentation(message: ContextMessage): boolean {
  if (message.content.length <= 1_000) return false
  const content = message.content.trim()
  if (/^\/\*[\s\S]*\*\/$/.test(content)) return true
  if (content.split(/\r?\n/).every(line => !line.trim() || /^\s*(?:\/\/|\*)/.test(line))) return true
  return !message.filePath && /^#\s/.test(content)
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/')
}

function baseScore(message: ContextMessage, duplicate: boolean, lowCoverageFiles: Set<string>): Score {
  if (duplicate || (message.kind === 'skill-definition' && !message.invoked)) return 20
  if (message.invoked === false && /^\s*(?:export\s+)?(?:async\s+)?function\s+\w+/.test(message.content)) return 20
  if (message.isRecentlyModified) return 90
  if (message.kind === 'source-code' && message.filePath
    && lowCoverageFiles.has(normalizePath(message.filePath))) return 90
  if (isLongDocumentation(message)) return 20
  if (message.kind === 'source-code' || message.kind === 'config-file'
    || message.kind === 'coverage-report' || message.kind === 'review-result'
    || (message.filePath && (SOURCE_FILE.test(message.filePath) || CONFIG_FILE.test(message.filePath)))) return 80
  if (message.kind === 'conversation' || (!message.kind && message.content.length > 4_000)) return 20
  return 50
}

export class TestAwareContext implements TestContextManager {
  private readonly uncoveredLines = new Map<string, Set<number>>()

  constructor(private readonly lowCoverageThreshold = 0.8) {
    if (!Number.isFinite(lowCoverageThreshold) || lowCoverageThreshold < 0 || lowCoverageThreshold > 1) {
      throw new Error('lowCoverageThreshold 必须在 0 到 1 之间')
    }
  }

  compressContext<T extends ContextMessage>(messages: readonly T[], maxTokens: number): T[] {
    if (!Number.isInteger(maxTokens) || maxTokens < 0) {
      throw new Error('maxTokens 必须是非负整数')
    }

    const duplicates = new Set<number>()
    const seenToolResults = new Set<string>()
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].kind !== 'tool-result') continue
      if (seenToolResults.has(messages[i].content)) duplicates.add(i)
      else seenToolResults.add(messages[i].content)
    }

    const fragments: Fragment[] = []
    const lowCoverageFiles = new Set(this.uncoveredLines.keys())
    messages.forEach((message, messageIndex) => {
      const protectedWhole = message.isActiveFile || message.isSelectedFile
        || message.kind === 'test-code' || message.kind === 'assertion'
        || message.kind === 'test-failure' || message.kind === 'test-output'
        || (message.kind === 'source-code' && message.filePath && message.lineNumber !== undefined
          && this.uncoveredLines.get(normalizePath(message.filePath))?.has(message.lineNumber))
      if (protectedWhole) {
        fragments.push({ messageIndex, text: message.content, score: 100, removed: false })
        return
      }

      const score = baseScore(message, duplicates.has(messageIndex), lowCoverageFiles)
      const spans = protectedSpans(message.content)
      let cursor = 0
      for (const span of spans) {
        if (span.start > cursor) {
          fragments.push({ messageIndex, text: message.content.slice(cursor, span.start), score, removed: false })
        }
        fragments.push({ messageIndex, text: message.content.slice(span.start, span.end), score: 100, removed: false })
        cursor = span.end
      }
      if (cursor < message.content.length || !spans.length) {
        fragments.push({ messageIndex, text: message.content.slice(cursor), score, removed: false })
      }
    })

    const byMessage = messages.map(() => [] as Fragment[])
    for (const fragment of fragments) byMessage[fragment.messageIndex].push(fragment)
    let tokens = byMessage.reduce((sum, parts) => sum + messageTokens(parts), 0)
    if (tokens <= maxTokens) return [...messages]

    const candidates = fragments
      .filter(fragment => fragment.score < 100)
      .sort((a, b) => a.score - b.score || b.text.length - a.text.length)
    for (const fragment of candidates) {
      if (tokens <= maxTokens) break
      const parts = byMessage[fragment.messageIndex]
      if (fragment.text.length > 4_000) {
        const before = messageTokens(parts)
        fragment.text = fragment.text.slice(0, 2_000)
          + TRUNCATION_MARKER + fragment.text.slice(-1_000)
        tokens += messageTokens(parts) - before
      }
      if (tokens > maxTokens) {
        const before = messageTokens(parts)
        fragment.removed = true
        tokens += messageTokens(parts) - before
      }
    }

    return messages.flatMap((message, messageIndex) => {
      const kept = byMessage[messageIndex].filter(fragment => !fragment.removed)
      if (!kept.length) return []
      return [{ ...message, content: kept.map(fragment => fragment.text).join('') } as T]
    })
  }

  updateCoverageData(coverageMap: unknown): void {
    this.uncoveredLines.clear()
    if (typeof coverageMap !== 'object' || coverageMap === null || !('files' in coverageMap)
      || !Array.isArray(coverageMap.files)) return
    for (const file of coverageMap.files) {
      if (typeof file !== 'object' || file === null || typeof file.filePath !== 'string'
        || typeof file.lines !== 'object' || file.lines === null) continue
      const lines = Object.entries(file.lines).filter(([line, hits]) => Number.isInteger(Number(line))
        && typeof hits === 'number' && Number.isFinite(hits) && hits >= 0)
      const uncovered = new Set(lines.filter(([, hits]) => hits === 0).map(([line]) => Number(line)))
      if (Array.isArray(file.uncoveredBranchLines)) {
        for (const line of file.uncoveredBranchLines) if (Number.isInteger(line) && line > 0) uncovered.add(line)
      }
      const covered = lines.filter(([, hits]) => (hits as number) > 0).length
      if ((lines.length > 0 && covered / lines.length < this.lowCoverageThreshold) || uncovered.size > 0) {
        this.uncoveredLines.set(normalizePath(file.filePath), uncovered)
      }
    }
  }
}
