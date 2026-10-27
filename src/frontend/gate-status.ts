import type { GateCheckResult } from '../review/index.js'

/** Framework-neutral data for a submit button and its adjacent status panel. */
export interface GateViewModel {
  status: GateCheckResult['status']
  title: string
  message: string
  submitDisabled: boolean
  coverageLabel: string
  blockingLocations: string[]
}

export interface GateControls {
  submitButton: { disabled: boolean }
  statusText: { textContent: string | null }
}

export function toGateViewModel(gate: GateCheckResult): GateViewModel {
  const titles = { blocked: '提交已拦截', warning: '提交前请检查警告', passed: '质量门禁通过' }
  return {
    status: gate.status,
    title: titles[gate.status],
    message: gate.message,
    submitDisabled: !gate.allowed,
    coverageLabel: gate.lineCoverage === null ? '覆盖率未知'
      : `行覆盖率 ${(gate.lineCoverage * 100).toFixed(1)}% / 门槛 ${(gate.minLineCoverage * 100).toFixed(1)}%`,
    blockingLocations: gate.blockingIssues.map(issue => `${issue.filePath ?? '未知文件'}:${issue.line}`),
  }
}

/** Apply a gate decision to the host front end's submit controls. */
export function applyGateToControls(gate: GateCheckResult, controls: GateControls): GateViewModel {
  const view = toGateViewModel(gate)
  controls.submitButton.disabled = view.submitDisabled
  controls.statusText.textContent = [view.title, view.message, view.coverageLabel,
    ...view.blockingLocations].join('\n')
  return view
}
