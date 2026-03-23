/**
 * Blossom (BUD-02) 画像アップロード
 *
 * @see https://github.com/hzrd149/blossom/blob/master/buds/02.md
 */

import type { NostrEvent } from "../types/nostr";
import {
  ALLOWED_MIME_TYPES,
  MAX_FILE_SIZE,
  type AllowedMimeType,
  type BlossomUploadResponse,
} from "../types/blossom";
import { BLOSSOM_UPLOAD_URL, BLOSSOM_AUTH_EXPIRATION } from "./constants";

/** ファイルのバリデーション */
function validateFile(file: File): void {
  if (file.size > MAX_FILE_SIZE) {
    const sizeMB = (file.size / (1024 * 1024)).toFixed(1);
    throw new Error(
      `ファイルサイズが大きすぎます（${sizeMB}MB）。上限は10MBです`,
    );
  }

  if (
    !ALLOWED_MIME_TYPES.includes(file.type as AllowedMimeType)
  ) {
    throw new Error(
      `対応していないファイル形式です（${file.type || "不明"}）。JPEG, PNG, GIF, WebPのみ対応しています`,
    );
  }
}

/** ArrayBuffer → hex文字列 */
function bufferToHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** ファイルのSHA-256ハッシュを計算 */
async function computeSha256(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const hashBuffer = await crypto.subtle.digest("SHA-256", buffer);
  return bufferToHex(hashBuffer);
}

/** Blossom認証イベント (kind:24242) を作成・署名 */
async function createAuthEvent(
  file: File,
  sha256hex: string,
): Promise<string> {
  if (!window.nostr) {
    throw new Error(
      "NIP-07拡張（nos2x等）が見つかりません。ブラウザ拡張をインストールしてください",
    );
  }

  const now = Math.floor(Date.now() / 1000);
  const expiration = now + BLOSSOM_AUTH_EXPIRATION;

  const unsignedEvent: NostrEvent = {
    kind: 24242,
    created_at: now,
    content: `Upload ${file.name}`,
    tags: [
      ["t", "upload"],
      ["x", sha256hex],
      ["expiration", String(expiration)],
    ],
  };

  let signedEvent: NostrEvent & { id: string; sig: string; pubkey: string };
  try {
    signedEvent = await window.nostr.signEvent(unsignedEvent);
  } catch {
    throw new Error("署名が拒否されました。アップロードにはイベント署名が必要です");
  }

  // base64urlエンコードしてAuthorizationヘッダー用の値を作成（BUD-11準拠）
  const eventJson = JSON.stringify(signedEvent);
  const base64 = btoa(
    // UTF-8 → binary string（日本語ファイル名対応）
    new TextEncoder()
      .encode(eventJson)
      .reduce((s, b) => s + String.fromCharCode(b), ""),
  );
  // Base64 → Base64url (URL-safe, no padding)
  const base64url = base64
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  return base64url;
}

/**
 * Blossomサーバーに画像をアップロードする
 *
 * @param file アップロードするファイル
 * @returns アップロードされた画像のURL
 * @throws バリデーションエラー、署名拒否、ネットワークエラー
 */
export async function uploadImageToBlossom(file: File): Promise<string> {
  // 1. バリデーション
  validateFile(file);

  // 2. SHA-256ハッシュ計算
  const sha256hex = await computeSha256(file);

  // 3. 認証イベント作成・署名
  const authBase64 = await createAuthEvent(file, sha256hex);

  // 4. アップロード
  let response: Response;
  try {
    response = await fetch(BLOSSOM_UPLOAD_URL, {
      method: "PUT",
      headers: {
        Authorization: `Nostr ${authBase64}`,
        "Content-Type": file.type,
      },
      body: file,
    });
  } catch {
    throw new Error(
      "アップロードサーバーに接続できませんでした。ネットワーク接続を確認してください",
    );
  }

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(
      `アップロードに失敗しました（${response.status}）${errorText ? `: ${errorText}` : ""}`,
    );
  }

  const data: BlossomUploadResponse = await response.json();

  if (!data.url) {
    throw new Error("サーバーからURLが返されませんでした");
  }

  return data.url;
}
