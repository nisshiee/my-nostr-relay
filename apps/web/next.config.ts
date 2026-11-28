import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        source: "/yo.svg",
        headers: [{ key: "Access-Control-Allow-Origin", value: "*" }],
      },
    ];
  },
  images: {
    // サーバー側optimizerを使わず、全画像をブラウザから直接取得する。
    unoptimized: true,
    remotePatterns: [],
    localPatterns: [],
  },
  turbopack: {
    // 複数のlockfileがあるリポジトリでもWebアプリをrootとして解決する
    root: __dirname,
  },
};

export default nextConfig;
