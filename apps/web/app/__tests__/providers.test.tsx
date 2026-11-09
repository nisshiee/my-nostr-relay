// @vitest-environment jsdom

import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Providers } from "../providers";

const routing = vi.hoisted(() => ({ pathname: "/" }));
const auth = vi.hoisted(() => ({ mount: vi.fn() }));
vi.mock("next/navigation", () => ({ usePathname: () => routing.pathname }));
vi.mock("../contexts/AuthContext", () => ({
  AuthProvider: ({ children }: { children: React.ReactNode }) => {
    auth.mount();
    return <div data-testid="auth">{children}</div>;
  },
}));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("ラボの認証隔離", () => {
  it("/v2/labではAuthProviderをマウントしない", () => {
    routing.pathname = "/v2/lab";
    render(<Providers><span>ラボ</span></Providers>);
    expect(screen.getByText("ラボ")).toBeDefined();
    expect(auth.mount).not.toHaveBeenCalled();
  });

  it.each(["/", "/v2", "/v2/lab-other"])("%sでは通常の認証を維持する", pathname => {
    routing.pathname = pathname;
    render(<Providers><span>アプリ</span></Providers>);
    expect(screen.getByTestId("auth")).toBeDefined();
    expect(auth.mount).toHaveBeenCalled();
  });
});
