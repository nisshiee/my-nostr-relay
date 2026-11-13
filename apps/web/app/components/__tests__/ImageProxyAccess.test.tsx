// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ImageProxyAccess } from '../ImageProxyAccess';
import type { useCanvasImageSession } from '../../hooks/useCanvasImageSession';
afterEach(cleanup);
const access=()=>({nativeImagesEnabled:false,canAuthorize:true,pending:false,message:'署名が拒否されました',reason:'確認待ち',authorize:vi.fn(),revoke:vi.fn()} as ReturnType<typeof useCanvasImageSession>);
describe('設定内の画像本人確認操作',()=>{
  it('表示だけでは署名せず明示再試行だけauthorizeする',()=>{
    const state=access();render(<ImageProxyAccess access={state} nativeCapable manualDOM={false}/>);
    expect(state.authorize).not.toHaveBeenCalled();expect(screen.getByRole('status').textContent).toContain('拒否');
    fireEvent.click(screen.getByRole('button',{name:'画像の本人確認を再試行'}));expect(state.authorize).toHaveBeenCalledOnce();
  });
  it.each([[false,false,true],[true,true,true],[true,false,false]])('未対応・互換選択・対象外は再試行できない', (capable,manual,eligible)=>{
    const state=access();state.canAuthorize=eligible;render(<ImageProxyAccess access={state} nativeCapable={capable} manualDOM={manual}/>);
    const button=screen.getByRole('button',{name:'画像の本人確認を再試行'}) as HTMLButtonElement;
    expect(button.disabled).toBe(true);fireEvent.click(button);expect(state.authorize).not.toHaveBeenCalled();
  });
});
