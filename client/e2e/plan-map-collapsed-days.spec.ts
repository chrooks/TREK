import { test, expect } from '@playwright/test'

// Collapsing days in the Day plan sidebar hides their places from the map
// (upstream behaviour). The map must say so and offer a way back, so the
// marker count never silently disagrees with the "All N" places list.
test('plan map shows a signifier for places hidden by collapsed days and restores them', async ({ page }) => {
  await page.goto('/dashboard')

  const thanks = page.locator('div[role="presentation"].fixed.inset-0')
  if (await thanks.isVisible({ timeout: 3000 }).catch(() => false)) {
    await thanks.locator('svg').first().click()
    await thanks.waitFor({ state: 'hidden' }).catch(() => {})
  }

  await page.locator('.add-trip-card').click()
  const title = `E2E MapCollapsed ${Date.now()}`
  await page.getByPlaceholder('e.g. Summer in Japan').fill(title)
  await page.getByText('Number of Days').locator('..').locator('input').fill('2')
  await page.getByRole('button', { name: 'Create New Trip' }).click()

  await page.getByText(title).first().click()
  await expect(page).toHaveURL(/\/trips\/\d+/)
  const tripId = Number(page.url().match(/\/trips\/(\d+)/)?.[1])

  // Three places with coordinates: two scheduled (one per day), one in the pool.
  await page.evaluate(async id => {
    const post = (path: string, body: unknown) => fetch(path, {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }).then(r => r.json())
    const dres = await fetch(`/api/trips/${id}/days`, { credentials: 'include' }).then(r => r.json())
    const days = Array.isArray(dres) ? dres : dres.days
    const pts = [['Ferry Building', 37.7955, -122.3937], ['Salesforce Tower', 37.7897, -122.3972], ['Chinatown Gate', 37.7908, -122.4056]]
    const ids: number[] = []
    for (const [name, lat, lng] of pts) ids.push((await post(`/api/trips/${id}/places`, { name, lat, lng })).place.id)
    await post(`/api/trips/${id}/days/${days[0].id}/assignments`, { place_id: ids[0] })
    await post(`/api/trips/${id}/days/${days[1].id}/assignments`, { place_id: ids[1] })
  }, tripId)

  await page.reload()
  // Either renderer (Leaflet or MapLibre) draws one DOM element per place marker.
  const markers = page.locator('.maplibregl-marker, .mapboxgl-marker, .leaflet-marker-icon')
  await expect(markers).toHaveCount(3)
  const signifier = page.getByTestId('map-hidden-places')
  await expect(signifier).toHaveCount(0)

  await page.getByRole('button', { name: 'Collapse all days' }).click()
  await expect(markers).toHaveCount(1)
  await expect(signifier).toContainText('2 places hidden by collapsed days')

  // The collapsed state survives a reload (sessionStorage); so must the signifier.
  await page.reload()
  await expect(markers).toHaveCount(1)
  await expect(signifier).toBeVisible()

  await signifier.click()
  await expect(markers).toHaveCount(3)
  await expect(signifier).toHaveCount(0)
})
