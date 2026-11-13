import { Home } from "./components/Home";
import { isCanvasDiagnosticsEnabled } from "./lib/canvasDiagnostics";
import { getCanvasImageAccessMode } from "./lib/canvasImageDeployment";

export const dynamic = 'force-dynamic';

export default function Page() {
  const imageAccessMode = getCanvasImageAccessMode();
  return <Home diagnosticsEnabled={isCanvasDiagnosticsEnabled()} imageAccessMode={imageAccessMode} />;
}
