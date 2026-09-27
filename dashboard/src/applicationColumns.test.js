import { describe, expect, it } from 'vitest'
import { APPLICATION_PAGE_SELECT, APPLICATION_PUBLIC_COLUMNS } from './applicationColumns'

const PRIVATE_COLUMNS = [
  'body',
  'subject',
  'sender',
  'contact_name',
  'key_dates',
  'action_required',
  'action_description',
  'extraction_confidence',
  'gmail_message_id',
]

describe('application browser columns', () => {
  it('never requests email content or contact details', () => {
    for (const col of PRIVATE_COLUMNS) {
      expect(APPLICATION_PUBLIC_COLUMNS).not.toContain(col)
    }
  })

  it('selects explicit columns, never *', () => {
    expect(APPLICATION_PAGE_SELECT).not.toContain('*')
    expect(APPLICATION_PAGE_SELECT).toBe(
      'id, company_raw, role_raw, category, received_at, job_id, job(company, title)',
    )
  })
})
