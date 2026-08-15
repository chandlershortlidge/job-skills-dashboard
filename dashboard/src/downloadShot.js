// Save-a-copy URL for a job's stored JD screenshot.
//
// Deliberately a SECOND request rather than a field on the view response: the
// download flavor is a distinct signed URL carrying Content-Disposition:
// attachment (api/file.js &download=1), and that header is what actually makes
// a cross-origin URL save instead of open — the browser ignores an <a download>
// attribute when the href points at another origin (Supabase Storage).
export async function fetchScreenshotDownloadUrl(jobId, fetchImpl = fetch) {
  const r = await fetchImpl(`/api/file?kind=screenshot&id=${encodeURIComponent(jobId)}&download=1`)
  const data = await r.json().catch(() => null)
  if (!r.ok || !data?.url) throw new Error(data?.error || `HTTP ${r.status}`)
  return data.url
}

// Point a throwaway anchor at an attachment URL: the browser saves the file and
// the page never navigates.
export function triggerDownload(url) {
  const a = document.createElement('a')
  a.href = url
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
}
