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
      { type: "text", text: "https://example.com/img.jpg/page" },
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
});
