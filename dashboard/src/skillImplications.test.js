import { describe, expect, it } from 'vitest'
import {
  SKILL_IMPLICATIONS,
  expandSkillEvidence,
  sanitizeResumeProfile,
} from './skillImplications'

describe('expandSkillEvidence', () => {
  it('pins the complete curated implication graph', () => {
    expect(SKILL_IMPLICATIONS).toEqual({
      RAG: ['LLMs'],
      'Prompt engineering': ['LLMs'],
      LangChain: ['LLM orchestration'],
      LlamaIndex: ['LLM orchestration'],
      'LLM orchestration': ['LLMs'],
      ReAct: ['Agents'],
      LangGraph: ['Agents'],
      'Google ADK': ['Agents'],
      Agno: ['Agents'],
      'Chain-of-Thought': ['Prompt engineering'],
      AWS: ['Cloud'],
      Azure: ['Cloud'],
      GCP: ['Cloud'],
      'Vertex AI': ['GCP'],
      Gemini: ['LLMs'],
      TensorFlow: ['Deep Learning'],
      PyTorch: ['Deep Learning'],
      pandas: ['Python'],
      NumPy: ['Python'],
      'scikit-learn': ['Python'],
      Docker: ['Containerization'],
      Kubernetes: ['Containerization'],
      pgvector: ['Vector Databases'],
      Ragas: ['Evaluation'],
      LangSmith: ['Evaluation'],
      'Claude Code': ['AI developer tooling'],
      Codex: ['AI developer tooling'],
      Cursor: ['AI developer tooling'],
      'GitHub Copilot': ['AI developer tooling'],
      'API Design': ['Software engineering'],
      FastAPI: ['APIs'],
      Flask: ['APIs'],
      'Agent state management': ['Agents'],
      'Agent architecture': ['Agents'],
      'Multi-Agent Systems': ['Agents'],
      'LLM guardrails': ['LLMs'],
      'MITRE ATT&CK': ['Cybersecurity'],
      'MITRE CALDERA': ['Adversary emulation'],
      'Adversary emulation': ['Cybersecurity'],
      'Lateral movement': ['Cybersecurity'],
      Persistence: ['Cybersecurity'],
      'Cyber ranges': ['Cybersecurity'],
      'Red team tooling': ['Cybersecurity'],
      'Security simulation': ['Cybersecurity'],
      PostgreSQL: ['SQL'],
      MySQL: ['SQL'],
      SQL: ['Data stores'],
      'Object Storage': ['Data stores'],
      NoSQL: ['Data stores'],
      'AWS S3': ['Object Storage', 'AWS'],
      LLMOps: ['MLOps'],
      'Molecular Fingerprints': ['Cheminformatics'],
      'Chemical Descriptors': ['Cheminformatics'],
      RDKit: ['Cheminformatics'],
      'Molecular Similarity Search': ['Cheminformatics'],
    })
  })

  it('allows specific-to-broad matching but never broad-to-specific matching', () => {
    expect([...expandSkillEvidence(['RAG'])]).toEqual(['RAG', 'LLMs'])
    expect([...expandSkillEvidence(['LLMs'])]).toEqual(['LLMs'])
  })

  it('dedupes a shared parent and does not mutate caller input', () => {
    const input = new Set(['RAG', 'Prompt engineering'])
    const expanded = expandSkillEvidence(input)

    expect([...input]).toEqual(['RAG', 'Prompt engineering'])
    expect([...expanded]).toEqual(['RAG', 'Prompt engineering', 'LLMs'])
    expect([...expanded].filter((skill) => skill === 'LLMs')).toHaveLength(1)
  })

  it('follows transitive implications', () => {
    expect([...expandSkillEvidence(['LangChain'])]).toEqual([
      'LangChain',
      'LLM orchestration',
      'LLMs',
    ])
    expect([...expandSkillEvidence(['Chain-of-Thought'])]).toEqual([
      'Chain-of-Thought',
      'Prompt engineering',
      'LLMs',
    ])
  })

  it('lets Golden 020 Python libraries satisfy the explicit Python parent only upward', () => {
    for (const library of ['pandas', 'NumPy', 'scikit-learn']) {
      expect([...expandSkillEvidence([library])]).toEqual([library, 'Python'])
    }
    expect([...expandSkillEvidence(['Python'])]).toEqual(['Python'])
    expect([...expandSkillEvidence(['pandas', 'NumPy', 'scikit-learn'])]).toEqual([
      'pandas',
      'NumPy',
      'scikit-learn',
      'Python',
    ])
  })

  it('lets every named AI coding product satisfy broad developer tooling once', () => {
    for (const product of ['Claude Code', 'Codex', 'Cursor', 'GitHub Copilot']) {
      expect([...expandSkillEvidence([product])]).toEqual([product, 'AI developer tooling'])
    }
    expect([...expandSkillEvidence(['AI developer tooling'])]).toEqual(['AI developer tooling'])
    expect([...expandSkillEvidence(['Codex', 'Cursor'])]).toEqual([
      'Codex',
      'Cursor',
      'AI developer tooling',
    ])
  })

  it('expands Golden 016 frameworks and products only toward approved parents', () => {
    expect([...expandSkillEvidence(['LangGraph', 'Google ADK', 'Agno'])]).toEqual([
      'LangGraph',
      'Google ADK',
      'Agno',
      'Agents',
    ])
    expect([...expandSkillEvidence(['Vertex AI'])]).toEqual(['Vertex AI', 'GCP', 'Cloud'])
    expect([...expandSkillEvidence(['Gemini'])]).toEqual(['Gemini', 'LLMs'])
    expect([...expandSkillEvidence(['Ragas', 'LangSmith'])]).toEqual([
      'Ragas',
      'LangSmith',
      'Evaluation',
    ])
    for (const broad of ['Agents', 'LLMs', 'Cloud', 'Evaluation']) {
      expect([...expandSkillEvidence([broad])]).toEqual([broad])
    }
    expect([...expandSkillEvidence(['GCP'])]).toEqual(['GCP', 'Cloud'])
  })

  it('expands Golden 017 frameworks and container tools only toward broad parents', () => {
    expect([...expandSkillEvidence(['TensorFlow', 'PyTorch'])]).toEqual([
      'TensorFlow',
      'PyTorch',
      'Deep Learning',
    ])
    expect([...expandSkillEvidence(['Kubernetes'])]).toEqual(['Kubernetes', 'Containerization'])
    expect([...expandSkillEvidence(['Docker'])]).toEqual(['Docker', 'Containerization'])
    expect([...expandSkillEvidence(['Deep Learning'])]).toEqual(['Deep Learning'])
    expect([...expandSkillEvidence(['Containerization'])]).toEqual(['Containerization'])
  })

  it('expands Golden 018 evidence through approved specific-to-broad paths', () => {
    expect([...expandSkillEvidence(['FastAPI'])]).toEqual(['FastAPI', 'APIs'])
    expect([...expandSkillEvidence(['PostgreSQL'])]).toEqual([
      'PostgreSQL',
      'SQL',
      'Data stores',
    ])
    expect([...expandSkillEvidence(['AWS S3'])]).toEqual([
      'AWS S3',
      'Object Storage',
      'AWS',
      'Data stores',
      'Cloud',
    ])
    expect([...expandSkillEvidence(['LLMOps'])]).toEqual(['LLMOps', 'MLOps'])
    expect([...expandSkillEvidence(['RDKit', 'Molecular Fingerprints'])]).toEqual([
      'RDKit',
      'Molecular Fingerprints',
      'Cheminformatics',
    ])
  })

  it('does not generalize Golden 018 state management or MCP beyond approved context', () => {
    expect([...expandSkillEvidence(['State Management'])]).toEqual(['State Management'])
    expect([...expandSkillEvidence(['MCP'])]).toEqual(['MCP'])
    expect([...expandSkillEvidence(['Multi-step reasoning'])]).toEqual(['Multi-step reasoning'])
    expect([...expandSkillEvidence(['Prompt engineering'])]).toEqual(['Prompt engineering', 'LLMs'])
  })

  it('expands Golden 019 evidence only toward approved broader capabilities', () => {
    expect([...expandSkillEvidence(['Agent architecture', 'Multi-Agent Systems'])]).toEqual([
      'Agent architecture',
      'Multi-Agent Systems',
      'Agents',
    ])
    expect([...expandSkillEvidence(['MITRE CALDERA'])]).toEqual([
      'MITRE CALDERA',
      'Adversary emulation',
      'Cybersecurity',
    ])
    expect([...expandSkillEvidence([
      'MITRE ATT&CK',
      'Lateral movement',
      'Persistence',
      'Cyber ranges',
      'Red team tooling',
      'Security simulation',
    ])]).toEqual([
      'MITRE ATT&CK',
      'Lateral movement',
      'Persistence',
      'Cyber ranges',
      'Red team tooling',
      'Security simulation',
      'Cybersecurity',
    ])
    expect([...expandSkillEvidence(['Cybersecurity'])]).toEqual(['Cybersecurity'])
    expect([...expandSkillEvidence(['Agents'])]).toEqual(['Agents'])
  })

  it.each([
    ['Tool calling', 'Agents'],
    ['Backend development', 'Full-stack development'],
    ['Frontend development', 'Full-stack development'],
    ['Containerization', 'AI deployment'],
    ['Serverless', 'AI deployment'],
    ['Fine-tuning', 'LLMs'],
    ['Model Selection', 'LLMs'],
    ['Elasticsearch', 'Vector Databases'],
    ['Agents', 'LLMs'],
    ['Active Directory', 'Networking'],
  ])('does not invent the deliberately excluded %s → %s edge', (specific, broad) => {
    expect(expandSkillEvidence([specific]).has(broad)).toBe(false)
  })

  it('keeps the curated graph acyclic and every declared parent reachable', () => {
    for (const [child, parents] of Object.entries(SKILL_IMPLICATIONS)) {
      const expanded = expandSkillEvidence([child])
      expect(expanded.has(child)).toBe(true)
      for (const parent of parents) expect(expanded.has(parent)).toBe(true)

      const visiting = new Set()
      const visited = new Set()
      const visit = (skill) => {
        if (visiting.has(skill)) throw new Error(`skill implication cycle at ${skill}`)
        if (visited.has(skill)) return
        visiting.add(skill)
        for (const parent of SKILL_IMPLICATIONS[skill] || []) visit(parent)
        visiting.delete(skill)
        visited.add(skill)
      }
      visit(child)
    }
  })
})

describe('sanitizeResumeProfile', () => {
  it('removes only the exact legacy synthetic LLM marker without mutating the profile', () => {
    const profile = {
      title: 'AI Engineer',
      skills: [
        { canonical: 'RAG', raw_text: 'RAG pipelines' },
        { canonical: 'LLMs', raw_text: 'inferred from LLM tooling' },
      ],
    }

    expect(sanitizeResumeProfile(profile)).toEqual({
      title: 'AI Engineer',
      skills: [{ canonical: 'RAG', raw_text: 'RAG pipelines' }],
    })
    expect(profile.skills).toHaveLength(2)
  })

  it('preserves genuine LLM evidence and nonmatching legacy-like rows', () => {
    const profile = {
      skills: [
        { canonical: 'LLMs', raw_text: 'Built LLM applications' },
        { canonical: 'RAG', raw_text: 'inferred from LLM tooling' },
      ],
    }
    expect(sanitizeResumeProfile(profile)).toBe(profile)
  })
})
