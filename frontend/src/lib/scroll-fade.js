// A row that scrolls sideways (the filter chips, the Coach's quick questions) says so: the edge
// where more is hidden fades out (index.css `.more-l` / `.more-r`). Without it a chip cut off at
// the screen edge read as the last one, the iPhone Duo folded most of all.
export const FADE_ROWS = '.chips, .chips-row'

/** Which edges of `el` hide more: { l, r }. */
export function fadeOf (el) {
  const max = (el?.scrollWidth || 0) - (el?.clientWidth || 0)
  const at = Math.abs(el?.scrollLeft || 0)   // negative in a right-to-left row
  const rtl = !!el && typeof getComputedStyle === 'function' && getComputedStyle(el).direction === 'rtl'
  const start = at > 2, end = at < max - 2
  return rtl ? { l: end, r: start } : { l: start, r: end }
}

export function updateFade (el) {
  const f = fadeOf(el)
  el.classList.toggle('more-l', f.l)
  el.classList.toggle('more-r', f.r)
}

/** Installed once: keeps every such row's fade current as it scrolls, resizes and appears. */
export function installScrollFades (doc = document) {
  let queued = false
  const all = () => { queued = false; doc.querySelectorAll(FADE_ROWS).forEach(updateFade) }
  const soon = () => { if (!queued) { queued = true; requestAnimationFrame(all) } }
  const onScroll = e => { if (e.target?.matches?.(FADE_ROWS)) updateFade(e.target) }
  doc.addEventListener('scroll', onScroll, true)
  window.addEventListener('resize', soon)
  const mo = typeof MutationObserver === 'function' ? new MutationObserver(soon) : null
  mo?.observe(doc.body, { childList: true, subtree: true })
  soon()
  return () => { doc.removeEventListener('scroll', onScroll, true); window.removeEventListener('resize', soon); mo?.disconnect() }
}
