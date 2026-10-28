/** Explicit deployment choice. Absence preserves World-only startup and never
 * probes source capability. The legacy routes always keep their own meaning. */
export function inspectorEntry(path: string, configured = "world"): "source" | "world" | "sqlite" | "icons" | "invalid" {
  if (path === "/icon-preview") return "icons";
  if (path === "/sqlite") return "sqlite";
  if (path === "/source") return "source";
  if (path === "/world") return "world";
  if (configured !== "world" && configured !== "source") return "invalid";
  return configured;
}
