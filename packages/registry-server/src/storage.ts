import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";

/** Local-disk blob store for published bundle tarballs — one file per name+version, laid out like an OCI blob store's leaf directories. */
export class BlobStore {
  constructor(private readonly rootDir: string) {}

  pathFor(name: string, version: string): string {
    return join(this.rootDir, name, version, "bundle.tar.gz");
  }

  async write(name: string, version: string, bytes: Buffer): Promise<string> {
    const path = this.pathFor(name, version);
    await mkdir(join(this.rootDir, name, version), { recursive: true });
    await writeFile(path, bytes);
    return path;
  }

  async read(path: string): Promise<Buffer> {
    return readFile(path);
  }
}
