import { createHash } from 'node:crypto';
import { finalizeEvent, generateSecretKey, getPublicKey, type EventTemplate } from 'nostr-tools/pure';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import { GET, POST, DELETE } from '../route';
import { authorizeImageRequest, getImageAuthConfig, getImageSession, IMAGE_CHALLENGE_COOKIE, IMAGE_SESSION_COOKIE } from '../../../../lib/canvasImageAuth';

// テスト内だけの一時鍵。既存利用者の鍵・署名器・外部通信は使用しない。
const key = generateSecretKey(), other = generateSecretKey(), owner = getPublicKey(key);
const origin = 'https://image-auth.example', url = `${origin}/api/canvas-image/auth`;
const now = 2_000_000_000_000;
function req(method: string, body?: string, headers: Record<string, string> = {}, target = url) {
  return new Request(target, { method, ...(body === undefined ? {} : { body }), headers: { Origin: origin, 'Content-Type': 'application/json', ...headers } });
}
function cookies(response: Response) { return response.headers.getSetCookie().map(value => value.split(';')[0]); }
async function challenge() {
  const response = await POST(req('POST', JSON.stringify({ action: 'challenge' })));
  expect(response.status).toBe(200);
  return { response, data: await response.json(), cookie: cookies(response)[0] };
}
function event(payload: string, overrides: Partial<EventTemplate> = {}, secret = key) {
  return finalizeEvent({ kind: 27235, created_at: Math.floor(Date.now()/1000), content: '',
    tags: [['u', url], ['method', 'POST'], ['payload', createHash('sha256').update(payload).digest('hex')]], ...overrides }, secret);
}
function verification(payload: string, cookie: string, signed = event(payload), target = url) {
  return req('POST', payload, { Cookie: cookie, Authorization: `Nostr ${Buffer.from(JSON.stringify(signed)).toString('base64')}` }, target);
}
async function session() {
  const c = await challenge(); const response = await POST(verification(c.data.payload, c.cookie));
  expect(response.status).toBe(200); return { c, response, cookie: cookies(response).find(value=>value.startsWith(`${IMAGE_SESSION_COOKIE}=`))! };
}
beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(now);
  vi.stubEnv('CANVAS_IMAGE_PROXY_ENABLED', '1');vi.stubEnv('CANVAS_IMAGE_PROXY_SCOPE', 'owner-auth');
  vi.stubEnv('CANVAS_IMAGE_OWNER_PUBKEYS', owner);vi.stubEnv('CANVAS_IMAGE_AUTH_ORIGIN', origin);
  vi.stubEnv('CANVAS_IMAGE_AUTH_SECRET', 'only-for-ephemeral-unit-tests-32-characters');
  Reflect.deleteProperty(globalThis, Symbol.for('nlc.canvas-image.auth-budget.v1'));
});
afterEach(() => { vi.restoreAllMocks();vi.unstubAllEnvs(); });
describe('本人限定画像署名認証', () => {
 it('statusはchallengeを作らず、明示challenge→署名→固定期限sessionにする', async()=>{
  const initial=await GET(req('GET'));expect(await initial.json()).toEqual({available:true,authenticated:false});expect(initial.headers.get('set-cookie')).toBeNull();
  const s=await session();expect(await s.response.json()).toEqual({authenticated:true,pubkey:owner,expiresAt:now+1800_000});
  const set=s.response.headers.getSetCookie();expect(set[0]).toContain('Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=1800');expect(set[1]).toContain(`${IMAGE_CHALLENGE_COOKIE}=;`);expect(set[1]).toContain('Max-Age=0');
  const request=req('GET',undefined,{Cookie:s.cookie},`${origin}/api/canvas-image?url=ignored`);
  expect(authorizeImageRequest(request)).toBe(true);expect(getImageSession(request)?.expiresAt).toBe(now+1800_000);
  vi.spyOn(Date,'now').mockReturnValue(now+1799_000);expect(authorizeImageRequest(request)).toBe(true);
  vi.spyOn(Date,'now').mockReturnValue(now+1800_000);expect(authorizeImageRequest(request)).toBe(false);
 });
 it.each(['CANVAS_IMAGE_PROXY_ENABLED','CANVAS_IMAGE_PROXY_SCOPE','CANVAS_IMAGE_OWNER_PUBKEYS','CANVAS_IMAGE_AUTH_ORIGIN','CANVAS_IMAGE_AUTH_SECRET'])('設定不足%sは拒否し本文を読まない',async name=>{
  vi.stubEnv(name,undefined);const request=req('POST','{}');const reader=vi.spyOn(request.body!,'getReader');
  expect(getImageAuthConfig()).toBeNull();expect((await POST(request)).status).toBe(503);expect(reader).not.toHaveBeenCalled();
  expect(await (await GET(req('GET'))).json()).toEqual({available:false,authenticated:false});
 });
 it.each(['http://image-auth.example','https://image-auth.example/','https://u:p@image-auth.example','https://image-auth.example?x=1'])('canonicalHTTPS以外を拒否%s',value=>{
  vi.stubEnv('CANVAS_IMAGE_AUTH_ORIGIN',value);expect(getImageAuthConfig()).toBeNull();
 });
 it('secret短長/owner不正を拒否',()=>{
  vi.stubEnv('CANVAS_IMAGE_AUTH_SECRET','short');expect(getImageAuthConfig()).toBeNull();
  vi.stubEnv('CANVAS_IMAGE_AUTH_SECRET','x'.repeat(1025));expect(getImageAuthConfig()).toBeNull();
  vi.stubEnv('CANVAS_IMAGE_AUTH_SECRET','x'.repeat(32));vi.stubEnv('CANVAS_IMAGE_OWNER_PUBKEYS','invalid');expect(getImageAuthConfig()).toBeNull();
 });
 it.each(['https://evil.example','null',''])('Origin不一致%sで署名検証以前に拒否',async value=>{
  const r=req('POST','{}',{Origin:value});expect((await POST(r)).status).toBe(403);expect((await DELETE(r)).status).toBe(403);
 });
 it('Host/転送header偽装/querysuffix/crosssiteを拒否',async()=>{
  expect((await POST(req('POST','{}',{'X-Forwarded-Host':'image-auth.example'},'https://evil.example/api/canvas-image/auth'))).status).toBe(403);
  expect((await POST(req('POST','{}',{},`${url}?x=1`))).status).toBe(403);
  expect((await POST(req('POST','{}',{'Sec-Fetch-Site':'cross-site'}))).status).toBe(403);
 });
 it('別owner・改ざん署名・本文hash違いを拒否',async()=>{
  const c=await challenge();expect((await POST(verification(c.data.payload,c.cookie,event(c.data.payload,{},other)))).status).toBe(401);
  const invalid={...event(c.data.payload),sig:'0'.repeat(128)};expect((await POST(verification(c.data.payload,c.cookie,invalid))).status).toBe(401);
  expect((await POST(verification(c.data.payload,c.cookie,event('different')))).status).toBe(401);
  expect((await POST(verification(c.data.payload+' ',c.cookie))).status).toBe(401);
 });
 it.each(['u','method','payload'])('tag %s の重複/変更を拒否',async name=>{
  const c=await challenge(),base=event(c.data.payload);
  const tags=base.tags.map(tag=>tag[0]===name?[name,'wrong']:tag);
  expect((await POST(verification(c.data.payload,c.cookie,event(c.data.payload,{tags})))).status).toBe(401);
  expect((await POST(verification(c.data.payload,c.cookie,event(c.data.payload,{tags:[...base.tags,[name,'wrong']]})))).status).toBe(401);
 });
 it.each([{kind:1},{content:'text'},{created_at:Math.floor(now/1000)-61},{created_at:Math.floor(now/1000)+61}])('event意味/時刻を検査%j',async override=>{
  const c=await challenge();expect((await POST(verification(c.data.payload,c.cookie,event(c.data.payload,override)))).status).toBe(401);
 });
 it('cookie無し/別challenge/改ざん/重複cookieを拒否',async()=>{
  const a=await challenge(),b=await challenge();
  for(const cookie of ['',b.cookie,a.cookie+'a',`${a.cookie}; ${a.cookie}`]) expect((await POST(verification(a.data.payload,cookie))).status).toBe(401);
  expect((await POST(req('POST',a.data.payload,{Cookie:a.cookie,Authorization:'Nostr !!!'}))).status).toBe(401);
 });
 it('challenge期限後拒否。stateless再送は有効期間内のみ許容される残余制限',async()=>{
  const c=await challenge(),signed=event(c.data.payload);
  expect((await POST(verification(c.data.payload,c.cookie,signed))).status).toBe(200);
  // cookieを盗まれた場合の厳密one-timeは共有storeなしでは保証しない。
  expect((await POST(verification(c.data.payload,c.cookie,signed))).status).toBe(200);
  vi.spyOn(Date,'now').mockReturnValue(now+120_000);
  expect((await POST(verification(c.data.payload,c.cookie,event(c.data.payload)))).status).toBe(401);
 });
 it('sessionをchallengeとして流用できず、kill/secret/allowlist変更は即拒否',async()=>{
  const s=await session();expect((await POST(verification(s.c.data.payload,s.cookie.replace(IMAGE_SESSION_COOKIE,IMAGE_CHALLENGE_COOKIE)))).status).toBe(401);
  const request=req('GET',undefined,{Cookie:s.cookie});
  expect(getImageSession(req('GET',undefined,{Cookie:`${s.cookie}; ${s.cookie}`}))).toBeNull();
  vi.stubEnv('CANVAS_IMAGE_PROXY_ENABLED','0');expect(getImageSession(request)).toBeNull();
  vi.stubEnv('CANVAS_IMAGE_PROXY_ENABLED','1');vi.stubEnv('CANVAS_IMAGE_AUTH_SECRET','different-unit-test-secret-32-characters');expect(getImageSession(request)).toBeNull();
  vi.stubEnv('CANVAS_IMAGE_AUTH_SECRET','only-for-ephemeral-unit-tests-32-characters');
  vi.stubEnv('CANVAS_IMAGE_OWNER_PUBKEYS',getPublicKey(other));expect(getImageSession(request)).toBeNull();
 });
 it('logoutは両cookieを削除し署名を要求しない',async()=>{
  vi.stubEnv('CANVAS_IMAGE_PROXY_ENABLED','0');vi.stubEnv('CANVAS_IMAGE_AUTH_SECRET',undefined);
  const r=await DELETE(req('DELETE'));expect(r.status).toBe(200);expect(r.headers.getSetCookie()).toHaveLength(2);
  expect(r.headers.getSetCookie().every(c=>c.includes('Max-Age=0'))).toBe(true);
 });
 it('本文上限・不正UTF8・不正type、読取前budgetを検査',async()=>{
  expect((await POST(req('POST','{}',{'Content-Length':'9000'}))).status).toBe(413);
  expect((await POST(req('POST','x'.repeat(8193)))).status).toBe(400);
  expect((await POST(req('POST','{}',{'Content-Type':'text/plain'}))).status).toBe(415);
  for(let i=0;i<8;i++) await POST(req('POST','bad-json'));
  const request=req('POST','{}');const reader=vi.spyOn(request.body!,'getReader');
  expect((await POST(request)).status).toBe(429);expect(reader).not.toHaveBeenCalled();
 });
 it('不正UTF8/無本文/重複Authorization相当の結合文字列を拒否',async()=>{
  const malformed=new Request(url,{method:'POST',body:new Uint8Array([0xff]),headers:{Origin:origin,'Content-Type':'application/json'}});
  expect((await POST(malformed)).status).toBe(400);
  expect((await POST(req('POST'))).status).toBe(400);
  expect((await POST(req('POST','\uFEFF{\"action\":\"challenge\"}'))).status).toBe(401);
  const c=await challenge();const signed=event(c.data.payload),encoded=Buffer.from(JSON.stringify(signed)).toString('base64');
  expect((await POST(req('POST',c.data.payload,{Cookie:c.cookie,Authorization:`Nostr ${encoded}, Nostr ${encoded}`}))).status).toBe(401);
 });
 it('slowbodyは期限でcancelし同時2枠を超えない',async()=>{
  vi.useFakeTimers();
  try {
    const cancel=vi.fn();const stream=()=>new ReadableStream<Uint8Array>({cancel});
    const make=()=>new Request(url,{method:'POST',body:stream(),duplex:'half',headers:{Origin:origin,'Content-Type':'application/json'}} as RequestInit);
    const a=POST(make()),b=POST(make());expect((await POST(make())).status).toBe(429);
    await vi.advanceTimersByTimeAsync(5000);expect((await a).status).toBe(400);expect((await b).status).toBe(400);expect(cancel).toHaveBeenCalledTimes(2);
  } finally {vi.useRealTimers();}
 });
});
