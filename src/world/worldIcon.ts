/** Generate a tile from the world ID. There is no catalogue of motifs. */
export function worldIconPattern(worldId: string) {
  let hash = 2166136261;
  for (const byte of new TextEncoder().encode(`world-mesh-v5:${worldId}`)) {
    hash = Math.imul(hash ^ byte, 16777619) >>> 0;
  }
  const random = () => {
    hash = (hash + 0x6d2b79f5) >>> 0;
    let n = Math.imul(hash ^ (hash >>> 15), 1 | hash);
    n ^= n + Math.imul(n ^ (n >>> 7), 61 | n);
    return ((n ^ (n >>> 14)) >>> 0) / 4294967296;
  };
  const cells = Array.from({ length: 9 }, (_, index) => index);
  for (let i = cells.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [cells[i], cells[j]] = [cells[j], cells[i]];
  }
  // Three diagonals per tile keeps the amount of ink consistent. The other
  // six cells stay open; the shared lattice joins every diagonal endpoint.
  const tile = Array<number>(9).fill(0);
  for (const index of cells.slice(0, 4)) {
    const diagonal = random() < 0.5 ? 1 : -1;
    // Keep the existing seed sequence and mirror choices: this revision
    // removes one stroke from each tile without changing its other strokes.
    if (index !== cells[3]) tile[index] = diagonal;
  }
  return { tile, mirrorX: random() < 0.5, mirrorY: random() < 0.5 };
}

/** A generated 3 × 3 tile repeats twice in each direction on a 6 × 6 mesh. */
export function worldIconSvg(worldId: string, mode: "light" | "dark" = "light"): string {
  const pattern = worldIconPattern(worldId);
  const ink = mode === "dark" ? "#fff" : "#000";
  const paper = mode === "dark" ? "#000" : "#fff";
  const at = (n: number) => Number((2 + n * 28 / 6).toFixed(4));
  const paths: string[] = [];
  for (let i = 0; i <= 6; i += 1) {
    paths.push(`M${at(i)} 2V30`, `M2 ${at(i)}H30`);
  }
  for (let row = 0; row < 6; row += 1) {
    for (let column = 0; column < 6; column += 1) {
      const flipX = pattern.mirrorX && column >= 3;
      const flipY = pattern.mirrorY && row >= 3;
      const x = flipX ? 2 - column % 3 : column % 3;
      const y = flipY ? 2 - row % 3 : row % 3;
      const diagonal = pattern.tile[y * 3 + x];
      if (!diagonal) continue;
      const rising = (diagonal === 1) !== (flipX !== flipY);
      paths.push(`M${at(column)} ${at(row + (rising ? 1 : 0))}L${at(column + 1)} ${at(row + (rising ? 0 : 1))}`);
    }
  }
  const knots: string[] = [];
  for (let row = 0; row <= 6; row += 1) {
    for (let column = 0; column <= 6; column += 1) {
      knots.push(`<circle cx="${at(column)}" cy="${at(row)}" r="0.42"/>`);
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" fill="${paper}"/><path d="${paths.join("")}" fill="none" stroke="${ink}" stroke-width="0.48" stroke-linecap="butt"/><g fill="${ink}">${knots.join("")}</g></svg>`;
}

export function worldIconUrl(worldId: string, mode: "light" | "dark" = "light") {
  return `data:image/svg+xml,${encodeURIComponent(worldIconSvg(worldId, mode))}`;
}
