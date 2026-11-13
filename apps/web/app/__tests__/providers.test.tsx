// @vitest-environment jsdom

import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Providers } from "../providers";

const auth = vi.hoisted(() => ({ mount: vi.fn() }));
vi.mock("../contexts/AuthContext", () => ({
  AuthProvider: ({ children }: { children: React.ReactNode }) => {
    auth.mount();
    return <div data-testid="auth">{children}</div>;
  },
}));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("共通プロバイダー", () => {
  it("子要素を認証プロバイダーの内側に描画する", () => {
    render(<Providers><span>アプリ</span></Providers>);
    expect(screen.getByTestId("auth")).toBeDefined();
    expect(screen.getByText("アプリ")).toBeDefined();
    expect(auth.mount).toHaveBeenCalled();
  });
});
