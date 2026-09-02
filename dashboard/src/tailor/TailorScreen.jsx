import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../supabase'
import { matchJob } from '../match'
import { sanitizeResumeProfile } from '../skillImplications'
import SectionCard from './SectionCard'
import { fetchScreenshotDownloadUrl, triggerDownload } from '../downloadShot'
import {
  computeSkillGap,
  mintPillClaim,
  sessionEvidence,
  assembleSections,
  assertFreshSplit,
  afterScoreSet,
} from './session'

// Spec C8 — the tailored-résumé screen for one job. Left pane: the original JD
// screenshot (signed URL via /api/file, house lightbox pattern). Right pane:
// skill-gap pills → claim checklist → section-by-section generation loop →
// docx export with a staleness gate. All approval/pill state is client-only
// (lost on refresh, re-confirmable — spec scope). The match score is
// display-only and is NEVER sent to /api/tailor.
export default function TailorScreen({ job, onBack }) {
  const [loading, setLoading] = useState(true)
  const [cv, setCv] = useState(null) // most recent cv with full_text AND sections
  const [templates, setTemplates] = useState([])
  const [phase, setPhase] = useState('pills') // pills → checklist → loop
  const [pillDecisions, setPillDecisions] = useState({}) // canonical → 'confirmed'|'rejected'
  const [confirmedPills, setConfirmedPills] = useState([]) // minted pill_claims
  const [checkedClaimIds, setCheckedClaimIds] = useState(new Set())
  const [sectionState, setSectionState] = useState({}) // name → {status, bullets, verified, objection, error}
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState(null)
  const [exportBlocked, setExportBlocked] = useState(false)
  const [shotUrl, setShotUrl] = useState(null)
  const [shotError, setShotError] = useState(null)
  const [lightbox, setLightbox] = useState(false)
  const [savingShot, setSavingShot] = useState(false)

  const cvSkills = useMemo(
    () => (cv?.raw_profile?.skills || []).map((s) => s.canonical),
    [cv],
  )

  // Skill-gap pills: required JD skills covered by neither the cv nor any
  // template claim (pure computation — pinned by session.test.js).
  const pillGap = useMemo(
    () =>
      cv
        ? computeSkillGap({ jobSkills: job.skills, cvSkills, templates })
        : [],
    [cv, job.skills, cvSkills, templates],
  )
  const pendingPills = pillGap.filter((c) => !pillDecisions[c])
  const confirmedPillCanonicals = pillGap.filter((c) => pillDecisions[c] === 'confirmed')

  // v1 cv selection: most recent row with non-null full_text AND sections.
  useEffect(() => {
    let cancelled = false
    async function load() {
      const [cvRes, tplRes] = await Promise.all([
        supabase
          .from('cv')
          .select('id, name, raw_profile, full_text, sections')
          .order('created_at', { ascending: false }),
        supabase.from('project_template').select('id, name, claims'),
      ])
      if (cancelled) return
      const savedRow =
        (cvRes.data || []).find((c) => c.full_text != null && c.sections != null) || null
      const row = savedRow
        ? { ...savedRow, raw_profile: sanitizeResumeProfile(savedRow.raw_profile) }
        : null
      const tpls = tplRes.data || []
      setCv(row)
      setTemplates(tpls)
      // Checklist starts with every template claim pre-checked (uncheck freely).
      setCheckedClaimIds(new Set(tpls.flatMap((t) => (t.claims || []).map((c) => c.id))))
      setLoading(false)
    }
    load()
    return () => {
      cancelled = true
    }
  }, [])

  // No undecided pills left → advance past the pill step (covers the empty gap).
  useEffect(() => {
    if (!loading && cv && phase === 'pills' && pendingPills.length === 0) {
      setPhase('checklist')
    }
  }, [loading, cv, phase, pendingPills.length])

  // Left pane: signed screenshot URL on demand (browser has no bucket access).
  useEffect(() => {
    if (!job.screenshot_path) return
    let cancelled = false
    fetch(`/api/file?kind=screenshot&id=${encodeURIComponent(job.id)}`)
      .then(async (r) => {
        const data = await r.json().catch(() => null)
        if (!r.ok || !data?.url) throw new Error(data?.error || `HTTP ${r.status}`)
        if (!cancelled) setShotUrl(data.url)
      })
      .catch((e) => {
        if (!cancelled) setShotError(String(e.message || e))
      })
    return () => {
      cancelled = true
    }
  }, [job.id, job.screenshot_path])

  // Save a copy of the JD screenshot — a second, attachment-flavored signed URL
  // (downloadShot.js); reuses shotError for the failure line.
  async function saveShot() {
    setSavingShot(true)
    setShotError(null)
    try {
      triggerDownload(await fetchScreenshotDownloadUrl(job.id))
    } catch (e) {
      setShotError(String(e.message || e))
    } finally {
      setSavingShot(false)
    }
  }

  function confirmPill(canonical) {
    setPillDecisions((d) => ({ ...d, [canonical]: 'confirmed' }))
    setConfirmedPills((p) => [
      ...p,
      mintPillClaim(canonical, new Date().toISOString().slice(0, 10)),
    ])
  }
  // Reject → the skill is dropped entirely: no claim minted, out of the
  // after-score set, never re-prompted this session.
  function rejectPill(canonical) {
    setPillDecisions((d) => ({ ...d, [canonical]: 'rejected' }))
  }

  function toggleClaim(id) {
    setCheckedClaimIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const sectionsMeta = cv?.sections?.sections || []
  const loopSections = sectionsMeta.filter((s) => s.name !== '_header') // _header: always carryover
  const currentSection = loopSections.find((s) => {
    const st = sectionState[s.name]?.status
    return st !== 'approved' && st !== 'skipped'
  })

  // Evidence the review card can highlight: selected template claims ∪
  // confirmed pills ∪ the section's orig-claim (mirrors the server's set).
  const allTemplateClaims = useMemo(
    () => templates.flatMap((t) => t.claims || []),
    [templates],
  )
  function evidenceFor(section) {
    const selected = allTemplateClaims.filter((c) => checkedClaimIds.has(c.id))
    const orig = {
      id: `orig-${section.name}`,
      text: cv.full_text.slice(section.start, section.end),
    }
    return [...selected, ...sessionEvidence({ confirmedPills }), orig]
  }

  // generate / revise via POST /api/tailor. The body carries claim selections
  // and pill claims only — never scores (Goodhart guard, spec C8).
  async function runGenerate(sectionName, revision) {
    setSectionState((s) => ({
      ...s,
      [sectionName]: { ...s[sectionName], status: 'generating', error: null },
    }))
    try {
      const res = await fetch('/api/tailor', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: revision ? 'revise' : 'generate',
          jobId: job.id,
          cvId: cv.id,
          sectionName,
          claimIds: [...checkedClaimIds],
          pillClaims: sessionEvidence({ confirmedPills }),
          ...(revision ? { note: revision.note, priorBullets: revision.priorBullets } : {}),
        }),
      })
      const data = await res.json().catch(() => null)
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`)
      setSectionState((s) => ({
        ...s,
        [sectionName]: {
          status: 'review',
          bullets: data.bullets,
          verified: data.verified,
          objection: data.objection ?? null,
          error: null,
        },
      }))
    } catch (e) {
      setSectionState((s) => ({
        ...s,
        [sectionName]: { ...s[sectionName], status: 'error', error: String(e.message || e) },
      }))
    }
  }

  function approveSection(name, bullets) {
    setSectionState((s) => ({ ...s, [name]: { ...s[name], bullets, status: 'approved' } }))
  }
  function skipSection(name) {
    setSectionState((s) => ({ ...s, [name]: { ...s[name], status: 'skipped' } }))
  }

  const approvedByName = useMemo(() => {
    const out = {}
    for (const [name, st] of Object.entries(sectionState)) {
      if (st.status === 'approved') out[name] = st.bullets
    }
    return out
  }, [sectionState])

  // Early exit (spec C8): ONE fresh select, staleness assert, verbatim
  // carryover for everything unapproved, client-side docx build + download.
  async function handleExport() {
    setExporting(true)
    setExportError(null)
    setExportBlocked(false)
    try {
      const { data, error } = await supabase
        .from('cv')
        .select('full_text, sections')
        .eq('id', cv.id)
        .single()
      if (error || data?.full_text == null || data?.sections == null) {
        throw new Error(error?.message || 'could not load résumé text')
      }
      const fresh = await assertFreshSplit({
        fullText: data.full_text,
        sectionsMeta: data.sections,
      })
      if (!fresh) {
        setExportBlocked(true) // résumé text changed — re-run split
        return
      }
      const assembled = assembleSections({
        fullText: data.full_text,
        sections: data.sections.sections,
        approvedByName,
      })
      // candidateName = first non-empty line of the _header slice (the résumé's
      // own name block — NOT cv.name, which is filename-derived).
      const header = assembled.find((s) => s.name === '_header')
      const candidateName =
        (header?.carryText || '')
          .split('\n')
          .map((l) => l.trim())
          .find(Boolean) || ''
      const { buildDocx } = await import('./docx.js')
      const blob = await buildDocx({ candidateName, sections: assembled })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `resume-${job.id}.docx`
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
    } catch (e) {
      setExportError(String(e.message || e))
    } finally {
      setExporting(false)
    }
  }

  // Before/after score — display only.
  const beforeMatch = cv ? matchJob(job, new Set(cvSkills)) : null
  const afterMatch = cv
    ? matchJob(job, afterScoreSet({ cvSkills, confirmedPillCanonicals }))
    : null

  return (
    <div className="app tailor">
      <div className="tailor-top">
        <button className="tailor-back" onClick={onBack}>
          ← Back to jobs
        </button>
        <h1 className="tailor-h1">
          Tailored résumé — {job.company || '—'}
          <span className="tailor-h1-title"> {job.title || ''}</span>
        </h1>
      </div>

      {loading ? (
        <p className="loading">Loading…</p>
      ) : !cv ? (
        <div className="tailor-setup">
          <h2>Almost there — your résumé text isn’t ready yet</h2>
          <p>
            Tailoring needs a résumé that has been <strong>transcribed</strong> and{' '}
            <strong>split</strong> into sections:
          </p>
          <ol>
            <li>
              Run <code>POST /api/tailor</code> with{' '}
              <code>{'{action: "transcribe", cvId}'}</code> to turn your uploaded CV PDF into
              canonical text (correct it in the Supabase console if needed).
            </li>
            <li>
              Then run <code>{'{action: "split", cvId}'}</code> to divide that text into
              sections.
            </li>
          </ol>
          <p>Once a résumé has both, this screen picks it up automatically.</p>
        </div>
      ) : (
        <div className="tailor-panes">
          {/* Left pane — the JD screenshot this résumé is being tailored to. */}
          <div className="tailor-left">
            {job.screenshot_path ? (
              shotUrl ? (
                <img
                  className="tailor-shot"
                  src={shotUrl}
                  alt="Original JD screenshot"
                  onClick={() => setLightbox(true)}
                  title="Click to enlarge"
                />
              ) : (
                <div className="tailor-placeholder">
                  {shotError ? `⚠ ${shotError}` : 'Loading screenshot…'}
                </div>
              )
            ) : (
              <div className="tailor-placeholder">No screenshot stored for this job.</div>
            )}
            {lightbox && shotUrl && (
              <div className="lightbox" onClick={() => setLightbox(false)} title="Click to close">
                <img src={shotUrl} alt="Original JD screenshot" />
                <button
                  className="lightbox-save"
                  onClick={(e) => {
                    e.stopPropagation() // the overlay closes on click; the button must not
                    saveShot()
                  }}
                  disabled={savingShot}
                >
                  {savingShot ? 'Preparing…' : '⤓ Download'}
                </button>
              </div>
            )}
          </div>

          {/* Right pane — pills → checklist → section loop, export always visible. */}
          <div className="tailor-flow">
            <div className="tailor-export">
              <span className="tailor-scores">
                <span className="tailor-score">
                  before <strong>{Math.round(beforeMatch.score * 100)}%</strong>
                </span>
                <span className="tailor-score after">
                  after <strong>{Math.round(afterMatch.score * 100)}%</strong>
                </span>
              </span>
              <button className="tailor-download" onClick={handleExport} disabled={exporting}>
                {exporting ? 'Building…' : 'Ready — download my résumé'}
              </button>
            </div>
            {exportBlocked && (
              <p className="tailor-export-err" role="alert">
                Export blocked: résumé text changed — re-run split.
              </p>
            )}
            {exportError && (
              <p className="tailor-export-err" role="alert">
                ⚠ {exportError}
              </p>
            )}

            {phase === 'pills' && pendingPills.length > 0 && (
              <div className="tailor-step">
                <h2>Do you have these skills?</h2>
                <p className="hint">
                  This job requires skills not on your résumé or in your project claims.
                  Confirm only what’s true — confirmed skills become citable claims;
                  rejected ones are dropped for this session.
                </p>
                <ul className="pill-list">
                  {pendingPills.map((canonical) => (
                    <li key={canonical} className="pill-row">
                      <span className="pill-skill">{canonical}</span>
                      <button className="pill-confirm" onClick={() => confirmPill(canonical)}>
                        Confirm
                      </button>
                      <button className="pill-reject" onClick={() => rejectPill(canonical)}>
                        Reject
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {phase === 'checklist' && (
              <div className="tailor-step">
                <h2>Which project claims may the résumé use?</h2>
                <p className="hint">
                  Everything starts checked. Uncheck anything you don’t want cited.
                </p>
                {templates.length === 0 && (
                  <p className="tailor-none">
                    No project templates yet — generation will use only each section’s
                    original text{confirmedPills.length > 0 ? ' and your confirmed skills' : ''}.
                  </p>
                )}
                {templates.map((t) => (
                  <div key={t.id} className="claim-group">
                    <h3 className="claim-group-name">{t.name}</h3>
                    <ul className="claim-list">
                      {(t.claims || []).map((c) => (
                        <li key={c.id}>
                          <label className="claim-check">
                            <input
                              type="checkbox"
                              checked={checkedClaimIds.has(c.id)}
                              onChange={() => toggleClaim(c.id)}
                            />
                            <span className="claim-chip">{c.id}</span>
                            <span className="claim-text">{c.text}</span>
                          </label>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
                <button className="tailor-continue" onClick={() => setPhase('loop')}>
                  Continue to sections
                </button>
              </div>
            )}

            {phase === 'loop' && (
              <div className="tailor-step">
                <h2>Sections</h2>
                <p className="hint">
                  In résumé order. Approve to include generated bullets; skip to keep the
                  original text verbatim. The header always carries over.
                </p>
                {loopSections.map((s) => (
                  <SectionCard
                    key={s.name}
                    name={s.name}
                    state={sectionState[s.name]}
                    evidence={evidenceFor(s)}
                    isCurrent={currentSection?.name === s.name}
                    onGenerate={() => runGenerate(s.name)}
                    onRevise={(note, priorBullets) =>
                      runGenerate(s.name, { note, priorBullets })
                    }
                    onApprove={(bullets) => approveSection(s.name, bullets)}
                    onSkip={() => skipSection(s.name)}
                  />
                ))}
                {loopSections.length === 0 && (
                  <p className="tailor-none">
                    The split produced no generatable sections — everything carries over.
                  </p>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
