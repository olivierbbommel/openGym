// The model call behind "Log by voice" (voice-log.js has the rest). It rides on the Coach's
// setup on this phone: the Anthropic key the person brought, kept in the Keychain, and the
// native HTTP path. Reading a few sentences into JSON is a small model's job, so it asks Haiku
// whatever model the Coach itself was set to. Only the description and the exercise names go
// out: no history, no body weight, no profile.
import { extractJSON } from '../../../api/coach/core/parse.js'
import { HTTP_PROVIDERS, baseUrlFor } from '../../../api/coach/core/providers.js'
import { ANTHROPIC_VERSION } from '../../../api/coach/core/adapters/anthropic.js'
import { nativeFetch } from './capacitor-fetch.js'
import { getApiKey } from './coach-secrets.js'
import { loadCoachDevice } from './coach-device.js'
import { EXDB } from './exercises.js'
import { candidateExercises, draftToEntries, SYSTEM, userPrompt } from './voice-log.js'
import { t } from './i18n.js'

export const VOICE_LOG_MODEL = 'claude-haiku-5-5'
const TIMEOUT_MS = 90000
const MAX_TOKENS = 4000

const fail = (msg, code) => Object.assign(new Error(msg), { code })

/** Whether this phone can read a description: the Coach set up with an Anthropic key. */
export async function voiceLogReady() {
  try {
    const d = await loadCoachDevice()
    return d.mode === 'byok' && d.provider === 'anthropic' && !!(await getApiKey())
  } catch { return false }
}

/** A description in, { name, durationMin, entries, unmatched, dropped } out (voice-log.js). */
export async function readDescription(S, description, { fetchImpl = nativeFetch } = {}) {
  const d = await loadCoachDevice()
  if (d.mode !== 'byok' || d.provider !== 'anthropic') throw fail(t('Set up the Coach with your Anthropic key first (Settings → Coach).'), 'off')
  const key = await getApiKey()
  if (!key) throw fail(t('Set up the Coach with your Anthropic key first (Settings → Coach).'), 'off')
  const candidates = candidateExercises(S, description, EXDB)
  const base = baseUrlFor('anthropic', d.baseUrl ? { providerOptions: { anthropic: { baseUrl: d.baseUrl } } } : {}) || HTTP_PROVIDERS.anthropic.defaultBase
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS)
  let res
  try {
    res = await fetchImpl(base + '/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': ANTHROPIC_VERSION, 'anthropic-dangerous-direct-browser-access': 'true' },
      body: JSON.stringify({ model: VOICE_LOG_MODEL, max_tokens: MAX_TOKENS, system: SYSTEM, messages: [{ role: 'user', content: userPrompt(description, candidates) }] }),
      signal: ctl.signal
    })
  } catch {
    throw fail(ctl.signal.aborted ? t('That took too long. Try again.') : t('Couldn’t reach Anthropic. Check your connection and try again.'), 'network')
  } finally { clearTimeout(timer) }
  let data = null
  try { data = await res.json() } catch { /* below */ }
  if (!res.ok) throw fail(t('Anthropic said no: {0}', (data && data.error && data.error.message) || res.status), 'provider')
  const text = (data?.content || []).filter(b => b && b.type === 'text').map(b => b.text).join('')
  const parsed = extractJSON(text)
  if (parsed.error) throw fail(t('Couldn’t read that into a workout. Try saying it again.'), 'unusable')
  const out = draftToEntries(parsed.value, candidates)
  if (!out.entries.length) throw fail(t('Couldn’t find any exercises in that. Try naming them.'), 'empty')
  return out
}
