import { createHash } from 'node:crypto';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
vi.mock('../../../../lib/publicImageFetch', () => ({ fetchPublicImage: vi.fn(), fetchInlineImage: vi.fn(), PublicImageDeadlineError: class extends Error {} }));
import { fetchPublicImage, fetchInlineImage } from '../../../../lib/publicImageFetch';
import { POST as AUTH } from '../route';
import { GET, POST } from '../../route';
import { IMAGE_SESSION_COOKIE } from '../../../../lib/canvasImageAuth';
const secret = generateSecretKey(), owner = getPublicKey(secret), origin='https://image-auth.example';
const authUrl=`${origin}/api/canvas-image/auth`,imageUrl=`${origin}/api/canvas-image?url=https%3A%2F%2Fimages.example%2Fa.png&w=64`;
function request(url=imageUrl,cookie?:string) { return new Request(url,{headers:cookie?{Cookie:cookie}:{}}); }
async function cookie() {
 const challenge=await AUTH(new Request(authUrl,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:'{"action":"challenge"}'}));
 const data=await challenge.json();const event=finalizeEvent({kind:27235,created_at:Math.floor(Date.now()/1000),content:'',tags:[['u',authUrl],['method','POST'],['payload',createHash('sha256').update(data.payload).digest('hex')]]},secret);
 const verified=await AUTH(new Request(authUrl,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',Cookie:challenge.headers.getSetCookie()[0].split(';')[0],Authorization:`Nostr ${Buffer.from(JSON.stringify(event)).toString('base64')}`},body:data.payload}));
 expect(verified.status).toBe(200);return verified.headers.getSetCookie().find(c=>c.startsWith(`${IMAGE_SESSION_COOKIE}=`))!.split(';')[0];
}
beforeEach(()=>{
 vi.stubEnv('CANVAS_IMAGE_PROXY_ENABLED','1');vi.stubEnv('CANVAS_IMAGE_PROXY_SCOPE','owner-auth');vi.stubEnv('CANVAS_IMAGE_OWNER_PUBKEYS',owner);vi.stubEnv('CANVAS_IMAGE_AUTH_ORIGIN',origin);vi.stubEnv('CANVAS_IMAGE_AUTH_SECRET','only-for-ephemeral-unit-tests-32-characters');vi.stubEnv('VERCEL_ENV','production');vi.stubEnv('VERCEL_TARGET_ENV','production');
 Reflect.deleteProperty(globalThis,Symbol.for('nlc.canvas-image.state.v1'));Reflect.deleteProperty(globalThis,Symbol.for('nlc.canvas-image.auth-budget.v1'));
 vi.mocked(fetchPublicImage).mockReset().mockResolvedValue(Buffer.from('webp'));vi.mocked(fetchInlineImage).mockReset().mockResolvedValue(Buffer.from('webp'));
});
afterEach(()=>{vi.unstubAllEnvs();vi.restoreAllMocks();});
describe('画像route本人cookieの先行検査',()=>{
 it('owner productionで未認証GET/POSTは本文/取得/変換より前に拒否',async()=>{
  expect((await GET(request())).status).toBe(401);
  const post=new Request(`${origin}/api/canvas-image`,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:'{}'});
  const read=vi.spyOn(post.body!,'getReader');expect((await POST(post)).status).toBe(401);expect(read).not.toHaveBeenCalled();
  expect(fetchPublicImage).not.toHaveBeenCalled();expect(fetchInlineImage).not.toHaveBeenCalled();
 });
 it('正しいsessionだけ取得しwarmcacheでもcookieなしを拒否',async()=>{
  const c=await cookie();expect((await GET(request(imageUrl,c))).status).toBe(200);expect(fetchPublicImage).toHaveBeenCalledTimes(1);
  expect((await GET(request())).status).toBe(401);expect(fetchPublicImage).toHaveBeenCalledTimes(1);
  expect((await GET(request(imageUrl,c))).status).toBe(200);expect(fetchPublicImage).toHaveBeenCalledTimes(1);
  vi.stubEnv('CANVAS_IMAGE_PROXY_ENABLED','0');expect((await GET(request(imageUrl,c))).status).toBe(503);
 });
 it('取得待機中に期限/killが変われば結果を返さない',async()=>{
  const c=await cookie();let finish!:(b:Buffer)=>void;vi.mocked(fetchPublicImage).mockReturnValue(new Promise(resolve=>{finish=resolve;}));
  const result=GET(request(imageUrl,c));await Promise.resolve();vi.stubEnv('CANVAS_IMAGE_PROXY_ENABLED','0');finish(Buffer.from('webp'));
  expect((await result).status).toBe(503);
 });
 it('POST本文読取中にsession期限を過ぎたらdecode/cache開始前に拒否',async()=>{
  const started=Date.now();vi.spyOn(Date,'now').mockReturnValue(started);const c=await cookie();
  let controller!:ReadableStreamDefaultController<Uint8Array>;
  const body=new ReadableStream<Uint8Array>({start(value){controller=value;}});
  const request=new Request(`${origin}/api/canvas-image`,{method:'POST',body,duplex:'half',headers:{Origin:origin,'Content-Type':'application/json',Cookie:c}} as RequestInit);
  const pending=POST(request);
  vi.spyOn(Date,'now').mockReturnValue(started+604800_000);
  controller.enqueue(new TextEncoder().encode(JSON.stringify({data:'data:image/png;base64,aGVsbG8=',width:64})));controller.close();
  expect((await pending).status).toBe(401);expect(fetchInlineImage).not.toHaveBeenCalled();
 });
 it('古いpreview許可をownerへ引き継がず本番previewscopeは拒否',async()=>{
  vi.stubEnv('CANVAS_IMAGE_PROXY_SCOPE','protected-preview');vi.stubEnv('VERCEL_ENV','preview');vi.stubEnv('VERCEL_TARGET_ENV',undefined);
  expect((await GET(request())).status).toBe(200);
  vi.stubEnv('CANVAS_IMAGE_PROXY_SCOPE','owner-auth');expect((await GET(request())).status).toBe(401);
  vi.stubEnv('CANVAS_IMAGE_PROXY_SCOPE','protected-preview');vi.stubEnv('VERCEL_ENV','production');expect((await GET(request())).status).toBe(503);
 });
});
