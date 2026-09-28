/**
 * Values for a sandbox's environment from the command line: `--env NAME`
 * (taken from this process's environment, so a secret needn't appear in
 * shell history or `ps`), `--env NAME=value`, and `--env-file <path>` in
 * dotenv form. The sandbox delivers any name an app declares under
 * `secrets:` to that app alone (see startContainer()).
 */

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** KEY=value lines; blank lines and # comments skipped; optional `export ` prefix and matching quotes. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  text.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) return;
    const match = /^(?:export\s+)?([^=\s]+)\s*=\s*(.*)$/.exec(line);
    if (!match || !NAME.test(match[1]!)) throw new Error(`line ${index + 1} isn't NAME=value: ${JSON.stringify(raw)}`);
    let value = match[2]!;
    const quoted = /^(["'])(.*)\1$/.exec(value);
    if (quoted) value = quoted[2]!;
    else value = value.replace(/\s+#.*$/, "");
    out[match[1]!] = value;
  });
  return out;
}

/** Resolves repeated `--env` values; later entries win, and they win over the file. */
export function resolveEnvFlags(entries: string[], fromFile: Record<string, string>, processEnv: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = { ...fromFile };
  for (const entry of entries) {
    const eq = entry.indexOf("=");
    const name = eq === -1 ? entry : entry.slice(0, eq);
    if (!NAME.test(name)) throw new Error(`--env ${JSON.stringify(entry)}: ${JSON.stringify(name)} isn't a valid variable name`);
    if (eq !== -1) {
      out[name] = entry.slice(eq + 1);
      continue;
    }
    const value = processEnv[name];
    if (value === undefined) throw new Error(`--env ${name}: ${name} isn't set in this shell (use --env ${name}=value, or --env-file)`);
    out[name] = value;
  }
  return out;
}
