"use client";

import { useState, useCallback, useRef } from "react";
import { uploadImageToBlossom } from "../lib/blossom";
import { ALLOWED_MIME_TYPES, MAX_FILE_SIZE } from "../types/blossom";
import type { AllowedMimeType } from "../types/blossom";

export interface ImageUploadState {
  file: File | null;
  uploading: boolean;
  uploadedUrl: string | null;
  error: string | null;
}

const initialState: ImageUploadState = {
  file: null,
  uploading: false,
  uploadedUrl: null,
  error: null,
};

/**
 * 画像アップロード管理hook。
 *
 * - ファイル選択時のバリデーション（サイズ・MIME制限）
 * - Blossomサーバーへのアップロード
 * - アップロード状態・エラーの管理
 */
export function useImageUpload(): {
  state: ImageUploadState;
  selectFile: (file: File) => void;
  uploadImage: () => Promise<string | null>;
  clearImage: () => void;
  reset: () => void;
} {
  const [state, setState] = useState<ImageUploadState>(initialState);
  const fileRef = useRef<File | null>(null);

  /** ファイル選択・バリデーション */
  const selectFile = useCallback((file: File) => {
    // サイズチェック
    if (file.size > MAX_FILE_SIZE) {
      const sizeMB = (file.size / (1024 * 1024)).toFixed(1);
      fileRef.current = null;
      setState({
        file: null,
        uploading: false,
        uploadedUrl: null,
        error: `ファイルサイズが大きすぎます（${sizeMB}MB）。上限は10MBです`,
      });
      return;
    }

    // MIMEタイプチェック
    if (!ALLOWED_MIME_TYPES.includes(file.type as AllowedMimeType)) {
      fileRef.current = null;
      setState({
        file: null,
        uploading: false,
        uploadedUrl: null,
        error: `対応していないファイル形式です（${file.type || "不明"}）。JPEG, PNG, GIF, WebPのみ対応しています`,
      });
      return;
    }

    // バリデーションOK
    fileRef.current = file;
    setState({
      file,
      uploading: false,
      uploadedUrl: null,
      error: null,
    });
  }, []);

  /** Blossomアップロード実行 */
  const uploadImage = useCallback(async () => {
    const currentFile = fileRef.current;
    if (!currentFile) {
      setState((prev) => ({
        ...prev,
        error: "ファイルが選択されていません",
      }));
      return null;
    }

    setState((prev) => ({ ...prev, uploading: true, error: null }));

    try {
      const url = await uploadImageToBlossom(currentFile);
      setState((prev) => ({
        ...prev,
        uploading: false,
        uploadedUrl: url,
        error: null,
      }));
      return url;
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : "画像のアップロード中に予期しないエラーが発生しました";
      setState((prev) => ({
        ...prev,
        uploading: false,
        error: message,
      }));
      return null;
    }
  }, []);

  /** 選択ファイルをクリア（アップロード済みURLは保持） */
  const clearImage = useCallback(() => {
    fileRef.current = null;
    setState((prev) => ({
      ...prev,
      file: null,
      error: null,
    }));
  }, []);

  /** 全状態をリセット */
  const reset = useCallback(() => {
    fileRef.current = null;
    setState(initialState);
  }, []);

  return { state, selectFile, uploadImage, clearImage, reset };
}
