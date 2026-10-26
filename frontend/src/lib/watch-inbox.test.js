import { describe, expect, it } from 'vitest'
import { mergeInbox, putInbox, inboxPending, markInboxDone, INBOX_DONE_MAX } from './watch-inbox.js'
import { mergeStates } from './sync-merge.js'

const ev = (id, seq, type = 'setDone') => ({ id, seq, type, wid: 'w1' })

describe('watch inbox', () => {
  it('keeps every event either copy has, once, in the order the watch made them', () => {
    const m = mergeInbox({ watchInbox: [ev('b', 2), ev('c', 3)] }, { watchInbox: [ev('a', 1, 'start'), ev('b', 2)] })
    expect(m.watchInbox.map(e => e.id)).toEqual(['a', 'b', 'c'])
    expect(m.watchInboxDone).toBe(null)
  })

  it('an event applied on either copy does not come back from the other', () => {
    const phone = { watchInbox: [], watchInboxDone: ['a', 'b'] }
    const server = { watchInbox: [ev('a', 1, 'start'), ev('b', 2), ev('c', 3)] }
    const m = mergeInbox(server, phone)
    expect(m.watchInbox.map(e => e.id)).toEqual(['c'])
    expect(m.watchInboxDone).toEqual(['a', 'b'])
  })

  it('drops what is not an event, and keeps the applied ids bounded', () => {
    const many = Array.from({ length: INBOX_DONE_MAX + 5 }, (_, i) => 'x' + i)
    const m = mergeInbox({ watchInbox: [null, 3, { id: 1 }, ev('ok', 1)], watchInboxDone: many }, null)
    expect(m.watchInbox.map(e => e.id)).toEqual(['ok'])
    expect(m.watchInboxDone.length).toBe(INBOX_DONE_MAX)
    expect(m.watchInboxDone.at(-1)).toBe('x' + (INBOX_DONE_MAX + 4))
  })

  it('pending: what neither this device nor another has applied', () => {
    const S = { watchInbox: [ev('a', 1), ev('b', 2), ev('c', 3)], watchInboxDone: ['a'] }
    expect(inboxPending(S, ['b']).map(e => e.id)).toEqual(['c'])
    expect(inboxPending({}, [])).toEqual([])
  })

  it('marking done empties the inbox field once nothing waits', () => {
    const s = { watchInbox: [ev('a', 1)] }
    markInboxDone(s, ['a'])
    expect('watchInbox' in s).toBe(false)
    expect(s.watchInboxDone).toEqual(['a'])
    expect(putInbox({ watchInbox: [1] }, { watchInbox: null, watchInboxDone: null })).toEqual({})
  })

  it('a sync merge keeps the watch\'s upload when the phone pushes a copy without it', () => {
    // The watch wrote two events; the phone, which never saw them, pushed its newer copy: the
    // server's 409 hands the phone the watch's copy to merge with.
    const server = { _ts: 1, workouts: [], watchInbox: [ev('a', 1, 'start'), ev('b', 2)] }
    const phone = { _ts: 2, workouts: [] }
    const out = mergeStates(phone, server)
    expect(out.watchInbox.map(e => e.id)).toEqual(['a', 'b'])
    // Once applied on the phone, the server's stale copy does not bring them back.
    const applied = { _ts: 3, workouts: [], watchInboxDone: ['a', 'b'] }
    const again = mergeStates(applied, server)
    expect(again.watchInbox).toBeUndefined()
    expect(again.watchInboxDone).toEqual(['a', 'b'])
  })
})
