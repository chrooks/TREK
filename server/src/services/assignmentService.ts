import { db } from '../db/database';
import { loadTagsByPlaceIds, loadParticipantsByAssignmentIds, formatAssignmentWithPlace } from './queryHelpers';
import { AssignmentRow, DayAssignment } from '../types';

export function getAssignmentWithPlace(assignmentId: number | bigint) {
  const a = db.prepare(`
    SELECT da.*, p.id as place_id, p.name as place_name, p.description as place_description,
      p.lat, p.lng, p.address, p.category_id, p.price, p.currency as place_currency,
      COALESCE(da.assignment_time, p.place_time) as place_time,
      COALESCE(da.assignment_end_time, p.end_time) as end_time,
      p.duration_minutes, p.notes as place_notes,
      p.image_url, p.transport_mode, p.google_place_id, p.google_ftid, p.website, p.phone,
      c.name as category_name, c.color as category_color, c.icon as category_icon
    FROM day_assignments da
    JOIN places p ON da.place_id = p.id
    LEFT JOIN categories c ON p.category_id = c.id
    WHERE da.id = ?
  `).get(assignmentId) as AssignmentRow | undefined;

  if (!a) return null;

  const tags = db.prepare(`
    SELECT t.* FROM tags t
    JOIN place_tags pt ON t.id = pt.tag_id
    WHERE pt.place_id = ?
  `).all(a.place_id);

  const participants = db.prepare(`
    SELECT ap.user_id, u.username, u.avatar
    FROM assignment_participants ap
    JOIN users u ON ap.user_id = u.id
    WHERE ap.assignment_id = ?
  `).all(a.id);

  return {
    id: a.id,
    day_id: a.day_id,
    place_id: a.place_id,
    order_index: a.order_index,
    notes: a.notes,
    assignment_time: a.assignment_time ?? null,
    assignment_end_time: a.assignment_end_time ?? null,
    candidate_group: a.candidate_group ?? null,
    is_chosen: a.is_chosen ? 1 : 0,
    participants,
    created_at: a.created_at,
    place: {
      id: a.place_id,
      name: a.place_name,
      description: a.place_description,
      lat: a.lat,
      lng: a.lng,
      address: a.address,
      category_id: a.category_id,
      price: a.price,
      currency: a.place_currency,
      place_time: a.place_time,
      end_time: a.end_time,
      duration_minutes: a.duration_minutes,
      notes: a.place_notes,
      image_url: a.image_url,
      transport_mode: a.transport_mode,
      google_place_id: a.google_place_id,
      google_ftid: a.google_ftid,
      website: a.website,
      phone: a.phone,
      category: a.category_id ? {
        id: a.category_id,
        name: a.category_name,
        color: a.category_color,
        icon: a.category_icon,
      } : null,
      tags,
    }
  };
}

export function listDayAssignments(dayId: string | number) {
  const assignments = db.prepare(`
    SELECT da.*, p.id as place_id, p.name as place_name, p.description as place_description,
      p.lat, p.lng, p.address, p.category_id, p.price, p.currency as place_currency,
      COALESCE(da.assignment_time, p.place_time) as place_time,
      COALESCE(da.assignment_end_time, p.end_time) as end_time,
      p.duration_minutes, p.notes as place_notes,
      p.image_url, p.transport_mode, p.google_place_id, p.google_ftid, p.website, p.phone,
      c.name as category_name, c.color as category_color, c.icon as category_icon
    FROM day_assignments da
    JOIN places p ON da.place_id = p.id
    LEFT JOIN categories c ON p.category_id = c.id
    WHERE da.day_id = ?
    ORDER BY da.order_index ASC, da.created_at ASC
  `).all(dayId) as AssignmentRow[];

  const placeIds = [...new Set(assignments.map(a => a.place_id))];
  const tagsByPlaceId = loadTagsByPlaceIds(placeIds, { compact: true });

  const assignmentIds = assignments.map(a => a.id);
  const participantsByAssignment = loadParticipantsByAssignmentIds(assignmentIds);

  return assignments.map(a => {
    return formatAssignmentWithPlace(a, tagsByPlaceId[a.place_id] || [], participantsByAssignment[a.id] || []);
  });
}

export function dayExists(dayId: string | number, tripId: string | number) {
  return !!db.prepare('SELECT id FROM days WHERE id = ? AND trip_id = ?').get(dayId, tripId);
}

export function placeExists(placeId: string | number, tripId: string | number) {
  return !!db.prepare('SELECT id FROM places WHERE id = ? AND trip_id = ?').get(placeId, tripId);
}

export function createAssignment(dayId: string | number, placeId: string | number, notes: string | null) {
  const maxOrder = db.prepare('SELECT MAX(order_index) as max FROM day_assignments WHERE day_id = ?').get(dayId) as { max: number | null };
  const orderIndex = (maxOrder.max !== null ? maxOrder.max : -1) + 1;

  const result = db.prepare(
    'INSERT INTO day_assignments (day_id, place_id, order_index, notes) VALUES (?, ?, ?, ?)'
  ).run(dayId, placeId, orderIndex, notes || null);

  return getAssignmentWithPlace(result.lastInsertRowid);
}

export function assignmentExistsInDay(id: string | number, dayId: string | number, tripId: string | number) {
  return !!db.prepare(
    'SELECT da.id FROM day_assignments da JOIN days d ON da.day_id = d.id WHERE da.id = ? AND da.day_id = ? AND d.trip_id = ?'
  ).get(id, dayId, tripId);
}

export function deleteAssignment(id: string | number) {
  db.prepare('DELETE FROM day_assignments WHERE id = ?').run(id);
}

export function reorderAssignments(dayId: string | number, orderedIds: number[]) {
  const update = db.prepare('UPDATE day_assignments SET order_index = ? WHERE id = ? AND day_id = ?');
  db.exec('BEGIN');
  try {
    orderedIds.forEach((id: number, index: number) => {
      update.run(index, id, dayId);
    });
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export function getAssignmentForTrip(id: string | number, tripId: string | number) {
  return db.prepare(`
    SELECT da.* FROM day_assignments da
    JOIN days d ON da.day_id = d.id
    WHERE da.id = ? AND d.trip_id = ?
  `).get(id, tripId) as DayAssignment | undefined;
}

export function moveAssignment(id: string | number, newDayId: string | number, orderIndex: number, oldDayId: number) {
  db.prepare('UPDATE day_assignments SET day_id = ?, order_index = ? WHERE id = ?').run(newDayId, orderIndex || 0, id);
  const updated = getAssignmentWithPlace(Number(id));
  return { assignment: updated, oldDayId };
}

export function getParticipants(assignmentId: string | number) {
  return db.prepare(`
    SELECT ap.user_id, u.username, u.avatar
    FROM assignment_participants ap
    JOIN users u ON ap.user_id = u.id
    WHERE ap.assignment_id = ?
  `).all(assignmentId);
}

export function updateTime(id: string | number, placeTime: string | null, endTime: string | null) {
  db.prepare('UPDATE day_assignments SET assignment_time = ?, assignment_end_time = ? WHERE id = ?')
    .run(placeTime ?? null, endTime ?? null, id);

  // Auto-sort: reorder timed assignments chronologically within the day
  if (placeTime) {
    const assignment = db.prepare('SELECT day_id FROM day_assignments WHERE id = ?').get(id) as { day_id: number } | undefined;
    if (assignment) {
      const dayAssignments = db.prepare(`
        SELECT da.id, COALESCE(da.assignment_time, p.place_time) as effective_time
        FROM day_assignments da
        JOIN places p ON da.place_id = p.id
        WHERE da.day_id = ?
        ORDER BY da.order_index ASC
      `).all(assignment.day_id) as { id: number; effective_time: string | null }[];

      // Separate timed and untimed, sort timed by time
      const timed = dayAssignments.filter(a => a.effective_time).sort((a, b) => {
        const ta = a.effective_time!.includes(':') ? a.effective_time! : '99:99';
        const tb = b.effective_time!.includes(':') ? b.effective_time! : '99:99';
        return ta.localeCompare(tb);
      });
      const untimed = dayAssignments.filter(a => !a.effective_time);

      // Interleave: timed in chronological order, untimed keep relative position
      const reordered = [...timed, ...untimed];
      const update = db.prepare('UPDATE day_assignments SET order_index = ? WHERE id = ?');
      reordered.forEach((a, i) => update.run(i, a.id));
    }
  }

  return getAssignmentWithPlace(Number(id));
}

export function setParticipants(assignmentId: string | number, userIds: number[]) {
  db.prepare('DELETE FROM assignment_participants WHERE assignment_id = ?').run(assignmentId);
  if (userIds.length > 0) {
    const insert = db.prepare('INSERT OR IGNORE INTO assignment_participants (assignment_id, user_id) VALUES (?, ?)');
    for (const userId of userIds) insert.run(assignmentId, userId);
  }

  return db.prepare(`
    SELECT ap.user_id, u.username, u.avatar
    FROM assignment_participants ap
    JOIN users u ON ap.user_id = u.id
    WHERE ap.assignment_id = ?
  `).all(assignmentId);
}

/**
 * Candidate places (#2): link same-day assignments as alternatives for one
 * timeslot. The group id is the lowest member id — stable, needs no sequence.
 * Returns the updated assignments. Throws on members from different days.
 */
export function createCandidateGroup(tripId: string | number, assignmentIds: number[]) {
  const members = assignmentIds
    .map(id => getAssignmentForTrip(id, tripId))
    .filter((a): a is NonNullable<typeof a> => Boolean(a));
  if (members.length !== assignmentIds.length) throw new Error('Assignment not found');
  const dayIds = new Set(members.map(m => m.day_id));
  if (dayIds.size !== 1) throw new Error('Candidates must be on the same day');

  // Merging into an existing group keeps that group's id.
  const groupId = Math.min(...members.map(m => (m as any).candidate_group ?? m.id));
  const update = db.prepare('UPDATE day_assignments SET candidate_group = ?, is_chosen = 0 WHERE id = ? OR candidate_group = ?');
  for (const m of members) update.run(groupId, m.id, (m as any).candidate_group ?? -1);
  return listGroupMembers(groupId);
}

/** Pick the winner: it stays visible, the rest collapse behind it. */
export function chooseCandidate(tripId: string | number, assignmentId: string | number) {
  const assignment = getAssignmentForTrip(assignmentId, tripId) as any;
  if (!assignment) throw new Error('Assignment not found');
  if (assignment.candidate_group == null) throw new Error('Assignment is not in a candidate group');
  db.prepare('UPDATE day_assignments SET is_chosen = CASE WHEN id = ? THEN 1 ELSE 0 END WHERE candidate_group = ?')
    .run(assignment.id, assignment.candidate_group);
  return listGroupMembers(assignment.candidate_group);
}

/** Dissolve a group: members become ordinary independent assignments again. */
export function dissolveCandidateGroup(tripId: string | number, groupId: string | number) {
  const members = listGroupMembers(groupId).filter(m =>
    getAssignmentForTrip((m as any).id, tripId)
  );
  if (members.length === 0) throw new Error('Candidate group not found');
  db.prepare('UPDATE day_assignments SET candidate_group = NULL, is_chosen = 0 WHERE candidate_group = ?').run(groupId);
  return members.map(m => ({ ...(m as any), candidate_group: null, is_chosen: 0 }));
}

function listGroupMembers(groupId: string | number) {
  const rows = db.prepare('SELECT id FROM day_assignments WHERE candidate_group = ? ORDER BY id').all(groupId) as { id: number }[];
  return rows.map(r => getAssignmentWithPlace(r.id));
}
