/** Directory entry for `node --test scripts/`: import every `*.test.ts`. */
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const dir = import.meta.dirname;
const names = (await readdir(dir)).filter((name) => name.endsWith(".test.ts"));
for (const name of names.sort()) {
  await import(pathToFileURL(join(dir, name)).href);
}
