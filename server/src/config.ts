import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const dataDir = path.resolve(__dirname, '../data');

// JWT_SECRET is always managed by the server — auto-generated on first start and
// persisted to data/.jwt_secret. Use the admin panel to rotate it; do not set it
// via environment variable (env var would override a rotation on next restart).
const jwtSecretFile = path.join(dataDir, '.jwt_secret');
let _jwtSecret: string;

try {
  _jwtSecret = fs.readFileSync(jwtSecretFile, 'utf8').trim();
} catch {
  _jwtSecret = crypto.randomBytes(32).toString('hex');
  try {
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(jwtSecretFile, _jwtSecret, { mode: 0o600 });
    console.log('Generated and saved JWT secret to', jwtSecretFile);
  } catch (writeErr: unknown) {
    console.warn('WARNING: Could not persist JWT secret to disk:', writeErr instanceof Error ? writeErr.message : writeErr);
    console.warn('Sessions will reset on server restart.');
  }
}

// export let so TypeScript's CJS output keeps exports.JWT_SECRET live
// (generates `exports.JWT_SECRET = JWT_SECRET = newVal` inside updateJwtSecret)
export let JWT_SECRET = _jwtSecret;

// Called by the admin rotate-jwt-secret endpoint to update the in-process
// binding that all middleware and route files reference.
export function updateJwtSecret(newSecret: string): void {
  JWT_SECRET = newSecret;
}

// ENCRYPTION_KEY is used to derive at-rest encryption keys for stored secrets
// (API keys, MFA TOTP secrets, SMTP password, OIDC client secret, etc.).
// Keeping it separate from JWT_SECRET means you can rotate session tokens without
// invalidating all stored encrypted data, and vice-versa.
//
// Resolution order:
//   1. ENCRYPTION_KEY env var — explicit, always takes priority.
//   2. data/.jwt_secret — used automatically for existing installs that upgrade
//      without setting ENCRYPTION_KEY; encrypted data stays readable with no
//      manual intervention required.
//   3. data/.encryption_key — auto-generated and persisted on first start of a
//      fresh install where neither of the above is available.
let _encryptionKey: string = process.env.ENCRYPTION_KEY || '';

if (!_encryptionKey) {
  // Fallback 1: existing install — reuse the JWT secret so previously encrypted
  // values remain readable after an upgrade.
  try {
    _encryptionKey = fs.readFileSync(jwtSecretFile, 'utf8').trim();
    console.warn('WARNING: ENCRYPTION_KEY is not set. Falling back to JWT secret for at-rest encryption.');
    console.warn('Set ENCRYPTION_KEY explicitly to decouple encryption from JWT signing (recommended).');
  } catch {
    // JWT secret not found — must be a fresh install, fall through.
  }
}

if (!_encryptionKey) {
  // Fallback 2: fresh install — auto-generate a dedicated key.
  const encKeyFile = path.join(dataDir, '.encryption_key');
  try {
    _encryptionKey = fs.readFileSync(encKeyFile, 'utf8').trim();
  } catch {
    _encryptionKey = crypto.randomBytes(32).toString('hex');
    try {
      if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(encKeyFile, _encryptionKey, { mode: 0o600 });
      console.log('Generated and saved encryption key to', encKeyFile);
    } catch (writeErr: unknown) {
      console.warn('WARNING: Could not persist encryption key to disk:', writeErr instanceof Error ? writeErr.message : writeErr);
      console.warn('Set ENCRYPTION_KEY env var to avoid losing access to encrypted secrets on restart.');
    }
  }
}

export const ENCRYPTION_KEY = _encryptionKey;
