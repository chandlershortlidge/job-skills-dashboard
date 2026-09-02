// Deterministic skill normalization for the live paths (JD drop-in + résumé parse).
// Mirrors normalize.py so an uploaded item lands on the SAME canonical the corpus chart
// uses: split known slash-lists -> resolve each part to a canonical via the generated
// canonicalMap (lowercased / paren-acronym / paren-stripped spelling; fallback keep-as-is)
// -> dedupe by canonical.
//
// The `canonicalMap` ({ splits, map }) is passed in rather than imported, so this stays a
// pure function (testable with a controlled map). `inputField` names the model-side concept
// label: résumés and legacy data use canonical; JD extraction uses extracted_skill. The output
// is always canonical-only. `withRequirement: true` keeps each skill's required/nice-to-have
// and keeps an explicit alternative_group when present. The
// group is part of a job requirement's identity: the same canonical can occur in
// two separate alternatives and must not make either criterion disappear. Résumés
// leave it false (a résumé has no requirement).
export function normalizeSkills(skills, canonicalMap, { withRequirement = false, inputField = 'canonical' } = {}) {
  if (!['canonical', 'extracted_skill'].includes(inputField)) {
    throw new TypeError('inputField must be canonical or extracted_skill')
  }
  const { splits, map, exact_map: exactMap = {} } = canonicalMap
  const byCanon = {}
  for (const s of skills || []) {
    const raw = String(s[inputField] ?? '').trim()
    const parts = splits[raw.toLowerCase()] || [raw]
    for (const part of parts) {
      const exact = exactMap[part.trim()]
      // Try, in order: exact lowercased form; the parenthetical acronym (catches
      // "Large Language Models (LLMs)" -> "llms" -> LLMs); the paren-stripped form
      // (catches "Retrieval-Augmented Generation (RAG)" -> "retrieval-augmented generation").
      const k1 = part.toLowerCase()
      const k3 = (part.match(/\(([^)]+)\)/)?.[1] || '').toLowerCase().trim()
      const k2 = k1.replace(/\s*\([^)]*\)/g, '').trim()
      const canon = exact || map[k1] || map[k3] || map[k2] || part
      if (!canon) continue
      const alternativeGroup = s.alternative_group || null
      const identity = withRequirement && alternativeGroup ? `${canon}\u0000${alternativeGroup}` : canon
      if (!byCanon[identity]) {
        byCanon[identity] = withRequirement
          ? { canonical: canon, raw_text: s.raw_text, requirement: s.requirement, alternative_group: alternativeGroup }
          : { canonical: canon, raw_text: s.raw_text }
      } else if (withRequirement && s.requirement === 'required') {
        byCanon[identity].requirement = 'required' // prefer required if any mention is
      }
    }
  }
  return Object.values(byCanon)
}

// Shared JD boundary used by both the live route and LangSmith evaluations.
export function normalizeExtractedTechnicalSkills(skills, canonicalMap) {
  return normalizeSkills(skills, canonicalMap, {
    withRequirement: true,
    inputField: 'extracted_skill',
  })
}
