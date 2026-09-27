import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

/** A bundle for this name+version is already stored; versions are immutable. */
export class BundleExistsError extends Error {
  constructor(name: string, version: string) {
    super(`${name}@${version} is already published — versions are immutable`);
    this.name = "BundleExistsError";
  }
}

/** Local-disk blob store for published bundle tarballs — one file per name+version, laid out like an OCI blob store's leaf directories. */
export class BlobStore {
  constructor(private readonly rootDir: string) {}

  pathFor(name: string, version: string): string {
    return join(this.rootDir, name, version, "bundle.tar.gz");
  }

  /**
   * Stores a bundle, refusing to replace one that exists. The file is opened
   * create-only, so a second publish of the same version (including one racing
   * the first) fails here instead of overwriting the bytes the first one
   * stored.
   */
  async write(name: string, version: string, bytes: Buffer): Promise<string> {
    const path = this.pathFor(name, version);
    await mkdir(join(this.rootDir, name, version), { recursive: true });
    try {
      await writeFile(path, bytes, { flag: "wx" });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") throw new BundleExistsError(name, version);
      throw err;
    }
    return path;
  }

  async read(path: string): Promise<Buffer> {
    return readFile(path);
  }

  /** Removes a bundle this process just wrote, when the publish it belonged to didn't go through. */
  async remove(path: string): Promise<void> {
    await rm(path, { force: true });
  }
}
