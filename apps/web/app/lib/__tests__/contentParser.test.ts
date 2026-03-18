import { describe, it, expect } from "vitest";
import { parseContent } from "../contentParser";

describe("parseContent", () => {
  // 1. テキストのみ
  it("テキストのみの場合、textノード1つを返す", () => {
    const result = parseContent("こんにちは世界");
    expect(result).toEqual([{ type: "text", text: "こんにちは世界" }]);
  });

  // 2. 画像URL1つ
  it("画像URLのみの場合、imageノード1つを返す", () => {
    const result = parseContent("https://example.com/photo.jpg");
    expect(result).toEqual([
      { type: "image", url: "https://example.com/photo.jpg" },
    ]);
  });

  // 3. テキスト + 画像URL + テキスト → 3ノード
  it("テキストの間に画像URLがある場合、3ノードに分割する", () => {
    const result = parseContent(
      "見てこれ https://example.com/cat.png かわいい"
    );
    expect(result).toEqual([
      { type: "text", text: "見てこれ " },
      { type: "image", url: "https://example.com/cat.png" },
      { type: "text", text: " かわいい" },
    ]);
  });

  // 4. 複数の画像URL
  it("複数の画像URLを含む場合、それぞれimageノードに分離する", () => {
    const result = parseContent(
      "https://example.com/a.jpg テスト https://example.com/b.png"
    );
    expect(result).toEqual([
      { type: "image", url: "https://example.com/a.jpg" },
      { type: "text", text: " テスト " },
      { type: "image", url: "https://example.com/b.png" },
    ]);
  });

  // 5. 画像URLだけ（前後テキストなし）
  it("画像URLだけの場合、imageノードのみを返す", () => {
    const result = parseContent("https://cdn.example.com/image.webp");
    expect(result).toEqual([
      { type: "image", url: "https://cdn.example.com/image.webp" },
    ]);
  });

  // 6. 空文字列 → []
  it("空文字列の場合、空配列を返す", () => {
    expect(parseContent("")).toEqual([]);
  });

  // 7. URLっぽいがhttpでない文字列 → textとして扱う
  it("http(s)でないURLは画像として検出しない", () => {
    const result = parseContent("ftp://example.com/img.jpg");
    expect(result).toEqual([
      { type: "text", text: "ftp://example.com/img.jpg" },
    ]);
  });

  // 8. クエリパラメータ付き画像URL
  it("クエリパラメータ付きの画像URLも検出する", () => {
    const result = parseContent(
      "画像: https://example.com/img.jpg?w=100&h=200"
    );
    expect(result).toEqual([
      { type: "text", text: "画像: " },
      { type: "image", url: "https://example.com/img.jpg?w=100&h=200" },
    ]);
  });

  // 追加: 各拡張子のテスト
  it("すべてのサポート拡張子を検出する (.jpg, .jpeg, .png, .gif, .webp)", () => {
    const extensions = ["jpg", "jpeg", "png", "gif", "webp"];
    for (const ext of extensions) {
      const url = `https://example.com/img.${ext}`;
      const result = parseContent(url);
      expect(result).toEqual([{ type: "image", url }]);
    }
  });

  // 追加: 大文字の拡張子
  it("大文字の拡張子も検出する", () => {
    const result = parseContent("https://example.com/photo.JPG");
    expect(result).toEqual([
      { type: "image", url: "https://example.com/photo.JPG" },
    ]);
  });

  // 追加: URLパス途中の画像拡張子は誤検出しない
  it("URLパスの途中に画像拡張子がある場合、画像として検出しない", () => {
    const result = parseContent("https://example.com/img.jpg/page");
    expect(result).toEqual([
      { type: "link", url: "https://example.com/img.jpg/page", text: "example.com/img.jpg/page" },
    ]);
  });

  // 追加: フラグメント付き画像URL
  it("フラグメント付きの画像URLも検出する", () => {
    const result = parseContent("https://example.com/img.png#section");
    // フラグメント付きでも画像URLとして検出されるべき
    expect(result).toEqual([
      { type: "image", url: "https://example.com/img.png#section" },
    ]);
  });

  // ===== link ノード基本テスト =====

  // linkノード: URLのみ
  it("一般URLのみの場合、linkノード1つを返す", () => {
    const result = parseContent("https://example.com/page");
    expect(result).toEqual([
      { type: "link", url: "https://example.com/page", text: "example.com/page" },
    ]);
  });

  // linkノード: テキスト + URL + テキスト
  it("テキストの間に一般URLがある場合、text + link + text に分割する", () => {
    const result = parseContent("見て https://example.com/page すごい");
    expect(result).toEqual([
      { type: "text", text: "見て " },
      { type: "link", url: "https://example.com/page", text: "example.com/page" },
      { type: "text", text: " すごい" },
    ]);
  });

  // linkノード: 複数URL
  it("複数の一般URLを含む場合、それぞれlinkノードに分離する", () => {
    const result = parseContent("https://a.com と https://b.com");
    expect(result).toEqual([
      { type: "link", url: "https://a.com", text: "a.com" },
      { type: "text", text: " と " },
      { type: "link", url: "https://b.com", text: "b.com" },
    ]);
  });

  // linkノード: 画像URL + 一般URL混在
  it("画像URLと一般URLが混在する場合、image + text + link に分割する", () => {
    const result = parseContent("https://img.com/photo.jpg と https://example.com");
    expect(result).toEqual([
      { type: "image", url: "https://img.com/photo.jpg" },
      { type: "text", text: " と " },
      { type: "link", url: "https://example.com", text: "example.com" },
    ]);
  });

  // ===== URL省略表示テスト =====

  // 短いURL → プロトコル除去のみ
  it("短いURLはプロトコルを除去した文字列をtextに使う", () => {
    const result = parseContent("https://example.com");
    expect(result).toEqual([
      { type: "link", url: "https://example.com", text: "example.com" },
    ]);
  });

  // 長いURL（50文字超） → 省略表示
  it("50文字を超える長いURLは末尾を省略する", () => {
    // プロトコル除去後に50文字超になるURL
    const longUrl = "https://example.com/very/long/path/that/exceeds/fifty/characters/limit/page";
    const result = parseContent(longUrl);
    const withoutProtocol = longUrl.replace(/^https?:\/\//, "");
    // 50文字超なので49文字 + "…"
    const expectedText = withoutProtocol.slice(0, 49) + "…";
    expect(result).toEqual([
      { type: "link", url: longUrl, text: expectedText },
    ]);
    expect(expectedText.length).toBe(50);
    expect(expectedText).toContain("…");
  });

  // ちょうど50文字 → 省略されない境界値テスト
  it("プロトコル除去後ちょうど50文字のURLは省略されない", () => {
    // "example.com/" = 12文字、残り38文字をパディング → 合計50文字
    const padding = "a".repeat(38);
    const url = `https://example.com/${padding}`;
    const withoutProtocol = url.replace(/^https?:\/\//, "");
    // ちょうど50文字であることを確認
    expect(withoutProtocol.length).toBe(50);
    const result = parseContent(url);
    expect(result).toEqual([
      { type: "link", url: url, text: withoutProtocol },
    ]);
    // "…" が含まれないことを確認
    expect(withoutProtocol).not.toContain("…");
  });

  // ===== エッジケース =====

  // 括弧で囲まれたURL
  it("括弧で囲まれたURLを正しく分離する", () => {
    const result = parseContent("(https://example.com)");
    expect(result).toEqual([
      { type: "text", text: "(" },
      { type: "link", url: "https://example.com", text: "example.com" },
      { type: "text", text: ")" },
    ]);
  });

  // 日本語句読点の後
  it("URLの後に日本語句読点「。」がある場合、linkとtextに分離する", () => {
    const result = parseContent("https://example.com。次の文");
    expect(result).toEqual([
      { type: "link", url: "https://example.com", text: "example.com" },
      { type: "text", text: "。次の文" },
    ]);
  });

  // 日本語読点の後
  it("URLの後に日本語読点「、」がある場合、linkとtextに分離する", () => {
    const result = parseContent("https://example.com、次");
    expect(result).toEqual([
      { type: "link", url: "https://example.com", text: "example.com" },
      { type: "text", text: "、次" },
    ]);
  });

  // 全角感嘆符の後
  it("URLの後に全角感嘆符「！」がある場合、linkとtextに分離する", () => {
    const result = parseContent("https://example.com！すごい");
    expect(result).toEqual([
      { type: "link", url: "https://example.com", text: "example.com" },
      { type: "text", text: "！すごい" },
    ]);
  });

  // 画像URLはlinkにならない
  it("画像URLはlinkノードではなくimageノードになる", () => {
    const result = parseContent("https://example.com/photo.jpg");
    expect(result).toEqual([
      { type: "image", url: "https://example.com/photo.jpg" },
    ]);
    // linkノードが含まれないことを確認
    expect(result.every((n) => n.type !== "link")).toBe(true);
  });

  // http:// も検出
  it("http://スキームのURLもlinkノードとして検出する", () => {
    const result = parseContent("http://example.com");
    expect(result).toEqual([
      { type: "link", url: "http://example.com", text: "example.com" },
    ]);
  });
});
