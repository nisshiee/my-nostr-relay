import { describe, expect, it } from "vitest";
import {
  isCustomEmojiShortcode,
  isUnicodeEmoji,
  isValidRecentEmoji,
  normalizeReactionContent,
} from "../reactionContent";

describe("reactionContent", () => {
  describe("normalizeReactionContent", () => {
    it("NIP-25のlike/dislike省略表現を既存どおり正規化する", () => {
      expect(normalizeReactionContent("+")).toBe("👍");
      expect(normalizeReactionContent("")).toBe("👍");
      expect(normalizeReactionContent("-")).toBe("👎");
    });

    it("単一のUnicode絵文字を許容する", () => {
      expect(normalizeReactionContent("😀")).toBe("😀");
      expect(normalizeReactionContent("👍🏽")).toBe("👍🏽");
      expect(normalizeReactionContent("🇯🇵")).toBe("🇯🇵");
      expect(normalizeReactionContent("1️⃣")).toBe("1️⃣");
    });

    it("単一のcustom emoji shortcodeを許容する", () => {
      expect(normalizeReactionContent(":blobcat:")).toBe(":blobcat:");
      expect(normalizeReactionContent(":blob-cat_123:")).toBe(":blob-cat_123:");
    });

    it("複数emojiや任意文字列を棄却する", () => {
      expect(normalizeReactionContent("😀😀")).toBeNull();
      expect(normalizeReactionContent("😀 ok")).toBeNull();
      expect(normalizeReactionContent("ok")).toBeNull();
      expect(normalizeReactionContent("👍:blobcat:")).toBeNull();
    });

    it("不正なcustom emoji shortcodeを棄却する", () => {
      expect(normalizeReactionContent("::")).toBeNull();
      expect(normalizeReactionContent(":blobcat::party:")).toBeNull();
      expect(normalizeReactionContent(":blob cat:")).toBeNull();
      expect(normalizeReactionContent(":blobcat")).toBeNull();
      expect(normalizeReactionContent("blobcat:")).toBeNull();
    });
  });

  it("recent emoji用の判定では+, -, 空文字を除外する", () => {
    expect(isValidRecentEmoji("😀")).toBe(true);
    expect(isValidRecentEmoji(":blobcat:")).toBe(true);
    expect(isValidRecentEmoji("+")).toBe(false);
    expect(isValidRecentEmoji("-")).toBe(false);
    expect(isValidRecentEmoji("")).toBe(false);
  });

  it("単一emojiとcustom emoji shortcodeの個別判定を公開する", () => {
    expect(isUnicodeEmoji("😀")).toBe(true);
    expect(isUnicodeEmoji("😀😀")).toBe(false);
    expect(isCustomEmojiShortcode(":blobcat:")).toBe(true);
    expect(isCustomEmojiShortcode(":blobcat::party:")).toBe(false);
  });
});
