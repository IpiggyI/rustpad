import { useEffect, useState } from "react";

const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const idLen = 6;

function generateId() {
  let id = "";
  for (let i = 0; i < idLen; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

export type HashInfo =
  | { mode: "single"; id: string }
  | { mode: "blocks"; id: string };

export type ParsedHash =
  | { type: "empty" }
  | { type: "page"; id: string }
  | { type: "folds" }
  | { type: "single"; id: string };

const PAGE_PREFIX = "page:";
const FOLDS_PREFIX = "folds:";

export function parseHashString(raw: string): ParsedHash {
  if (!raw) return { type: "empty" };
  if (raw.startsWith(PAGE_PREFIX)) {
    return { type: "page", id: raw.slice(PAGE_PREFIX.length) };
  }
  if (raw.startsWith(FOLDS_PREFIX)) {
    return { type: "folds" };
  }
  return { type: "single", id: raw };
}

function parseHash(): HashInfo {
  const raw = window.location.hash ? window.location.hash.slice(1) : "";
  const parsed = parseHashString(raw);
  if (parsed.type === "page") {
    return { mode: "blocks", id: parsed.id };
  }
  if (parsed.type === "single") {
    return { mode: "single", id: parsed.id };
  }
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

function useHash() {
  const info = useHashInfo();
  return info.id;
}

export default useHash;
