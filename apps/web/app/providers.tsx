"use client";

import { AuthProvider } from "./contexts/AuthContext";

/** Client Component のプロバイダーをまとめるラッパー */
export function Providers({ children }: { children: React.ReactNode }) {
  return <AuthProvider>{children}</AuthProvider>;
}
