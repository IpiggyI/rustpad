export const IMAGE_FILE_PATTERN =
  "(?:[0-9]{8}-[a-z0-9]{4}|[a-z0-9]+)\\.(?:png|jpg|gif|webp)";

export function sanitizeCollapsedImages(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const pattern = new RegExp(`^${IMAGE_FILE_PATTERN}$`);
  return Array.from(
    new Set(
      value.filter((name) => typeof name === "string" && pattern.test(name)),
    ),
  ).sort();
}

export function localImageDate(date: Date = new Date()): string {
  return `${date.getFullYear().toString().padStart(4, "0")}${(date.getMonth() + 1).toString().padStart(2, "0")}${date.getDate().toString().padStart(2, "0")}`;
}
