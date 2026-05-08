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
      { type: "linkPreview", url: "https://example.com/img.jpg/page", text: "example.com/img.jpg/page" },
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

  // linkPreviewノード: URLのみ
  it("一般URLのみの場合、linkPreviewノード1つを返す", () => {
    const result = parseContent("https://example.com/page");
    expect(result).toEqual([
      { type: "linkPreview", url: "https://example.com/page", text: "example.com/page" },
    ]);
  });

  // linkPreviewノード: テキスト + URL + テキスト
  it("テキストの間に一般URLがある場合、text + linkPreview + text に分割する", () => {
    const result = parseContent("見て https://example.com/page すごい");
    expect(result).toEqual([
      { type: "text", text: "見て " },
      { type: "linkPreview", url: "https://example.com/page", text: "example.com/page" },
      { type: "text", text: " すごい" },
    ]);
  });

  // linkノード: 複数URL
  it("複数の一般URLを含む場合、最初だけlinkPreviewノードにする", () => {
    const result = parseContent("https://a.com と https://b.com");
    expect(result).toEqual([
      { type: "linkPreview", url: "https://a.com", text: "a.com" },
      { type: "text", text: " と " },
      { type: "link", url: "https://b.com", text: "b.com" },
    ]);
  });

  // linkPreviewノード: 画像URL + 一般URL混在
  it("画像URLと一般URLが混在する場合、image + text + linkPreview に分割する", () => {
    const result = parseContent("https://img.com/photo.jpg と https://example.com");
    expect(result).toEqual([
      { type: "image", url: "https://img.com/photo.jpg" },
      { type: "text", text: " と " },
      { type: "linkPreview", url: "https://example.com", text: "example.com" },
    ]);
  });

  // ===== URL省略表示テスト =====

  // 短いURL → プロトコル除去のみ
  it("短いURLはプロトコルを除去した文字列をtextに使う", () => {
    const result = parseContent("https://example.com");
    expect(result).toEqual([
      { type: "linkPreview", url: "https://example.com", text: "example.com" },
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
      { type: "linkPreview", url: longUrl, text: expectedText },
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
      { type: "linkPreview", url: url, text: withoutProtocol },
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
      { type: "linkPreview", url: "https://example.com", text: "example.com" },
      { type: "text", text: ")" },
    ]);
  });

  // 日本語句読点の後
  it("URLの後に日本語句読点「。」がある場合、linkとtextに分離する", () => {
    const result = parseContent("https://example.com。次の文");
    expect(result).toEqual([
      { type: "linkPreview", url: "https://example.com", text: "example.com" },
      { type: "text", text: "。次の文" },
    ]);
  });

  // 日本語読点の後
  it("URLの後に日本語読点「、」がある場合、linkとtextに分離する", () => {
    const result = parseContent("https://example.com、次");
    expect(result).toEqual([
      { type: "linkPreview", url: "https://example.com", text: "example.com" },
      { type: "text", text: "、次" },
    ]);
  });

  // 全角感嘆符の後
  it("URLの後に全角感嘆符「！」がある場合、linkとtextに分離する", () => {
    const result = parseContent("https://example.com！すごい");
    expect(result).toEqual([
      { type: "linkPreview", url: "https://example.com", text: "example.com" },
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
      { type: "linkPreview", url: "http://example.com", text: "example.com" },
    ]);
  });

  // ===== Nostr URI テスト =====

  // nevent1 の検出
  it("nostr:nevent1... を検出してquoteノードを返す", () => {
    const uri = "nostr:nevent1qqsxyzabc123def456ghi789jkl012mno345pqr678stu901vwx234yz";
    const result = parseContent(uri);
    expect(result).toEqual([
      { type: "quote", uri },
    ]);
  });

  // note1 の検出
  it("nostr:note1... を検出してquoteノードを返す", () => {
    const uri = "nostr:note1qqsxyzabc123def456ghi789jkl012mno345pqr678stu901vwx234yz";
    const result = parseContent(uri);
    expect(result).toEqual([
      { type: "quote", uri },
    ]);
  });

  // naddr1 の検出
  it("nostr:naddr1... を検出してquoteノードを返す", () => {
    const uri = "nostr:naddr1qqsxyzabc123def456ghi789jkl012mno345pqr678stu901vwx234yz";
    const result = parseContent(uri);
    expect(result).toEqual([
      { type: "quote", uri },
    ]);
  });

  // テキスト + Nostr URI + テキスト → 3ノード
  it("テキストの間にNostr URIがある場合、text + quote + text に分割する", () => {
    const uri = "nostr:nevent1qqsxyzabc123def456ghi789jkl012mno345pqr";
    const result = parseContent(`引用: ${uri} いいね`);
    expect(result).toEqual([
      { type: "text", text: "引用: " },
      { type: "quote", uri },
      { type: "text", text: " いいね" },
    ]);
  });

  // 複数Nostr URI の処理
  it("複数のNostr URIを含む場合、それぞれquoteノードに分離する", () => {
    const uri1 = "nostr:nevent1qqsabc123def456ghi789jkl012mno345";
    const uri2 = "nostr:note1qqsxyz789abc012def345ghi678jkl901";
    const result = parseContent(`${uri1} と ${uri2}`);
    expect(result).toEqual([
      { type: "quote", uri: uri1 },
      { type: "text", text: " と " },
      { type: "quote", uri: uri2 },
    ]);
  });

  // 画像URL → Nostr URI → 一般URL の優先順テスト
  it("画像URL・Nostr URI・一般URLが混在する場合、それぞれ正しいノードタイプに変換する", () => {
    const imageUrl = "https://example.com/photo.jpg";
    const nostrUri = "nostr:nevent1qqsabc123def456ghi789jkl012mno345pqr";
    const linkUrl = "https://example.com/page";
    const result = parseContent(`${imageUrl} ${nostrUri} ${linkUrl}`);
    expect(result).toEqual([
      { type: "image", url: imageUrl },
      { type: "text", text: " " },
      { type: "quote", uri: nostrUri },
      { type: "text", text: " " },
      { type: "linkPreview", url: linkUrl, text: "example.com/page" },
    ]);
  });

  // 不正なNostr URI（bech32でない）の処理
  it("nostr: の後にbech32プレフィックスがない場合、quoteノードとして検出しない", () => {
    const result = parseContent("nostr:invalidprefix123abc");
    expect(result).toEqual([
      { type: "text", text: "nostr:invalidprefix123abc" },
    ]);
  });

  // nostr: だけの場合
  it("nostr: だけの場合、textノードとして扱う", () => {
    const result = parseContent("nostr:");
    expect(result).toEqual([
      { type: "text", text: "nostr:" },
    ]);
  });

  // Nostr URIに大文字が含まれる場合（case-insensitive マッチ）
  it("nostr:nevent1 の後に大文字が含まれても全体がquoteノードとしてマッチする", () => {
    // 正規表現は gi フラグ（case-insensitive）なので大文字もマッチに含まれる
    const result = parseContent("nostr:nevent1abcXYZ rest");
    expect(result).toEqual([
      { type: "quote", uri: "nostr:nevent1abcXYZ" },
      { type: "text", text: " rest" },
    ]);
  });

  // Nostr URI + 一般URLの重複防止（nostr URIはhttpスキームでないのでURLと競合しない）
  it("テキスト中のNostr URIが一般URL検出と競合しない", () => {
    const nostrUri = "nostr:note1abc123def456ghi789jkl012mno345pqr678stu";
    const linkUrl = "https://example.com";
    const result = parseContent(`${nostrUri} ${linkUrl}`);
    expect(result).toEqual([
      { type: "quote", uri: nostrUri },
      { type: "text", text: " " },
      { type: "linkPreview", url: linkUrl, text: "example.com" },
    ]);
  });

  // ===== カスタム絵文字（NIP-30）テスト =====

  // 基本: emoji タグありで :shortcode: を emoji ノードに変換
  it("emoji タグがある場合、:shortcode: を emoji ノードに変換する", () => {
    const tags = [["emoji", "sushi", "https://example.com/sushi.png"]];
    const result = parseContent("美味しい :sushi: だね", tags);
    expect(result).toEqual([
      { type: "text", text: "美味しい " },
      { type: "emoji", shortcode: "sushi", url: "https://example.com/sushi.png" },
      { type: "text", text: " だね" },
    ]);
  });

  // 複数の絵文字
  it("複数のカスタム絵文字を含む場合、それぞれ emoji ノードに変換する", () => {
    const tags = [
      ["emoji", "sushi", "https://example.com/sushi.png"],
      ["emoji", "beer", "https://example.com/beer.png"],
    ];
    const result = parseContent(":sushi: と :beer:", tags);
    expect(result).toEqual([
      { type: "emoji", shortcode: "sushi", url: "https://example.com/sushi.png" },
      { type: "text", text: " と " },
      { type: "emoji", shortcode: "beer", url: "https://example.com/beer.png" },
    ]);
  });

  // 未定義 shortcode はテキストのまま
  it("emoji タグに定義されていない :shortcode: はテキストのまま残す", () => {
    const tags = [["emoji", "sushi", "https://example.com/sushi.png"]];
    const result = parseContent(":sushi: と :unknown:", tags);
    expect(result).toEqual([
      { type: "emoji", shortcode: "sushi", url: "https://example.com/sushi.png" },
      { type: "text", text: " と :unknown:" },
    ]);
  });

  // tags 省略時（後方互換）
  it("tags を省略した場合、:shortcode: はテキストのまま残る（後方互換）", () => {
    const result = parseContent("hello :world:");
    expect(result).toEqual([
      { type: "text", text: "hello :world:" },
    ]);
  });

  // 画像URLとカスタム絵文字の混在
  it("画像URLとカスタム絵文字が混在する場合、それぞれ正しいノードタイプに変換する", () => {
    const tags = [["emoji", "cat", "https://example.com/cat-emoji.png"]];
    const result = parseContent(":cat: https://example.com/photo.jpg", tags);
    expect(result).toEqual([
      { type: "emoji", shortcode: "cat", url: "https://example.com/cat-emoji.png" },
      { type: "text", text: " " },
      { type: "image", url: "https://example.com/photo.jpg" },
    ]);
  });

  // Nostr URIとカスタム絵文字の混在
  it("Nostr URIとカスタム絵文字が混在する場合、それぞれ正しいノードタイプに変換する", () => {
    const nostrUri = "nostr:nevent1qqsabc123def456ghi789jkl012mno345pqr";
    const tags = [["emoji", "fire", "https://example.com/fire.png"]];
    const result = parseContent(`:fire: ${nostrUri}`, tags);
    expect(result).toEqual([
      { type: "emoji", shortcode: "fire", url: "https://example.com/fire.png" },
      { type: "text", text: " " },
      { type: "quote", uri: nostrUri },
    ]);
  });

  // emoji タグ以外のタグは無視
  it("emoji タグ以外のタグは無視する", () => {
    const tags = [
      ["p", "pubkey123"],
      ["emoji", "heart", "https://example.com/heart.png"],
      ["t", "nostr"],
    ];
    const result = parseContent(":heart:", tags);
    expect(result).toEqual([
      { type: "emoji", shortcode: "heart", url: "https://example.com/heart.png" },
    ]);
  });

  // 空の tags 配列
  it("空の tags 配列の場合、:shortcode: はテキストのまま残る", () => {
    const result = parseContent(":hello:", []);
    expect(result).toEqual([
      { type: "text", text: ":hello:" },
    ]);
  });

  // 同じ shortcode が複数回出現
  it("同じ shortcode が複数回出現する場合、すべて emoji ノードに変換する", () => {
    const tags = [["emoji", "star", "https://example.com/star.png"]];
    const result = parseContent(":star: good :star:", tags);
    expect(result).toEqual([
      { type: "emoji", shortcode: "star", url: "https://example.com/star.png" },
      { type: "text", text: " good " },
      { type: "emoji", shortcode: "star", url: "https://example.com/star.png" },
    ]);
  });
});
