/**
 * Pure geometry for the day timeline: turning times into vertical positions, and
 * laying overlapping items out side-by-side within a day column.
 *
 * Kept free of React and of Trek's data shapes so the maths can be tested on its
 * own — the view supplies whatever it wants to place, as long as each item
 * carries a start and end in minutes-from-midnight.
 */

/** Drops snap to this grid, so a dragged block lands on a tidy time. */
export const SLOT_MINUTES = 15

/** How tall one minute is, in pixels. A 1h block is 60px at this scale. */
export const PX_PER_MINUTE = 1

/** An item with no end time is drawn as an hour so it stays grabbable. */
export const DEFAULT_DURATION_MINUTES = 60

/** A block never draws shorter than this, however brief it actually is. */
export const MIN_BLOCK_MINUTES = 20

export interface TimeSpan {
  startMinutes: number
  endMinutes: number
}

export interface PositionedSpan<T extends TimeSpan> {
  span: T
  /** Zero-based lane within the cluster of mutually overlapping spans. */
  column: number
  /** How many lanes that cluster needs. Width is 1/columnCount of the day. */
  columnCount: number
}

/**
 * Assign each span a column so overlapping spans sit beside each other rather
 * than on top of each other.
 *
 * Spans that overlap transitively form a cluster and share its width: A overlaps
 * B and B overlaps C puts all three in one cluster, even if A and C never touch.
 * Within a cluster each span takes the first lane free at its start time, which
 * is the standard calendar packing and keeps the common two-item case at half
 * width rather than fragmenting.
 *
 * Returns spans in start order, not input order.
 */
export function layoutOverlappingSpans<T extends TimeSpan>(spans: readonly T[]): PositionedSpan<T>[] {
  const sorted = [...spans].sort(
    (a, b) => a.startMinutes - b.startMinutes || a.endMinutes - b.endMinutes
  )

  const positioned: PositionedSpan<T>[] = []
  let cluster: PositionedSpan<T>[] = []
  let laneEnds: number[] = []
  let clusterEnd = -Infinity

  const closeCluster = (): void => {
    for (const entry of cluster) {
      positioned.push({ ...entry, columnCount: laneEnds.length })
    }
    cluster = []
    laneEnds = []
    clusterEnd = -Infinity
  }

  for (const span of sorted) {
    // Starting at or after everything seen so far means the previous cluster is
    // closed — nothing later can overlap it, because spans arrive in start order.
    if (span.startMinutes >= clusterEnd) closeCluster()

    let lane = laneEnds.findIndex(end => end <= span.startMinutes)
    if (lane === -1) {
      laneEnds.push(span.endMinutes)
      lane = laneEnds.length - 1
    } else {
      laneEnds[lane] = span.endMinutes
    }

    cluster.push({ span, column: lane, columnCount: 0 })
    clusterEnd = Math.max(clusterEnd, span.endMinutes)
  }
  closeCluster()

  return positioned
}

/** Round a minute offset to the nearest drop slot, clamped to the day. */
export function snapToSlot(minutes: number, slot: number = SLOT_MINUTES): number {
  const snapped = Math.round(minutes / slot) * slot
  return Math.min(24 * 60 - slot, Math.max(0, snapped))
}

/** Minutes from midnight as "HH:MM", the shape the assignment time API takes. */
export function minutesToTimeString(minutes: number): string {
  const clamped = Math.min(24 * 60 - 1, Math.max(0, Math.round(minutes)))
  const hours = Math.floor(clamped / 60)
  const mins = clamped % 60
  return `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}`
}

/**
 * The hour range the grid should cover: wide enough for everything scheduled,
 * but defaulting to waking hours so an empty or daytime-only trip does not open
 * on hours of blank night.
 */
export function getVisibleHourRange(
  spans: readonly TimeSpan[],
  defaultStartHour = 6,
  defaultEndHour = 24
): { startHour: number; endHour: number } {
  if (spans.length === 0) return { startHour: defaultStartHour, endHour: defaultEndHour }

  const earliest = Math.min(...spans.map(s => s.startMinutes))
  const latest = Math.max(...spans.map(s => s.endMinutes))

  return {
    startHour: Math.min(defaultStartHour, Math.floor(earliest / 60)),
    endHour: Math.max(defaultEndHour, Math.ceil(latest / 60)),
  }
}

/**
 * The end of a block given its optional end time. Falls back to a default
 * duration, and never returns a span so short it cannot be seen or grabbed.
 */
export function resolveEndMinutes(startMinutes: number, endMinutes: number | null): number {
  const end = endMinutes ?? startMinutes + DEFAULT_DURATION_MINUTES
  return Math.max(end, startMinutes + MIN_BLOCK_MINUTES)
}
