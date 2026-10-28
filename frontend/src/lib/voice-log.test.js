import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EXDB } from './exercises.js'
import { candidateExercises, draftToEntries, wordsOf, userPrompt } from './voice-log.js'

// The class this was built for (Oct 27): four rounds of a pull-up hold, band pull-ups and lifted
// pike push-ups; paused dips; dips to failure; chin-ups around the bar.
const SAID = 'Four rounds of a 10 second pull-up hold, then 6 pull-ups with the yellow band, then 8 pike push-ups with my feet lifted. ' +
  'Then 4 dips with a 5 second pause at the bottom, four times. Then dips until failure, four times: 9, 8, 7 and 6. Then chin-ups around the world.'

describe('the words of a name and of a description', () => {
  it('reads pull-up, pull up and pullups as the same word', () => {
    expect(wordsOf('Pull-ups')).toContain('pullup')
    expect(wordsOf('pull up')).toContain('pullup')
    expect(wordsOf('pullups')).toContain('pullup')
    expect(wordsOf('the four reps')).toEqual(new Set())
  })
})

describe('the exercises the model may name', () => {
  const ids = candidateExercises({ workouts: [], customEx: [{ id: 'cx1', n: 'Active hang' }] }, SAID, EXDB).map(c => c.id)
  it('holds what was said, the person’s own exercises first', () => {
    expect(ids[0]).toBe('cx1')
    for (const id of ['0970', '0652', '2831', '0814', '4207']) expect(ids, id).toContain(id)
  })
  it('is bounded', () => {
    expect(ids.length).toBeLessThanOrEqual(220)
    expect(userPrompt(SAID, [{ id: '0970', n: 'band assisted pull-up' }])).toContain('0970 | band assisted pull-up')
  })
})

describe('the answer as session entries', () => {
  const cands = ['0652', '0970', '2831', '0814', '4207'].map(id => ({ id, n: id }))
  const draft = {
    name: 'Calisthenics class',
    durationMin: null,
    exercises: [
      { id: '0652', group: 'A', groupName: 'Circuit A', mode: 'time', sets: Array(4).fill({ sec: 10 }), note: '10 s hold at the top' },
      { id: '0970', group: 'A', groupName: 'Circuit A', mode: 'reps', sets: Array(4).fill({ reps: 6 }), note: 'Yellow band' },
      { id: '2831', group: 'A', groupName: 'Circuit A', mode: 'reps', sets: Array(4).fill({ reps: 8 }), note: 'Feet lifted' },
      { id: '0814', group: null, mode: 'reps', sets: Array(4).fill({ reps: 4 }), note: '5 s pause at the bottom' },
      { id: '0814', group: null, mode: 'reps', sets: [9, 8, 7, 6].map(r => ({ reps: r, failure: true })) },
      { id: '4207', group: null, mode: 'reps', sets: [{ reps: null }] },
      { id: '9999', mode: 'reps', sets: [{ reps: 5 }] }
    ],
    unmatched: ['around the world']
  }
  const out = draftToEntries(draft, cands)

  it('makes the circuit one superset with its name, sets done', () => {
    const circuit = out.entries.slice(0, 3)
    expect(new Set(circuit.map(e => e.target.sg)).size).toBe(1)
    expect(circuit[0].target.sg).toBeTruthy()
    expect(circuit.every(e => e.target.sgName === 'Circuit A')).toBe(true)
    expect(circuit[0].target.mode).toBe('time')
    expect(circuit[0].sets).toEqual(Array(4).fill({ w: 0, sec: 10, done: true }))
    expect(circuit[1].note).toBe('Yellow band')
    expect(circuit[1].sets[0]).toEqual({ w: 0, r: 6, done: true })
  })
  it('marks failure sets and keeps their reps', () => {
    expect(out.entries[4].sets.map(s => [s.r, s.failure])).toEqual([[9, true], [8, true], [7, true], [6, true]])
    expect(out.entries[3].target.sg).toBeUndefined()
  })
  it('drops what it cannot use instead of inventing it', () => {
    expect(out.entries.map(e => e.id)).toEqual(['0652', '0970', '2831', '0814', '0814'])
    expect(out.dropped).toBe(2)          // the set with no number, the id that was not offered
    expect(out.unmatched).toEqual(['around the world'])
    expect(out.name).toBe('Calisthenics class')
  })
  it('does not make a superset of one', () => {
    const one = draftToEntries({ exercises: [{ id: '0652', group: 'B', mode: 'reps', sets: [{ reps: 5 }] }] }, cands)
    expect(one.entries[0].target.sg).toBeUndefined()
  })
})

describe('reading a description with the Coach’s key', () => {
  beforeEach(() => { vi.resetModules() })
  it('asks Haiku and returns entries', async () => {
    vi.doMock('./coach-device.js', () => ({ loadCoachDevice: async () => ({ mode: 'byok', provider: 'anthropic', baseUrl: null }) }))
    vi.doMock('./coach-secrets.js', () => ({ getApiKey: async () => 'sk-ant-test' }))
    const { readDescription, VOICE_LOG_MODEL } = await import('./voice-log-ai.js')
    let sent = null
    const fetchImpl = async (url, init) => {
      sent = { url, body: JSON.parse(init.body), headers: init.headers }
      const answer = { name: 'Class', exercises: [{ id: '0970', mode: 'reps', sets: [{ reps: 6 }] }], unmatched: [] }
      return { ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: '```json\n' + JSON.stringify(answer) + '\n```' }] }) }
    }
    const out = await readDescription({ workouts: [] }, SAID, { fetchImpl })
    expect(sent.url).toBe('https://api.anthropic.com/v1/messages')
    expect(sent.body.model).toBe(VOICE_LOG_MODEL)
    expect(sent.headers['x-api-key']).toBe('sk-ant-test')
    expect(sent.body.messages[0].content).toContain('Four rounds')
    expect(out.entries[0].sets[0]).toEqual({ w: 0, r: 6, done: true })
  })
  it('says so when the Coach is not set up with an Anthropic key', async () => {
    vi.doMock('./coach-device.js', () => ({ loadCoachDevice: async () => ({ mode: 'off' }) }))
    vi.doMock('./coach-secrets.js', () => ({ getApiKey: async () => null }))
    const { readDescription, voiceLogReady } = await import('./voice-log-ai.js')
    expect(await voiceLogReady()).toBe(false)
    await expect(readDescription({}, SAID, { fetchImpl: async () => { throw new Error('no') } })).rejects.toMatchObject({ code: 'off' })
  })
})
