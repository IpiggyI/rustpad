import { useEffect, useState } from "react";

const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const idLen = 6;

export function generateId() {
  let id = "";
  for (let i = 0; i < idLen; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

export type HashInfo =
  | { mode: "home" }
  | { mode: "single"; id: string }
  | { mode: "blocks"; id: string };

const PAGE_PREFIX = "page:";
const FOLDS_PREFIX = "folds:";

/** Home for an empty hash. `#folds:` still allocates a fresh single document. */
export function parseHashString(
  raw: string,
): HashInfo | { mode: "new-single" } {
  if (!raw) return { mode: "home" };
  if (raw.startsWith(PAGE_PREFIX)) {
    return { mode: "blocks", id: raw.slice(PAGE_PREFIX.length) };
  }
  if (raw.startsWith(FOLDS_PREFIX)) {
    return { mode: "new-single" };
  }
  return { mode: "single", id: raw };
}

function parseHash(): HashInfo {
  const raw = window.location.hash ? window.location.hash.slice(1) : "";
  const route = parseHashString(raw);
  if (route.mode !== "new-single") return route;
  const id = generateId();
  window.history.replaceState(null, "", "#" + id);
  return { mode: "single", id };
}

export function useHashInfo(): HashInfo {
  const [info, setInfo] = useState<HashInfo>(parseHash);

  useEffect(() => {
    const handler = () => setInfo(parseHash());
    window.addEventListener("hashchange", handler);
    return () => window.removeEventListener("hashchange", handler);
  }, []);

  return info;
}

export function getWsUri(id: string) {
  const url = new URL(`api/socket/${id}`, window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.href;
}
