import { describe, expect, it } from 'vitest'

import {
  getVisibleHourRange,
  layoutOverlappingSpans,
  minutesToTimeString,
  resolveEndMinutes,
  snapToSlot,
} from './timelineLayout'

const span = (id: string, startMinutes: number, endMinutes: number) => ({ id, startMinutes, endMinutes })

type IdSpan = ReturnType<typeof span>

/** Look a positioned span up by id, so assertions do not depend on output order. */
const at = (positioned: ReturnType<typeof layoutOverlappingSpans<IdSpan>>, id: string) => {
  const found = positioned.find(p => p.span.id === id)
  if (!found) throw new Error(`no positioned span with id ${id}`)
  return found
}

describe('layoutOverlappingSpans', () => {
  it('gives a lone span the full width', () => {
    const result = layoutOverlappingSpans([span('a', 600, 660)])
    expect(at(result, 'a')).toMatchObject({ column: 0, columnCount: 1 })
  })

  it('keeps sequential spans at full width', () => {
    const result = layoutOverlappingSpans([span('a', 600, 660), span('b', 660, 720)])
    expect(at(result, 'a')).toMatchObject({ column: 0, columnCount: 1 })
    expect(at(result, 'b')).toMatchObject({ column: 0, columnCount: 1 })
  })

  it('splits two overlapping spans side by side', () => {
    const result = layoutOverlappingSpans([span('a', 600, 700), span('b', 660, 760)])
    expect(at(result, 'a')).toMatchObject({ column: 0, columnCount: 2 })
    expect(at(result, 'b')).toMatchObject({ column: 1, columnCount: 2 })
  })

  it('splits three mutually overlapping spans into three lanes', () => {
    const result = layoutOverlappingSpans([
      span('a', 600, 720),
      span('b', 610, 730),
      span('c', 620, 740),
    ])
    expect(at(result, 'a')).toMatchObject({ column: 0, columnCount: 3 })
    expect(at(result, 'b')).toMatchObject({ column: 1, columnCount: 3 })
    expect(at(result, 'c')).toMatchObject({ column: 2, columnCount: 3 })
  })

  it('shares one cluster width across a transitive overlap chain', () => {
    // a-b overlap and b-c overlap, but a and c never touch. All three must still
    // share a width, otherwise b would be drawn over one of its neighbours.
    const result = layoutOverlappingSpans([
      span('a', 600, 660),
      span('b', 630, 700),
      span('c', 680, 740),
    ])
    expect(at(result, 'a').columnCount).toBe(2)
    expect(at(result, 'b').columnCount).toBe(2)
    expect(at(result, 'c').columnCount).toBe(2)
    expect(at(result, 'a').column).toBe(0)
    expect(at(result, 'b').column).toBe(1)
    expect(at(result, 'c').column).toBe(0)
  })

  it('reuses a lane once its previous span has ended', () => {
    const result = layoutOverlappingSpans([
      span('a', 600, 660),
      span('b', 600, 780),
      span('c', 660, 720),
    ])
    // c starts exactly when a ends, so it takes a's lane rather than a third one.
    expect(at(result, 'c').column).toBe(at(result, 'a').column)
    expect(at(result, 'c').columnCount).toBe(2)
  })

  it('starts a fresh cluster after a gap', () => {
    const result = layoutOverlappingSpans([
      span('a', 600, 700),
      span('b', 620, 700),
      span('c', 900, 960),
    ])
    expect(at(result, 'a').columnCount).toBe(2)
    expect(at(result, 'c').columnCount).toBe(1)
  })

  it('treats a touching boundary as no overlap', () => {
    const result = layoutOverlappingSpans([span('a', 600, 660), span('b', 660, 720)])
    expect(at(result, 'b').columnCount).toBe(1)
  })

  it('handles an empty list', () => {
    expect(layoutOverlappingSpans([])).toEqual([])
  })

  it('does not mutate the input array', () => {
    const input = [span('b', 700, 760), span('a', 600, 660)]
    const snapshot = [...input]
    layoutOverlappingSpans(input)
    expect(input).toEqual(snapshot)
  })
})

describe('snapToSlot', () => {
  it('rounds to the nearest slot', () => {
    expect(snapToSlot(607)).toBe(600)
    expect(snapToSlot(608)).toBe(615)
    expect(snapToSlot(615)).toBe(615)
  })

  it('clamps into the day', () => {
    expect(snapToSlot(-30)).toBe(0)
    expect(snapToSlot(24 * 60 + 90)).toBe(24 * 60 - 15)
  })
})

describe('minutesToTimeString', () => {
  it('formats as zero-padded HH:MM', () => {
    expect(minutesToTimeString(0)).toBe('00:00')
    expect(minutesToTimeString(545)).toBe('09:05')
    expect(minutesToTimeString(1439)).toBe('23:59')
  })

  it('clamps out-of-range values', () => {
    expect(minutesToTimeString(-10)).toBe('00:00')
    expect(minutesToTimeString(99999)).toBe('23:59')
  })
})

describe('getVisibleHourRange', () => {
  it('falls back to waking hours when nothing is scheduled', () => {
    expect(getVisibleHourRange([])).toEqual({ startHour: 6, endHour: 24 })
  })

  it('keeps the default window for a daytime-only day', () => {
    expect(getVisibleHourRange([span('a', 600, 660)])).toEqual({ startHour: 6, endHour: 24 })
  })

  it('stretches to cover an early start', () => {
    expect(getVisibleHourRange([span('a', 150, 240)]).startHour).toBe(2)
  })
})

describe('resolveEndMinutes', () => {
  it('defaults to an hour when there is no end time', () => {
    expect(resolveEndMinutes(600, null)).toBe(660)
  })

  it('enforces a minimum visible height', () => {
    expect(resolveEndMinutes(600, 605)).toBe(620)
  })

  it('keeps a real end time', () => {
    expect(resolveEndMinutes(600, 780)).toBe(780)
  })
})
