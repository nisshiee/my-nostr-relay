// @vitest-environment jsdom
import React, { StrictMode } from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CanvasImageProvider, MediaImage } from '../../components/CanvasAwareImage';
import { canvasImageLoader } from '../../lib/canvasImageLoader';
import { useCanvasImageSession, type CanvasImageAccessMode } from '../useCanvasImageSession';
const key='a'.repeat(64);
vi.mock('../../lib/nostrSigner',()=>({signEventWithActiveSigner:vi.fn()}));
const fetchMock=vi.fn<typeof fetch>();
function App({mode,pubkey=key}:{mode:CanvasImageAccessMode;pubkey?:string}) {
 const access=useCanvasImageSession({pubkey,mode});
 return <CanvasImageProvider enabled={access.nativeImagesEnabled}><MediaImage src="https://images.example/image.png" imageSize={64} alt="実loader画像" width={32} height={32}/></CanvasImageProvider>;
}
beforeEach(()=>{
 vi.stubGlobal('fetch',fetchMock);fetchMock.mockReset();
 Object.defineProperty(URL,'createObjectURL',{configurable:true,value:vi.fn(()=> 'blob:verified-image')});
 Object.defineProperty(URL,'revokeObjectURL',{configurable:true,value:vi.fn()});
 canvasImageLoader.invalidateAuthorization();
});
afterEach(()=>{cleanup();canvasImageLoader.invalidateAuthorization();vi.unstubAllGlobals();});
describe('session親と実loader子のeffect順序',()=>{
 it.each([false,true])('preview初回mount後に画像がBlobへ到達する (StrictMode=%s)',async strict=>{
  fetchMock.mockImplementation(async()=>({ok:true,status:200,blob:async()=>new Blob(['pixels'],{type:'image/webp'})}) as Response);
  render(strict?<StrictMode><App mode="preview"/></StrictMode>:<App mode="preview"/>);
  await waitFor(()=>expect(screen.getByRole('img',{name:'実loader画像'}).getAttribute('src')).toBe('blob:verified-image'));
  expect(fetchMock.mock.calls.every(([url])=>String(url).startsWith('/api/canvas-image?'))).toBe(true);
 });
 it('owner status成功で新しくmountされた画像subscriptionを破棄しない',async()=>{
  fetchMock.mockImplementation(async url=>String(url)==='/api/canvas-image/auth'
   ? ({ok:true,status:200,json:async()=>({available:true,authenticated:true,pubkey:key,expiresAt:Date.now()+60000})}) as Response
   : ({ok:true,status:200,blob:async()=>new Blob(['pixels'],{type:'image/webp'})}) as Response);
  render(<App mode="owner"/>);
  await waitFor(()=>expect(screen.getByRole('img',{name:'実loader画像'}).getAttribute('src')).toBe('blob:verified-image'));
  expect(fetchMock.mock.calls.some(([url])=>String(url).startsWith('/api/canvas-image?'))).toBe(true);
 });
 it('previewのaccount変更は公開画像subscriptionを壊さず表示を維持する',async()=>{
  fetchMock.mockImplementation(async()=>({ok:true,status:200,blob:async()=>new Blob(['pixels'],{type:'image/webp'})}) as Response);
  const app=render(<App mode="preview"/>);
  await waitFor(()=>expect(screen.getByRole('img',{name:'実loader画像'}).getAttribute('src')).toBe('blob:verified-image'));
  app.rerender(<App mode="preview" pubkey={'b'.repeat(64)}/>);
  expect(screen.getByRole('img',{name:'実loader画像'}).getAttribute('src')).toBe('blob:verified-image');
  expect(URL.revokeObjectURL).not.toHaveBeenCalled();
 });

});
