import { describe, expect, it } from "vitest";
import { describeRemoteLoginError } from "../remoteLoginError";

describe("safe remote login diagnostics", () => {
  it.each([
    ["All promises were rejected", "N46-PUBLISH"],
    ["connection timed out", "N46-RELAY-TIMEOUT"],
    ["publish timed out", "N46-RELAY-TIMEOUT"],
    ["auth timed out", "N46-RELAY-TIMEOUT"],
    ["connection failed", "N46-CONNECTION"],
    ["websocket closed", "N46-CONNECTION"],
    ["connection aborted", "N46-ABORTED"],
    ["Nostr extension took over, please retry the operation", "N46-EXTENSION"],
    ["subscription closed before connection was established.", "N46-SUBSCRIPTION"],
  ])("classifies the exact known rejection %s", (message, code) => {
    expect(describeRemoteLoginError(message)).toContain(code);
    expect(describeRemoteLoginError(new Error(message))).toContain(code);
  });
  it.each([
    "bunker://private?secret=DO_NOT_DISPLAY",
    new Error("https://signer.example/auth?token=DO_NOT_DISPLAY"),
    { message: "DO_NOT_DISPLAY", stack: "DO_NOT_DISPLAY" },
    "All promises were rejected: DO_NOT_DISPLAY",
    null, undefined,
  ])("does not echo unknown errors, keys, URLs, or objects", error => {
    const result = describeRemoteLoginError(error);
    expect(result).toContain("N46-UNKNOWN");
    expect(result).not.toMatch(/DO_NOT_DISPLAY|bunker:|https:|secret=|token=/);
  });
  it("distinguishes response timeout from relay timeout", () => {
    expect(describeRemoteLoginError(new Error(
      "署名器から応答がありません。署名器と接続リレーを確認し、ログインをやり直してください。",
    ))).toContain("N46-RESPONSE-TIMEOUT");
  });
});
