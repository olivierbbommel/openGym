import { useEffect, useState } from 'react'
import { useStore } from '../store/useStore.js'

// A screen too short for the workout's big animation and the sets under it: the folded iPhone Duo
// (678 pt), a phone held sideways, a small phone. There the animation starts small, so the set
// rows are on the first screen; Expand still opens it, for this screen only.
export const SHORT_SCREEN = '(max-height: 760px)'

export function useShortScreen (query = SHORT_SCREEN) {
  const read = () => (typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(query).matches : false)
  const [short, setShort] = useState(read)
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const mql = window.matchMedia(query)
    const on = () => setShort(mql.matches)
    on()
    mql.addEventListener?.('change', on)
    return () => mql.removeEventListener?.('change', on)
  }, [query])
  return short
}

/**
 * The workout animation's size: the saved choice (Settings, or the Minimize/Expand on the card),
 * except that on a short screen a saved "full" starts small, and Expand opens it for this card
 * without changing what is saved. `minimizable` false (a superset card, the library): always full.
 */
export function useWorkoutMediaSize (minimizable) {
  const gifSize = useStore(s => s.S.gifSize)
  const update = useStore(s => s.update)
  const short = useShortScreen()
  const [opened, setOpened] = useState(false)
  const auto = !!minimizable && short && gifSize !== 'mini'
  const mini = !!minimizable && (gifSize === 'mini' || (auto && !opened))
  const toggleSize = e => {
    e?.stopPropagation?.()
    if (auto) setOpened(o => !o)
    else update(s => { s.gifSize = mini ? 'full' : 'mini' })
  }
  return { mini, toggleSize, off: !!minimizable && gifSize === 'off' }
}
