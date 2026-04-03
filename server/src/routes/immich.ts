import express, { Request, Response, NextFunction } from 'express';
import { db, canAccessTrip } from '../db/database';
import { authenticate } from '../middleware/auth';
import { broadcast } from '../websocket';
import { AuthRequest } from '../types';
import { consumeEphemeralToken } from '../services/ephemeralTokens';
import { getClientIp } from '../services/auditLog';
import {
  getConnectionSettings,
  saveImmichSettings,
  testConnection,
  getConnectionStatus,
  browseTimeline,
  searchPhotos,
  listTripPhotos,
  addTripPhotos,
  removeTripPhoto,
  togglePhotoSharing,
  getAssetInfo,
  proxyThumbnail,
  proxyOriginal,
  isValidAssetId,
  listAlbums,
  listAlbumLinks,
  createAlbumLink,
  deleteAlbumLink,
  syncAlbumAssets,
} from '../services/immichService';

const router = express.Router();

// ── Dual auth middleware (JWT or ephemeral token for <img> src) ─────────────

function authFromQuery(req: Request, res: Response, next: NextFunction) {
  const queryToken = req.query.token as string | undefined;
  if (queryToken) {
    const userId = consumeEphemeralToken(queryToken, 'immich');
    if (!userId) return res.status(401).send('Invalid or expired token');
    const user = db.prepare('SELECT id, username, email, role, mfa_enabled FROM users WHERE id = ?').get(userId) as any;
    if (!user) return res.status(401).send('User not found');
    (req as AuthRequest).user = user;
    return next();
  }
  return (authenticate as any)(req, res, next);
}

// ── Immich Connection Settings ─────────────────────────────────────────────

router.get('/settings', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  res.json(getConnectionSettings(authReq.user.id));
});

router.put('/settings', authenticate, async (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { immich_url, immich_api_key } = req.body;
  const result = await saveImmichSettings(authReq.user.id, immich_url, immich_api_key, getClientIp(req));
  if (!result.success) return res.status(400).json({ error: result.error });
  if (result.warning) return res.json({ success: true, warning: result.warning });
  res.json({ success: true });
});

router.get('/status', authenticate, async (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const creds = getImmichCredentials(authReq.user.id);
  if (!creds) {
    return res.json({ connected: false, error: 'Not configured' });
  }
  try {
    const resp = await fetch(`${creds.immich_url}/api/users/me`, {
      headers: { 'x-api-key': creds.immich_api_key, 'Accept': 'application/json' },
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) return res.json({ connected: false, error: `HTTP ${resp.status}` });
    const data = await resp.json() as { name?: string; email?: string };
    res.json({ connected: true, user: { name: data.name, email: data.email } });
  } catch (err: unknown) {
    res.json({ connected: false, error: err instanceof Error ? err.message : 'Connection failed' });
  }
});

// Test connection with provided credentials only
router.post('/test', authenticate, async (req: Request, res: Response) => {
  const { immich_url, immich_api_key } = req.body as { immich_url?: string; immich_api_key?: string };
  const url = String(immich_url || '').trim();
  const apiKey = String(immich_api_key || '').trim();
  if (!url || !apiKey) return res.json({ connected: false, error: 'URL and API key required' });
  const ssrf = await checkSsrf(url);
  if (!ssrf.allowed) return res.json({ connected: false, error: ssrf.error ?? 'Invalid Immich URL' });
  try {
    const resp = await fetch(`${url}/api/users/me`, {
      headers: { 'x-api-key': apiKey, 'Accept': 'application/json' },
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) return res.json({ connected: false, error: `HTTP ${resp.status}` });
    const data = await resp.json() as { name?: string; email?: string };
    res.json({ connected: true, user: { name: data.name, email: data.email } });
  } catch (err: unknown) {
    res.json({ connected: false, error: err instanceof Error ? err.message : 'Connection failed' });
  }
});

// ── Browse Immich Library (for photo picker) ───────────────────────────────

router.get('/browse', authenticate, async (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const result = await browseTimeline(authReq.user.id);
  if (result.error) return res.status(result.status!).json({ error: result.error });
  res.json({ buckets: result.buckets });
});

router.post('/search', authenticate, async (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { from, to } = req.body;
  const result = await searchPhotos(authReq.user.id, from, to);
  if (result.error) return res.status(result.status!).json({ error: result.error });
  res.json({ assets: result.assets });
});

// ── Asset Details ──────────────────────────────────────────────────────────

router.get('/assets/:assetId/info', authenticate, async (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { assetId } = req.params;
  if (!isValidAssetId(assetId)) return res.status(400).json({ error: 'Invalid asset ID' });
  const result = await getAssetInfo(authReq.user.id, assetId);
  if (result.error) return res.status(result.status!).json({ error: result.error });
  res.json(result.data);
});

// ── Proxy Immich Assets ────────────────────────────────────────────────────

router.get('/assets/:assetId/thumbnail', authFromQuery, async (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { assetId } = req.params;
  if (!isValidAssetId(assetId)) return res.status(400).send('Invalid asset ID');
  const result = await proxyThumbnail(authReq.user.id, assetId);
  if (result.error) return res.status(result.status!).send(result.error);
  res.set('Content-Type', result.contentType!);
  res.set('Cache-Control', 'public, max-age=86400');
  res.send(result.buffer);
});

router.get('/assets/:assetId/original', authFromQuery, async (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { assetId } = req.params;
  if (!isValidAssetId(assetId)) return res.status(400).send('Invalid asset ID');
  const result = await proxyOriginal(authReq.user.id, assetId);
  if (result.error) return res.status(result.status!).send(result.error);
  res.set('Content-Type', result.contentType!);
  res.set('Cache-Control', 'public, max-age=86400');
  res.send(result.buffer);
});

// ── Album Linking ──────────────────────────────────────────────────────────

router.get('/albums', authenticate, async (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const creds = getImmichCredentials(authReq.user.id);
  if (!creds) return res.status(400).json({ error: 'Immich not configured' });

  try {
    const resp = await fetch(`${creds.immich_url}/api/albums`, {
      headers: { 'x-api-key': creds.immich_api_key, 'Accept': 'application/json' },
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) return res.status(resp.status).json({ error: 'Failed to fetch albums' });
    const albums = (await resp.json() as any[]).map((a: any) => ({
      id: a.id,
      albumName: a.albumName,
      assetCount: a.assetCount || 0,
      startDate: a.startDate,
      endDate: a.endDate,
      albumThumbnailAssetId: a.albumThumbnailAssetId,
    }));
    res.json({ albums });
  } catch {
    res.status(502).json({ error: 'Could not reach Immich' });
  }
});

router.post('/trips/:tripId/album-links', authenticate, async (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId } = req.params;
  if (!canAccessTrip(tripId, authReq.user.id)) return res.status(404).json({ error: 'Trip not found' });
  const { album_id, album_name } = req.body;
  if (!album_id) return res.status(400).json({ error: 'album_id required' });

  try {
    db.prepare(
      'INSERT OR IGNORE INTO trip_album_links (trip_id, user_id, provider, album_id, album_name) VALUES (?, ?, ?, ?, ?)'
    ).run(tripId, authReq.user.id, 'immich', album_id, album_name || '');
    res.json({ success: true });
  } catch (err: any) {
    res.status(400).json({ error: 'Album already linked' });
  }
});

router.post('/trips/:tripId/album-links/:linkId/sync', authenticate, async (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId, linkId } = req.params;

  const link = db.prepare("SELECT * FROM trip_album_links WHERE id = ? AND trip_id = ? AND user_id = ? AND provider = 'immich'")
    .get(linkId, tripId, authReq.user.id) as any;
  if (!link) return res.status(404).json({ error: 'Album link not found' });

  const creds = getImmichCredentials(authReq.user.id);
  if (!creds) return res.status(400).json({ error: 'Immich not configured' });

  try {
    const resp = await fetch(`${creds.immich_url}/api/albums/${link.album_id}`, {
      headers: { 'x-api-key': creds.immich_api_key, 'Accept': 'application/json' },
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) return res.status(resp.status).json({ error: 'Failed to fetch album' });
    const albumData = await resp.json() as { assets?: any[] };
    const assets = (albumData.assets || []).filter((a: any) => a.type === 'IMAGE');

    const insert = db.prepare(
      "INSERT OR IGNORE INTO trip_photos (trip_id, user_id, asset_id, provider, shared) VALUES (?, ?, ?, 'immich', 1)"
    );
    let added = 0;
    for (const asset of assets) {
      const r = insert.run(tripId, authReq.user.id, asset.id);
      if (r.changes > 0) added++;
    }

    db.prepare('UPDATE trip_album_links SET last_synced_at = CURRENT_TIMESTAMP WHERE id = ?').run(linkId);

    res.json({ success: true, added, total: assets.length });
    if (added > 0) {
      broadcast(tripId, 'memories:updated', { userId: authReq.user.id }, req.headers['x-socket-id'] as string);
    }
  } catch {
    res.status(502).json({ error: 'Could not reach Immich' });
  }
});

export default router;
