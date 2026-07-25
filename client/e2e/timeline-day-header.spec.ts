import { test, expect } from '@playwright/test'

// A day with a custom title must still say WHEN it is: the header shows the
// title on top and the weekday+date underneath.
test('timeline day header shows weekday and date under a titled day', async ({ page }) => {
  await page.goto('/dashboard')

  const thanks = page.locator('div[role="presentation"].fixed.inset-0')
  if (await thanks.isVisible({ timeout: 3000 }).catch(() => false)) {
    await thanks.locator('svg').first().click()
    await thanks.waitFor({ state: 'hidden' }).catch(() => {})
  }

  await page.locator('.add-trip-card').click()
  const title = `E2E DayHeader ${Date.now()}`
  await page.getByPlaceholder('e.g. Summer in Japan').fill(title)
  await page.getByText('Number of Days').locator('..').locator('input').fill('2')
  await page.getByRole('button', { name: 'Create New Trip' }).click()

  await page.getByText(title).first().click()
  await expect(page).toHaveURL(/\/trips\/\d+/)
  const tripId = Number(page.url().match(/\/trips\/(\d+)/)?.[1])

  // Dates come from the trip; the title is set per day. Both are needed for
  // the header to have a title AND a date to show under it.
  await page.evaluate(async id => {
    await fetch(`/api/trips/${id}`, {
      method: 'PUT',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ start_date: '2026-08-03', end_date: '2026-08-04' }),
    })
    const res = await fetch(`/api/trips/${id}/days`, { credentials: 'include' })
    const body = await res.json()
    const day = (Array.isArray(body) ? body : body.days)[0]
    await fetch(`/api/trips/${id}/days/${day.id}`, {
      method: 'PUT',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Arrival Day' }),
    })
  }, tripId)

  await page.reload()
  await page.getByRole('button', { name: /Timeline/i }).click()

  const header = page.locator('#trip-timeline').getByText('Arrival Day').locator('..')
  await expect(header).toContainText('Arrival Day')
  // 2026-08-03 is a Monday.
  await expect(header).toContainText(/Mon/)
  await expect(header).toContainText(/Aug/)
})
