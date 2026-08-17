import { describe, it, expect } from 'vitest'
import { normalizeSkills } from './normalizeSkills.js'

// A small controlled map so the tests don't depend on the generated canonicalMap.js.
const MAP = {
  splits: { 'gcp/aws/azure': ['GCP', 'AWS', 'Azure'] },
  map: {
    llms: 'LLMs', // acronym only (not "large language models") -> isolates the k3 path
    'retrieval-augmented generation': 'RAG', // stripped only (not "rag") -> isolates k2
    python: 'Python',
  },
}
const skill = (canonical, requirement, alternative_group = null) => ({ canonical, raw_text: canonical, requirement, alternative_group })

describe('normalizeSkills', () => {
  it('splits known slash-lists into separate canonicals', () => {
    const out = normalizeSkills([skill('GCP/AWS/Azure', 'required')], MAP, { withRequirement: true })
    expect(out.map((s) => s.canonical)).toEqual(['GCP', 'AWS', 'Azure'])
  })

  it('resolves a parenthetical acronym via the paren body (k3)', () => {
    // "Large Language Models (LLMs)": full form unmapped -> falls to k3 "llms" -> LLMs
    const out = normalizeSkills([skill('Large Language Models (LLMs)', 'required')], MAP, { withRequirement: true })
    expect(out[0].canonical).toBe('LLMs')
  })

  it('resolves via the paren-stripped form (k2)', () => {
    // "Retrieval-Augmented Generation (RAG)": k3 "rag" unmapped -> k2 stripped form -> RAG
    const out = normalizeSkills([skill('Retrieval-Augmented Generation (RAG)', 'required')], MAP, { withRequirement: true })
    expect(out[0].canonical).toBe('RAG')
  })

  it('keeps an unmapped skill as-is (passthrough)', () => {
    const out = normalizeSkills([skill('Kubernetes', 'required')], MAP, { withRequirement: true })
    expect(out[0].canonical).toBe('Kubernetes')
  })

  it('dedupes different spellings that fold to the same canonical', () => {
    const out = normalizeSkills(
      [skill('LLMs', 'required'), skill('Large Language Models (LLMs)', 'required')],
      MAP,
      { withRequirement: true },
    )
    expect(out.map((s) => s.canonical)).toEqual(['LLMs'])
  })

  it('withRequirement:true keeps requirement and prefers "required"', () => {
    const out = normalizeSkills(
      [skill('Python', 'nice_to_have'), skill('Python', 'required')],
      MAP,
      { withRequirement: true },
    )
    expect(out).toEqual([{ canonical: 'Python', raw_text: 'Python', requirement: 'required', alternative_group: null }])
  })

  it('default (résumé mode) omits requirement entirely', () => {
    const out = normalizeSkills([skill('Python', 'required')], MAP)
    expect(out).toEqual([{ canonical: 'Python', raw_text: 'Python' }])
  })

  it('tolerates null / empty input', () => {
    expect(normalizeSkills(null, MAP)).toEqual([])
    expect(normalizeSkills([], MAP)).toEqual([])
  })

  it('keeps different alternatives separate while preserving each group id', () => {
    const out = normalizeSkills(
      [skill('Python', 'required', 'alt-1'), skill('Java', 'required', 'alt-1')],
      MAP,
      { withRequirement: true },
    )
    expect(out).toEqual([
      { canonical: 'Python', raw_text: 'Python', requirement: 'required', alternative_group: 'alt-1' },
      { canonical: 'Java', raw_text: 'Java', requirement: 'required', alternative_group: 'alt-1' },
    ])
  })
})
