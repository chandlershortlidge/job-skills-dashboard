import { useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import { supabase } from './supabase'
import { matchJob } from './match'
import { sanitizeResumeProfile } from './skillImplications'
import { skillRequirements } from './skillRequirements'
import { filterJobsByCompany } from './searchJobs'
import { findSimilarJob } from './similar'
import { fetchScreenshotDownloadUrl, triggerDownload } from './downloadShot'
import TailorScreen from './tailor/TailorScreen'
import ApplicationsPage from './ApplicationsPage'
import { paginateSkillChart, SKILL_CHART_PAGE_SIZE } from './skillChartPagination'

// Selecting a level re-scopes the chart to that level's jobs and recolors the bars.
// "All" (no level) keeps the default global indigo.
const GLOBAL_COLOR = '#4f46e5'
const SENIORITY_LEVELS = [
  { level: 'Junior', color: '#16a34a' },
  { level: 'Mid', color: '#d97706' },
  { level: 'Senior', color: '#dc2626' },
]

// A job is "New" if it was added in the last 7 days. Drives the New badge and the
// default (new-only) Jobs view. Jobs from jobs.json have no created_at -> never New.
const NEW_WINDOW_MS = 7 * 24 * 60 * 60 * 1000
const JOBS_PAGE = 20
function isNewJob(job) {
  if (!job.created_at) return false
  return Date.now() - new Date(job.created_at).getTime() < NEW_WINDOW_MS
}

// Read a File into a base64 string (no data: prefix) for POSTing to /api/extract.
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).split(',')[1])
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

export default function App() {
  const [data, setData] = useState(null)
  const [selectedSkill, setSelectedSkill] = useState(null)
  const [selectedSeniority, setSelectedSeniority] = useState(null)
  const [companyQuery, setCompanyQuery] = useState('')
  const [jobsExpanded, setJobsExpanded] = useState(false)
  const [visibleOlder, setVisibleOlder] = useState(JOBS_PAGE)
  const [showAll, setShowAll] = useState(false)
  const [skillChartCap, setSkillChartCap] = useState(SKILL_CHART_PAGE_SIZE)
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState(null)
  const [lastUploadedJob, setLastUploadedJob] = useState(null)
  const [dupNotice, setDupNotice] = useState(null) // { id, label } when an upload is a dup
  const [similarNotice, setSimilarNotice] = useState(null) // { id, label } same-company soft warning
  const [highlight, setHighlight] = useState({ id: null, n: 0 }) // scroll+expand target
  const [deleteError, setDeleteError] = useState(null)
  const [resumeProfile, setResumeProfile] = useState(null)
  const [resumeBusy, setResumeBusy] = useState(false)
  const [resumeError, setResumeError] = useState(null)
  const [savedCvs, setSavedCvs] = useState([])
  const [selectedCvId, setSelectedCvId] = useState(null)
  const [editingCvId, setEditingCvId] = useState(null)
  const [editingName, setEditingName] = useState('')
  const [tailorJob, setTailorJob] = useState(null) // job being tailored → full-screen TailorScreen
  const [view, setView] = useState('jobs') // 'jobs' | 'applications' — additive nav toggle (spec §9)

  useEffect(() => {
    async function load() {
      try {
        // Jobs (+ their skills) come from Supabase now. The "merged from" reveal map
        // (skill_variants) stays in the static jobs.json corpus snapshot.
        const [{ data: rows, error }, variants] = await Promise.all([
          supabase.from('job').select('*, skill(*)').order('created_at', { ascending: false }),
          fetch('/jobs.json').then((r) => r.json()),
        ])
        if (error) throw error
        const jobs = rows.map((j) => ({
          id: j.id,
          company: j.company,
          title: j.title,
          seniority: j.seniority,
          seniority_signal: j.seniority_signal,
          seniority_basis: j.seniority_basis,
          summary: j.summary,
          source: j.source,
          created_at: j.created_at,
          screenshot_path: j.screenshot_path,
          non_skill_mentions: j.non_skill_mentions || [],
          skills: (j.skill || []).map((s) => ({
            canonical: s.canonical,
            raw_text: s.raw_text,
            requirement: s.requirement,
            alternative_group: s.alternative_group,
          })),
        }))
        setData({ jobs, skill_variants: variants.skill_variants || {} })
      } catch (e) {
        // Fallback: if Supabase is unreachable, render the static corpus snapshot.
        console.error('Supabase load failed, falling back to jobs.json', e)
        setData(await fetch('/jobs.json').then((r) => r.json()))
      }
    }
    load()
  }, [])

  // Load previously-saved résumés so they can be re-selected without re-uploading.
  useEffect(() => {
    supabase
      .from('cv')
      .select('id, name, raw_profile')
      .order('created_at', { ascending: false })
      .then(({ data, error }) => {
        if (error || !data?.length) return
        const cvs = data.map((c) => ({
          id: c.id,
          name: c.name,
          profile: sanitizeResumeProfile(c.raw_profile),
        }))
        setSavedCvs(cvs)
        setSelectedCvId(cvs[0].id)
        setResumeProfile(cvs[0].profile) // restore the most recent match on load
      })
  }, [])

  // Switch to a saved résumé — re-runs the client-side match against its skills.
  function selectCv(cv) {
    setSelectedCvId(cv.id)
    setResumeProfile(cv.profile)
  }

  function startRename(cv) {
    setEditingCvId(cv.id)
    setEditingName(cv.name)
  }

  // Persist a rename via the server (browser has read-only RLS on cv). Optimistic:
  // update the chip immediately, roll back if the request fails.
  async function commitRename() {
    const id = editingCvId
    const name = editingName.trim()
    setEditingCvId(null)
    const current = savedCvs.find((c) => c.id === id)
    if (!id || !name || !current || name === current.name) return
    const prev = savedCvs
    setSavedCvs((cvs) => cvs.map((c) => (c.id === id ? { ...c, name } : c)))
    try {
      const res = await fetch('/api/cv', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id, name }),
      })
      if (!res.ok) throw new Error((await res.json()).error || 'rename failed')
    } catch (e) {
      setSavedCvs(prev) // roll back
      setResumeError(String(e.message || e))
    }
  }

  // Delete a saved résumé server-side. Optimistic; if it was the active one, fall
  // back to the next saved résumé (or clear the match if none remain).
  async function deleteCv(id) {
    const prev = savedCvs
    const remaining = prev.filter((c) => c.id !== id)
    setSavedCvs(remaining)
    if (selectedCvId === id) {
      setSelectedCvId(remaining[0]?.id ?? null)
      setResumeProfile(remaining[0]?.profile ?? null)
    }
    try {
      const res = await fetch(`/api/cv?id=${encodeURIComponent(id)}`, { method: 'DELETE' })
      if (!res.ok) throw new Error((await res.json()).error || 'delete failed')
    } catch (e) {
      setSavedCvs(prev) // roll back
      setResumeError(String(e.message || e))
    }
  }

  // Live drop-in: parse an uploaded screenshot in a Daytona sandbox, prepend the job.
  // Reveal an existing job in the list: expand the panel, render enough rows to include
  // it, and pulse it. The bumped nonce re-triggers even if it's the same job as last time.
  function revealJob(id) {
    setJobsExpanded(true)
    setVisibleOlder(Number.MAX_SAFE_INTEGER)
    setHighlight((h) => ({ id, n: h.n + 1 }))
  }

  // Permanently delete a job (and its skills) server-side. Optimistic: drop it from the
  // list immediately, roll back if the request fails. Also clears any dangling reference.
  async function deleteJob(id) {
    const prev = data
    setDeleteError(null)
    setData((d) => ({ ...d, jobs: d.jobs.filter((j) => j.id !== id) }))
    setLastUploadedJob((j) => (j && j.id === id ? null : j))
    setDupNotice((n) => (n && n.id === id ? null : n))
    setSimilarNotice((n) => (n && n.id === id ? null : n))
    try {
      const res = await fetch(`/api/job?id=${encodeURIComponent(id)}`, { method: 'DELETE' })
      if (!res.ok) throw new Error((await res.json()).error || 'delete failed')
    } catch (e) {
      setData(prev) // roll back — the row reappears
      setDeleteError(`Couldn't delete that job — ${String(e.message || e)}`)
    }
  }

  async function handleUpload(e) {
    const file = e.target.files?.[0]
    if (!file) return
    setUploadError(null)
    setDupNotice(null)
    setSimilarNotice(null)
    setUploading(true)
    try {
      const image = await fileToBase64(file)
      const res = await fetch('/api/extract', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ image, media_type: file.type || 'image/png' }),
      })
      const payload = await res.json()
      if (res.status === 409 && payload.duplicate) {
        const d = payload.duplicate
        const label = [d.company, d.title].filter(Boolean).join(' · ') || 'a job already in your list'
        setLastUploadedJob(null) // clear any stale "résumé vs …" card so the banner stands alone
        setDupNotice({ id: d.id, label }) // banner only — reveal happens on explicit link click
        return
      }
      if (!res.ok || !payload.job) throw new Error(payload.error || 'extraction failed')
      // Soft dedup: the hash check upstream only blocks byte-identical files. If an
      // existing job shares this company, warn (non-blocking) — the job is still added.
      const similar = findSimilarJob(data?.jobs || [], payload.job)
      if (similar) {
        const label =
          [similar.company, similar.title].filter(Boolean).join(' · ') ||
          'a job already in your list'
        setSimilarNotice({ id: similar.id, label })
      }
      setData((prev) => ({ ...prev, jobs: [payload.job, ...prev.jobs] }))
      setLastUploadedJob(payload.job) // surface an immediate résumé-vs-this-job comparison

    } catch (err) {
      setUploadError(String(err.message || err))
    } finally {
      setUploading(false)
      e.target.value = '' // allow re-uploading the same file
    }
  }

  // Résumé match: parse an uploaded PDF in a Daytona sandbox, get back a normalized profile.
  async function handleResume(e) {
    const file = e.target.files?.[0]
    if (!file) return
    setResumeError(null)
    setResumeBusy(true)
    try {
      const pdf = await fileToBase64(file)
      const res = await fetch('/api/resume', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pdf, media_type: file.type || 'application/pdf', filename: file.name }),
      })
      const payload = await res.json()
      if (!res.ok || !payload.profile) throw new Error(payload.error || 'parse failed')
      setResumeProfile(payload.profile)
      if (payload.cv) {
        const entry = { id: payload.cv.id, name: payload.cv.name, profile: payload.profile }
        setSavedCvs((prev) => [entry, ...prev.filter((c) => c.id !== entry.id)])
        setSelectedCvId(payload.cv.id)
      }
    } catch (err) {
      setResumeError(String(err.message || err))
    } finally {
      setResumeBusy(false)
      e.target.value = ''
    }
  }

  const derived = useMemo(() => {
    if (!data) return null
    const jobs = data.jobs
    const variants = data.skill_variants || {}

    const skillSet = new Set()
    const companySet = new Set()
    for (const j of jobs) {
      if (j.company) companySet.add(j.company.trim().toLowerCase())
      for (const s of j.skills) skillSet.add(s.canonical)
    }

    // jobs per level, for the view-selector buttons (seniority read from data, not recomputed)
    const senCounts = { Junior: 0, Mid: 0, Senior: 0 }
    for (const j of jobs) {
      if (Object.hasOwn(senCounts, j.seniority)) senCounts[j.seniority] += 1
    }

    // document frequency: distinct jobs per canonical skill, scoped to the selected seniority view
    const counts = {}
    for (const j of jobs) {
      if (selectedSeniority && j.seniority !== selectedSeniority) continue
      const seen = new Set()
      for (const s of j.skills) {
        if (!showAll && s.requirement !== 'required') continue
        if (seen.has(s.canonical)) continue
        seen.add(s.canonical)
        ;(counts[s.canonical] ??= new Set()).add(j.id)
      }
    }
    let chart = Object.entries(counts).map(([skill, set]) => ({ skill, count: set.size }))
    if (!showAll) chart = chart.filter((d) => d.count >= 2)
    chart.sort((a, b) => b.count - a.count || a.skill.localeCompare(b.skill))
    const max = chart.length ? chart[0].count : 1

    return {
      jobs,
      variants,
      senCounts,
      stats: { jobs: jobs.length, skills: skillSet.size, companies: companySet.size },
      chart,
      max,
    }
  }, [data, showAll, selectedSeniority])

  // Match the résumé profile against every job: % of each job's REQUIRED skills the
  // candidate has. Extra skills (not required anywhere) never affect the score; they're
  // surfaced separately so the match reflects the candidate's whole profile honestly.
  const resumeMatch = useMemo(() => {
    if (!resumeProfile || !data) return null
    const resumeSet = new Set(resumeProfile.skills.map((s) => s.canonical))
    const allJobCanon = new Set()
    for (const j of data.jobs) for (const s of j.skills) allJobCanon.add(s.canonical)

    const ranked = data.jobs
      .map((j) => ({ job: j, ...matchJob(j, resumeSet) }))
      .filter((m) => m.matched.length + m.missing.length > 0)
      .sort((a, b) => b.score - a.score || b.matched.length - a.matched.length)

    const extra = resumeProfile.skills
      .map((s) => s.canonical)
      .filter((c) => !allJobCanon.has(c))
    return { ranked, extra }
  }, [resumeProfile, data])

  // The selected résumé's canonical skills, shared by the upload card and per-row compare.
  const resumeSet = resumeProfile
    ? new Set(resumeProfile.skills.map((s) => s.canonical))
    : null
  // Immediate résumé-vs-job comparison for a freshly dropped-in JD.
  const jdCompare = lastUploadedJob && resumeSet ? matchJob(lastUploadedJob, resumeSet) : null

  if (!derived) {
    return (
      <div className="app">
        <p className="loading">Loading…</p>
      </div>
    )
  }

  // Full-screen tailoring flow for one job (spec C8) — back returns to the list.
  if (tailorJob) {
    return <TailorScreen job={tailorJob} onBack={() => setTailorJob(null)} />
  }

  // Applications view (email-parser output) — additive, routerless toggle (spec §9).
  if (view === 'applications') {
    return <ApplicationsPage onBack={() => setView('jobs')} />
  }

  const { jobs, variants, senCounts, stats, chart, max } = derived
  const visibleChart = paginateSkillChart(chart, selectedSeniority, skillChartCap)
  const activeColor = selectedSeniority
    ? SENIORITY_LEVELS.find((s) => s.level === selectedSeniority).color
    : GLOBAL_COLOR
  // The job list composes all three filters: company search, the clicked skill, AND the
  // selected seniority. Search scopes the list only — chart and stats stay global.
  const searching = companyQuery.trim() !== ''
  const shownJobs = filterJobsByCompany(jobs, companyQuery).filter(
    (j) =>
      (!selectedSkill || j.skills.some((s) => s.canonical === selectedSkill)) &&
      (!selectedSeniority || j.seniority === selectedSeniority),
  )
  // The list shows New jobs (last 7 days) by default; expanding reveals the rest,
  // paginated JOBS_PAGE at a time. An active search overrides the collapse — matches
  // would otherwise hide behind the new-only default view.
  const newJobs = shownJobs.filter(isNewJob)
  const olderJobs = shownJobs.filter((j) => !isNewJob(j))
  const listExpanded = jobsExpanded || searching
  const olderVisible = searching ? olderJobs : olderJobs.slice(0, visibleOlder)

  return (
    <div className="app">
      <nav className="view-nav">
        <button type="button" className="active" aria-current="page">
          Jobs
        </button>
        <button type="button" onClick={() => setView('applications')}>
          Applications
        </button>
      </nav>
      <header>
        <h1>AI Job Skills Dashboard: See What AI Employers Want</h1>
        <p className="sub">
          What is the AI job market prioritizing? Click any skill to see the roles that want it.
        </p>
      </header>

      <section className="stats">
        <div>
          <strong>{stats.jobs}</strong>
          <span>jobs</span>
        </div>
        <div>
          <strong>{stats.skills}</strong>
          <span>skills</span>
        </div>
        <div>
          <strong>{stats.companies}</strong>
          <span>companies</span>
        </div>
      </section>

      <section className="upload">
        <label className={'upload-btn' + (uploading ? ' busy' : '')}>
          {uploading ? 'Parsing in a Daytona sandbox…' : '+ add a screenshot'}
          <input type="file" accept="image/*" onChange={handleUpload} disabled={uploading} hidden />
        </label>
        <span className="upload-hint">parsed live in a Daytona sandbox</span>
        {uploadError && <span className="upload-err">⚠ {uploadError}</span>}
      </section>

      {dupNotice && (
        <div className="dup-banner" role="alert">
          <span className="dup-banner-msg">
            <span className="dup-banner-icon" aria-hidden="true">
              ⚠
            </span>{' '}
            Already added —{' '}
            <button className="dup-banner-link" onClick={() => revealJob(dupNotice.id)}>
              {dupNotice.label}
            </button>
          </span>
          <button
            className="dup-banner-x"
            title="Dismiss"
            aria-label="Dismiss"
            onClick={() => setDupNotice(null)}
          >
            ×
          </button>
        </div>
      )}

      {similarNotice && (
        <div className="dup-banner soft" role="status">
          <span className="dup-banner-msg">
            <span className="dup-banner-icon" aria-hidden="true">
              ⚠
            </span>{' '}
            Added — but this may duplicate{' '}
            <button className="dup-banner-link" onClick={() => revealJob(similarNotice.id)}>
              {similarNotice.label}
            </button>{' '}
            (click to compare)
          </span>
          <button
            className="dup-banner-x"
            title="Dismiss"
            aria-label="Dismiss"
            onClick={() => setSimilarNotice(null)}
          >
            ×
          </button>
        </div>
      )}

      {lastUploadedJob && (
        <section className="jd-compare">
          <div className="jd-compare-head">
            <span className="jd-compare-label">Your résumé vs</span>
            <strong className="jd-compare-co">{lastUploadedJob.company || '—'}</strong>
            <span className="jd-compare-title">{lastUploadedJob.title || ''}</span>
            {jdCompare && (
              <span className="jd-compare-score">{Math.round(jdCompare.score * 100)}%</span>
            )}
            <button
              className="jd-compare-x"
              title="Dismiss"
              onClick={() => setLastUploadedJob(null)}
            >
              ×
            </button>
          </div>
          {jdCompare ? (
            <MatchChips match={jdCompare} />
          ) : (
            <p className="jd-compare-none">
              Job added. Upload a résumé below to see how your skills compare.
            </p>
          )}
        </section>
      )}

      <section className="chart">
        <div className="sen-view">
          <span className="sen-view-label">Compare by level:</span>
          <button
            className={'sen-chip' + (selectedSeniority === null ? ' active' : '')}
            style={{ '--chip-color': GLOBAL_COLOR }}
            aria-pressed={selectedSeniority === null}
            onClick={() => {
              setSelectedSeniority(null)
              setSkillChartCap(SKILL_CHART_PAGE_SIZE)
            }}
          >
            All <span className="sen-chip-n">{stats.jobs}</span>
          </button>
          {SENIORITY_LEVELS.map(({ level, color }) => (
            <button
              key={level}
              className={'sen-chip' + (selectedSeniority === level ? ' active' : '')}
              style={{ '--chip-color': color }}
              aria-pressed={selectedSeniority === level}
              onClick={() => {
                setSelectedSeniority(level)
                setSkillChartCap(SKILL_CHART_PAGE_SIZE)
              }}
            >
              {level} <span className="sen-chip-n">{senCounts[level]}</span>
            </button>
          ))}
        </div>
        <div className="chart-head">
          <h2>
            Most-wanted skills
            {selectedSeniority && (
              <span className="chart-scope" style={{ color: activeColor }}>
                {' · '}
                {selectedSeniority}
              </span>
            )}
          </h2>
          <label className="toggle">
            <input
              type="checkbox"
              checked={showAll}
              onChange={(e) => {
                setShowAll(e.target.checked)
                setSkillChartCap(SKILL_CHART_PAGE_SIZE)
              }}
            />
            include all skills
          </label>
        </div>
        <p className="hint">
          {showAll ? 'All skills (required + nice-to-have)' : 'Required skills wanted by 2+ jobs'}
          {selectedSeniority ? ` at ${selectedSeniority} level` : ''}. Hover a bar to see what
          merged into it; click to filter the jobs below.
        </p>
        {chart.length === 0 ? (
          <p className="empty">
            No required skills appear in 2+ {selectedSeniority} jobs — try “include all skills”.
          </p>
        ) : (
          <ul className="bars" style={{ '--bar-color': activeColor }}>
            {visibleChart.chart.map((d) => (
              <li
                key={d.skill}
                className={'bar-row' + (selectedSkill === d.skill ? ' selected' : '')}
                onClick={() => setSelectedSkill(selectedSkill === d.skill ? null : d.skill)}
              >
                <span className="bar-label">{d.skill}</span>
                <span className="bar-track">
                  <span className="bar-fill" style={{ width: `${(d.count / max) * 100}%` }} />
                </span>
                <span className="bar-count">{d.count}</span>
                {variants[d.skill] && (
                  <span className="tooltip">
                    <strong>{d.skill}</strong> merged from: {variants[d.skill].join(', ')}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
        {selectedSeniority === null && visibleChart.hasMore && (
          <button
            type="button"
            className="chart-more"
            onClick={() => setSkillChartCap(visibleChart.nextCap)}
          >
            See more ({visibleChart.chart.length} of {chart.length})
          </button>
        )}
      </section>

      {deleteError && <p className="delete-error">⚠ {deleteError}</p>}
      <section className="jobs">
        <div className="jobs-head">
          <h2 className="jobs-h2">
            <button
              className="jobs-toggle"
              onClick={() => setJobsExpanded((o) => !o)}
              aria-expanded={jobsExpanded}
              disabled={olderJobs.length === 0}
            >
              <svg
                className={'chevron' + (jobsExpanded ? ' open' : '')}
                width="15"
                height="15"
                viewBox="0 0 16 16"
                aria-hidden="true"
              >
                <path
                  d="M6 4l4 4-4 4"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              <span className="jobs-title-text">
                Jobs{selectedSkill ? <> wanting <em>{selectedSkill}</em></> : ''}
              </span>
              {newJobs.length > 0 && <span className="new-count">{newJobs.length} new</span>}
              <span className="count">{shownJobs.length}</span>
            </button>
          </h2>
          <span className="job-search-wrap">
            <input
              className="job-search"
              type="search"
              placeholder="Search company…"
              aria-label="Search jobs by company"
              value={companyQuery}
              onChange={(e) => setCompanyQuery(e.target.value)}
            />
            {searching && (
              <button
                className="job-search-x"
                title="Clear search"
                aria-label="Clear search"
                onClick={() => setCompanyQuery('')}
              >
                ×
              </button>
            )}
          </span>
          {selectedSkill && (
            <button className="clear" onClick={() => setSelectedSkill(null)}>
              clear ✕
            </button>
          )}
        </div>

        {searching && shownJobs.length === 0 && (
          <p className="jobs-empty-new">No jobs match “{companyQuery.trim()}”.</p>
        )}

        {/* New jobs (last 7 days) — always visible */}
        {newJobs.length > 0 ? (
          <ul className="job-list">
            {newJobs.map((j) => (
              <JobRow
                key={j.id}
                job={j}
                resumeSet={resumeSet}
                highlight={highlight}
                onDelete={deleteJob}
                onTailor={setTailorJob}
              />
            ))}
          </ul>
        ) : (
          !listExpanded &&
          olderJobs.length > 0 && (
            <p className="jobs-empty-new">No new jobs in the last 7 days.</p>
          )
        )}

        {/* Older jobs — smooth reveal, paginated */}
        {olderJobs.length > 0 && (
          <div className={'jobs-collapse' + (listExpanded ? ' open' : '')}>
            <div className="jobs-collapse-inner">
              <ul className="job-list">
                {olderVisible.map((j) => (
                  <JobRow
                key={j.id}
                job={j}
                resumeSet={resumeSet}
                highlight={highlight}
                onDelete={deleteJob}
                onTailor={setTailorJob}
              />
                ))}
              </ul>
            </div>
          </div>
        )}

        {/* Controls — hidden while searching (search already reveals every match) */}
        {olderJobs.length > 0 && !searching && (
          <div className="jobs-more">
            {!jobsExpanded ? (
              <button className="jobs-more-btn" onClick={() => setJobsExpanded(true)}>
                Show all {shownJobs.length} jobs
              </button>
            ) : (
              <>
                {olderVisible.length < olderJobs.length && (
                  <button
                    className="jobs-more-btn"
                    onClick={() => setVisibleOlder((n) => n + JOBS_PAGE)}
                  >
                    See more ({newJobs.length + olderVisible.length} of {shownJobs.length})
                  </button>
                )}
                <button
                  className="jobs-less-btn"
                  onClick={() => {
                    setJobsExpanded(false)
                    setVisibleOlder(JOBS_PAGE)
                  }}
                >
                  Show less
                </button>
              </>
            )}
          </div>
        )}
      </section>

      <section className="resume">
        <h2>Match your résumé</h2>
        <p className="hint">
          Upload your résumé (PDF) — it's parsed live in a Daytona sandbox, normalized to the
          same canonical skills, and matched against every job by the share of required skills
          you already have.
        </p>
        <div className="upload">
          <label className={'upload-btn' + (resumeBusy ? ' busy' : '')}>
            {resumeBusy ? 'Parsing in a Daytona sandbox…' : '+ upload résumé (PDF)'}
            <input
              type="file"
              accept="application/pdf"
              onChange={handleResume}
              disabled={resumeBusy}
              hidden
            />
          </label>
          {resumeProfile?.title && (
            <span className="upload-hint">read as: {resumeProfile.title}</span>
          )}
          {resumeError && <span className="upload-err">⚠ {resumeError}</span>}
        </div>

        {savedCvs.length > 0 && (
          <div className="cv-toggle">
            <span className="cv-toggle-label">Saved résumés:</span>
            {savedCvs.map((cv) =>
              editingCvId === cv.id ? (
                <input
                  key={cv.id}
                  className="cv-edit-input"
                  value={editingName}
                  autoFocus
                  onChange={(e) => setEditingName(e.target.value)}
                  onBlur={commitRename}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitRename()
                    if (e.key === 'Escape') setEditingCvId(null)
                  }}
                />
              ) : (
                <span
                  key={cv.id}
                  className={'cv-chip' + (selectedCvId === cv.id ? ' active' : '')}
                >
                  <button className="cv-chip-name" onClick={() => selectCv(cv)}>
                    {cv.name}
                  </button>
                  <button
                    className="cv-chip-btn"
                    title="Rename"
                    onClick={() => startRename(cv)}
                  >
                    ✎
                  </button>
                  <button
                    className="cv-chip-btn"
                    title="Delete"
                    onClick={() => deleteCv(cv.id)}
                  >
                    ×
                  </button>
                </span>
              ),
            )}
          </div>
        )}

        {resumeMatch && (
          <>
            <ul className="match-list">
              {resumeMatch.ranked.slice(0, 6).map(({ job, matched, missing, score }) => (
                <li key={job.id} className="match">
                  <div className="match-head">
                    <span className="match-co">{job.company || '—'}</span>
                    <span className="match-title">{job.title || '—'}</span>
                    <span className="match-score">{Math.round(score * 100)}%</span>
                  </div>
                  <div className="chips">
                    {matched.map((c) => (
                      <span key={c} className="chip have">
                        {c}
                      </span>
                    ))}
                    {missing.map((c) => (
                      <span key={c} className="chip miss">
                        {c}
                      </span>
                    ))}
                  </div>
                </li>
              ))}
            </ul>
            {resumeMatch.extra.length > 0 && (
              <p className="extra">
                <strong>You also have:</strong> {resumeMatch.extra.join(', ')}
                <span className="extra-note"> — not asked for in these roles.</span>
              </p>
            )}
          </>
        )}
      </section>

      <footer>AI extraction + deterministic normalization · built at the hackathon</footer>
    </div>
  )
}

// Shared "have (green) / missing (dashed)" chips for a matchJob() result. Used by both
// the post-upload comparison card and the per-row compare, so the visual can't drift.
function MatchChips({ match }) {
  if (match.matched.length + match.missing.length === 0) {
    return <p className="match-none">No required skills listed for this job.</p>
  }
  return (
    <div className="chips">
      {match.matched.map((c) => (
        <span key={c} className="chip have">
          {c}
        </span>
      ))}
      {match.missing.map((c) => (
        <span key={c} className="chip miss">
          {c}
        </span>
      ))}
    </div>
  )
}

// "View screenshot" + lightbox for jobs with a stored source screenshot.
// Fetches a short-lived signed URL from /api/file on demand (the browser has no
// direct read access to the private bucket) and shows the image in an overlay.
// The lightbox's Download button asks for a second, attachment-flavored URL —
// see downloadShot.js for why it can't reuse the view URL.
function ViewScreenshot({ jobId }) {
  const [url, setUrl] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [saving, setSaving] = useState(false)

  async function openShot() {
    setBusy(true)
    setError(null)
    try {
      const r = await fetch(`/api/file?kind=screenshot&id=${encodeURIComponent(jobId)}`)
      const data = await r.json().catch(() => null)
      if (!r.ok || !data?.url) throw new Error(data?.error || `HTTP ${r.status}`)
      setUrl(data.url)
    } catch (e) {
      setError(String(e.message || e))
    } finally {
      setBusy(false)
    }
  }

  async function saveShot() {
    setSaving(true)
    setError(null)
    try {
      triggerDownload(await fetchScreenshotDownloadUrl(jobId))
    } catch (e) {
      setError(String(e.message || e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <button className="job-shot" onClick={openShot} disabled={busy}>
        {busy ? 'Loading…' : 'View screenshot'}
      </button>
      {error && <span className="job-shot-err">{error}</span>}
      {url && (
        <div className="lightbox" onClick={() => setUrl(null)} title="Click to close">
          <img src={url} alt="Original JD screenshot" />
          <button
            className="lightbox-save"
            onClick={(e) => {
              e.stopPropagation() // the overlay closes on click; the button must not
              saveShot()
            }}
            disabled={saving}
          >
            {saving ? 'Preparing…' : '⤓ Download'}
          </button>
        </div>
      )}
    </>
  )
}

function JobRow({ job, resumeSet, highlight, onDelete, onTailor }) {
  const [open, setOpen] = useState(false)
  const [flash, setFlash] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const ref = useRef(null)
  const myMatch = resumeSet ? matchJob(job, resumeSet) : null

  // When this row is the reveal target (e.g. a duplicate upload points here), open it,
  // scroll it into view, and pulse it. Depends on the nonce so a repeat still fires.
  useEffect(() => {
    if (!highlight || highlight.id !== job.id) return
    setOpen(true)
    setFlash(true)
    const scrollT = setTimeout(
      () => ref.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }),
      350, // let the panel's expand animation settle first
    )
    const flashT = setTimeout(() => setFlash(false), 2000)
    return () => {
      clearTimeout(scrollT)
      clearTimeout(flashT)
    }
  }, [highlight, job.id])

  return (
    <li className={'job' + (flash ? ' flash' : '')} ref={ref}>
      <button className="job-head" onClick={() => setOpen((o) => !o)}>
        <span className="job-co">
          {job.company || '—'}
          {isNewJob(job) && <span className="new-badge">New</span>}
        </span>
        <span className="job-title">{job.title || '—'}</span>
        <span className="job-sen">
          {job.seniority || '—'}
          {job.seniority_basis === 'inferred' && (
            <span className="inf" title={job.seniority_signal || 'inferred'}>
              {' '}~
            </span>
          )}
        </span>
      </button>
      {open && (
        <div className="job-detail">
          {myMatch && (
            <div className="job-match">
              <div className="job-match-head">
                <span className="job-match-label">Your résumé</span>
                <span className="job-match-score">{Math.round(myMatch.score * 100)}%</span>
              </div>
              <MatchChips match={myMatch} />
            </div>
          )}
          {job.summary && <p className="job-sum">{job.summary}</p>}
          {/* Full skill list only when there's no résumé to compare against — otherwise
              the have/missing chips above already cover the (required) skills. */}
          {!myMatch && (
            <div className="chips">
              {skillRequirements(job.skills).map((s) => (
                <span
                  key={`${s.requirement}-${s.label}`}
                  className={'chip' + (s.requirement === 'required' ? ' req' : '')}
                >
                  {s.label}
                </span>
              ))}
            </div>
          )}
          <div className="job-actions">
            <span className="job-actions-left">
              <button className="job-tailor" onClick={() => onTailor?.(job)}>
                Create a résumé
              </button>
              {job.screenshot_path && <ViewScreenshot jobId={job.id} />}
            </span>
            {confirmingDelete ? (
              <span className="job-del-confirm">
                Delete this job?
                <button className="job-del-yes" onClick={() => onDelete?.(job.id)}>
                  Delete
                </button>
                <button className="job-del-cancel" onClick={() => setConfirmingDelete(false)}>
                  Cancel
                </button>
              </span>
            ) : (
              <button className="job-del" onClick={() => setConfirmingDelete(true)}>
                Delete
              </button>
            )}
          </div>
        </div>
      )}
    </li>
  )
}
