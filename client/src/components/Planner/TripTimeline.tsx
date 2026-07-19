import React, { useMemo, useRef, useState } from 'react'
import { CalendarClock, Clock, Minus } from 'lucide-react'
import { assignmentsApi } from '../../api/client'
import { useTripStore } from '../../store/tripStore'
import { useCanDo } from '../../store/permissionsStore'
import { useSettingsStore } from '../../store/settingsStore'
import { useTranslation } from '../../i18n'
import { useToast } from '../shared/Toast'
import PlaceAvatar from '../shared/PlaceAvatar'
import { useContextMenu, ContextMenu } from '../shared/ContextMenu'
import { RES_ICONS } from './DayPlanSidebar.constants'
import { parseTimeToMinutes, getSpanPhase, getTransportForDay } from '../../utils/dayMerge'
import { formatDate, formatTime } from '../../utils/formatters'
import {
  PX_PER_MINUTE, SLOT_MINUTES,
  layoutOverlappingSpans, snapToSlot, minutesToTimeString,
  getVisibleHourRange, resolveEndMinutes,
  type TimeSpan,
} from '../../utils/timelineLayout'
import type { Trip, Day, Place, Assignment, AssignmentsMap, Accommodation, Reservation } from '../../types'

const AXIS_WIDTH = 56
const DAY_MIN_WIDTH = 220
const HEADER_HEIGHT = 46
const UNSCHEDULED_HEIGHT = 74
/** A transport with only one known endpoint on this day draws this tall. */
const TRANSPORT_STUB_MINUTES = 30

interface AssignmentSpan extends TimeSpan {
  kind: 'place'
  assignment: Assignment
  dayId: number
}

interface TransportSpan extends TimeSpan {
  kind: 'transport'
  reservation: Reservation & { __leg?: { index: number; from?: string | null; to?: string | null } }
  /** Label already tz-suffixed where the endpoints cross zones. */
  timeLabel: string
}

type DaySpan = AssignmentSpan | TransportSpan

interface TripTimelineProps {
  tripId: number
  trip: Trip
  days: Day[]
  assignments: AssignmentsMap
  reservations: Reservation[]
  accommodations: Accommodation[]
  onPlaceClick: (placeId: number | null, assignmentId?: number | null) => void
  onEditPlace: (place: Place, assignmentId?: number) => void
  onRemoveAssignment: (dayId: number, assignmentId: number) => void
  onEditTransport?: (reservation: Reservation) => void
}

/** Short zone name ("EDT") for an IANA timezone, at a given date for DST correctness. */
function tzAbbreviation(timeZone: string | null | undefined, dateStr?: string | null): string {
  if (!timeZone) return ''
  try {
    const at = dateStr ? new Date(`${dateStr}T12:00:00`) : new Date()
    const part = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'short' })
      .formatToParts(at).find(p => p.type === 'timeZoneName')
    return part?.value ?? ''
  } catch {
    return ''
  }
}

/**
 * The "when" surface: a time axis on the left, one column per day, assignment
 * blocks positioned by their times. Untimed assignments wait in a strip above
 * each column; dragging one into the grid gives it a time, dragging a block
 * back into the strip removes it. Transports and bookings with times render as
 * read-only blocks at their LOCAL wall-clock times (a flight departs at its
 * origin's clock and arrives at its destination's), tz-labelled when the ends
 * differ. Right-click opens edit/remove actions.
 */
export default function TripTimeline({
  tripId, trip, days, assignments, reservations, accommodations,
  onPlaceClick, onEditPlace, onRemoveAssignment, onEditTransport,
}: TripTimelineProps) {
  const { t, locale } = useTranslation()
  const toast = useToast()
  const can = useCanDo()
  const canEdit = can('day_edit', trip)
  const timeFormat = useSettingsStore(s => s.settings.time_format) || '24h'
  const tripActions = useRef(useTripStore.getState()).current
  const ctxMenu = useContextMenu()

  const [draggingId, setDraggingId] = useState<number | null>(null)
  const [dropPreview, setDropPreview] = useState<{ dayId: number; minutes: number } | null>(null)
  const [stripPreviewDayId, setStripPreviewDayId] = useState<number | null>(null)
  // Live minutes while a bottom-edge resize is in flight; committed on pointerup.
  const [resizing, setResizing] = useState<{ assignmentId: number; endMinutes: number } | null>(null)

  // Accommodation stays (the villa, the hotel) are all-day by nature — they'd
  // clutter every unscheduled strip, so they stay off this surface entirely.
  const accommodationPlaceIds = useMemo(
    () => new Set(accommodations.map(a => a.place_id).filter((id): id is number => id != null)),
    [accommodations]
  )

  const { scheduled, unscheduled } = useMemo(() => {
    const scheduled: AssignmentSpan[] = []
    const unscheduled: Array<{ assignment: Assignment; dayId: number }> = []
    for (const day of days) {
      for (const a of assignments[String(day.id)] || []) {
        if (accommodationPlaceIds.has(a.place_id)) continue
        const start = parseTimeToMinutes(a.place?.place_time)
        if (start == null) {
          unscheduled.push({ assignment: a, dayId: day.id })
        } else {
          scheduled.push({
            kind: 'place',
            assignment: a,
            dayId: day.id,
            startMinutes: start,
            endMinutes: resolveEndMinutes(start, parseTimeToMinutes(a.place?.end_time)),
          })
        }
      }
    }
    return { scheduled, unscheduled }
  }, [days, assignments, accommodationPlaceIds])

  // Transports and timed bookings, positioned at their local wall-clock times.
  const transportSpansByDay = useMemo(() => {
    const byDay = new Map<number, TransportSpan[]>()
    for (const day of days) {
      const dayAssignmentIds = (assignments[String(day.id)] || []).map(a => a.id)
      const spans: TransportSpan[] = []
      for (const r of getTransportForDay({ reservations, dayId: day.id, dayAssignmentIds, days })) {
        const phase = getSpanPhase(r, day.id)
        if (phase === 'middle') continue

        const endpoints: Array<{ role: string; timezone?: string | null; local_date?: string | null }> = r.endpoints || []
        const fromTz = endpoints.find(e => e.role === 'from')?.timezone
        const toEp = endpoints.find(e => e.role === 'to')
        const crossesZones = Boolean(fromTz && toEp?.timezone && fromTz !== toEp.timezone)

        const dep = parseTimeToMinutes(r.reservation_time)
        const arr = parseTimeToMinutes(r.reservation_end_time)
        const fmt = (m: number): string => formatTime(minutesToTimeString(m), locale, timeFormat)

        if (phase === 'single') {
          if (dep == null) continue
          const end = arr != null && arr > dep ? arr : resolveEndMinutes(dep, arr)
          const label = crossesZones && arr != null
            ? `${fmt(dep)} ${tzAbbreviation(fromTz)} – ${fmt(arr)} ${tzAbbreviation(toEp?.timezone, toEp?.local_date)}`
            : `${fmt(dep)}${arr != null ? ` – ${fmt(arr)}` : ''}`
          spans.push({ kind: 'transport', reservation: r, startMinutes: dep, endMinutes: end, timeLabel: label })
        } else if (phase === 'start') {
          if (dep == null) continue
          spans.push({
            kind: 'transport', reservation: r,
            startMinutes: dep, endMinutes: dep + TRANSPORT_STUB_MINUTES,
            timeLabel: `${fmt(dep)}${crossesZones ? ` ${tzAbbreviation(fromTz)}` : ''} →`,
          })
        } else {
          // 'end' phase: the block lands at the arrival's local wall-clock time.
          if (arr == null) continue
          spans.push({
            kind: 'transport', reservation: r,
            startMinutes: Math.max(0, arr - TRANSPORT_STUB_MINUTES), endMinutes: arr,
            timeLabel: `→ ${fmt(arr)}${crossesZones ? ` ${tzAbbreviation(toEp?.timezone, toEp?.local_date)}` : ''}`,
          })
        }
      }
      byDay.set(day.id, spans)
    }
    return byDay
  }, [days, assignments, reservations, locale, timeFormat])

  const allSpans = useMemo(
    () => [...scheduled, ...Array.from(transportSpansByDay.values()).flat()],
    [scheduled, transportSpansByDay]
  )
  const { startHour, endHour } = getVisibleHourRange(allSpans)
  const gridStart = startHour * 60
  const gridHeight = (endHour - startHour) * 60 * PX_PER_MINUTE
  const hours = Array.from({ length: endHour - startHour + 1 }, (_, i) => startHour + i)

  const positionedByDay = useMemo(() => {
    const byDay = new Map<number, ReturnType<typeof layoutOverlappingSpans<DaySpan>>>()
    for (const day of days) {
      const daySpans: DaySpan[] = [
        ...scheduled.filter(s => s.dayId === day.id),
        ...(transportSpansByDay.get(day.id) || []),
      ]
      byDay.set(day.id, layoutOverlappingSpans(daySpans))
    }
    return byDay
  }, [days, scheduled, transportSpansByDay])

  /** Optimistically mirror a time change into the store the way the sidebar does. */
  const setLocalTime = (dayId: number, assignmentId: number, placeTime: string | null, endTime: string | null): void => {
    const state = useTripStore.getState()
    const key = String(dayId)
    tripActions.setAssignments({
      ...state.assignments,
      [key]: (state.assignments[key] || []).map(a =>
        a.id === assignmentId ? { ...a, place: { ...a.place, place_time: placeTime, end_time: endTime } } : a
      ),
    })
  }

  const persistTime = async (dayId: number, assignment: Assignment, placeTime: string | null, endTime: string | null): Promise<void> => {
    const previous = { placeTime: assignment.place?.place_time ?? null, endTime: assignment.place?.end_time ?? null }
    setLocalTime(dayId, assignment.id, placeTime, endTime)
    try {
      await assignmentsApi.updateTime(tripId, assignment.id, { place_time: placeTime, end_time: endTime })
    } catch (err) {
      setLocalTime(dayId, assignment.id, previous.placeTime, previous.endTime)
      toast.error(err instanceof Error ? err.message : t('common.unknownError'))
    }
  }

  const readDragPayload = (e: React.DragEvent): { assignmentId: number; fromDayId: number } | null => {
    const assignmentId = Number(e.dataTransfer.getData('assignmentId') || window.__dragData?.assignmentId)
    const fromDayId = Number(e.dataTransfer.getData('fromDayId') || window.__dragData?.fromDayId)
    window.__dragData = null
    return assignmentId && fromDayId ? { assignmentId, fromDayId } : null
  }

  const handleDrop = async (e: React.DragEvent, dayId: number): Promise<void> => {
    e.preventDefault()
    setDropPreview(null)
    setDraggingId(null)
    const payload = readDragPayload(e)
    if (!payload) return
    const { assignmentId, fromDayId } = payload

    const source = (assignments[String(fromDayId)] || []).find(a => a.id === assignmentId)
    if (!source) return

    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const minutes = snapToSlot(gridStart + (e.clientY - rect.top) / PX_PER_MINUTE)

    // Keep the block's duration when it already has an end time.
    const oldStart = parseTimeToMinutes(source.place?.place_time)
    const oldEnd = parseTimeToMinutes(source.place?.end_time)
    const duration = oldStart != null && oldEnd != null ? oldEnd - oldStart : null
    const newEnd = duration != null ? minutesToTimeString(Math.min(24 * 60 - 1, minutes + duration)) : null

    if (dayId !== fromDayId) {
      try {
        await tripActions.moveAssignment(tripId, assignmentId, fromDayId, dayId)
      } catch (err) {
        toast.error(err instanceof Error ? err.message : t('common.unknownError'))
        return
      }
      const moved = (useTripStore.getState().assignments[String(dayId)] || []).find(a => a.id === assignmentId)
      await persistTime(dayId, moved ?? source, minutesToTimeString(minutes), newEnd)
    } else {
      await persistTime(dayId, source, minutesToTimeString(minutes), newEnd)
    }
  }

  /** Dropping a block onto the unscheduled strip clears its time (and moves days if needed). */
  const handleStripDrop = async (e: React.DragEvent, dayId: number): Promise<void> => {
    e.preventDefault()
    setStripPreviewDayId(null)
    setDraggingId(null)
    const payload = readDragPayload(e)
    if (!payload) return
    const { assignmentId, fromDayId } = payload
    const source = (assignments[String(fromDayId)] || []).find(a => a.id === assignmentId)
    if (!source) return

    if (dayId !== fromDayId) {
      try {
        await tripActions.moveAssignment(tripId, assignmentId, fromDayId, dayId)
      } catch (err) {
        toast.error(err instanceof Error ? err.message : t('common.unknownError'))
        return
      }
    }
    const target = (useTripStore.getState().assignments[String(dayId)] || []).find(a => a.id === assignmentId) ?? source
    await persistTime(dayId, target, null, null)
  }

  const handleDragOverColumn = (e: React.DragEvent, dayId: number): void => {
    if (!canEdit) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    setDropPreview({ dayId, minutes: snapToSlot(gridStart + (e.clientY - rect.top) / PX_PER_MINUTE) })
  }

  const startResize = (e: React.PointerEvent, span: AssignmentSpan): void => {
    if (!canEdit) return
    e.preventDefault()
    e.stopPropagation()
    const startY = e.clientY
    const initialEnd = span.endMinutes
    let latest = initialEnd

    const onMove = (ev: PointerEvent): void => {
      latest = Math.max(
        span.startMinutes + SLOT_MINUTES,
        snapToSlot(initialEnd + (ev.clientY - startY) / PX_PER_MINUTE)
      )
      setResizing({ assignmentId: span.assignment.id, endMinutes: latest })
    }
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      setResizing(null)
      if (latest !== initialEnd) {
        void persistTime(span.dayId, span.assignment, minutesToTimeString(span.startMinutes), minutesToTimeString(latest))
      }
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  const openAssignmentMenu = (e: React.MouseEvent, dayId: number, assignment: Assignment, hasTime: boolean): void => {
    ctxMenu.open(e, [
      ...(canEdit && hasTime
        ? [{ label: t('timeline.menu.removeTime'), icon: Clock, onClick: () => void persistTime(dayId, assignment, null, null) }]
        : []),
      ...(canEdit
        ? [{ label: t('timeline.menu.removeFromDay'), icon: Minus, danger: true, onClick: () => onRemoveAssignment(dayId, assignment.id) }]
        : []),
    ])
  }

  const openDetails = (assignment: Assignment): void => {
    onEditPlace(assignment.place as unknown as Place, assignment.id)
  }

  const dayLabel = (day: Day, index: number): string => {
    const date = day.date ? formatDate(day.date, locale) : null
    return day.title || date || t('timeline.day', { number: day.day_number ?? index + 1 })
  }

  if (days.length === 0) {
    return (
      <div id="trip-timeline-empty" className="flex h-full flex-col items-center justify-center gap-3 text-content-muted">
        <CalendarClock size={32} />
        <span style={{ fontSize: 14 }}>{t('timeline.empty')}</span>
      </div>
    )
  }

  return (
    <div id="trip-timeline" className="h-full overflow-auto bg-surface" style={{ overscrollBehavior: 'contain' }}>
      <div style={{ display: 'flex', minWidth: AXIS_WIDTH + days.length * DAY_MIN_WIDTH }}>

        {/* Time axis — sticky so it survives horizontal scroll on long trips */}
        <div className="bg-surface" style={{ width: AXIS_WIDTH, flexShrink: 0, position: 'sticky', left: 0, zIndex: 3 }}>
          <div style={{ height: HEADER_HEIGHT + UNSCHEDULED_HEIGHT }} />
          <div style={{ position: 'relative', height: gridHeight }}>
            {hours.map(h => (
              <div key={h} className="text-content-faint" style={{
                position: 'absolute', top: (h * 60 - gridStart) * PX_PER_MINUTE - 7,
                right: 8, fontSize: 10, fontVariantNumeric: 'tabular-nums',
              }}>
                {formatTime(`${String(h % 24).padStart(2, '0')}:00`, locale, timeFormat)}
              </div>
            ))}
          </div>
        </div>

        {days.map((day, dayIndex) => {
          const positioned = positionedByDay.get(day.id) || []
          const dayUnscheduled = unscheduled.filter(u => u.dayId === day.id)
          return (
            <div key={day.id} className="border-l border-edge-faint" style={{ flex: 1, minWidth: DAY_MIN_WIDTH }}>

              {/* Day header */}
              <div className="bg-surface border-b border-edge-faint" style={{
                height: HEADER_HEIGHT, position: 'sticky', top: 0, zIndex: 2,
                display: 'flex', alignItems: 'center', padding: '0 12px',
              }}>
                <span className="text-content" style={{ fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {dayLabel(day, dayIndex)}
                </span>
              </div>

              {/* Unscheduled strip — drag a chip into the grid to give it a time,
                  or drag a block back here to take its time away */}
              <div
                id={`timeline-strip-${day.id}`}
                className="bg-surface-tertiary"
                onDragOver={e => { if (canEdit) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setStripPreviewDayId(day.id) } }}
                onDragLeave={() => setStripPreviewDayId(p => (p === day.id ? null : p))}
                onDrop={e => void handleStripDrop(e, day.id)}
                style={{
                  height: UNSCHEDULED_HEIGHT, padding: '6px 8px', overflowY: 'auto',
                  display: 'flex', flexWrap: 'wrap', gap: 4, alignContent: 'flex-start',
                  boxShadow: stripPreviewDayId === day.id ? 'inset 0 0 0 2px var(--accent)' : 'none',
                  transition: 'box-shadow 120ms ease-out',
                }}
              >
                {dayUnscheduled.length === 0 && (
                  <span className="text-content-muted" style={{ fontSize: 10, alignSelf: 'center', margin: '0 auto' }}>
                    {t('timeline.noUnscheduled')}
                  </span>
                )}
                {dayUnscheduled.map(({ assignment }) => (
                  <div
                    key={assignment.id}
                    id={`timeline-unscheduled-${assignment.id}`}
                    draggable={canEdit}
                    onDragStart={e => {
                      e.dataTransfer.setData('assignmentId', String(assignment.id))
                      e.dataTransfer.setData('fromDayId', String(day.id))
                      e.dataTransfer.effectAllowed = 'move'
                      window.__dragData = { assignmentId: String(assignment.id), fromDayId: String(day.id) }
                      setDraggingId(assignment.id)
                    }}
                    onDragEnd={() => { setDraggingId(null); setDropPreview(null); setStripPreviewDayId(null); window.__dragData = null }}
                    onClick={() => onPlaceClick(assignment.place_id, assignment.id)}
                    onDoubleClick={() => openDetails(assignment)}
                    onContextMenu={e => openAssignmentMenu(e, day.id, assignment, false)}
                    className="bg-surface-card text-content hover:shadow-md"
                    style={{
                      display: 'inline-flex', alignItems: 'center', gap: 5,
                      padding: '3px 8px', borderRadius: 8, fontSize: 11, maxWidth: '100%',
                      cursor: canEdit ? 'grab' : 'pointer',
                      opacity: draggingId === assignment.id ? 0.4 : 1,
                      boxShadow: '0 1px 2px rgba(0,0,0,0.08)',
                      transition: 'box-shadow 180ms cubic-bezier(0.23,1,0.32,1)',
                    }}
                  >
                    <PlaceAvatar place={assignment.place} size={14} />
                    <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{assignment.place?.name}</span>
                  </div>
                ))}
              </div>

              {/* Time grid */}
              <div
                id={`timeline-day-${day.id}`}
                style={{ position: 'relative', height: gridHeight }}
                onDragOver={e => handleDragOverColumn(e, day.id)}
                onDragLeave={() => setDropPreview(p => (p?.dayId === day.id ? null : p))}
                onDrop={e => void handleDrop(e, day.id)}
              >
                {hours.slice(0, -1).map(h => (
                  <div key={h} className="border-t border-edge-faint" style={{
                    position: 'absolute', top: (h * 60 - gridStart) * PX_PER_MINUTE, left: 0, right: 0,
                  }} />
                ))}

                {dropPreview?.dayId === day.id && (
                  <div className="text-accent" style={{
                    position: 'absolute', top: (dropPreview.minutes - gridStart) * PX_PER_MINUTE,
                    left: 0, right: 0, borderTop: '2px solid var(--accent)', zIndex: 5,
                    pointerEvents: 'none', fontSize: 9, paddingLeft: 4,
                  }}>
                    {formatTime(minutesToTimeString(dropPreview.minutes), locale, timeFormat)}
                  </div>
                )}

                {positioned.map(({ span, column, columnCount }) => {
                  const widthPct = 100 / columnCount
                  const sharedPos = {
                    left: `calc(${column * widthPct}% + 2px)`,
                    width: `calc(${widthPct}% - 4px)`,
                  }

                  if (span.kind === 'transport') {
                    const r = span.reservation
                    const Icon = RES_ICONS[r.type as keyof typeof RES_ICONS] || RES_ICONS.transport_other
                    const leg = r.__leg
                    const title = leg?.from && leg?.to ? `${leg.from} → ${leg.to}` : r.title
                    return (
                      <div
                        key={`transport-${r.id}-${leg?.index ?? 0}-${span.startMinutes}`}
                        id={`timeline-transport-${r.id}`}
                        onClick={onEditTransport ? () => onEditTransport(r) : undefined}
                        className="border border-edge bg-surface-tertiary"
                        style={{
                          position: 'absolute',
                          top: (span.startMinutes - gridStart) * PX_PER_MINUTE,
                          height: Math.max(18, (span.endMinutes - span.startMinutes) * PX_PER_MINUTE),
                          ...sharedPos,
                          borderRadius: 8, padding: '3px 8px', overflow: 'hidden',
                          borderStyle: 'dashed',
                          cursor: onEditTransport ? 'pointer' : 'default', zIndex: 1,
                        }}
                      >
                        <div className="text-content" style={{ fontSize: 11, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          <Icon size={11} style={{ flexShrink: 0 }} />
                          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{title}</span>
                        </div>
                        <div className="text-content-muted" style={{ fontSize: 10, fontVariantNumeric: 'tabular-nums' }}>
                          {span.timeLabel}
                        </div>
                      </div>
                    )
                  }

                  const liveEnd = resizing?.assignmentId === span.assignment.id ? resizing.endMinutes : span.endMinutes
                  const top = (span.startMinutes - gridStart) * PX_PER_MINUTE
                  const height = Math.max(18, (liveEnd - span.startMinutes) * PX_PER_MINUTE)
                  return (
                    <div
                      key={span.assignment.id}
                      id={`timeline-block-${span.assignment.id}`}
                      draggable={canEdit && resizing == null}
                      onDragStart={e => {
                        e.dataTransfer.setData('assignmentId', String(span.assignment.id))
                        e.dataTransfer.setData('fromDayId', String(day.id))
                        e.dataTransfer.effectAllowed = 'move'
                        window.__dragData = { assignmentId: String(span.assignment.id), fromDayId: String(day.id) }
                        setDraggingId(span.assignment.id)
                      }}
                      onDragEnd={() => { setDraggingId(null); setDropPreview(null); setStripPreviewDayId(null); window.__dragData = null }}
                      onClick={() => onPlaceClick(span.assignment.place_id, span.assignment.id)}
                      onDoubleClick={() => openDetails(span.assignment)}
                      onContextMenu={e => openAssignmentMenu(e, day.id, span.assignment, true)}
                      className="border border-edge-faint hover:shadow-md"
                      style={{
                        position: 'absolute', top, height,
                        ...sharedPos,
                        borderRadius: 8, padding: '4px 8px', overflow: 'hidden',
                        background: 'color-mix(in srgb, var(--accent) 5%, var(--bg-card))',
                        boxShadow: '0 1px 3px rgba(0,0,0,0.1)',
                        cursor: canEdit ? 'grab' : 'pointer', zIndex: 1,
                        opacity: draggingId === span.assignment.id ? 0.4 : 1,
                        transition: 'box-shadow 180ms cubic-bezier(0.23,1,0.32,1)',
                      }}
                    >
                      <div className="text-content" style={{ fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {span.assignment.place?.name}
                      </div>
                      <div className="text-content-muted" style={{ fontSize: 10, fontVariantNumeric: 'tabular-nums' }}>
                        {formatTime(minutesToTimeString(span.startMinutes), locale, timeFormat)}
                        {' – '}
                        {formatTime(minutesToTimeString(liveEnd), locale, timeFormat)}
                      </div>
                      {canEdit && (
                        <div
                          id={`timeline-resize-${span.assignment.id}`}
                          onPointerDown={e => startResize(e, span as AssignmentSpan)}
                          style={{
                            position: 'absolute', bottom: 0, left: 0, right: 0, height: 8,
                            cursor: 'ns-resize', touchAction: 'none',
                          }}
                        />
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          )
        })}
      </div>
      <ContextMenu menu={ctxMenu.menu} onClose={ctxMenu.close} />
    </div>
  )
}
