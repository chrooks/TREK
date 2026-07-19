import { test, expect } from '@playwright/test'

// The day timeline surface (TripTimeline): create a trip with dates, add a
// place via the API using the app's own session, open the Timeline tab, and
// prove the grid renders, an unscheduled chip drags into the grid to gain a
// time, and the resulting block sits in the day column.
test('timeline tab schedules a place by drag', async ({ page }) => {
  await page.goto('/dashboard')

  // First run shows a supporter thank-you dialog — dismiss it if present.
  const thanks = page.locator('div[role="presentation"].fixed.inset-0')
  if (await thanks.isVisible({ timeout: 3000 }).catch(() => false)) {
    await thanks.locator('svg').first().click()
    await thanks.waitFor({ state: 'hidden' }).catch(() => {})
  }

  // Create a trip WITH dates so days exist.
  await page.locator('.add-trip-card').click()
  const title = `E2E Timeline ${Date.now()}`
  await page.getByPlaceholder('e.g. Summer in Japan').fill(title)
  // Days can be created by count alone — no need to drive the date picker.
  await page.getByText('Number of Days').locator('..').locator('input').fill('3')
  await page.getByRole('button', { name: 'Create New Trip' }).click()

  await page.getByText(title).first().click()
  await expect(page).toHaveURL(/\/trips\/\d+/)
  const tripId = Number(page.url().match(/\/trips\/(\d+)/)?.[1])

  // Seed one place + one untimed assignment + one timed flight through the API
  // with the browser's own session cookies — faster and more reliable than
  // driving the map UI.
  const seeded = await page.evaluate(async id => {
    const daysRes = await fetch(`/api/trips/${id}/days`, { credentials: 'include' })
    const days = await daysRes.json()
    const dayId = (Array.isArray(days) ? days : days.days)[0].id
    const placeRes = await fetch(`/api/trips/${id}/places`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Universal Studios', lat: 28.474, lng: -81.467 }),
    })
    const place = await placeRes.json()
    const placeId = place.id ?? place.place?.id
    await fetch(`/api/trips/${id}/days/${dayId}/assignments`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ place_id: placeId }),
    })
    await fetch(`/api/trips/${id}/reservations`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'LA Trip Flight', type: 'flight', status: 'confirmed',
        day_id: dayId, reservation_time: '07:00', reservation_end_time: '09:37',
      }),
    })
    // A second, untimed place whose linked BOOKING carries the time — must
    // auto-schedule on the timeline at the booking's time.
    const place2Res = await fetch(`/api/trips/${id}/places`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'SoFi Stadium Tour', lat: 33.953, lng: -118.339 }),
    })
    const place2 = await place2Res.json()
    const assignment2Res = await fetch(`/api/trips/${id}/days/${dayId}/assignments`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ place_id: place2.id ?? place2.place?.id }),
    })
    const assignment2 = await assignment2Res.json()
    await fetch(`/api/trips/${id}/reservations`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'SoFi Stadium Tour', type: 'tour', status: 'confirmed',
        day_id: dayId, assignment_id: assignment2.id ?? assignment2.assignment?.id,
        reservation_time: '14:00', reservation_end_time: '16:00',
      }),
    })
    return { dayId, placeId }
  }, tripId)

  // Into the Timeline tab (reload so the freshly seeded assignment is loaded).
  await page.reload()
  await page.getByRole('button', { name: 'Timeline' }).click()
  await expect(page.locator('#trip-timeline')).toBeVisible({ timeout: 20_000 })

  // The untimed assignment waits in the unscheduled strip — but ONLY the one
  // without a booking. The booked place auto-schedules at its booking's time.
  const chip = page.locator(`[id^="timeline-unscheduled-"]`)
  await expect(chip).toHaveCount(1)
  await expect(chip).toContainText('Universal Studios')
  const bookedBlock = page.locator('[id^="timeline-block-"]', { hasText: 'SoFi Stadium Tour' })
  await expect(bookedBlock).toBeVisible()
  await expect(bookedBlock).toContainText('2:00 PM – 4:00 PM')

  // Drag it into the day's grid to give it a time.
  const grid = page.locator(`#timeline-day-${seeded.dayId}`)
  await expect(grid).toBeVisible()
  await chip.dragTo(grid, { targetPosition: { x: 100, y: 240 } })

  // It becomes a positioned block with a time range, and the strip empties.
  const universalBlock = page.locator('[id^="timeline-block-"]', { hasText: 'Universal Studios' })
  await expect(universalBlock).toBeVisible()
  await expect(universalBlock).toContainText('–')
  await expect(page.locator('[id^="timeline-unscheduled-"]')).toHaveCount(0)

  // The time persisted: reload and the block is still scheduled.
  await page.reload()
  await page.getByRole('button', { name: 'Timeline' }).click()
  await expect(page.locator('[id^="timeline-block-"]', { hasText: 'Universal Studios' })).toBeVisible({ timeout: 20_000 })
  await expect(page.locator('[id^="timeline-unscheduled-"]')).toHaveCount(0)

  // The seeded flight renders as a read-only transport block at its times.
  const transport = page.locator('[id^="timeline-transport-"]')
  await expect(transport).toBeVisible()
  await expect(transport).toContainText('LA Trip Flight')

  // Double-click the block → the place details modal opens.
  await page.locator('[id^="timeline-block-"]', { hasText: 'Universal Studios' }).dblclick()
  await expect(page.getByText('Edit Place')).toBeVisible()
  await expect(page.getByPlaceholder('e.g. Eiffel Tower')).toHaveValue('Universal Studios')
  await page.keyboard.press('Escape')

  // Right-click the block → context menu → Remove time puts it back in the strip.
  await page.locator('[id^="timeline-block-"]', { hasText: 'Universal Studios' }).click({ button: 'right' })
  await page.getByText('Remove time').click()
  await expect(page.locator('[id^="timeline-unscheduled-"]')).toHaveCount(1)
  await expect(page.locator('[id^="timeline-block-"]', { hasText: 'Universal Studios' })).toHaveCount(0)

  // Drag the chip back into the grid, then drag the block onto the strip — the
  // drag-out affordance also unschedules.
  const chip2 = page.locator('[id^="timeline-unscheduled-"]')
  await chip2.dragTo(page.locator(`#timeline-day-${seeded.dayId}`), { targetPosition: { x: 100, y: 240 } })
  const block2 = page.locator('[id^="timeline-block-"]', { hasText: 'Universal Studios' })
  await expect(block2).toBeVisible()
  await block2.dragTo(page.locator(`#timeline-strip-${seeded.dayId}`))
  await expect(page.locator('[id^="timeline-unscheduled-"]')).toHaveCount(1)
  await expect(page.locator('[id^="timeline-block-"]', { hasText: 'Universal Studios' })).toHaveCount(0)

  // Candidate groups (#2): drag the Universal chip onto the booked SoFi block —
  // they become alternatives for one slot; the chip collapses behind the block.
  const chip3 = page.locator('[id^="timeline-unscheduled-"]')
  const sofiBlock = page.locator('[id^="timeline-block-"]', { hasText: 'SoFi Stadium Tour' })
  // dragTo drops on the column behind the block; dispatch the HTML5 sequence
  // at the block directly so the drop-onto-block path is what's exercised.
  const dt = await page.evaluateHandle(() => new DataTransfer())
  await chip3.dispatchEvent('dragstart', { dataTransfer: dt })
  await sofiBlock.dispatchEvent('dragover', { dataTransfer: dt })
  await sofiBlock.dispatchEvent('drop', { dataTransfer: dt })
  await chip3.dispatchEvent('dragend', { dataTransfer: dt }).catch(() => {})
  await expect(page.getByText('Grouped as candidates')).toBeVisible()
  await expect(page.locator('[id^="timeline-unscheduled-"]')).toHaveCount(0)
  const groupBadge = page.locator('[id^="timeline-candidates-"]')
  await expect(groupBadge).toContainText('2?')

  // Open the chooser and pick Universal — it becomes the visible winner with a
  // +1 collapsed-alternate badge.
  await groupBadge.click()
  await page.getByText('Universal Studios', { exact: false }).last().click()
  await expect(page.locator('[id^="timeline-block-"]', { hasText: 'Universal Studios' })).toBeVisible()
  await expect(page.locator('[id^="timeline-candidates-"]')).toContainText('+1')

  // Ungroup dissolves the alternatives back to normal items.
  await page.locator('[id^="timeline-candidates-"]').click()
  await page.getByText('Ungroup candidates').click()
  await expect(page.locator('[id^="timeline-candidates-"]')).toHaveCount(0)

  // Right-click chip → Remove from day deletes the assignment entirely.
  await page.locator('[id^="timeline-unscheduled-"]').first().click({ button: 'right' })
  await page.getByText('Remove from day').click()

  // Visual artifacts for design review (test-results/ is ephemeral output).
  await page.screenshot({ path: 'test-results/timeline-light.png', fullPage: false })
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.evaluate(() => document.documentElement.classList.add('dark'))
  await page.screenshot({ path: 'test-results/timeline-dark.png', fullPage: false })
})
