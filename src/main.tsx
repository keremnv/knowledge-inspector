import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
// One cut per mono trial (styles/typography.ts FONT_MONO_TRIALS) — none of
// them is ever rendered above `regular`, so 400 is the only weight any needs.
import "@fontsource/ibm-plex-mono/latin-400.css";
import "@fontsource/dm-mono/latin-400.css";
import "@fontsource/space-mono/latin-400.css";
// Jost carries the three weight-scale steps (styles/type.ts) and nothing
// else — 200/300/700 were loaded and never referenced by any live rule.
import "@fontsource/jost/latin-400.css";
import "@fontsource/jost/latin-500.css";
import "@fontsource/jost/latin-600.css";
import App from "./App";
import "./styles/base.css";
import { applyTypographyToDocument } from "./styles/typography";

applyTypographyToDocument();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
