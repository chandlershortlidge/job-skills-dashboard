// Résumé-vs-job skill matching. Pure — no React, no I/O — so it's unit-testable.
// Used by App.jsx for both the post-upload comparison card and the per-row compare.
import { requiredSkillRequirements } from './skillRequirements'
import { expandSkillEvidence } from './skillImplications'

// Compare one job's REQUIRED skills against a résumé's canonical skill set.
// Returns the skills the résumé has (matched), lacks (missing), and the share covered.
export function matchJob(job, resumeSet) {
  const requirements = requiredSkillRequirements(job.skills)
  const evidence = expandSkillEvidence(resumeSet)
  const matched = requirements.filter((r) => r.options.some((c) => evidence.has(c))).map((r) => r.label)
  const missing = requirements.filter((r) => !r.options.some((c) => evidence.has(c))).map((r) => r.label)
  return { matched, missing, score: requirements.length ? matched.length / requirements.length : 0 }
}
