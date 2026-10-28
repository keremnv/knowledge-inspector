import { useState } from "react";
import { useWorldIcon } from "./useWorldIcon";
import { useBrowserTheme } from "./useBrowserTheme";
import { worldIconPattern, worldIconUrl } from "./worldIcon";
import "./IconPreview.css";

export function IconPreview() {
  const browserMode = useBrowserTheme();
  const [override, setMode] = useState<"light" | "dark" | null>(null);
  const mode = override ?? browserMode;
  const [seed, setSeed] = useState("world");
  const [selected, setSelected] = useState(0);
  useWorldIcon(`${seed}:${selected}`);
  return (
    <main className="icon-preview" data-mode={mode}>
      <header>
        <a href="/">← Inspector</a>
        <button onClick={() => setMode(mode === "light" ? "dark" : "light")}>
          {mode === "light" ? "Dark" : "Light"} background
        </button>
      </header>
      <h1>Square / generated tiles</h1>
      <p>Each world generates its own 3 × 3 tile, repeated or mirrored across a lighter 6 × 6 mesh.</p>
      <label className="icon-preview__seed">World ID prefix
        <input value={seed} onChange={(event) => setSeed(event.target.value)} />
      </label>
      <p>Click a sample to try it in this browser tab. Every sample has the same line weight and density.</p>
      <section className="icon-preview__grid" aria-label="World favicon samples">
        {Array.from({ length: 24 }, (_, index) => {
          const id = `${seed}:${index}`;
          const url = worldIconUrl(id, mode);
          const pattern = worldIconPattern(id);
          return (
            <button key={index} className="icon-preview__sample" aria-pressed={selected === index}
              onClick={() => setSelected(index)}>
              <img src={url} width={160} height={160} alt={`${id} geometric mesh`} />
              <span className="icon-preview__sizes">
                <span><img src={url} width={16} height={16} alt="" />16 px</span>
                <span><img src={url} width={32} height={32} alt="" />32 px</span>
                <span><img src={url} width={48} height={48} alt="" />48 px</span>
              </span>
              <span className="icon-preview__name">{id}</span>
              <span>{pattern.mirrorX || pattern.mirrorY ? "Mirrored repeat" : "Straight repeat"}</span>
            </button>
          );
        })}
      </section>
    </main>
  );
}
