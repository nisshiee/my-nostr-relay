"use client";

import { useState } from "react";
import { AnimatePresence } from "framer-motion";
import { ImageLightbox } from "./ImageLightbox";

interface ImageNodeProps {
  url: string;
  imageUrls?: string[];
  imageIndex?: number;
  onHold?: () => void;
  onRelease?: () => void;
}

/** 画像を表示するノード（クリックでLightbox表示） */
export function ImageNode({
  url,
  imageUrls,
  imageIndex,
  onHold,
  onRelease,
}: ImageNodeProps) {
  const [lightboxOpen, setLightboxOpen] = useState(false);

  /** 画像クリック時: Lightboxを開いてホールド通知 */
  const handleClick = () => {
    setLightboxOpen(true);
    onHold?.();
  };

  /** Lightbox閉じる時: 状態リセットしてリリース通知 */
  const handleClose = () => {
    setLightboxOpen(false);
    onRelease?.();
  };

  return (
    <>
      <img
        src={url}
        alt="投稿画像"
        loading="lazy"
        className="my-2 max-w-full cursor-pointer rounded-lg"
        onClick={handleClick}
      />
      <AnimatePresence>
        {lightboxOpen && (
          <ImageLightbox
            images={imageUrls ?? [url]}
            currentIndex={imageIndex ?? 0}
            onClose={handleClose}
          />
        )}
      </AnimatePresence>
    </>
  );
}
