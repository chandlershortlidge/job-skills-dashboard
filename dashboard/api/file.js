// Vercel serverless function — signed-URL read path for stored source files.
// GET ?kind=screenshot&id=<job-id> -> { url } (signed, 3600 s) | 400 | 404.
// Add &download=1 for a save-a-copy URL (same object, same TTL, served with
// Content-Disposition: attachment). The attachment filename is the basename of
// the stored path — server-generated like every storage key, never the query
// string.
//
// What it does NOT do: writes of any kind (GET only), CV retrieval (kind
// allowlist is `screenshot` only in v1 — no login + sequential cv ids would
// make résumés publicly enumerable, storage-blueprint.md D1), or lookups by
// arbitrary storage path (the path always comes from the DB row, never from
// the query string).
//
// Invariant: this is the ONLY read path into the private `sources` bucket.
import { createClient } from '@supabase/supabase-js'
import { signedUrl } from './sourceStore.js'

// kind -> { table, pathColumn }. Add 'cv' only alongside an access story (D1).
const KINDS = {
  screenshot: { table: 'job', pathColumn: 'screenshot_path' },
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' })

  const kind = KINDS[req.query?.kind]
  const id = req.query?.id
  if (!kind) return res.status(400).json({ error: 'unknown kind' })
  if (!id) return res.status(400).json({ error: 'no id provided' })

  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return res.status(500).json({ error: 'storage not configured' })
  const supabase = createClient(url, key)

  const { data, error } = await supabase
    .from(kind.table)
    .select(kind.pathColumn)
    .eq('id', id)
    .maybeSingle()
  if (error) return res.status(500).json({ error: 'lookup failed' })

  const path = data?.[kind.pathColumn]
  if (!path) return res.status(404).json({ error: 'no stored file for this id' })

  const asDownload = req.query?.download === '1'
  const options = asDownload ? { download: path.split('/').pop() } : undefined
  const signed = await signedUrl(supabase, path, 3600, options) // null when the object is missing
  if (!signed) return res.status(404).json({ error: 'stored file not found' })
  return res.status(200).json({ url: signed })
}
