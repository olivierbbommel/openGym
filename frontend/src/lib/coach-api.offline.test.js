/* A phone with its own key whose provider never answered (no network, a dropped connection):
 * one plain line that says what to do, not the provider's raw "could not reach …: The network
 * connection was lost." Other failures keep their detail: that is what lets the operator fix them. */
import { describe, expect, it, vi } from 'vitest'

vi.mock('./demo.js', () => ({ DEMO: false, DEMO_SEEDED: 'gym_demo_seeded_v1', REPO: '' }))
vi.mock('./mobile.js', () => ({ MOBILE: true }))
vi.mock('./api.js', () => ({ api: vi.fn() }))
vi.mock('./coach-demo.js', () => ({}))
vi.mock('./coach-local.js', () => ({ setNotifier: vi.fn() }))
vi.mock('../store/useStore.js', () => ({ useStore: { getState: () => ({ S: { unit: 'kg' }, coachLocal: { mode: 'byok' } }) } }))
vi.mock('../store/useUI.js', () => ({ useUI: { getState: () => ({ toast: vi.fn() }) } }))

const { jobErrorText, NO_CONNECTION, BYOK_ERRORS } = await import('./coach-api.js')

describe('the Coach on a phone with its own key, offline', () => {
  it('a provider out of reach reads as a connection problem', () => {
    expect(jobErrorText('provider', 'could not reach api.anthropic.com: The network connection was lost.')).toBe(NO_CONNECTION())
    expect(jobErrorText('provider', 'timed out')).toBe(NO_CONNECTION())
  })
  it('a provider that answered with an error keeps its words', () => {
    expect(jobErrorText('provider', 'model not found: claude-x')).toBe(BYOK_ERRORS.provider + '\nmodel not found: claude-x')
  })
})
