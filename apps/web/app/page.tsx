import { Home } from "./components/Home";
import { isCanvasDiagnosticsEnabled } from "./lib/canvasDiagnostics";

export const dynamic = 'force-dynamic';

export default function Page() {
  return <Home diagnosticsEnabled={isCanvasDiagnosticsEnabled()} />;
}
