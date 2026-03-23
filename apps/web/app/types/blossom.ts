/** Blossom (BUD-02) 関連の型定義 */

/** アップロード可能な画像MIMEタイプ */
export const ALLOWED_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
] as const;

export type AllowedMimeType = (typeof ALLOWED_MIME_TYPES)[number];

/** ファイルサイズ上限（10MB） */
export const MAX_FILE_SIZE = 10 * 1024 * 1024;

/** Blossom BUD-02 アップロードレスポンス */
export interface BlossomUploadResponse {
  /** アップロードされたファイルのURL */
  url: string;
  /** SHA-256ハッシュ（hex） */
  sha256: string;
  /** ファイルサイズ（bytes） */
  size: number;
  /** MIMEタイプ */
  type?: string;
  /** アップロード日時（unix timestamp） */
  uploaded?: number;
}
