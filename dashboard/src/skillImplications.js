/**
 * Expand résumé evidence through curated, directional skill implications.
 *
 * This module does not change JD requirements, canonical aliases, extraction
 * output, or persisted résumé data. Its invariants are specific-to-broad only,
 * transitive closure, set-based deduplication, and no mutation of caller input.
 */

export const SKILL_IMPLICATIONS = Object.freeze({
  RAG: Object.freeze(['LLMs']),
  'Prompt engineering': Object.freeze(['LLMs']),
  LangChain: Object.freeze(['LLM orchestration']),
  LlamaIndex: Object.freeze(['LLM orchestration']),
  'LLM orchestration': Object.freeze(['LLMs']),
  ReAct: Object.freeze(['Agents']),
  LangGraph: Object.freeze(['Agents']),
  'Google ADK': Object.freeze(['Agents']),
  Agno: Object.freeze(['Agents']),
  'Chain-of-Thought': Object.freeze(['Prompt engineering']),
  AWS: Object.freeze(['Cloud']),
  Azure: Object.freeze(['Cloud']),
  GCP: Object.freeze(['Cloud']),
  'Vertex AI': Object.freeze(['GCP']),
  Gemini: Object.freeze(['LLMs']),
  TensorFlow: Object.freeze(['Deep Learning']),
  PyTorch: Object.freeze(['Deep Learning']),
  pandas: Object.freeze(['Python']),
  NumPy: Object.freeze(['Python']),
  'scikit-learn': Object.freeze(['Python']),
  Docker: Object.freeze(['Containerization']),
  Kubernetes: Object.freeze(['Containerization']),
  pgvector: Object.freeze(['Vector Databases']),
  Ragas: Object.freeze(['Evaluation']),
  LangSmith: Object.freeze(['Evaluation']),
  'Claude Code': Object.freeze(['AI developer tooling']),
  Codex: Object.freeze(['AI developer tooling']),
  Cursor: Object.freeze(['AI developer tooling']),
  'GitHub Copilot': Object.freeze(['AI developer tooling']),
  'API Design': Object.freeze(['Software engineering']),
  FastAPI: Object.freeze(['APIs']),
  Flask: Object.freeze(['APIs']),
  'Agent state management': Object.freeze(['Agents']),
  'Agent architecture': Object.freeze(['Agents']),
  'Multi-Agent Systems': Object.freeze(['Agents']),
  'LLM guardrails': Object.freeze(['LLMs']),
  'MITRE ATT&CK': Object.freeze(['Cybersecurity']),
  'MITRE CALDERA': Object.freeze(['Adversary emulation']),
  'Adversary emulation': Object.freeze(['Cybersecurity']),
  'Lateral movement': Object.freeze(['Cybersecurity']),
  Persistence: Object.freeze(['Cybersecurity']),
  'Cyber ranges': Object.freeze(['Cybersecurity']),
  'Red team tooling': Object.freeze(['Cybersecurity']),
  'Security simulation': Object.freeze(['Cybersecurity']),
  PostgreSQL: Object.freeze(['SQL']),
  MySQL: Object.freeze(['SQL']),
  SQL: Object.freeze(['Data stores']),
  'Object Storage': Object.freeze(['Data stores']),
  NoSQL: Object.freeze(['Data stores']),
  'AWS S3': Object.freeze(['Object Storage', 'AWS']),
  LLMOps: Object.freeze(['MLOps']),
  'Molecular Fingerprints': Object.freeze(['Cheminformatics']),
  'Chemical Descriptors': Object.freeze(['Cheminformatics']),
  RDKit: Object.freeze(['Cheminformatics']),
  'Molecular Similarity Search': Object.freeze(['Cheminformatics']),
})

export function expandSkillEvidence(skills) {
  const expanded = new Set(skills || [])
  const pending = [...expanded]

  for (let index = 0; index < pending.length; index += 1) {
    for (const parent of SKILL_IMPLICATIONS[pending[index]] || []) {
      if (expanded.has(parent)) continue
      expanded.add(parent)
      pending.push(parent)
    }
  }
  return expanded
}

// Old résumé parsing persisted this exact synthetic marker. Filter only that
// marker at read time so genuine LLM evidence and the stored row remain intact.
export function sanitizeResumeProfile(profile) {
  if (!profile || !Array.isArray(profile.skills)) return profile
  const skills = profile.skills.filter(
    (skill) => !(skill?.canonical === 'LLMs' && skill?.raw_text === 'inferred from LLM tooling'),
  )
  return skills.length === profile.skills.length ? profile : { ...profile, skills }
}
