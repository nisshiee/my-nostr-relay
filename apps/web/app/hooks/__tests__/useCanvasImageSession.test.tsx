// @vitest-environment jsdom
import React from 'react';
import { webcrypto } from 'node:crypto';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useCanvasImageSession, CANVAS_IMAGE_SESSION_INVALIDATED } from '../useCanvasImageSession';
import { ImageProxyAccess } from '../../components/ImageProxyAccess';
const mocks=vi.hoisted(()=>({sign:vi.fn(),invalidate:vi.fn()}));
vi.mock('../../lib/nostrSigner',()=>({signEventWithActiveSigner:mocks.sign}));
vi.mock('../../lib/canvasImageLoader',()=>({canvasImageLoader:{invalidateAuthorization:mocks.invalidate}}));
const key='a'.repeat(64), other='b'.repeat(64), path='/api/canvas-image/auth';
function response(data:unknown,ok=true){return {ok,json:async()=>data} as Response;}
function challenge(){return {challenge:'nonce',payload:'{"challenge":"nonce"}',createdAt:Math.floor(Date.now()/1000),expiresAt:Date.now()+60000,url:new URL(path,window.location.origin).href,method:'POST'};}
const fetchMock=vi.fn<typeof fetch>();
beforeEach(()=>{sessionStorage.clear();localStorage.clear();sessionStorage.setItem('nlc-image-auth-attempt:'+key,'1');vi.stubGlobal('fetch',fetchMock);vi.stubGlobal('crypto',webcrypto);fetchMock.mockReset();mocks.sign.mockReset();mocks.invalidate.mockClear();});
afterEach(()=>{cleanup();vi.unstubAllGlobals();vi.useRealTimers();vi.restoreAllMocks();});
describe('画像配信の明示的本人確認',()=>{
 it('statusだけ自動取得し署名せず、本人の期限付きsessionだけを使う',async()=>{
  fetchMock.mockResolvedValue(response({available:true,authenticated:true,pubkey:key,expiresAt:Date.now()+60000}));
  const h=renderHook(()=>useCanvasImageSession({pubkey:key,mode:'owner',nativeCapable:true}));
  await waitFor(()=>expect(h.result.current.nativeImagesEnabled).toBe(true));
  expect(mocks.sign).not.toHaveBeenCalled();expect(fetchMock).toHaveBeenCalledTimes(1);
 });
 it('明示buttonだけNIP98署名しpayloadとverify bodyを完全一致させる',async()=>{
  const c=challenge();fetchMock.mockResolvedValueOnce(response({available:true,authenticated:false,eligible:true})).mockResolvedValueOnce(response({available:true,authenticated:false,eligible:true})).mockResolvedValueOnce(response(c)).mockResolvedValueOnce(response({authenticated:true,pubkey:key,expiresAt:Date.now()+60000}));
  mocks.sign.mockImplementation(async event=>({...event,pubkey:key,id:'id',sig:'sig'}));
  function UI(){return <ImageProxyAccess nativeCapable manualDOM={false} access={useCanvasImageSession({pubkey:key,mode:'owner',nativeCapable:true})}/>;}
  render(<UI/>);await waitFor(()=>expect((screen.getByRole('button',{name:'画像の本人確認を再試行'}) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole('button',{name:'画像の本人確認を再試行'}));
  await screen.findByRole('button',{name:'画像エフェクトを停止して本人確認を解除'});
  const event=mocks.sign.mock.calls[0][0];expect(event.kind).toBe(27235);expect(event.content).toBe('');
  const hash=await webcrypto.subtle.digest('SHA-256',new TextEncoder().encode(c.payload));
  expect(event.tags).toEqual([['u',c.url],['method','POST'],['payload',Buffer.from(hash).toString('hex')]]);
  const verify=fetchMock.mock.calls[3][1]!;expect(verify.body).toBe(c.payload);
  expect(JSON.parse(atob((verify.headers as Record<string,string>).Authorization.slice(6))).pubkey).toBe(key);
 });
 it('別originchallengeを署名せず拒否する',async()=>{
  fetchMock.mockResolvedValueOnce(response({authenticated:false})).mockResolvedValueOnce(response({available:true,authenticated:false,eligible:true})).mockResolvedValueOnce(response({...challenge(),url:'https://other.example/api/canvas-image/auth'}));
  const h=renderHook(()=>useCanvasImageSession({pubkey:key,mode:'owner',nativeCapable:true}));
  await act(async()=>{await h.result.current.authorize();});
  expect(mocks.sign).not.toHaveBeenCalled();expect(h.result.current.nativeImagesEnabled).toBe(false);
 });
 it('account変更後に遅延署名が返ってもverifyへ送らない',async()=>{
  let resolve!:(v:unknown)=>void;fetchMock.mockResolvedValue(response({authenticated:false}));
  fetchMock.mockResolvedValueOnce(response({authenticated:false})).mockResolvedValueOnce(response({available:true,authenticated:false,eligible:true})).mockResolvedValueOnce(response(challenge()));
  mocks.sign.mockReturnValue(new Promise(r=>{resolve=r;}));
  const h=renderHook(({pubkey})=>useCanvasImageSession({pubkey,mode:'owner',nativeCapable:true}),{initialProps:{pubkey:key}});
  let authorization!:Promise<void>;act(()=>{authorization=h.result.current.authorize();});
  await waitFor(()=>expect(mocks.sign).toHaveBeenCalledOnce());h.rerender({pubkey:other});
  await act(async()=>{resolve({pubkey:key});await authorization;});
  expect(fetchMock.mock.calls.filter(([,init])=>init?.headers && 'Authorization' in init.headers)).toHaveLength(0);
  expect(h.result.current.nativeImagesEnabled).toBe(false);
 });
 it('401通知で直ちにcacheとnativeを無効化し明示DELETEできる',async()=>{
  fetchMock.mockResolvedValue(response({available:true,authenticated:true,pubkey:key,expiresAt:Date.now()+60000}));
  const h=renderHook(()=>useCanvasImageSession({pubkey:key,mode:'owner',nativeCapable:true}));await waitFor(()=>expect(h.result.current.nativeImagesEnabled).toBe(true));
  act(()=>window.dispatchEvent(new Event(CANVAS_IMAGE_SESSION_INVALIDATED)));
  expect(h.result.current.nativeImagesEnabled).toBe(false);expect(mocks.invalidate).toHaveBeenCalled();
  await act(async()=>{await h.result.current.revoke();});expect(fetchMock.mock.calls.at(-1)?.[1]?.method).toBe('DELETE');
 });
 it('期限切れで無効化し、previewだけserver指定modeで署名なしに有効',async()=>{
  vi.useFakeTimers();fetchMock.mockResolvedValue(response({available:true,authenticated:true,pubkey:key,expiresAt:Date.now()+1000}));
  const h=renderHook(()=>useCanvasImageSession({pubkey:key,mode:'owner',nativeCapable:true}));await act(async()=>{await Promise.resolve();await Promise.resolve();});
  expect(h.result.current.nativeImagesEnabled).toBe(true);act(()=>vi.advanceTimersByTime(1001));expect(h.result.current.nativeImagesEnabled).toBe(false);
  const preview=renderHook(()=>useCanvasImageSession({pubkey:key,mode:'preview',nativeCapable:true}));expect(preview.result.current.nativeImagesEnabled).toBe(true);expect(mocks.sign).not.toHaveBeenCalled();
 });
 it('別accountのcookieは有効化せず、previewも失効通知で停止する',async()=>{
  fetchMock.mockResolvedValue(response({available:true,authenticated:true,pubkey:other,expiresAt:Date.now()+60000}));
  const h=renderHook(()=>useCanvasImageSession({pubkey:key,mode:'owner',nativeCapable:true}));await waitFor(()=>expect(h.result.current.message).toContain('別アカウント'));
  expect(h.result.current.nativeImagesEnabled).toBe(false);
  const preview=renderHook(()=>useCanvasImageSession({pubkey:key,mode:'preview',nativeCapable:true}));expect(preview.result.current.nativeImagesEnabled).toBe(true);
  act(()=>window.dispatchEvent(new Event(CANVAS_IMAGE_SESSION_INVALIDATED)));expect(preview.result.current.nativeImagesEnabled).toBe(false);
 });
 it('署名拒否はgeneric表示にしrawerrorや内容を漏らさない',async()=>{
  fetchMock.mockResolvedValueOnce(response({available:true,authenticated:false})).mockResolvedValueOnce(response({available:true,authenticated:false,eligible:true})).mockResolvedValueOnce(response(challenge()));
  mocks.sign.mockRejectedValue(new Error('secret-raw-error'));
  const h=renderHook(()=>useCanvasImageSession({pubkey:key,mode:'owner',nativeCapable:true}));await act(async()=>{await h.result.current.authorize();});
  expect(h.result.current.nativeImagesEnabled).toBe(false);expect(h.result.current.message).not.toContain('secret');expect(h.result.current.pending).toBe(false);
  expect(fetchMock).toHaveBeenCalledTimes(3);
 });

 it('送信済verifyの応答後にDELETEし遅延Set-Cookieとの同画面raceを避ける',async()=>{
  let resolve!:(response:Response)=>void;const pending=new Promise<Response>(r=>{resolve=r;});
  fetchMock.mockResolvedValueOnce(response({available:true,authenticated:false})).mockResolvedValueOnce(response({available:true,authenticated:false,eligible:true})).mockResolvedValueOnce(response(challenge())).mockReturnValueOnce(pending).mockResolvedValueOnce(response({authenticated:false}));
  mocks.sign.mockImplementation(async event=>({...event,pubkey:key,id:'id',sig:'sig'}));
  const h=renderHook(()=>useCanvasImageSession({pubkey:key,mode:'owner',nativeCapable:true}));
  let authorization!:Promise<void>;act(()=>{authorization=h.result.current.authorize();});
  await waitFor(()=>expect(fetchMock).toHaveBeenCalledTimes(4));
  let revocation!:Promise<void>;act(()=>{revocation=h.result.current.revoke();});
  expect(fetchMock).toHaveBeenCalledTimes(4);expect(h.result.current.nativeImagesEnabled).toBe(false);
  await act(async()=>{resolve(response({authenticated:true,pubkey:key,expiresAt:Date.now()+60000}));await authorization;await revocation;});
  expect(fetchMock.mock.calls[4][1]?.method).toBe('DELETE');expect(h.result.current.nativeImagesEnabled).toBe(false);expect(h.result.current.pending).toBe(false);
 });

 it('revoke中のaccount変更でもlockとpendingを保持し再authorizeを送らない',async()=>{
  let finishVerify!:(response:Response)=>void,finishDelete!:(response:Response)=>void;
  const verify=new Promise<Response>(resolve=>{finishVerify=resolve;});
  const deletion=new Promise<Response>(resolve=>{finishDelete=resolve;});
  fetchMock.mockResolvedValueOnce(response({available:true,authenticated:false})).mockResolvedValueOnce(response({available:true,authenticated:false,eligible:true})).mockResolvedValueOnce(response(challenge())).mockReturnValueOnce(verify).mockReturnValueOnce(deletion).mockResolvedValue(response({available:true,authenticated:false}));
  mocks.sign.mockImplementation(async event=>({...event,pubkey:key,id:'id',sig:'sig'}));
  const h=renderHook(({pubkey})=>useCanvasImageSession({pubkey,mode:'owner',nativeCapable:true}),{initialProps:{pubkey:key}});
  let authorization!:Promise<void>;act(()=>{authorization=h.result.current.authorize();});
  await waitFor(()=>expect(fetchMock).toHaveBeenCalledTimes(4));
  let revocation!:Promise<void>;act(()=>{revocation=h.result.current.revoke();});
  h.rerender({pubkey:other});expect(h.result.current.pending).toBe(true);expect(h.result.current.nativeImagesEnabled).toBe(false);
  await act(async()=>{await h.result.current.authorize();});expect(fetchMock).toHaveBeenCalledTimes(4);
  await act(async()=>{finishVerify(response({authenticated:true,pubkey:key,expiresAt:Date.now()+60000}));await authorization;});
  expect(fetchMock.mock.calls[4][1]?.method).toBe('DELETE');expect(h.result.current.pending).toBe(true);
  await act(async()=>{await h.result.current.authorize();});expect(fetchMock).toHaveBeenCalledTimes(5);
  await act(async()=>{finishDelete(response({authenticated:false}));await revocation;});
  expect(h.result.current.pending).toBe(false);expect(h.result.current.nativeImagesEnabled).toBe(false);expect(mocks.sign).toHaveBeenCalledOnce();
 });

 it('eligible native ownerだけlogin連動で一回署名しStrictModeとreloadでは繰り返さない',async()=>{
  sessionStorage.clear();localStorage.clear();
  fetchMock.mockImplementation(async (_url,init)=>{
   if(!init?.method)return response({available:true,authenticated:false,eligible:true});
   if(init.body===JSON.stringify({action:'challenge'}))return response(challenge());
   return response({authenticated:true,pubkey:key,expiresAt:Date.now()+60000});
  });
  mocks.sign.mockImplementation(async event=>({...event,pubkey:key,id:'id',sig:'sig'}));
  const h=renderHook(()=>useCanvasImageSession({pubkey:key,mode:'owner',nativeCapable:true}),{wrapper:React.StrictMode});
  await waitFor(()=>expect(h.result.current.nativeImagesEnabled).toBe(true));expect(mocks.sign).toHaveBeenCalledOnce();
  h.unmount();const next=renderHook(()=>useCanvasImageSession({pubkey:key,mode:'owner',nativeCapable:true}));
  await waitFor(()=>expect(next.result.current.canAuthorize).toBe(true));expect(mocks.sign).toHaveBeenCalledOnce();
 });
 it.each([{nativeCapable:false,manualDOM:false,eligible:true},{nativeCapable:true,manualDOM:true,eligible:true},{nativeCapable:true,manualDOM:false,eligible:false}])('unsupported/manualDOM/nonownerは自動も明示retryも署名しない %j',async options=>{
  sessionStorage.clear();localStorage.clear();fetchMock.mockResolvedValue(response({available:true,authenticated:false,eligible:options.eligible}));
  const h=renderHook(()=>useCanvasImageSession({pubkey:key,mode:'owner',...options}));
  await act(async()=>{await Promise.resolve();await Promise.resolve();await h.result.current.authorize();});
  expect(mocks.sign).not.toHaveBeenCalled();expect(fetchMock.mock.calls.every(([,init])=>!init?.method)).toBe(true);
 });
 it('自動署名の拒否後はexpiry通知やremountで再試行せず明示retryだけ許可',async()=>{
  sessionStorage.clear();localStorage.clear();fetchMock.mockImplementation(async(_url,init)=>init?.method==='POST'?response(challenge()):response({available:true,authenticated:false,eligible:true}));
  mocks.sign.mockRejectedValue(new Error('cancelled'));
  const h=renderHook(()=>useCanvasImageSession({pubkey:key,mode:'owner',nativeCapable:true}));
  await waitFor(()=>expect(h.result.current.message).toContain('完了できません'));expect(mocks.sign).toHaveBeenCalledOnce();
  act(()=>window.dispatchEvent(new Event(CANVAS_IMAGE_SESSION_INVALIDATED)));h.unmount();
  const next=renderHook(()=>useCanvasImageSession({pubkey:key,mode:'owner',nativeCapable:true}));await waitFor(()=>expect(next.result.current.canAuthorize).toBe(true));
  expect(mocks.sign).toHaveBeenCalledOnce();await act(async()=>{await next.result.current.authorize();});expect(mocks.sign).toHaveBeenCalledTimes(2);
 });
 it('別tabのcooldown印と未取得WebLockでは自動署名しない',async()=>{
  sessionStorage.clear();localStorage.clear();localStorage.setItem('nlc-image-auth-attempt:'+key,String(Date.now()+60000));
  fetchMock.mockResolvedValue(response({available:true,authenticated:false,eligible:true}));
  const h=renderHook(()=>useCanvasImageSession({pubkey:key,mode:'owner',nativeCapable:true}));await waitFor(()=>expect(h.result.current.canAuthorize).toBe(true));expect(mocks.sign).not.toHaveBeenCalled();h.unmount();
  localStorage.clear();Object.defineProperty(navigator,'locks',{configurable:true,value:{request:vi.fn(async(_name,_options,callback)=>callback(null))}});
  const next=renderHook(()=>useCanvasImageSession({pubkey:key,mode:'owner',nativeCapable:true}));await waitFor(()=>expect(next.result.current.canAuthorize).toBe(true));expect(mocks.sign).not.toHaveBeenCalled();
  Object.defineProperty(navigator,'locks',{configurable:true,value:undefined});
 });

 it('署名中manualDOMへ変更するとpendingを解除し遅延結果を送らない',async()=>{
  let finish!:(value:unknown)=>void;fetchMock.mockImplementation(async(_url,init)=>init?.method==='POST'?response(challenge()):response({available:true,authenticated:false,eligible:true}));
  mocks.sign.mockReturnValue(new Promise(resolve=>{finish=resolve;}));
  const h=renderHook(({manualDOM})=>useCanvasImageSession({pubkey:key,mode:'owner',nativeCapable:true,manualDOM}),{initialProps:{manualDOM:false}});
  let job!:Promise<void>;act(()=>{job=h.result.current.authorize();});await waitFor(()=>expect(mocks.sign).toHaveBeenCalledOnce());
  h.rerender({manualDOM:true});expect(h.result.current.pending).toBe(false);expect(h.result.current.nativeImagesEnabled).toBe(false);
  await act(async()=>{finish({pubkey:key});await job;});
  expect(fetchMock.mock.calls.some(([,init])=>init?.headers && 'Authorization' in init.headers)).toBe(false);
 });
 it('WebLock取得後statusを再確認し他tabの有効cookieなら署名を省く',async()=>{
  sessionStorage.clear();localStorage.clear();
  Object.defineProperty(navigator,'locks',{configurable:true,value:{request:vi.fn(async(_name,_options,callback)=>callback({name:'lock'}))}});
  fetchMock.mockResolvedValueOnce(response({available:true,authenticated:false,eligible:true})).mockResolvedValueOnce(response({available:true,authenticated:true,eligible:true,pubkey:key,expiresAt:Date.now()+1800000}));
  const h=renderHook(()=>useCanvasImageSession({pubkey:key,mode:'owner',nativeCapable:true}));await waitFor(()=>expect(h.result.current.nativeImagesEnabled).toBe(true));
  expect(fetchMock).toHaveBeenCalledTimes(2);expect(mocks.sign).not.toHaveBeenCalled();
  Object.defineProperty(navigator,'locks',{configurable:true,value:undefined});
 });

 it('storage不可なら自動署名なし、明示retryは利用できる',async()=>{
  sessionStorage.clear();localStorage.clear();vi.spyOn(Storage.prototype,'getItem').mockImplementation(()=>{throw new Error('blocked');});
  fetchMock.mockImplementation(async(_url,init)=>{
   if(!init?.method)return response({available:true,authenticated:false,eligible:true});
   if(init.body===JSON.stringify({action:'challenge'}))return response(challenge());
   return response({authenticated:true,pubkey:key,expiresAt:Date.now()+60000});
  });mocks.sign.mockImplementation(async event=>({...event,pubkey:key,id:'id',sig:'sig'}));
  const h=renderHook(()=>useCanvasImageSession({pubkey:key,mode:'owner',nativeCapable:true}));await waitFor(()=>expect(h.result.current.canAuthorize).toBe(true));expect(mocks.sign).not.toHaveBeenCalled();
  await act(async()=>{await h.result.current.authorize();});expect(mocks.sign).toHaveBeenCalledOnce();expect(h.result.current.nativeImagesEnabled).toBe(true);
 });

});
