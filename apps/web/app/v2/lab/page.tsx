import { notFound } from 'next/navigation';
import { isCanvasDiagnosticsEnabled } from '../../lib/canvasDiagnostics';
import { RendererLab } from '../../components/v2/RendererLab';

export const dynamic = 'force-dynamic';

export default function LabPage() {
  if (!isCanvasDiagnosticsEnabled()) notFound();
  return <RendererLab />;
}
