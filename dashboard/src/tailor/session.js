// Spec C8 — testable core of the tailoring session (pure, no React, no I/O).
// TailorScreen delegates every decision that matters to these functions so the
// pill/checklist/assembly/staleness/score logic stays unit-testable.
import { sha256Hex } from './anchor.js'
import { requiredSkillRequirements } from '../skillRequirements.js'
import { expandSkillEvidence } from '../skillImplications.js'

// Skill-gap pills: required JD canonicals absent from BOTH the cv skill set and
// every template claim's `skills` stamp (spec C8 "Before the loop").
// jobSkills: [{canonical, requirement, alternative_group?}]; cvSkills: [string];
// templates: [{claims: [{id, text, skills: [string]}]}]
// → sorted, deduped [canonical]
export function computeSkillGap({ jobSkills, cvSkills, templates }) {
  const covered = new Set(cvSkills)
  for (const template of templates) {
    for (const claim of template.claims || []) {
      for (const skill of claim.skills || []) covered.add(skill)
    }
  }
  const evidence = expandSkillEvidence(covered)
  return requiredSkillRequirements(jobSkills)
    .filter((r) => !r.options.some((skill) => evidence.has(skill)))
    .map((r) => r.label)
    .sort()
}

// Pill confirm → first-class claim, exact pill_claim shape from the data schema.
// The canonical is used verbatim (no slug/case transform) so a canonicalMap
// rename fails the pinned-id fixture loudly instead of drifting silently.
export function mintPillClaim(canonical, dateISO) {
  return {
    id: `pill-${canonical}`,
    text: `Has skill: ${canonical} (self-confirmed ${dateISO})`,
    source: 'pill',
  }
}

// Evidence contributed by this session's pill decisions: exactly the confirmed
// pills. A rejected skill was never confirmed, so it leaves no trace here.
export function sessionEvidence({ confirmedPills }) {
  return [...confirmedPills]
}

// Assemble export sections in stored order (spec C8 early exit): approved
// sections carry their bullets; everything else carries over the verbatim
// full_text slice. `_header` is never generated against — always carryover —
// so an approval for it is ignored. Output satisfies buildDocx's XOR contract
// (exactly one of bullets/carryText per section).
export function assembleSections({ fullText, sections, approvedByName }) {
  return sections.map(({ name, start, end }) => {
    const bullets = name === '_header' ? undefined : approvedByName[name]
    if (bullets) return { name, bullets }
    return { name, carryText: fullText.slice(start, end) }
  })
}

// Export staleness gate: the split is fresh iff the stored hash still matches
// the CURRENT full_text (console edits after split → false → export blocked).
export async function assertFreshSplit({ fullText, sectionsMeta }) {
  return (await sha256Hex(fullText)) === sectionsMeta.full_text_hash
}

// After-score set: cv skills ∪ confirmed pill canonicals. Rejected skills are
// simply never passed in. Display-only — never sent to /api/tailor.
export function afterScoreSet({ cvSkills, confirmedPillCanonicals }) {
  return new Set([...cvSkills, ...confirmedPillCanonicals])
}
