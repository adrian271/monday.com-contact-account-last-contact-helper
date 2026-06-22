import { createHmac, timingSafeEqual } from 'crypto';

// Monday signs every webhook request with a JWT in the Authorization header,
// using HS256 keyed by your account's signing secret
// (monday.com → Developers → your app → Signing Secret).
//
// We verify the signature ourselves with HMAC-SHA256. We never read the `alg`
// field from the token to choose an algorithm — we always compute HMAC-SHA256 —
// which sidesteps JWT "alg confusion" attacks. Set MONDAY_SIGNING_SECRET to enable.

export const MONDAY_SIGNING_SECRET = process.env.MONDAY_SIGNING_SECRET || '';

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export type VerifyResult = { ok: true } | { ok: false; reason: string };

export function verifyMondaySignature(authHeader: string | null): VerifyResult {
  if (!MONDAY_SIGNING_SECRET) {
    return { ok: false, reason: 'signing secret not configured' };
  }
  if (!authHeader) {
    return { ok: false, reason: 'missing authorization header' };
  }

  // Header is the JWT directly; tolerate an optional "Bearer " prefix.
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  const parts = token.split('.');
  if (parts.length !== 3) {
    return { ok: false, reason: 'malformed token' };
  }

  const [header, payload, signature] = parts;
  const expected = base64url(
    createHmac('sha256', MONDAY_SIGNING_SECRET).update(`${header}.${payload}`).digest()
  );

  // Timing-safe comparison (guard against length mismatch first).
  const provided = Buffer.from(signature);
  const computed = Buffer.from(expected);
  if (provided.length !== computed.length || !timingSafeEqual(provided, computed)) {
    return { ok: false, reason: 'invalid signature' };
  }

  // Reject expired tokens if an exp claim is present.
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
    if (typeof claims.exp === 'number' && Date.now() / 1000 > claims.exp) {
      return { ok: false, reason: 'token expired' };
    }
  } catch {
    return { ok: false, reason: 'unparseable payload' };
  }

  return { ok: true };
}
