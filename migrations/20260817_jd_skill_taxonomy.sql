-- JD skill-taxonomy v1: run once by hand in the Supabase SQL editor.
-- Safe for existing rows: legacy jobs have an empty audit array and legacy skills
-- have no alternative group, so their existing behavior is unchanged.

alter table job
  add column if not exists non_skill_mentions jsonb not null default '[]'::jsonb;

alter table skill
  add column if not exists alternative_group text;
