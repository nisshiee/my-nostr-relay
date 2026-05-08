import { describe, expect, it } from "vitest";
import { extractHashtags } from "../hashtags";

describe("extractHashtags", () => {
  it("本文先頭または空白直後のタグだけを抽出する", () => {
    expect(extractHashtags("#tag ok #next abc#bad"))
      .toEqual(["tag", "next"]);
  });

  it("日本語タグと数字を抽出する", () => {
    expect(extractHashtags("#ポケモン #写真 #今日の1枚"))
      .toEqual(["ポケモン", "写真", "今日の1枚"]);
  });

  it("英字部分をlowercaseし重複排除する", () => {
    expect(extractHashtags("#Pokemon #pokemon #POKEモン"))
      .toEqual(["pokemon", "pokeモン"]);
  });

  it("空白・改行・句読点・括弧・URL区切り文字で終端する", () => {
    expect(extractHashtags("#one,#two (#three)\n#four/#five #six。 #seven?x=1 #eight&x"))
      .toEqual(["one", "four", "six", "seven", "eight"]);
  });

  it("#単体、URL fragment、単語途中の#tagを除外する", () => {
    expect(extractHashtags("# https://example.com/page#section abc#tag"))
      .toEqual([]);
  });
});
