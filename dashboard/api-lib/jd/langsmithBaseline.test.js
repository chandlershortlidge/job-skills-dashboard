// Tests the guarded LangSmith baseline boundary with the real Micro1 reference.
// All network, model, Daytona, and LangSmith experiment boundaries are mocked.
import crypto from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import {
  buildLangSmithExtractionTarget,
  langSmithScoreEvaluator,
  preloadLangSmithAttachments,
  preflightLangSmithExamples,
  runAndSummarizeLangSmithBaseline,
  runLangSmithBaseline,
} from './langsmithBaseline.js'

const micro1 = JSON.parse(readFileSync(new URL('../../../evals/golden_017.jsonl', import.meta.url), 'utf8'))
const imageBytes = Buffer.from('Micro1 image bytes used only by the LangSmith boundary test')
const fixture = { ...micro1, source_sha256: crypto.createHash('sha256').update(imageBytes).digest('hex') }
const attachment = { presigned_url: 'https://example.test/micro1.png', mime_type: 'image/png' }
const example = {
  id: 'example-micro1',
  inputs: { job_description: fixture.job_description },
  outputs: { expected_extraction: fixture.expected_extraction },
  attachments: { 'job-10.png': attachment },
}

function exactResult() {
  return {
    skills: fixture.expected_extraction.technical_skills.map((skill) => ({ ...skill })),
    non_skill_mentions: fixture.expected_extraction.non_skill_mentions.map((mention) => ({ ...mention })),
  }
}

function fakeFetch() {
  return vi.fn(async () => new Response(imageBytes, { status: 200 }))
}

describe('LangSmith JD baseline boundary', () => {
  it('preflights a semantically identical remote reference and its single attachment', () => {
    expect(preflightLangSmithExamples([fixture], [example])).toEqual([example])
  })

  it('rejects a stale or incomplete remote expected extraction before model invocation', () => {
    const stale = structuredClone(example)
    stale.outputs = { source_file: 'job-10.png' }
    expect(() => preflightLangSmithExamples([fixture], [stale])).toThrow('golden_017: remote outputs.expected_extraction is required')
  })

  it('preloads a verified attachment before forwarding its exact bytes to the extractor', async () => {
    const fetchImpl = fakeFetch()
    const extract = vi.fn(async () => exactResult())
    const verifiedSources = await preloadLangSmithAttachments([fixture], [example], fetchImpl)
    const target = buildLangSmithExtractionTarget({ fixtures: [fixture], extract, verifiedSources })

    await expect(target(example.inputs)).resolves.toEqual(exactResult())
    expect(fetchImpl).toHaveBeenCalledWith(attachment.presigned_url)
    expect(extract).toHaveBeenCalledWith({ image: imageBytes.toString('base64'), mediaType: 'image/png' })
  })

  it('refuses a mismatched attachment before evaluate() can create an experiment', async () => {
    const client = {
      async *listExamples() { yield example },
    }
    const evaluate = vi.fn()

    await expect(runLangSmithBaseline({
      client,
      evaluate,
      fixtures: [fixture],
      datasetName: 'test-dataset',
      extract: async () => exactResult(),
      fetchImpl: async () => new Response(Buffer.from('wrong attachment'), { status: 200 }),
    })).rejects.toThrow('golden_017: attachment SHA-256 mismatch')
    expect(evaluate).not.toHaveBeenCalled()
  })

  it('reports the deliberate Micro1 grouping and audit mistakes as lower LangSmith metrics', () => {
    const incorrect = exactResult()
    incorrect.skills = incorrect.skills.map((skill) => (
      skill.alternative_group !== null ? { ...skill, alternative_group: null } : skill
    ))
    incorrect.non_skill_mentions = incorrect.non_skill_mentions.map((mention) => (
      mention.category === 'credential' ? { ...mention, category: 'soft_skill' } : mention
    ))

    const feedback = langSmithScoreEvaluator({ outputs: incorrect, referenceOutputs: example.outputs })
    expect(feedback).toEqual(expect.arrayContaining([
      { key: 'skill_alternative_group_accuracy', score: 0 },
      { key: 'audit_structured_accuracy', score: 12 / 13 },
      { key: 'non_skill_precision', score: 1 },
      { key: 'non_skill_recall', score: 1 },
      { key: 'audit_category_label_accuracy', score: 12 / 13 },
      { key: 'soft_skill_precision', score: 2 / 3 },
      { key: 'soft_skill_recall', score: 1 },
      { key: 'soft_skill_support', score: 2 },
    ]))
    expect(feedback.map(({ key }) => key)).toEqual(expect.arrayContaining([
      'skill_canonical_precision',
      'skill_canonical_recall',
      'skill_requirement_accuracy',
      'skill_alternative_group_accuracy',
      'non_skill_precision',
      'non_skill_recall',
      'audit_category_label_accuracy',
    ]))
    expect(feedback.map(({ key }) => key)).not.toContain('audit_source_text_precision')
    expect(feedback.map(({ key }) => key)).not.toContain('audit_source_text_recall')
    expect(feedback.map(({ key }) => key).some((key) => key.startsWith('technical_'))).toBe(false)
  })

  it('uses the CLI completion path without calling the obsolete result.wait()', async () => {
    const completedResults = {
      experimentName: 'mock-baseline',
      length: 20,
      wait: vi.fn(() => { throw new Error('wait must not be called') }),
    }
    const runBaseline = vi.fn(async () => completedResults)

    await expect(runAndSummarizeLangSmithBaseline({
      runBaseline,
      client: 'mock-client',
      datasetName: 'test-dataset',
      summary: { dataset: 'jd-skill-extraction-golden-v1', fixture_count: 20 },
    })).resolves.toEqual({
      dataset: 'jd-skill-extraction-golden-v1',
      fixture_count: 20,
      experiment_name: 'mock-baseline',
      completed_run_count: 20,
    })
    expect(runBaseline).toHaveBeenCalledWith({ client: 'mock-client', datasetName: 'test-dataset' })
    expect(completedResults.wait).not.toHaveBeenCalled()
  })

  it('runs the preflight before asking evaluate() to create an experiment', async () => {
    const fetchImpl = fakeFetch()
    const extract = vi.fn(async () => exactResult())
    const client = {
      async *listExamples() { yield example },
    }
    const experiment = { experimentName: 'mock-baseline' }
    const evaluate = vi.fn(async (target, options) => {
      expect(fetchImpl).toHaveBeenCalledTimes(1)
      await target(example.inputs)
      expect(options).toMatchObject({
        client,
        data: [example],
        includeAttachments: true,
        experimentPrefix: 'jd-skill-extraction-baseline',
        maxConcurrency: 1,
        metadata: { git_sha: 'test-sha', fixture_count: 1 },
      })
      expect(options.evaluators[0]({ outputs: exactResult(), referenceOutputs: example.outputs })).toEqual(expect.any(Array))
      return experiment
    })

    await expect(runLangSmithBaseline({
      client,
      evaluate,
      fixtures: [fixture],
      datasetName: 'test-dataset',
      extract,
      fetchImpl,
      metadata: { git_sha: 'test-sha' },
    })).resolves.toBe(experiment)
    expect(evaluate).toHaveBeenCalledTimes(1)
  })
})
