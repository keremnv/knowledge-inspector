/**
 * The local planes, spoken to.
 *
 * The World inspector has one read plane. `world.ts` imports `read` and
 * nothing else, so its read-only boundary is visible in its import list.
 */

/**
 * The token, read from the URL the way the rest of the product reads it.
 *
 * `#/world?apiToken=devtoken` — a development-only token for the local World
 * server and one bookmark serve both while both exist.
 */
export function tokenFromLocation(): string | null {
  const hash = window.location.hash;
  const query = hash.includes("?") ? hash.slice(hash.indexOf("?") + 1) : "";
  const params = new URLSearchParams(query || window.location.search);
  const supplied = params.get("apiToken");
  if (supplied) return supplied;

  // The local world explorer starts with `--token devtoken`. Make the plain
  // localhost URL usable as documented, while never inventing credentials for
  // a deployed or non-local origin.
  if (
    import.meta.env.DEV &&
    (window.location.hostname === "localhost" ||
      window.location.hostname === "127.0.0.1" ||
      window.location.hostname === "[::1]")
  ) {
    return "devtoken";
  }
  return null;
}

async function unwrap<T>(response: Response): Promise<T> {
  if (!response.ok) {
    let detail = "";
    try {
      const body = (await response.json()) as { error?: unknown };
      if (typeof body?.error === "string") detail = body.error;
    } catch {
      /* a body that is not JSON is still a failure worth reporting */
    }
    const status = response.status;
    if (status === 401) throw new Error("Inspector link needs refreshing\nThis link does not grant access to the world. Run author open <world-name>, then use the new inspector link.");
    if (status === 403) throw new Error("Access denied\nThis inspector link does not have permission to read the requested data. Open the world again to get its inspector link.");
    if (status === 404) throw new Error("Data not found\nThe requested item is no longer available. Refresh the inspector to load the current world.");
    if (status === 429) throw new Error("Too many requests\nWait a moment, then try again.");
    if (status >= 500) throw new Error("Inspector could not respond\nTry again. If this continues, check the terminal where you opened the world.");
    throw new Error(`Request could not be completed\n${detail || "Refresh the inspector and try again."}`);
  }
  try {
    return (await response.json()) as T;
  } catch {
    throw new Error("Unexpected inspector response\nRefresh the inspector. If this continues, open the world again.");
  }
}

async function request(path: string, options: RequestInit): Promise<Response> {
  try {
    return await fetch(path, options);
  } catch {
    throw new Error("Inspector disconnected\nCheck that the world is still running. If it has stopped, run author open <world-name> and use the new inspector link.");
  }
}

export async function read<T>(path: string): Promise<T> {
  const token = tokenFromLocation();
  return unwrap<T>(
    await request(path, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    }),
  );
}
