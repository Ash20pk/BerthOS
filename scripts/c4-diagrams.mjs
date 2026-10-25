#!/usr/bin/env node
// Generates the docs' C4 diagrams as SVG into docs/images/c4/.
//
//   node scripts/c4-diagrams.mjs
//
// One file per diagram in scripts/c4/diagrams/, laid out by hand so it stays
// legible at GitHub's page width; the primitives are in scripts/c4/lib.mjs.
// Colours follow the C4 convention; strokes and labels outside the boxes
// switch with prefers-color-scheme so they read on GitHub's light and dark
// themes.
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { svg } from "./c4/lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, "c4", "diagrams");
const OUT = join(here, "..", "docs", "images", "c4");

mkdirSync(OUT, { recursive: true });
for (const f of readdirSync(SRC).filter((f) => f.endsWith(".mjs")).sort()) {
  const { name, ...spec } = (await import(pathToFileURL(join(SRC, f)).href)).default;
  writeFileSync(join(OUT, `${name}.svg`), svg(spec));
  console.log(join("docs/images/c4", `${name}.svg`));
}
