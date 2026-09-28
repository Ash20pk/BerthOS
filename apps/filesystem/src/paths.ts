import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

/**
 * How apps/filesystem turns the path an agent passes into a file, shared with
 * the enforcement-probe fixture so the enforcement suite exercises exactly
 * this code rather than a copy of it.
 *
 * resolve(), not join(): a relative path lands under the root, and an
 * absolute one is taken as written. join() turned "/workspace/calc.txt" into
 * /workspace/workspace/calc.txt, which an agent passing the full path it was
 * told about never meant. Nothing here checks that the result is inside the
 * root: what the app may touch is its sandbox's to decide (see withContext).
 */
export function resolveUnder(root: string, path: string): string {
  return resolve(root, path);
}

function isInside(root: string, absolutePath: string): boolean {
  const rel = relative(resolve(root), absolutePath);
  return rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel);
}

/**
 * An error from a path that resolved outside the root, with the reason an
 * agent is most likely to have got there: "/notes.txt" is /notes.txt, not
 * <root>/notes.txt. The original message and code are kept, so a caller that
 * checks for EACCES still sees it.
 */
function withContext(err: unknown, root: string, path: string, absolutePath: string): unknown {
  if (isInside(root, absolutePath) || !(err instanceof Error)) return err;
  const explained = new Error(
    `"${path}" resolves to ${absolutePath}, which is outside ${root}. ` +
      `Relative paths are relative to ${root}, and an absolute path is used as written, so "/notes.txt" means /notes.txt, not ${root}/notes.txt. ` +
      `(${err.message})`,
  );
  (explained as NodeJS.ErrnoException).code = (err as NodeJS.ErrnoException).code;
  return explained;
}

/**
 * Writes the file, creating the directories its path names first: an agent
 * writing reports/q4.md into a fresh workspace has no other way to create
 * reports/. With the sandbox enforcing (Landlock), a directory outside the
 * app's declared write scope is refused at the mkdir, as the write itself
 * would be.
 */
export async function writeFileUnder(root: string, path: string, content: string): Promise<void> {
  const absolutePath = resolveUnder(root, path);
  try {
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, content, "utf-8");
  } catch (err) {
    throw withContext(err, root, path, absolutePath);
  }
}

export async function readFileUnder(root: string, path: string): Promise<string> {
  const absolutePath = resolveUnder(root, path);
  try {
    return await readFile(absolutePath, "utf-8");
  } catch (err) {
    throw withContext(err, root, path, absolutePath);
  }
}

/**
 * The one spelling of a path under the root: relative to it, normalised.
 * semantic-fs keys its index by the path relative to /context (what a write
 * through the mount records), so "/context/a.txt", "./a.txt" and "a.txt" must
 * all become "a.txt" before they are tagged, or one file ends up with two
 * index entries. A path outside the root has no such spelling, and neither
 * has the root itself: it would come out as "", a key naming no file.
 */
export function relativeUnder(root: string, path: string): string {
  const absolutePath = resolveUnder(root, path);
  if (!isInside(root, absolutePath)) {
    throw new Error(`"${path}" resolves to ${absolutePath}, which is outside ${root}. Relative paths are relative to ${root}.`);
  }
  const rel = relative(resolve(root), absolutePath);
  if (rel === "") throw new Error(`"${path}" is ${root} itself, not a file under it.`);
  return rel;
}
