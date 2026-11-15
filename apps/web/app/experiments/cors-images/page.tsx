import { notFound } from 'next/navigation';
import { Home } from '../../components/Home';
import { CanvasImageProvider } from '../../components/CanvasAwareImage';
import { isCorsImageExperimentEnabled } from '../../lib/corsImageExperiment';

export const dynamic = 'force-dynamic';

export default function CorsImagesExperimentPage() {
  if (!isCorsImageExperimentEnabled()) notFound();
  // モーダルやlightboxを含む全画像に同じ取得方式を適用する。
  return <CanvasImageProvider mode="cors"><Home corsExperiment /></CanvasImageProvider>;
}
