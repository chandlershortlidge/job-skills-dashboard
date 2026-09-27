// The only `application` columns the browser may read. The anon key ships in the
// public bundle, so these must match the column-level grant in
// migrations/20260927_application_public_columns.sql — email body, subject,
// sender, contact name, dates, and actions stay server-side only.
export const APPLICATION_PUBLIC_COLUMNS = [
  'id',
  'company_raw',
  'role_raw',
  'category',
  'received_at',
  'job_id',
]

// PostgREST select string for the Applications page: the allowlisted columns plus
// the linked job ad (company/title) embedded via the job_id FK.
export const APPLICATION_PAGE_SELECT = `${APPLICATION_PUBLIC_COLUMNS.join(', ')}, job(company, title)`
