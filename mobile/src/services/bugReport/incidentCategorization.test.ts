import {buildIncidentCategorization, normalizeOptionalIncidentString} from './incidentCategorization'

describe('normalizeOptionalIncidentString', () => {
  it('trims non-empty strings', () => {
    expect(normalizeOptionalIncidentString('  hello  ')).toBe('hello')
  })

  it('returns undefined for empty or non-string values', () => {
    expect(normalizeOptionalIncidentString('   ')).toBeUndefined()
    expect(normalizeOptionalIncidentString(undefined)).toBeUndefined()
    expect(normalizeOptionalIncidentString(7)).toBeUndefined()
  })
})

describe('buildIncidentCategorization', () => {
  it('builds the canonical categorization payload', () => {
    expect(
      buildIncidentCategorization({
        submissionMode: 'USER_INITIATED',
        triggerArea: 'applet_capsule_menu',
        triggerReason: 'manual_bug_report',
        sourceAppletPackageName: 'com.mentra.demo',
        sourceAppletName: 'Demo',
      }),
    ).toEqual({
      submissionMode: 'USER_INITIATED',
      triggerArea: 'applet_capsule_menu',
      triggerReason: 'manual_bug_report',
      automatic: false,
      source: 'manual_bug_report',
      sourceAppletPackageName: 'com.mentra.demo',
      sourceAppletName: 'Demo',
    })
  })

  it('preserves explicit compatibility fields when provided', () => {
    expect(
      buildIncidentCategorization({
        submissionMode: 'AUTOMATIC',
        triggerArea: 'gallery_video',
        triggerReason: 'gallery_video_on_error',
        source: 'gallery_video_onError',
        automatic: true,
      }),
    ).toEqual({
      submissionMode: 'AUTOMATIC',
      triggerArea: 'gallery_video',
      triggerReason: 'gallery_video_on_error',
      automatic: true,
      source: 'gallery_video_onError',
    })
  })
})

