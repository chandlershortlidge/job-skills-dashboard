// Tests for the no-write golden-evaluation orchestration. Uses the real Micro1
// reference with mocked image bytes and extraction; no live model or external writes.
import crypto from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { fixtureManifestSha256, runGoldenEvaluation } from './goldenRunner.js'

const micro1 = JSON.parse(readFileSync(new URL('../../../evals/golden_017.jsonl', import.meta.url), 'utf8'))
const sourceBytes = Buffer.from('test image bytes for golden runner')
const fixture = { ...micro1, source_sha256: crypto.createHash('sha256').update(sourceBytes).digest('hex') }

function exactResult() {
  return {
    skills: fixture.expected_extraction.technical_skills.map((skill) => ({ ...skill })),
    non_skill_mentions: fixture.expected_extraction.non_skill_mentions.map((mention) => ({ ...mention })),
  }
}

function resolveExactSource() {
  return { bytes: sourceBytes, mediaType: 'image/png', localFile: 'scratch/screenshots/AI Engineer micro1.png' }
}

describe('runGoldenEvaluation', () => {
  it('passes verified bytes to an injected extractor and records reproducible metadata', async () => {
    const extract = vi.fn(async () => exactResult())
    const result = await runGoldenEvaluation({
      fixtures: [fixture],
      resolveSource: resolveExactSource,
      extract,
      metadata: { git_sha: 'test-sha', model: 'mock', prompt_schema_version: 'mock-v1' },
    })

    expect(extract).toHaveBeenCalledWith({ image: sourceBytes.toString('base64'), mediaType: 'image/png' })
    expect(result.metadata).toEqual({
      git_sha: 'test-sha',
      model: 'mock',
      prompt_schema_version: 'mock-v1',
      fixture_count: 1,
      fixture_manifest_sha256: fixtureManifestSha256([fixture]),
    })
    expect(result.reports[0]).toMatchObject({
      id: 'golden_017',
      local_file: 'scratch/screenshots/AI Engineer micro1.png',
      source_sha256: fixture.source_sha256,
      score: { technical: { canonical_recall: 1 }, audit: { structured_accuracy: 1 } },
    })
    expect(result.aggregate.technical).toMatchObject({ alternative_group_accuracy: 1, alternative_group_jobs: 1 })
  })

  it('carries a wrong alternative grouping and audit category through to lower metrics', async () => {
    const incorrect = exactResult()
    incorrect.skills = incorrect.skills.map((skill) => (
      skill.alternative_group !== null ? { ...skill, alternative_group: null } : skill
    ))
    incorrect.non_skill_mentions = incorrect.non_skill_mentions.map((mention) => (
      mention.category === 'credential' ? { ...mention, category: 'soft_skill' } : mention
    ))

    const result = await runGoldenEvaluation({
      fixtures: [fixture],
      resolveSource: resolveExactSource,
      extract: async () => incorrect,
    })

    expect(result.reports[0].score.technical).toMatchObject({ canonical_recall: 1, alternative_group_accuracy: 0 })
    expect(result.reports[0].score.audit).toMatchObject({ non_skill_recall: 1, structured_accuracy: 12 / 13 })
    expect(result.aggregate.audit.by_category.soft_skill).toEqual({
      expected: 2,
      predicted: 3,
      matched: 2,
      precision: 2 / 3,
      recall: 1,
      support: 2,
    })
    expect(result.aggregate.technical).toMatchObject({ alternative_group_accuracy: 0, alternative_group_jobs: 1 })
    expect(result.aggregate.audit.structured_accuracy).toBe(12 / 13)
  })

  it('fails before extraction if resolver bytes do not match the golden source hash', async () => {
    const extract = vi.fn()
    await expect(runGoldenEvaluation({
      fixtures: [fixture],
      resolveSource: () => ({ bytes: Buffer.from('wrong screenshot'), mediaType: 'image/png' }),
      extract,
    })).rejects.toThrow('golden_017: source SHA-256 mismatch')
    expect(extract).not.toHaveBeenCalled()
  })

  it('changes the manifest hash when an expected label changes', () => {
    const changed = structuredClone(fixture)
    changed.expected_extraction.technical_skills[0].requirement = 'nice_to_have'
    expect(fixtureManifestSha256([changed])).not.toBe(fixtureManifestSha256([fixture]))
  })
})
