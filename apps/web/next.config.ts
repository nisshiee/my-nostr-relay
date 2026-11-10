import type { NextConfig } from "next";
import { CANVAS_IMAGE_HOSTS, CANVAS_IMAGE_QUALITY } from "./app/lib/canvasImagePolicy";

const nextConfig: NextConfig = {
  images: {
    // 実フィードの公開画像hostのみ。query/認証付きURLはクライアントでも拒否する。
    remotePatterns: CANVAS_IMAGE_HOSTS.map(hostname => ({ protocol: 'https' as const, hostname, port: '', pathname: '/**', search: '' })),
    localPatterns: [],
    deviceSizes: [640, 1280],
    imageSizes: [32, 64, 128],
    qualities: [CANVAS_IMAGE_QUALITY],
    formats: ['image/webp'],
    minimumCacheTTL: 60,
    dangerouslyAllowSVG: false,
    contentDispositionType: 'attachment',
    contentSecurityPolicy: "default-src 'none'; sandbox;",
    // self-host Next向け。Vercel managed optimizerへの適用は未確認で、安全保証には使わない。
    maximumRedirects: 0,
    maximumResponseBody: 5_000_000,
    dangerouslyAllowLocalIP: false,
  },
  turbopack: {
    // 複数のlockfileがあるリポジトリでもWebアプリをrootとして解決する
    root: __dirname,
  },
};

export default nextConfig;
