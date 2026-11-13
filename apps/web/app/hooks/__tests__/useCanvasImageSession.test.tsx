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
beforeEach(()=>{vi.stubGlobal('fetch',fetchMock);vi.stubGlobal('crypto',webcrypto);fetchMock.mockReset();mocks.sign.mockReset();mocks.invalidate.mockClear();});
afterEach(()=>{cleanup();vi.unstubAllGlobals();vi.useRealTimers();});
describe('画像配信の明示的本人確認',()=>{
 it('statusだけ自動取得し署名せず、本人の期限付きsessionだけを使う',async()=>{
  fetchMock.mockResolvedValue(response({available:true,authenticated:true,pubkey:key,expiresAt:Date.now()+60000}));
  const h=renderHook(()=>useCanvasImageSession({pubkey:key,mode:'owner'}));
  await waitFor(()=>expect(h.result.current.nativeImagesEnabled).toBe(true));
  expect(mocks.sign).not.toHaveBeenCalled();expect(fetchMock).toHaveBeenCalledTimes(1);
 });
 it('明示buttonだけNIP98署名しpayloadとverify bodyを完全一致させる',async()=>{
  const c=challenge();fetchMock.mockResolvedValueOnce(response({available:true,authenticated:false})).mockResolvedValueOnce(response(c)).mockResolvedValueOnce(response({authenticated:true,pubkey:key,expiresAt:Date.now()+60000}));
  mocks.sign.mockImplementation(async event=>({...event,pubkey:key,id:'id',sig:'sig'}));
  function UI(){return <ImageProxyAccess access={useCanvasImageSession({pubkey:key,mode:'owner'})}/>;}
  render(<UI/>);await waitFor(()=>expect(fetchMock).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole('button',{name:'本人確認して画像エフェクトを有効にする'}));
  await screen.findByRole('button',{name:'画像エフェクトを停止して本人確認を解除'});
  const event=mocks.sign.mock.calls[0][0];expect(event.kind).toBe(27235);expect(event.content).toBe('');
  const hash=await webcrypto.subtle.digest('SHA-256',new TextEncoder().encode(c.payload));
  expect(event.tags).toEqual([['u',c.url],['method','POST'],['payload',Buffer.from(hash).toString('hex')]]);
  const verify=fetchMock.mock.calls[2][1]!;expect(verify.body).toBe(c.payload);
  expect(JSON.parse(atob((verify.headers as Record<string,string>).Authorization.slice(6))).pubkey).toBe(key);
 });
 it('別originchallengeを署名せず拒否する',async()=>{
  fetchMock.mockResolvedValueOnce(response({authenticated:false})).mockResolvedValueOnce(response({...challenge(),url:'https://other.example/api/canvas-image/auth'}));
  const h=renderHook(()=>useCanvasImageSession({pubkey:key,mode:'owner'}));
  await act(async()=>{await h.result.current.authorize();});
  expect(mocks.sign).not.toHaveBeenCalled();expect(h.result.current.nativeImagesEnabled).toBe(false);
 });
 it('account変更後に遅延署名が返ってもverifyへ送らない',async()=>{
  let resolve!:(v:unknown)=>void;fetchMock.mockResolvedValue(response({authenticated:false}));
  fetchMock.mockResolvedValueOnce(response({authenticated:false})).mockResolvedValueOnce(response(challenge()));
  mocks.sign.mockReturnValue(new Promise(r=>{resolve=r;}));
  const h=renderHook(({pubkey})=>useCanvasImageSession({pubkey,mode:'owner'}),{initialProps:{pubkey:key}});
  let authorization!:Promise<void>;act(()=>{authorization=h.result.current.authorize();});
  await waitFor(()=>expect(mocks.sign).toHaveBeenCalledOnce());h.rerender({pubkey:other});
  await act(async()=>{resolve({pubkey:key});await authorization;});
  expect(fetchMock.mock.calls.filter(([,init])=>init?.headers && 'Authorization' in init.headers)).toHaveLength(0);
  expect(h.result.current.nativeImagesEnabled).toBe(false);
 });
 it('401通知で直ちにcacheとnativeを無効化し明示DELETEできる',async()=>{
  fetchMock.mockResolvedValue(response({available:true,authenticated:true,pubkey:key,expiresAt:Date.now()+60000}));
  const h=renderHook(()=>useCanvasImageSession({pubkey:key,mode:'owner'}));await waitFor(()=>expect(h.result.current.nativeImagesEnabled).toBe(true));
  act(()=>window.dispatchEvent(new Event(CANVAS_IMAGE_SESSION_INVALIDATED)));
  expect(h.result.current.nativeImagesEnabled).toBe(false);expect(mocks.invalidate).toHaveBeenCalled();
  await act(async()=>{await h.result.current.revoke();});expect(fetchMock.mock.calls.at(-1)?.[1]?.method).toBe('DELETE');
 });
 it('期限切れで無効化し、previewだけserver指定modeで署名なしに有効',async()=>{
  vi.useFakeTimers();fetchMock.mockResolvedValue(response({available:true,authenticated:true,pubkey:key,expiresAt:Date.now()+1000}));
  const h=renderHook(()=>useCanvasImageSession({pubkey:key,mode:'owner'}));await act(async()=>{await Promise.resolve();await Promise.resolve();});
  expect(h.result.current.nativeImagesEnabled).toBe(true);act(()=>vi.advanceTimersByTime(1001));expect(h.result.current.nativeImagesEnabled).toBe(false);
  const preview=renderHook(()=>useCanvasImageSession({pubkey:key,mode:'preview'}));expect(preview.result.current.nativeImagesEnabled).toBe(true);expect(mocks.sign).not.toHaveBeenCalled();
 });
 it('別accountのcookieは有効化せず、previewも失効通知で停止する',async()=>{
  fetchMock.mockResolvedValue(response({available:true,authenticated:true,pubkey:other,expiresAt:Date.now()+60000}));
  const h=renderHook(()=>useCanvasImageSession({pubkey:key,mode:'owner'}));await waitFor(()=>expect(h.result.current.message).toContain('別アカウント'));
  expect(h.result.current.nativeImagesEnabled).toBe(false);
  const preview=renderHook(()=>useCanvasImageSession({pubkey:key,mode:'preview'}));expect(preview.result.current.nativeImagesEnabled).toBe(true);
  act(()=>window.dispatchEvent(new Event(CANVAS_IMAGE_SESSION_INVALIDATED)));expect(preview.result.current.nativeImagesEnabled).toBe(false);
 });
 it('署名拒否はgeneric表示にしrawerrorや内容を漏らさない',async()=>{
  fetchMock.mockResolvedValueOnce(response({available:true,authenticated:false})).mockResolvedValueOnce(response(challenge()));
  mocks.sign.mockRejectedValue(new Error('secret-raw-error'));
  const h=renderHook(()=>useCanvasImageSession({pubkey:key,mode:'owner'}));await act(async()=>{await h.result.current.authorize();});
  expect(h.result.current.nativeImagesEnabled).toBe(false);expect(h.result.current.message).not.toContain('secret');expect(h.result.current.pending).toBe(false);
  expect(fetchMock).toHaveBeenCalledTimes(2);
 });

 it('送信済verifyの応答後にDELETEし遅延Set-Cookieとの同画面raceを避ける',async()=>{
  let resolve!:(response:Response)=>void;const pending=new Promise<Response>(r=>{resolve=r;});
  fetchMock.mockResolvedValueOnce(response({available:true,authenticated:false})).mockResolvedValueOnce(response(challenge())).mockReturnValueOnce(pending).mockResolvedValueOnce(response({authenticated:false}));
  mocks.sign.mockImplementation(async event=>({...event,pubkey:key,id:'id',sig:'sig'}));
  const h=renderHook(()=>useCanvasImageSession({pubkey:key,mode:'owner'}));
  let authorization!:Promise<void>;act(()=>{authorization=h.result.current.authorize();});
  await waitFor(()=>expect(fetchMock).toHaveBeenCalledTimes(3));
  let revocation!:Promise<void>;act(()=>{revocation=h.result.current.revoke();});
  expect(fetchMock).toHaveBeenCalledTimes(3);expect(h.result.current.nativeImagesEnabled).toBe(false);
  await act(async()=>{resolve(response({authenticated:true,pubkey:key,expiresAt:Date.now()+60000}));await authorization;await revocation;});
  expect(fetchMock.mock.calls[3][1]?.method).toBe('DELETE');expect(h.result.current.nativeImagesEnabled).toBe(false);expect(h.result.current.pending).toBe(false);
 });

 it('revoke中のaccount変更でもlockとpendingを保持し再authorizeを送らない',async()=>{
  let finishVerify!:(response:Response)=>void,finishDelete!:(response:Response)=>void;
  const verify=new Promise<Response>(resolve=>{finishVerify=resolve;});
  const deletion=new Promise<Response>(resolve=>{finishDelete=resolve;});
  fetchMock.mockResolvedValueOnce(response({available:true,authenticated:false})).mockResolvedValueOnce(response(challenge())).mockReturnValueOnce(verify).mockReturnValueOnce(deletion).mockResolvedValue(response({available:true,authenticated:false}));
  mocks.sign.mockImplementation(async event=>({...event,pubkey:key,id:'id',sig:'sig'}));
  const h=renderHook(({pubkey})=>useCanvasImageSession({pubkey,mode:'owner'}),{initialProps:{pubkey:key}});
  let authorization!:Promise<void>;act(()=>{authorization=h.result.current.authorize();});
  await waitFor(()=>expect(fetchMock).toHaveBeenCalledTimes(3));
  let revocation!:Promise<void>;act(()=>{revocation=h.result.current.revoke();});
  h.rerender({pubkey:other});expect(h.result.current.pending).toBe(true);expect(h.result.current.nativeImagesEnabled).toBe(false);
  await act(async()=>{await h.result.current.authorize();});expect(fetchMock).toHaveBeenCalledTimes(3);
  await act(async()=>{finishVerify(response({authenticated:true,pubkey:key,expiresAt:Date.now()+60000}));await authorization;});
  expect(fetchMock.mock.calls[3][1]?.method).toBe('DELETE');expect(h.result.current.pending).toBe(true);
  await act(async()=>{await h.result.current.authorize();});expect(fetchMock).toHaveBeenCalledTimes(4);
  await act(async()=>{finishDelete(response({authenticated:false}));await revocation;});
  expect(h.result.current.pending).toBe(false);expect(h.result.current.nativeImagesEnabled).toBe(false);expect(mocks.sign).toHaveBeenCalledOnce();
 });

});
