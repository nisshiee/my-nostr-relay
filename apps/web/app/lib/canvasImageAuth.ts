import 'server-only';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { verifyEvent } from 'nostr-tools/pure';

export const IMAGE_AUTH_PATH = '/api/canvas-image/auth';
export const IMAGE_CHALLENGE_COOKIE = '__Host-nlc-image-challenge';
export const IMAGE_SESSION_COOKIE = '__Host-nlc-image-session';
export const IMAGE_CHALLENGE_SECONDS = 120;
export const IMAGE_SESSION_SECONDS = 1800;
export interface ImageAuthConfig { origin: string; owners: readonly string[]; secret: string; binding: string }
export interface ImageSession { pubkey: string; expiresAt: number }
type Claim = { purpose: 'challenge' | 'session'; binding: string; iat: number; exp: number; value: string };
const hex = /^[0-9a-f]{64}$/;

/** cookie削除はkill switch後も可能にするためoriginだけ独立検査する。 */
export function getImageAuthOrigin(): string | null {
  const origin = process.env.CANVAS_IMAGE_AUTH_ORIGIN ?? '';
  try {
    const url = new URL(origin);
    return url.protocol === 'https:' && url.origin === origin && !url.username && !url.password ? origin : null;
  } catch { return null; }
}
/** 設定不足は拒否。公開鍵/secretはサーバー内だけで使用する。 */
export function getImageAuthConfig(): ImageAuthConfig | null {
  if (process.env.CANVAS_IMAGE_PROXY_ENABLED !== '1' || process.env.CANVAS_IMAGE_PROXY_SCOPE !== 'owner-auth') return null;
  const origin = getImageAuthOrigin();
  if (!origin) return null;
  const secret = process.env.CANVAS_IMAGE_AUTH_SECRET ?? '';
  const rawOwners = process.env.CANVAS_IMAGE_OWNER_PUBKEYS ?? '';
  if (Buffer.byteLength(secret) < 32 || Buffer.byteLength(secret) > 1024 || rawOwners.length > 2080) return null;
  const owners = [...new Set(rawOwners.split(',').map(value => value.trim()))].sort();
  if (!owners.length || owners.length > 32 || owners.some(value => !hex.test(value))) return null;
  const binding = createHash('sha256').update(JSON.stringify([origin, owners])).digest('hex');
  return { origin, owners, secret, binding };
}
export function isImageAuthOrigin(request: Request, config: Pick<ImageAuthConfig, 'origin'>, mutation = false): boolean {
  try {
    if (new URL(request.url).origin !== config.origin) return false;
    const origin = request.headers.get('origin');
    if (mutation ? origin !== config.origin : origin !== null && origin !== config.origin) return false;
    const site = request.headers.get('sec-fetch-site');
    return site !== 'cross-site';
  } catch { return false; }
}
function cookie(request: Request, name: string): string | null {
  const header = request.headers.get('cookie');
  if (!header || header.length > 8192) return null;
  const values = header.split(';').map(part => part.trim()).filter(part => part.slice(0, part.indexOf('=')) === name);
  if (values.length !== 1) return null;
  const value = values[0].slice(name.length + 1);
  return value.length <= 2048 ? value : null;
}
function seal(claim: Claim, config: ImageAuthConfig): string {
  const payload = Buffer.from(JSON.stringify(claim)).toString('base64url');
  const signature = createHmac('sha256', config.secret).update(`nlc-image-auth-v1.${payload}`).digest('base64url');
  return `${payload}.${signature}`;
}
function open(value: string | null, purpose: Claim['purpose'], config: ImageAuthConfig, now: number): Claim | null {
  if (!value || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(value)) return null;
  const [payload, signature] = value.split('.');
  const expected = createHmac('sha256', config.secret).update(`nlc-image-auth-v1.${payload}`).digest();
  const supplied = Buffer.from(signature, 'base64url');
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Claim;
    if (!data || Object.keys(data).sort().join(',') !== 'binding,exp,iat,purpose,value' || data.purpose !== purpose || data.binding !== config.binding ||
        !Number.isSafeInteger(data.iat) || !Number.isSafeInteger(data.exp) || data.iat > now || data.exp <= now ||
        data.exp - data.iat !== (purpose === 'challenge' ? IMAGE_CHALLENGE_SECONDS : IMAGE_SESSION_SECONDS) || !hex.test(data.value)) return null;
    return data;
  } catch { return null; }
}
export function imageCookie(name: string, value: string, maxAge: number): string {
  return `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
}
export function getImageSession(request: Request, now = Math.floor(Date.now() / 1000)): ImageSession | null {
  const config = getImageAuthConfig();
  if (!config || !isImageAuthOrigin(request, config)) return null;
  const claim = open(cookie(request, IMAGE_SESSION_COOKIE), 'session', config, now);
  return claim && config.owners.includes(claim.value) ? { pubkey: claim.value, expiresAt: claim.exp * 1000 } : null;
}
export function authorizeImageRequest(request: Request): boolean { return getImageSession(request) !== null; }
export function createImageChallenge(config: ImageAuthConfig, now = Math.floor(Date.now() / 1000)) {
  const challenge = randomBytes(32).toString('hex');
  const payload = JSON.stringify({ challenge });
  return {
    body: { challenge, payload, createdAt: now, expiresAt: (now + IMAGE_CHALLENGE_SECONDS) * 1000, url: `${config.origin}${IMAGE_AUTH_PATH}`, method: 'POST' as const },
    cookie: imageCookie(IMAGE_CHALLENGE_COOKIE, seal({ purpose: 'challenge', binding: config.binding, iat: now, exp: now + IMAGE_CHALLENGE_SECONDS, value: challenge }, config), IMAGE_CHALLENGE_SECONDS),
  };
}
/** NIP-98のpayloadは実際のPOST本文そのもの。署名はリレーへ送信しない。 */
export function verifyImageChallenge(request: Request, body: string, config: ImageAuthConfig, now = Math.floor(Date.now() / 1000)) {
  if (request.method !== 'POST' || request.url !== `${config.origin}${IMAGE_AUTH_PATH}` || !isImageAuthOrigin(request, config, true)) return null;
  const challenge = open(cookie(request, IMAGE_CHALLENGE_COOKIE), 'challenge', config, now);
  if (!challenge || body !== JSON.stringify({ challenge: challenge.value })) return null;
  const auth = request.headers.get('authorization') ?? '';
  if (auth.length > 4096 || !/^Nostr [A-Za-z0-9+/]+={0,2}$/.test(auth)) return null;
  try {
    const encoded = auth.slice(6), decoded = Buffer.from(encoded, 'base64');
    if (decoded.toString('base64') !== encoded) return null;
    const event = JSON.parse(decoded.toString('utf8'));
    if (!event || Object.keys(event).sort().join(',') !== 'content,created_at,id,kind,pubkey,sig,tags' || event.kind !== 27235 || event.content !== '' ||
        !config.owners.includes(event.pubkey) || !Number.isSafeInteger(event.created_at) || Math.abs(event.created_at - now) > 60 || event.created_at < challenge.iat - 5 ||
        !Array.isArray(event.tags) || event.tags.length !== 3) return null;
    const tags = new Map<string, string>();
    for (const tag of event.tags) {
      if (!Array.isArray(tag) || tag.length !== 2 || typeof tag[0] !== 'string' || typeof tag[1] !== 'string' || tags.has(tag[0])) return null;
      tags.set(tag[0], tag[1]);
    }
    if (tags.get('u') !== `${config.origin}${IMAGE_AUTH_PATH}` || tags.get('method') !== 'POST' ||
        tags.get('payload') !== createHash('sha256').update(body).digest('hex') || !verifyEvent(event)) return null;
    const exp = now + IMAGE_SESSION_SECONDS;
    return { session: { pubkey: event.pubkey as string, expiresAt: exp * 1000 }, cookie: imageCookie(IMAGE_SESSION_COOKIE,
      seal({ purpose: 'session', binding: config.binding, iat: now, exp, value: event.pubkey }, config), IMAGE_SESSION_SECONDS) };
  } catch { return null; }
}
