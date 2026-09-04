// Tests the W&B Weave Golden boundary with real fixture contracts and fake image bytes.
// All reporter, model, Daytona, W&B, LangSmith, Supabase, and Storage boundaries are mocked.

import crypto from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import {
  allowlistedWeaveMetadata,
  runWeaveBaseline,
  weaveEvaluationLoggerOptions,
  weaveAggregateSummary,
  weaveScoreMetrics,
} from './weaveBaseline.js'

const evalsDirectory = new URL('../../../evals/', import.meta.url)
const fixtureFiles = readdirSync(evalsDirectory).filter((file) => /^golden_\d+\.jsonl$/.test(file)).sort()
const sourceBytesById = new Map()
const fixtures = fixtureFiles.map((file) => {
  const fixture = JSON.parse(readFileSync(new URL(file, evalsDirectory), 'utf8'))
  const bytes = Buffer.from(`mock screenshot bytes for ${fixture.id}`)
  sourceBytesById.set(fixture.id, bytes)
  return { ...fixture, source_sha256: crypto.createHash('sha256').update(bytes).digest('hex') }
})

function exactResult(fixture) {
  return {
    skills: fixture.expected_extraction.technical_skills.map((skill) => ({ ...skill })),
    non_skill_mentions: fixture.expected_extraction.non_skill_mentions.map((mention) => ({ ...mention })),
  }
}

function fakeReporter() {
  const predictions = []
  return {
    predictions,
    logPredictionAsync: vi.fn(async (inputs, output) => {
      const prediction = {
        inputs,
        output,
        scores: {},
        logScore: vi.fn(async (name, value) => { prediction.scores[name] = value }),
        finish: vi.fn(async () => {}),
      }
      predictions.push(prediction)
      return prediction
    }),
    logSummary: vi.fn(async () => {}),
  }
}

function resolveExactSource(fixture) {
  return { bytes: sourceBytesById.get(fixture.id), mediaType: 'image/png', localFile: `/private/${fixture.id}.png` }
}

describe('W&B Weave JD baseline boundary', () => {
  it('omits the bare dataset label that W&B UI parses as a reference', () => {
    const options = weaveEvaluationLoggerOptions({
      name: 'jd-skill-extraction-baseline',
      description: 'Golden evaluation',
      model: 'claude-test',
      metadata: {
        git_sha: 'test-sha',
        model: 'claude-test',
        secret: 'must-not-pass',
      },
    })

    expect(options).not.toHaveProperty('dataset')
    expect(options.name).toBe('jd-skill-extraction-baseline')
    expect(options.model).toEqual({ name: 'claude-test' })
    expect(options.attributes).toEqual({ git_sha: 'test-sha', model: 'claude-test' })
  })

  it('preflights all 20 sources before reporter initialization or extraction', async () => {
    expect(fixtures).toHaveLength(20)
    const initializeReporter = vi.fn()
    const extract = vi.fn()
    const finalFixtureId = fixtures.at(-1).id

    await expect(runWeaveBaseline({
      fixtures,
      resolveSource: (fixture) => fixture.id === finalFixtureId
        ? { bytes: Buffer.from('corrupt final screenshot'), mediaType: 'image/png' }
        : resolveExactSource(fixture),
      extract,
      initializeReporter,
    })).rejects.toThrow(`${finalFixtureId}: source SHA-256 mismatch`)

    expect(initializeReporter).not.toHaveBeenCalled()
    expect(extract).not.toHaveBeenCalled()
  })

  it('logs 20 sequential predictions without exposing image bytes or local paths', async () => {
    const reporter = fakeReporter()
    const initializeReporter = vi.fn(async () => reporter)
    let activeExtractions = 0
    let maximumActiveExtractions = 0
    const fixtureByImage = new Map(fixtures.map((fixture) => [sourceBytesById.get(fixture.id).toString('base64'), fixture]))
    const extract = vi.fn(async ({ image }) => {
      activeExtractions += 1
      maximumActiveExtractions = Math.max(maximumActiveExtractions, activeExtractions)
      await Promise.resolve()
      const result = exactResult(fixtureByImage.get(image))
      activeExtractions -= 1
      return result
    })

    const result = await runWeaveBaseline({
      fixtures,
      resolveSource: resolveExactSource,
      extract,
      initializeReporter,
      metadata: {
        git_sha: 'test-sha',
        model: 'mock-model',
        prompt_schema_sha256: 'prompt-hash',
        execution_mode: 'live',
        secret: 'must-not-pass',
      },
    })

    expect(extract).toHaveBeenCalledTimes(20)
    expect(maximumActiveExtractions).toBe(1)
    expect(reporter.logPredictionAsync).toHaveBeenCalledTimes(20)
    expect(reporter.predictions).toHaveLength(20)
    expect(reporter.predictions[0].inputs).toEqual({
      fixture_id: fixtures[0].id,
      job_description: fixtures[0].job_description,
      source_sha256: fixtures[0].source_sha256,
      expected_extraction: fixtures[0].expected_extraction,
    })
    expect(JSON.stringify(reporter.predictions)).not.toContain('mock screenshot bytes')
    expect(JSON.stringify(reporter.predictions)).not.toContain('/private/')
    expect(initializeReporter).toHaveBeenCalledWith({
      git_sha: 'test-sha',
      model: 'mock-model',
      prompt_schema_sha256: 'prompt-hash',
      execution_mode: 'live',
      fixture_count: 20,
      fixture_manifest_sha256: result.metadata.fixture_manifest_sha256,
    })
    expect(reporter.logSummary).toHaveBeenCalledWith(weaveAggregateSummary(result))
    expect(reporter.logSummary.mock.calls[0][0]).not.toHaveProperty('secret')
  })

  it('omits non-applicable and null row metrics without turning them into zero', () => {
    const score = {
      technical: {
        canonical_precision: 0.75,
        canonical_recall: 0.5,
        requirement_accuracy: 1,
        alternative_group_accuracy: 1,
        expected_alternative_groups: 0,
      },
      audit: {
        non_skill_precision: 1,
        non_skill_recall: 0.5,
        category_label_accuracy: 0.5,
        structured_accuracy: 0.25,
        by_category: {
          qualification: { expected: 0, precision: null, recall: null },
          responsibility: { expected: 2, precision: null, recall: 0.5 },
        },
      },
    }

    expect(weaveScoreMetrics(score)).toEqual({
      skill_canonical_precision: 0.75,
      skill_canonical_recall: 0.5,
      skill_requirement_accuracy: 1,
      non_skill_precision: 1,
      non_skill_recall: 0.5,
      audit_category_label_accuracy: 0.5,
      audit_structured_accuracy: 0.25,
      responsibility_recall: 0.5,
      responsibility_support: 2,
    })
  })

  it('surfaces a reporter failure without retrying the external write', async () => {
    const reporterError = new Error('W&B write failed')
    const reporter = {
      logPredictionAsync: vi.fn(async () => { throw reporterError }),
      logSummary: vi.fn(),
    }
    const initializeReporter = vi.fn(async () => reporter)
    const fixture = fixtures[0]

    await expect(runWeaveBaseline({
      fixtures: [fixture],
      resolveSource: resolveExactSource,
      extract: async () => exactResult(fixture),
      initializeReporter,
    })).rejects.toBe(reporterError)

    expect(initializeReporter).toHaveBeenCalledTimes(1)
    expect(reporter.logPredictionAsync).toHaveBeenCalledTimes(1)
    expect(reporter.logSummary).not.toHaveBeenCalled()
  })

  it('allowlists only reproducibility metadata', () => {
    expect(allowlistedWeaveMetadata({
      git_sha: 'abc',
      model: 'model',
      fixture_count: 20,
      api_key: 'secret',
    })).toEqual({ git_sha: 'abc', model: 'model', fixture_count: 20 })
  })
})
