// Deterministic skill normalization for the live paths (JD drop-in + résumé parse).
// Mirrors normalize.py so an uploaded item lands on the SAME canonical the corpus chart
// uses: split known slash-lists -> resolve each part to a canonical via the generated
// canonicalMap (lowercased / paren-acronym / paren-stripped spelling; fallback keep-as-is)
// -> dedupe by canonical.
//
// The `canonicalMap` ({ splits, map }) is passed in rather than imported, so this stays a
// pure function (testable with a controlled map). `withRequirement: true` keeps each skill's
// required/nice-to-have and keeps an explicit alternative_group when present. The
// group is part of a job requirement's identity: the same canonical can occur in
// two separate alternatives and must not make either criterion disappear. Résumés
// leave it false (a résumé has no requirement).
export function normalizeSkills(skills, canonicalMap, { withRequirement = false } = {}) {
  const { splits, map } = canonicalMap
  const byCanon = {}
  for (const s of skills || []) {
    const raw = (s.canonical || '').trim()
    const parts = splits[raw.toLowerCase()] || [raw]
    for (const part of parts) {
      // Try, in order: exact lowercased form; the parenthetical acronym (catches
      // "Large Language Models (LLMs)" -> "llms" -> LLMs); the paren-stripped form
      // (catches "Retrieval-Augmented Generation (RAG)" -> "retrieval-augmented generation").
      const k1 = part.toLowerCase()
      const k3 = (part.match(/\(([^)]+)\)/)?.[1] || '').toLowerCase().trim()
      const k2 = k1.replace(/\s*\([^)]*\)/g, '').trim()
      const canon = map[k1] || map[k3] || map[k2] || part
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
