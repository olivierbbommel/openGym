// @vitest-environment happy-dom
// The workout animation on a short screen (the folded iPhone Duo): small at first, so the sets are
// on the first screen; Expand opens it for that card without changing the saved size.
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { useWorkoutMediaSize } from './media-size.js'
import { useStore } from '../store/useStore.js'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
let host, root, seen, original
const short = matches => { window.matchMedia = () => ({ matches, addEventListener () {}, removeEventListener () {} }) }
function Probe ({ minimizable = true }) { seen = useWorkoutMediaSize(minimizable); return null }
const render = el => act(() => root.render(el))

beforeEach(() => {
  original = useStore.getState().S
  host = document.createElement('div')
  root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); useStore.setState({ S: original }) })
const setSize = gifSize => useStore.setState({ S: { ...useStore.getState().S, gifSize } })

it('a tall screen keeps the saved size, and Expand/Minimize saves it', () => {
  short(false); setSize('full')
  render(<Probe />)
  expect(seen.mini).toBe(false)
  act(() => seen.toggleSize())
  expect(useStore.getState().S.gifSize).toBe('mini')
})

it('a short screen starts small, and Expand opens it without changing what is saved', () => {
  short(true); setSize('full')
  render(<Probe />)
  expect(seen.mini).toBe(true)
  act(() => seen.toggleSize())
  expect(seen.mini).toBe(false)
  expect(useStore.getState().S.gifSize).toBe('full')
})

it('off stays off, and a card that cannot be minimized is always full', () => {
  short(true); setSize('off')
  render(<Probe />)
  expect(seen.off).toBe(true)
  setSize('full')
  render(<Probe minimizable={false} />)
  expect(seen.mini).toBe(false)
})
