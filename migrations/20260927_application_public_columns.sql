-- Restrict what the public (anon) key can read from `application`.
-- Run once by hand in the Supabase SQL editor, AFTER the dashboard change that
-- stops selecting `*` is deployed (otherwise the Applications page shows its empty
-- state until it is).
--
-- Why: the anon key ships in the public JS bundle and the table was readable in
-- full, so anyone could read stored email bodies, subjects, senders, and recruiter
-- names. The Applications page needs only the columns granted below
-- (dashboard/src/applicationColumns.js). The existing RLS read policy stays; this
-- narrows it by column. The parser writes with the service-role key, unaffected.

revoke select on table application from anon, authenticated;

grant select (id, company_raw, role_raw, category, received_at, job_id)
  on table application to anon, authenticated;
