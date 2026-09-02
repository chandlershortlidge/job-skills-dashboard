import { describe, it, expect } from 'vitest'
import canonicalMap from './canonicalMap.js'
import { normalizeExtractedTechnicalSkills, normalizeSkills } from './normalizeSkills.js'

// A small controlled map so the tests don't depend on the generated canonicalMap.js.
const MAP = {
  splits: { 'gcp/aws/azure': ['GCP', 'AWS', 'Azure'] },
  exact_map: { ReAct: 'ReAct' },
  map: {
    llms: 'LLMs', // acronym only (not "large language models") -> isolates the k3 path
    'retrieval-augmented generation': 'RAG', // stripped only (not "rag") -> isolates k2
    python: 'Python',
    'microsoft azure': 'Azure',
    'model context protocol': 'MCP',
    'multi-agent systems': 'Multi-Agent Systems',
    'ai agents': 'Agents',
    'openai api': 'OpenAI API',
    'openai apis': 'OpenAI API',
    'anthropic api': 'Anthropic API',
    'anthropic apis': 'Anthropic API',
    react: 'React',
    'llm orchestration': 'LLM orchestration',
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

  it('resolves exact-case ReAct before case-folding without changing React', () => {
    const out = normalizeSkills([
      skill('ReAct', 'required'),
      skill('React', 'required'),
    ], MAP, { withRequirement: true })

    expect(out.map((item) => item.canonical)).toEqual(['ReAct', 'React'])
  })

  it('keeps LLM orchestration distinct from LLMs', () => {
    const out = normalizeSkills([
      skill('LLM orchestration', 'required'),
      skill('LLMs', 'required'),
    ], MAP, { withRequirement: true })

    expect(out.map((item) => item.canonical)).toEqual(['LLM orchestration', 'LLMs'])
  })

  it('normalizes JD extracted_skill labels and emits canonical-only records', () => {
    const out = normalizeExtractedTechnicalSkills([{
      raw_text: 'large language models',
      extracted_skill: 'Large Language Models (LLMs)',
      requirement: 'required',
      alternative_group: null,
    }], MAP)

    expect(out).toEqual([{
      canonical: 'LLMs',
      raw_text: 'large language models',
      requirement: 'required',
      alternative_group: null,
    }])
    expect(out[0]).not.toHaveProperty('extracted_skill')
  })

  it('keeps an unknown extracted_skill as a provisional pass-through canonical', () => {
    const out = normalizeExtractedTechnicalSkills([{
      raw_text: 'Novel Agent Platform',
      extracted_skill: 'Novel Agent Platform',
      requirement: 'required',
      alternative_group: null,
    }], MAP)

    expect(out[0].canonical).toBe('Novel Agent Platform')
  })

  it('keeps bare OpenAI distinct from an explicitly stated OpenAI API', () => {
    const out = normalizeExtractedTechnicalSkills([
      {
        raw_text: 'related technical tools (OpenAI, LangChain, Langfuse …)',
        extracted_skill: 'OpenAI',
        requirement: 'required',
        alternative_group: null,
      },
      {
        raw_text: 'experience with the OpenAI API',
        extracted_skill: 'OpenAI API',
        requirement: 'nice_to_have',
        alternative_group: null,
      },
    ], canonicalMap)

    expect(out.map(({ canonical, requirement }) => ({ canonical, requirement }))).toEqual([
      { canonical: 'OpenAI', requirement: 'required' },
      { canonical: 'OpenAI API', requirement: 'nice_to_have' },
    ])
  })

  it('rejects a misspelled input field instead of silently dropping every skill', () => {
    expect(() => normalizeSkills([], MAP, { inputField: 'extractedSkill' }))
      .toThrow('inputField must be canonical or extracted_skill')
  })

  it('dedupes different spellings that fold to the same canonical', () => {
    const out = normalizeSkills(
      [skill('LLMs', 'required'), skill('Large Language Models (LLMs)', 'required')],
      MAP,
      { withRequirement: true },
    )
    expect(out.map((s) => s.canonical)).toEqual(['LLMs'])
  })

  it('merges AI-agent and provider API singular/plural aliases into stable canonicals', () => {
    const out = normalizeSkills([
      skill('AI Agents', 'required'),
      skill('OpenAI API', 'nice_to_have'),
      skill('OpenAI APIs', 'nice_to_have'),
      skill('Anthropic API', 'nice_to_have'),
      skill('Anthropic APIs', 'nice_to_have'),
    ], MAP, { withRequirement: true })

    expect(out.map((item) => item.canonical)).toEqual(['Agents', 'OpenAI API', 'Anthropic API'])
  })

  it('uses the generated live canonical map for the Cognee aliases', () => {
    const out = normalizeSkills([
      skill('AI Agents', 'required'),
      skill('OpenAI APIs', 'nice_to_have'),
      skill('Anthropic API', 'nice_to_have'),
    ], canonicalMap, { withRequirement: true })

    expect(out.map((item) => item.canonical)).toEqual(['Agents', 'OpenAI API', 'Anthropic API'])
  })

  it('uses the generated live canonical map to merge Microsoft Azure into Azure', () => {
    const out = normalizeSkills([
      skill('Microsoft Azure', 'required', 'cloud_platform'),
    ], canonicalMap, { withRequirement: true })

    expect(out).toEqual([
      { canonical: 'Azure', raw_text: 'Microsoft Azure', requirement: 'required', alternative_group: 'cloud_platform' },
    ])
  })

  it('uses the generated live canonical map to merge Model Context Protocol into MCP', () => {
    const out = normalizeSkills([
      skill('Model Context Protocol', 'nice_to_have'),
    ], canonicalMap, { withRequirement: true })

    expect(out).toEqual([
      { canonical: 'MCP', raw_text: 'Model Context Protocol', requirement: 'nice_to_have', alternative_group: null },
    ])
  })

  it.each([
    ['Full-stack competence', 'Full-stack development'],
    ['backend', 'Backend development'],
    ['frontend', 'Frontend development'],
    ['Tool Use', 'Tool calling'],
    ['Chain-of-Thought', 'Chain-of-Thought'],
    ['containers', 'Containerization'],
    ['serverless', 'Serverless'],
    ['pgvector', 'pgvector'],
    ['model selection', 'Model Selection'],
    ['AI/ML', 'AI/ML'],
    ['AI/ML ecosystem', 'AI/ML'],
    ['Applied AI', 'AI/ML'],
    ['LLM Integration', 'AI Integration'],
    ['AI Integration', 'AI Integration'],
    ['coding agents', 'AI developer tooling'],
    ['OpenAI Codex', 'Codex'],
    ['Copilot', 'GitHub Copilot'],
    ['GitHub Copilot', 'GitHub Copilot'],
    ['Cursor', 'Cursor'],
    ['Anthropic', 'Anthropic'],
    ['AI Security Guardrails', 'security guardrails'],
    ['Google Agent Development Kit', 'Google ADK'],
    ['Google Agent Development Kit (ADK)', 'Google ADK'],
    ['Gemini Models', 'Gemini'],
    ['RAGAs', 'Ragas'],
    ['Vertex AI', 'Vertex AI'],
    ['Vector Search', 'Vector Search'],
    ['AIOps', 'AIOps'],
    ['Model Deployment', 'AI deployment'],
    ['ML Model Deployment', 'AI deployment'],
    ['Deep Learning Frameworks', 'Deep Learning'],
    ['containerized workloads', 'Containerization'],
    ['Amazon S3', 'AWS S3'],
    ['Pandas', 'pandas'],
  ])('stabilizes revised example-policy identity %s as %s', (extractedSkill, canonical) => {
    const out = normalizeExtractedTechnicalSkills([{
      raw_text: extractedSkill,
      extracted_skill: extractedSkill,
      requirement: 'required',
      alternative_group: null,
    }], canonicalMap)

    expect(out[0].canonical).toBe(canonical)
  })

  it('keeps explicit Machine Learning distinct while canonicalizing Golden 013 bare Copilot', () => {
    const out = normalizeSkills([
      skill('Machine Learning', 'required'),
      skill('Copilot', 'required'),
    ], canonicalMap, { withRequirement: true })

    expect(out.map((item) => item.canonical)).toEqual(['Machine Learning', 'GitHub Copilot'])
  })

  it('does not collapse the Google Cloud AI/ML stack into a duplicate broad identity', () => {
    const out = normalizeSkills([
      skill('Google Cloud AI/ML', 'nice_to_have'),
    ], canonicalMap, { withRequirement: true })

    expect(out[0].canonical).toBe('Google Cloud AI/ML')
  })

  it.each(['API Design', 'API Architecture'])(
    'uses the generated live canonical map to keep %s distinct from API use',
    (extractedSkill) => {
      const out = normalizeExtractedTechnicalSkills([{
        raw_text: extractedSkill,
        extracted_skill: extractedSkill,
        requirement: 'required',
        alternative_group: null,
      }], canonicalMap)

      expect(out[0].canonical).toBe('API Design')
    },
  )

  it.each(['ETL/ELT Pipelines', 'ETL/ELT'])(
    'uses the generated live canonical map to merge %s into Data pipelines',
    (extractedSkill) => {
    const out = normalizeExtractedTechnicalSkills([{
      raw_text: 'ETL/ELT pipeline design, SQL, data modeling, API integrations',
      extracted_skill: extractedSkill,
      requirement: 'nice_to_have',
      alternative_group: null,
    }], canonicalMap)

    expect(out).toEqual([{
      canonical: 'Data pipelines',
      raw_text: 'ETL/ELT pipeline design, SQL, data modeling, API integrations',
      requirement: 'nice_to_have',
      alternative_group: null,
    }])
    },
  )

  it('keeps Multi-Agent Systems distinct from Agents in the generated live map', () => {
    const out = normalizeSkills([
      skill('Agents', 'required'),
      skill('multi-agent systems', 'nice_to_have'),
    ], canonicalMap, { withRequirement: true })

    expect(out.map(({ canonical, requirement }) => ({ canonical, requirement }))).toEqual([
      { canonical: 'Agents', requirement: 'required' },
      { canonical: 'Multi-Agent Systems', requirement: 'nice_to_have' },
    ])
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
