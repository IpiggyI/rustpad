const PAGE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const PAGE_LINK = "#page:";

/** A page id, or the id inside a link that contains `#page:<id>`. */
export function pageIdFromOpenInput(raw: string): string | null {
  const text = raw.trim();
  if (text === "") return null;
  const marker = text.indexOf(PAGE_LINK);
  if (marker >= 0) {
    const id = text.slice(marker + PAGE_LINK.length).trim();
    return PAGE_ID.test(id) ? id : null;
  }
  return PAGE_ID.test(text) ? text : null;
}
