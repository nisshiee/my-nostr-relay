import { Home } from "./components/Home";
import { isCanvasDiagnosticsEnabled } from "./lib/canvasDiagnostics";
import { isCanvasImageProxyEnabled } from "./lib/canvasImageDeployment";

export const dynamic = 'force-dynamic';

export default function Page() {
  return <Home diagnosticsEnabled={isCanvasDiagnosticsEnabled()} nativeImagesEnabled={isCanvasImageProxyEnabled()} />;
}
