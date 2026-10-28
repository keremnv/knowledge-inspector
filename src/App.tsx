import { OverlayChromeProvider } from "./world/worldOverlayChrome";
import { WorldPage } from "./world/WorldPage";
import { IconPreview } from "./world/IconPreview";
import { SQLiteTablesPage } from "./sqlite/SQLiteTablesPage";
import { SourceWorkspace } from "./source/SourceWorkspace";
import { inspectorEntry } from "./entry";

export default function App() {
  const entry = inspectorEntry(window.location.pathname, import.meta.env.VITE_INSPECTOR_ENTRY);
  if (entry === "icons") return <IconPreview />;
  if (entry === "sqlite") return <SQLiteTablesPage />;
  if (entry === "source") return <SourceWorkspace />;
  if (entry === "invalid") return <main><h1>Inspector entry configuration error</h1><p>VITE_INSPECTOR_ENTRY must be world or source.</p></main>;
  return <OverlayChromeProvider><WorldPage /></OverlayChromeProvider>;
}
