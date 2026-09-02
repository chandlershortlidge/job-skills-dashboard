-- email_parser migration (T5) — the `application` table.
--
-- Verbatim from the data model in PLAN-email-parser.md. No local DDL creds
-- (repo pattern): a PERSON runs this in the Supabase SQL editor. Do not run it
-- from code. RLS mirrors `job`: PUBLIC READ ONLY — every write goes through the
-- service-role key (no insert/update/delete policy exists).
--
-- Must be applied and confirmed before: T9's live run, T10 (seed), T11 (dashboard).

create table application (
  id                    bigserial primary key,
  gmail_message_id      text not null unique,
  subject               text,
  sender                text,
  body                  text,
  received_at           timestamptz,
  category              text,
  company_raw           text,
  role_raw              text,
  contact_name          text,
  key_dates             jsonb not null default '[]'::jsonb,
  action_required       boolean not null default false,
  action_description    text,
  extraction_confidence text,
  job_id                text references job(id),   -- nullable, TEXT
  created_at            timestamptz not null default now()
);
alter table application enable row level security;
create policy "public read application" on application for select using (true);
-- no insert/update/delete policy: writes only via service-role key
