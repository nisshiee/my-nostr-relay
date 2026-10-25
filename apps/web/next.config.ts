import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  turbopack: {
    // 複数のlockfileがあるリポジトリでもWebアプリをrootとして解決する
    root: __dirname,
  },
};

export default nextConfig;
