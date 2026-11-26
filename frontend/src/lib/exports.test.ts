import { afterEach, describe, expect, it, vi } from 'vitest'
import { exportCsv, exportJson } from './exports'

describe('downloads', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

  it('escapes CSV quotes/newlines and neutralizes spreadsheet formulas in recorded output', () => {
    const blob = vi.fn()
    vi.stubGlobal('Blob', blob)
    vi.stubGlobal('URL', { createObjectURL: vi.fn().mockReturnValue('blob:csv'), revokeObjectURL: vi.fn() })
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    exportCsv('record.csv', [['stdout', '=HYPERLINK("https://example.invalid")', 'line 1\nline "2"', -1, '\t+SUM(1,2)']])
    expect(blob.mock.calls[0][0][0]).toBe('"stdout","\'=HYPERLINK(""https://example.invalid"")","line 1\nline ""2""","-1","\'\t+SUM(1,2)"')
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:csv')
  })

  it('retains unmodified recorded JSON strings', () => {
    const blob = vi.fn()
    vi.stubGlobal('Blob', blob)
    vi.stubGlobal('URL', { createObjectURL: vi.fn().mockReturnValue('blob:json'), revokeObjectURL: vi.fn() })
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    const value = { stdout: '=actual output\nsecond line', stderr: '', retcode: 0 }
    exportJson('record.json', value)
    expect(JSON.parse(blob.mock.calls[0][0][0])).toEqual(value)
  })
})