"use client";

import { usePathname } from "next/navigation";
import { AuthProvider } from "./contexts/AuthContext";

/** Client Component のプロバイダーをまとめるラッパー */
export function Providers({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  // ラボは署名器の自動復元やリレー接続を開始しない。
  if (pathname === "/v2/lab") return <>{children}</>;
  return <AuthProvider>{children}</AuthProvider>;
}
