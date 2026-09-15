import type { Manifest } from "./manifestOps";

export type ManifestInitInput = {
  firstFullReplayCompleted: boolean;
  authoritativeRawText: string;
  parsed: Manifest | null;
  snapshot: Manifest | undefined;
  fallback: Manifest;
};

export type ManifestInitDecision =
  | { action: "defer" }
  | { action: "unusable" }
  | { action: "adopt"; manifest: Manifest; shouldMigrate: boolean };

function shouldMigrate(manifest: Manifest): boolean {
  return manifest.compactHeights !== true;
}

export function decideManifestInit(
  input: ManifestInitInput,
): ManifestInitDecision {
  // History replay notifies once per operation; a prefix is not the page yet.
  if (!input.firstFullReplayCompleted) {
    return { action: "defer" };
  }
  if (input.parsed) {
    return {
      action: "adopt",
      manifest: input.parsed,
      shouldMigrate: shouldMigrate(input.parsed),
    };
  }
  if (!input.authoritativeRawText.trim()) {
    const manifest = input.snapshot ?? input.fallback;
    return {
      action: "adopt",
      manifest,
      shouldMigrate: shouldMigrate(manifest),
    };
  }
  // Non-empty unparseable text is damage, not a new page.
  return { action: "unusable" };
}
