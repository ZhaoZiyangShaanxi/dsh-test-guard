import Schema from '@deepseek-ai/schemastery'
import type { PluginConfig } from './types/index.js'

const taskType = Schema.union([
  'review',
  'code-review',
  'complex-logic',
  'test-generation',
  'test-gen',
  'chat',
  'text-formatting',
  'context-analysis',
  'summarization',
  'coverage-analysis',
  'regression-analysis',
])

export const Config: Schema<PluginConfig> = Schema.object({
  providers: Schema.array(Schema.object({
    name: Schema.string().required(),
    endpoint: Schema.string().required(),
    healthCheckEndpoint: Schema.string(),
    apiKey: Schema.string().required(),
    model: Schema.string().required(),
    enabled: Schema.boolean().default(true),
    priority: Schema.number().default(0),
    taskTypes: Schema.array(taskType).required(),
  })).default([]),
  toolResultLimit: Schema.number().default(8192),
  toolResultHeadChars: Schema.number().default(4096),
  toolResultTailChars: Schema.number().default(1024),
  lowCoverageThreshold: Schema.number().min(0).max(1).default(0.8),
  minLineCoverage: Schema.number().min(0).max(1).default(0.8),
  minBranchCoverage: Schema.number().min(0).max(1).default(0.8),
  blockSeverities: Schema.array(Schema.union(['critical', 'high', 'medium', 'low']))
    .default(['critical', 'high']),
})
