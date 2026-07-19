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

  // Seed one place + one untimed assignment through the API with the browser's
  // own session cookies — faster and more reliable than driving the map UI.
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
    return { dayId, placeId }
  }, tripId)

  // Into the Timeline tab (reload so the freshly seeded assignment is loaded).
  await page.reload()
  await page.getByRole('button', { name: 'Timeline' }).click()
  await expect(page.locator('#trip-timeline')).toBeVisible({ timeout: 20_000 })

  // The untimed assignment waits in the unscheduled strip.
  const chip = page.locator(`[id^="timeline-unscheduled-"]`)
  await expect(chip).toBeVisible()
  await expect(chip).toContainText('Universal Studios')

  // Drag it into the day's grid to give it a time.
  const grid = page.locator(`#timeline-day-${seeded.dayId}`)
  await expect(grid).toBeVisible()
  await chip.dragTo(grid, { targetPosition: { x: 100, y: 240 } })

  // It becomes a positioned block with a time range, and the strip empties.
  const block = page.locator('[id^="timeline-block-"]')
  await expect(block).toBeVisible()
  await expect(block).toContainText('Universal Studios')
  await expect(block).toContainText('–')
  await expect(page.locator('[id^="timeline-unscheduled-"]')).toHaveCount(0)

  // The time persisted: reload and the block is still scheduled.
  await page.reload()
  await page.getByRole('button', { name: 'Timeline' }).click()
  await expect(page.locator('[id^="timeline-block-"]')).toBeVisible({ timeout: 20_000 })
  await expect(page.locator('[id^="timeline-unscheduled-"]')).toHaveCount(0)

  // Visual artifacts for design review (test-results/ is ephemeral output).
  await page.screenshot({ path: 'test-results/timeline-light.png', fullPage: false })
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.evaluate(() => document.documentElement.classList.add('dark'))
  await page.screenshot({ path: 'test-results/timeline-dark.png', fullPage: false })
})
