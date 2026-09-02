"""email_parser — part 2: turn job-search emails into `application` rows.

Reads Gmail (one curated label), classifies each email into one of five
categories, extracts raw fields, links each to a saved `job` ad via `job_id`
when the match is unambiguous, and stores an `application` row. A local,
hand-triggered pipeline (Gmail testing-mode login expires every 7 days).

Does NOT: send email; canonicalize company/role names; guess between >=2
candidate ads (returns None instead); write to the `job` table. See
PLAN-email-parser.md for the full contract.
"""
