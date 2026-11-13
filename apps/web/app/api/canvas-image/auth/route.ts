import { createImageChallenge, getImageAuthConfig, getImageAuthOrigin, getImageSession, imageCookie, IMAGE_CHALLENGE_COOKIE, IMAGE_SESSION_COOKIE, IMAGE_AUTH_PATH, isImageAuthOrigin, verifyImageChallenge } from '../../../lib/canvasImageAuth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'same-origin' };
const STATE = Symbol.for('nlc.canvas-image.auth-budget.v1');
type Budget = { tokens: number; at: number; active: number };
const globalBudget = globalThis as typeof globalThis & { [STATE]?: Budget };
function response(body: unknown, status = 200, cookies: string[] = []) {
  const h = new Headers(headers); h.set('Content-Type', 'application/json');
  for (const cookie of cookies) h.append('Set-Cookie', cookie);
  return new Response(JSON.stringify(body), { status, headers: h });
}
const error = (status: number) => response({ error: 'Image authorization unavailable' }, status);
export async function GET(request: Request) {
  const target = new URL(request.url);
  // 照会は署名案内の要否だけに使用し、認証・所有者一覧の代替にしない。
  const query = target.search;
  const requestedPubkey = query ? /^\?pubkey=([0-9a-f]{64})$/.exec(query)?.[1] : undefined;
  if (query && !requestedPubkey) return error(400);
  const config = getImageAuthConfig();
  const eligibility = requestedPubkey ? { eligible: !!config?.owners.includes(requestedPubkey) } : {};
  if (!config) return response({ available: false, authenticated: false, ...eligibility });
  if (`${target.origin}${target.pathname}` !== `${config.origin}${IMAGE_AUTH_PATH}` || target.hash || !isImageAuthOrigin(request, config)) return error(403);
  const session = getImageSession(request);
  return response({ available: true, authenticated: !!session, ...eligibility, ...(session ? { expiresAt: session.expiresAt, pubkey: session.pubkey } : {}) });
}
export async function POST(request: Request) {
  const config = getImageAuthConfig();
  if (!config) return error(503);
  if (request.url !== `${config.origin}${IMAGE_AUTH_PATH}` || !isImageAuthOrigin(request, config, true)) return error(403);
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return error(415);
  const now = Date.now(), budget = globalBudget[STATE] ??= { tokens: 10, at: now, active: 0 };
  budget.tokens = Math.min(10, budget.tokens + Math.max(0, now - budget.at) / 6000); budget.at = now;
  if (budget.active >= 2 || budget.tokens < 1) return error(429);
  budget.tokens--; budget.active++;
  const length = request.headers.get('content-length');
  if (length && (!/^\d+$/.test(length) || Number(length) > 8192)) { budget.active--; return error(413); }
  if (!request.body) { budget.active--; return error(400); }
  const reader = request.body.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let text = '';
  try {
    const read = async () => {
      const chunks: Uint8Array[] = []; let size = 0;
      while (true) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.byteLength; if (size > 8192) throw new Error('size'); chunks.push(chunk.value); }
      return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks));
    };
    text = await Promise.race([read(), new Promise<never>((_, reject) => { timer = setTimeout(() => { void reader.cancel().catch(() => {}); reject(new Error('timeout')); }, 5000); })]);
  } catch { return error(400); }
  finally { clearTimeout(timer); void reader.cancel().catch(() => {}); budget.active--; }
  if (getImageAuthConfig()?.binding !== config.binding) return error(503);
  if (text === JSON.stringify({ action: 'challenge' })) {
    const challenge = createImageChallenge(config);
    return response(challenge.body, 200, [challenge.cookie]);
  }
  const result = verifyImageChallenge(request, text, config);
  if (!result) return error(401);
  return response({ authenticated: true, ...result.session }, 200,
    [result.cookie, imageCookie(IMAGE_CHALLENGE_COOKIE, '', 0)]);
}
export async function DELETE(request: Request) {
  const origin = getImageAuthOrigin();
  if (!origin) return error(503);
  const config = { origin };
  if (request.url !== `${config.origin}${IMAGE_AUTH_PATH}` || !isImageAuthOrigin(request, config, true)) return error(403);
  return response({ authenticated: false }, 200, [imageCookie(IMAGE_SESSION_COOKIE, '', 0), imageCookie(IMAGE_CHALLENGE_COOKIE, '', 0)]);
}
