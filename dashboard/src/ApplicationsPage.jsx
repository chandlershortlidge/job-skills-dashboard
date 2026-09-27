import { useEffect, useState } from 'react'
import { supabase } from './supabase'
import { APPLICATION_PAGE_SELECT } from './applicationColumns'

// Read-only view over the `application` table (email → application parser output).
// Uses the anon browser client, which may read only the allowlisted columns in
// applicationColumns.js (column-level grant); email content stays server-side.
// When Supabase is unconfigured the stub client returns { data: null, error }, and
// there is no static applications fixture (unlike jobs.json), so any error OR an
// empty result renders the same explicit empty state rather than a blank screen.

const CATEGORY_LABEL = {
  recruiter_outreach: 'Recruiter outreach',
  interview_invite: 'Interview invite',
  rejection: 'Rejection',
  application_confirmation: 'Application confirmation',
  other: 'Other',
}

function formatDate(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString()
}

export default function ApplicationsPage({ onBack }) {
  const [rows, setRows] = useState(null) // null = loading; [] = loaded-empty (or errored)

  useEffect(() => {
    let cancelled = false
    // Embed the linked job ad (company/title) via the job_id FK — null when unlinked.
    supabase
      .from('application')
      .select(APPLICATION_PAGE_SELECT)
      .order('received_at', { ascending: false })
      .then(({ data, error }) => {
        if (cancelled) return
        // Error or empty both fall through to the one empty state (no static fixture).
        setRows(error ? [] : data || [])
      })
    return () => {
      cancelled = true
    }
  }, [])

  const nav = (
    <nav className="view-nav">
      {onBack && (
        <button type="button" onClick={onBack}>
          Jobs
        </button>
      )}
      <button type="button" className="active" aria-current="page">
        Applications
      </button>
    </nav>
  )

  if (rows === null) {
    return (
      <div className="app">
        {nav}
        <p className="loading">Loading…</p>
      </div>
    )
  }

  // Error OR empty → the one empty state (there is no static applications fixture).
  if (rows.length === 0) {
    return (
      <div className="app">
        {nav}
        <header>
          <h1>Applications</h1>
        </header>
        <p className="empty-state">No applications yet — run the email parser.</p>
      </div>
    )
  }

  return (
    <div className="app">
      {nav}
      <header>
        <h1>Applications</h1>
        <p className="sub">Job-search emails, classified and linked to saved job ads.</p>
      </header>

      <table className="applications">
        <thead>
          <tr>
            <th>Company</th>
            <th>Role</th>
            <th>Category</th>
            <th>Received</th>
            <th>Linked job</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>{r.company_raw || '—'}</td>
              <td>{r.role_raw || '—'}</td>
              <td>{CATEGORY_LABEL[r.category] || r.category || '—'}</td>
              <td>{formatDate(r.received_at)}</td>
              <td>{r.job ? `${r.job.company} — ${r.job.title}` : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
