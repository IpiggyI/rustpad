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

const PAGE_PREFIX = "page:";

function parseHash(): HashInfo {
  if (!window.location.hash) {
    const id = generateId();
    window.history.replaceState(null, "", "#" + id);
    return { mode: "single", id };
  }
  const raw = window.location.hash.slice(1);
  if (raw.startsWith(PAGE_PREFIX)) {
    return { mode: "blocks", id: raw.slice(PAGE_PREFIX.length) };
  }
  return { mode: "single", id: raw };
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
