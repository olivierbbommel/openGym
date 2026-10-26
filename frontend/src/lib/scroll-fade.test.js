// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { fadeOf, updateFade } from './scroll-fade.js'

const row = (scrollLeft, scrollWidth, clientWidth) => {
  const el = document.createElement('div')
  Object.defineProperty(el, 'scrollWidth', { value: scrollWidth })
  Object.defineProperty(el, 'clientWidth', { value: clientWidth })
  el.scrollLeft = scrollLeft
  Object.defineProperty(el, 'scrollLeft', { value: scrollLeft })
  document.body.appendChild(el)
  return el
}

describe('a row that scrolls sideways', () => {
  it('fades the edge that hides more, and neither when it all fits', () => {
    expect(fadeOf(row(0, 600, 300))).toEqual({ l: false, r: true })
    expect(fadeOf(row(150, 600, 300))).toEqual({ l: true, r: true })
    expect(fadeOf(row(300, 600, 300))).toEqual({ l: true, r: false })
    expect(fadeOf(row(0, 300, 300))).toEqual({ l: false, r: false })
  })

  it('sets the classes the stylesheet fades with', () => {
    const el = row(0, 600, 300)
    updateFade(el)
    expect(el.className).toBe('more-r')
  })
})
