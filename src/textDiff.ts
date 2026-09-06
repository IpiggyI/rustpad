import { OpSeq } from "rustpad-wasm";

/** Returns the number of Unicode codepoints in a string. */
function unicodeLength(str: string): number {
  let length = 0;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  for (const c of str) ++length;
  return length;
}

/** Returns whether a UTF-16 code unit is the high half of a surrogate pair. */
function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

/** Returns whether a UTF-16 code unit is the low half of a surrogate pair. */
function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * Build an OpSeq that maps `oldValue` to `newValue` via a common
 * prefix/suffix diff in UTF-16 code units, kept off surrogate-pair seams.
 */
export function diffText(oldValue: string, newValue: string): OpSeq {
  // Common prefix/suffix in UTF-16 code units, kept off surrogate-pair seams.
  const maxPrefix = Math.min(oldValue.length, newValue.length);
  let prefix = 0;
  while (prefix < maxPrefix && oldValue[prefix] === newValue[prefix]) {
    prefix++;
  }
  if (prefix > 0 && isHighSurrogate(oldValue.charCodeAt(prefix - 1))) {
    prefix--;
  }

  const maxSuffix = Math.min(oldValue.length, newValue.length) - prefix;
  let suffix = 0;
  while (
    suffix < maxSuffix &&
    oldValue[oldValue.length - 1 - suffix] ===
      newValue[newValue.length - 1 - suffix]
  ) {
    suffix++;
  }
  if (
    suffix > 0 &&
    isLowSurrogate(oldValue.charCodeAt(oldValue.length - suffix))
  ) {
    suffix--;
  }

  const deleted = oldValue.slice(prefix, oldValue.length - suffix);
  const inserted = newValue.slice(prefix, newValue.length - suffix);

  const operation = OpSeq.new();
  operation.retain(unicodeLength(oldValue.slice(0, prefix)));
  operation.delete(unicodeLength(deleted));
  operation.insert(inserted);
  operation.retain(unicodeLength(oldValue.slice(oldValue.length - suffix)));
  return operation;
}
