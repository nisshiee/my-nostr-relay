"use client";

import { useEffect, useState } from "react";
import { LinkNode } from "./LinkNode";

interface LinkPreviewNodeProps {
  url: string;
  text: string;
}

interface LinkPreviewData {
  url: string;
  domain: string;
  title: string;
  description?: string;
  image?: string;
  siteName?: string;
}

type PreviewState =
  | { url: string; status: "loading" }
  | { url: string; status: "success"; data: LinkPreviewData }
  | { url: string; status: "error" };

function LinkPreviewSkeleton() {
  return (
    <div className="block my-2 overflow-hidden rounded-lg border border-gray-200 dark:border-gray-600 bg-gray-50 dark:bg-gray-700/50 animate-pulse">
      <div className="aspect-[1.91/1] w-full bg-gray-200 dark:bg-gray-600" />
      <div className="p-3">
        <div className="h-3 w-24 rounded bg-gray-200 dark:bg-gray-600" />
        <div className="mt-2 h-4 w-3/4 rounded bg-gray-200 dark:bg-gray-600" />
        <div className="mt-2 h-3 w-full rounded bg-gray-200 dark:bg-gray-600" />
        <div className="mt-1 h-3 w-2/3 rounded bg-gray-200 dark:bg-gray-600" />
      </div>
    </div>
  );
}

/** OGPリンクプレビューを表示する。取得失敗時は通常リンクへフォールバックする。 */
export function LinkPreviewNode({ url, text }: LinkPreviewNodeProps) {
  const [state, setState] = useState<PreviewState>({ url, status: "loading" });

  useEffect(() => {
    const controller = new AbortController();

    fetch(`/api/link-preview?url=${encodeURIComponent(url)}`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("preview_failed");
        return (await response.json()) as LinkPreviewData;
      })
      .then((data) => {
        if (!data.title) throw new Error("preview_without_title");
        setState({ url, status: "success", data });
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setState({ url, status: "error" });
      });

    return () => controller.abort();
  }, [url]);

  if (state.url !== url || state.status === "loading") {
    return <LinkPreviewSkeleton />;
  }

  if (state.status === "error") {
    return <LinkNode url={url} text={text} />;
  }

  const { data } = state;
  const label = data.siteName || data.domain;

  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => e.stopPropagation()}
      className="block my-2 overflow-hidden rounded-lg border border-gray-200 dark:border-gray-600 bg-gray-50 dark:bg-gray-700/50 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
    >
      {data.image && (
        <img
          src={data.image}
          alt=""
          loading="lazy"
          className="aspect-[1.91/1] w-full object-cover bg-gray-100 dark:bg-gray-800"
        />
      )}
      <div className="p-3">
        <div className="text-xs text-gray-500 dark:text-gray-400 truncate">{label}</div>
        <div className="mt-1 text-sm font-semibold text-gray-900 dark:text-gray-100 line-clamp-2 break-words">
          {data.title}
        </div>
        {data.description && (
          <p className="mt-1 text-sm text-gray-700 dark:text-gray-300 line-clamp-3 break-words leading-relaxed">
            {data.description}
          </p>
        )}
      </div>
    </a>
  );
}
