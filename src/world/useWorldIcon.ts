import { useEffect } from "react";
import { worldIconUrl } from "./worldIcon";
import { useBrowserTheme } from "./useBrowserTheme";

export function useWorldIcon(worldId: string | undefined) {
  const mode = useBrowserTheme();
  useEffect(() => {
    const icon = document.createElement("link");
    icon.rel = "icon";
    icon.type = "image/svg+xml";
    icon.href = worldIconUrl(worldId ?? "world", mode);
    document.head.appendChild(icon);
    return () => icon.remove();
  }, [worldId, mode]);
}
