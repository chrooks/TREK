import express, { Request, Response } from 'express';
import { authenticate } from '../middleware/auth';
import { AuthRequest } from '../types';
import { isAddonEnabled } from '../services/adminService';
import { ALL_SCOPES, SCOPE_INFO } from '../mcp/scopes';
import { ADDON_IDS } from '../addons';
import {
  validateAuthorizeRequest,
  createAuthCode,
  consumeAuthCode,
  saveConsent,
  issueTokens,
  refreshTokens,
  revokeToken,
  verifyPKCE,
  authenticateClient,
  listOAuthClients,
  createOAuthClient,
  deleteOAuthClient,
  rotateOAuthClientSecret,
  listOAuthSessions,
  revokeSession,
  AuthorizeParams,
} from '../services/oauthService';
import { getAppUrl } from '../services/oidcService';

// ---------------------------------------------------------------------------
// Public router: /.well-known, /oauth/token, /oauth/revoke
// ---------------------------------------------------------------------------

export const oauthPublicRouter = express.Router();

// RFC 8414 discovery document
oauthPublicRouter.get('/.well-known/oauth-authorization-server', (_req: Request, res: Response) => {
  const base = (getAppUrl() || '').replace(/\/+$/, '');
  res.json({
    issuer:                                base,
    authorization_endpoint:                `${base}/oauth/authorize`,
    token_endpoint:                        `${base}/oauth/token`,
    revocation_endpoint:                   `${base}/oauth/revoke`,
    response_types_supported:              ['code'],
    grant_types_supported:                 ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported:      ['S256'],
    token_endpoint_auth_methods_supported: ['client_secret_post'],
    scopes_supported:                      ALL_SCOPES,
    scope_descriptions:                    Object.fromEntries(
      ALL_SCOPES.map(s => [s, SCOPE_INFO[s].label])
    ),
  });
});

// Token endpoint — handles authorization_code and refresh_token grants
oauthPublicRouter.post('/oauth/token', (req: Request, res: Response) => {
  // Accept both JSON and application/x-www-form-urlencoded
  const body: Record<string, string> = typeof req.body === 'object' ? req.body : {};
  const { grant_type, code, redirect_uri, client_id, client_secret, code_verifier, refresh_token } = body;

  if (!isAddonEnabled(ADDON_IDS.MCP)) {
    return res.status(403).json({ error: 'mcp_disabled', error_description: 'MCP is not enabled' });
  }

  if (!client_id || !client_secret) {
    return res.status(401).json({ error: 'invalid_client', error_description: 'client_id and client_secret are required' });
  }

  // ---- authorization_code grant ----
  if (grant_type === 'authorization_code') {
    if (!code || !redirect_uri || !code_verifier) {
      return res.status(400).json({ error: 'invalid_request', error_description: 'code, redirect_uri, and code_verifier are required' });
    }

    const pending = consumeAuthCode(code);
    if (!pending) {
      return res.status(400).json({ error: 'invalid_grant', error_description: 'Authorization code is invalid or expired' });
    }

    if (pending.clientId !== client_id) {
      return res.status(400).json({ error: 'invalid_grant', error_description: 'client_id mismatch' });
    }
    if (pending.redirectUri !== redirect_uri) {
      return res.status(400).json({ error: 'invalid_grant', error_description: 'redirect_uri mismatch' });
    }

    // Verify client secret
    if (!authenticateClient(client_id, client_secret)) {
      return res.status(401).json({ error: 'invalid_client', error_description: 'Invalid client credentials' });
    }

    // Verify PKCE
    if (!verifyPKCE(code_verifier, pending.codeChallenge)) {
      return res.status(400).json({ error: 'invalid_grant', error_description: 'PKCE verification failed' });
    }

    const tokens = issueTokens(client_id, pending.userId, pending.scopes);
    return res.json(tokens);
  }

  // ---- refresh_token grant ----
  if (grant_type === 'refresh_token') {
    if (!refresh_token) {
      return res.status(400).json({ error: 'invalid_request', error_description: 'refresh_token is required' });
    }

    const result = refreshTokens(refresh_token, client_id, client_secret);
    if (result.error) {
      return res.status(result.status || 400).json({
        error: result.error,
        error_description: result.error === 'invalid_client' ? 'Invalid client credentials' : 'Refresh token is invalid or expired',
      });
    }

    return res.json(result.tokens);
  }

  return res.status(400).json({ error: 'unsupported_grant_type', error_description: `Unsupported grant_type: ${grant_type}` });
});

// Token revocation endpoint (RFC 7009)
oauthPublicRouter.post('/oauth/revoke', (req: Request, res: Response) => {
  const body: Record<string, string> = typeof req.body === 'object' ? req.body : {};
  const { token, client_id, client_secret } = body;

  if (!token || !client_id || !client_secret) {
    return res.status(400).json({ error: 'invalid_request', error_description: 'token, client_id, and client_secret are required' });
  }

  if (!authenticateClient(client_id, client_secret)) {
    return res.status(401).json({ error: 'invalid_client', error_description: 'Invalid client credentials' });
  }

  revokeToken(token, client_id);
  // RFC 7009 §2.2: always respond 200 even if token was already revoked or not found
  return res.status(200).json({});
});

// ---------------------------------------------------------------------------
// API router: /api/oauth/* — authenticated endpoints used by the SPA
// ---------------------------------------------------------------------------

export const oauthApiRouter = express.Router();

// SPA calls this on page load to validate OAuth params before rendering consent UI
oauthApiRouter.get('/authorize/validate', (req: Request, res: Response) => {
  const params = req.query as Partial<AuthorizeParams>;
  const userId = (req as any).cookies?.trek_session
    ? (() => {
        try {
          const jwt = require('jsonwebtoken');
          const { JWT_SECRET } = require('../config');
          const decoded = jwt.verify((req as any).cookies.trek_session, JWT_SECRET, { algorithms: ['HS256'] }) as { id: number };
          const userRow = require('../db/database').db.prepare('SELECT id FROM users WHERE id = ?').get(decoded.id) as { id: number } | undefined;
          return userRow?.id ?? null;
        } catch { return null; }
      })()
    : null;

  const result = validateAuthorizeRequest(
    {
      response_type:          params.response_type || '',
      client_id:              params.client_id || '',
      redirect_uri:           params.redirect_uri || '',
      scope:                  params.scope || '',
      state:                  params.state,
      code_challenge:         params.code_challenge || '',
      code_challenge_method:  params.code_challenge_method || '',
    },
    userId,
  );

  return res.json(result);
});

// User submits consent (approve or deny) — requires cookie auth
oauthApiRouter.post('/authorize', authenticate, (req: Request, res: Response) => {
  const { user } = req as AuthRequest;
  const {
    client_id, redirect_uri, scope, state,
    code_challenge, code_challenge_method, approved,
  } = req.body as {
    client_id: string;
    redirect_uri: string;
    scope: string;
    state?: string;
    code_challenge: string;
    code_challenge_method: string;
    approved: boolean;
  };

  if (!isAddonEnabled(ADDON_IDS.MCP)) {
    return res.status(403).json({ error: 'MCP is not enabled' });
  }

  if (!approved) {
    // User denied — redirect with error
    const url = new URL(redirect_uri);
    url.searchParams.set('error', 'access_denied');
    url.searchParams.set('error_description', 'User denied the authorization request');
    if (state) url.searchParams.set('state', state);
    return res.json({ redirect: url.toString() });
  }

  // Re-validate all params (server-side re-check after user action)
  const params: AuthorizeParams = {
    response_type: 'code',
    client_id,
    redirect_uri,
    scope,
    state,
    code_challenge,
    code_challenge_method,
  };

  const validation = validateAuthorizeRequest(params, user.id);
  if (!validation.valid) {
    return res.status(400).json({ error: validation.error, error_description: validation.error_description });
  }

  const scopes = validation.scopes!;

  // Store consent so subsequent requests skip the screen
  saveConsent(client_id, user.id, scopes);

  // Issue auth code
  const code = createAuthCode({
    clientId: client_id,
    userId: user.id,
    redirectUri: redirect_uri,
    scopes,
    codeChallenge: code_challenge,
    codeChallengeMethod: 'S256',
  });

  const url = new URL(redirect_uri);
  url.searchParams.set('code', code);
  if (state) url.searchParams.set('state', state);

  return res.json({ redirect: url.toString() });
});

// ---- OAuth client CRUD ----

oauthApiRouter.get('/clients', authenticate, (req: Request, res: Response) => {
  if (!isAddonEnabled(ADDON_IDS.MCP)) return res.status(403).json({ error: 'MCP is not enabled' });
  const { user } = req as AuthRequest;
  return res.json({ clients: listOAuthClients(user.id) });
});

oauthApiRouter.post('/clients', authenticate, (req: Request, res: Response) => {
  if (!isAddonEnabled(ADDON_IDS.MCP)) return res.status(403).json({ error: 'MCP is not enabled' });
  const { user } = req as AuthRequest;
  const { name, redirect_uris, allowed_scopes } = req.body as {
    name: string;
    redirect_uris: string[];
    allowed_scopes: string[];
  };

  const result = createOAuthClient(user.id, name, redirect_uris, allowed_scopes);
  if (result.error) return res.status(result.status || 400).json({ error: result.error });
  return res.status(201).json(result);
});

oauthApiRouter.post('/clients/:id/rotate', authenticate, (req: Request, res: Response) => {
  if (!isAddonEnabled(ADDON_IDS.MCP)) return res.status(403).json({ error: 'MCP is not enabled' });
  const { user } = req as AuthRequest;
  const result = rotateOAuthClientSecret(user.id, req.params.id);
  if (result.error) return res.status(result.status || 400).json({ error: result.error });
  return res.json({ client_secret: result.client_secret });
});

oauthApiRouter.delete('/clients/:id', authenticate, (req: Request, res: Response) => {
  if (!isAddonEnabled(ADDON_IDS.MCP)) return res.status(403).json({ error: 'MCP is not enabled' });
  const { user } = req as AuthRequest;
  const result = deleteOAuthClient(user.id, req.params.id);
  if (result.error) return res.status(result.status || 400).json({ error: result.error });
  return res.json({ success: true });
});

// ---- Active OAuth sessions ----

oauthApiRouter.get('/sessions', authenticate, (req: Request, res: Response) => {
  if (!isAddonEnabled(ADDON_IDS.MCP)) return res.status(403).json({ error: 'MCP is not enabled' });
  const { user } = req as AuthRequest;
  return res.json({ sessions: listOAuthSessions(user.id) });
});

oauthApiRouter.delete('/sessions/:id', authenticate, (req: Request, res: Response) => {
  if (!isAddonEnabled(ADDON_IDS.MCP)) return res.status(403).json({ error: 'MCP is not enabled' });
  const { user } = req as AuthRequest;
  const result = revokeSession(user.id, Number(req.params.id));
  if (result.error) return res.status(result.status || 400).json({ error: result.error });
  return res.json({ success: true });
});
