import { useEffect, useState } from "react";

export function useBrowserTheme(): "light" | "dark" {
  const [mode, setMode] = useState<"light" | "dark">(() =>
    window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
  );
  useEffect(() => {
    const preference = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => setMode(preference.matches ? "dark" : "light");
    update();
    preference.addEventListener("change", update);
    return () => preference.removeEventListener("change", update);
  }, []);
  return mode;
}
