import { readFile } from "node:fs/promises";
import { Flags } from "@oclif/core";

/**
 * Values for a sandbox's environment from the command line: `--env NAME`
 * (taken from this process's environment, so a secret needn't appear in
 * shell history or `ps`), `--env NAME=value`, and `--env-file <path>` in
 * dotenv form. The sandbox delivers any name an app declares under
 * `secrets:` to that app alone (see startContainer()).
 *
 * Every error here names a line number or an entry's position, and at most a
 * variable name that is itself valid — never a value, and never text that
 * failed to parse as a name, since a malformed line in a secrets file is as
 * likely to be a fragment of a key as anything else. An `--env` entry's name
 * is echoed only when it looks like a conventional variable name, since a
 * token pasted as `--env ghp_...` is a valid name too.
 */

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The shape of a conventional environment variable name. A pasted token
 * (`ghp_abc123`, say) is often a valid name too, so a name is only echoed
 * back to the terminal when it also looks like one of these.
 */
const CONVENTIONAL_NAME = /^[A-Z_][A-Z0-9_]*$/;

export function isConventionalEnvName(name: string): boolean {
  return CONVENTIONAL_NAME.test(name);
}

/**
 * KEY=value lines, as dotenv reads them: blank lines and # comments skipped;
 * optional `export ` prefix; a trailing ` # comment` after an unquoted or a
 * quoted value; single-, double- or back-quoted values may span lines (a PEM
 * key, say), and double-quoted ones expand \n, \r, \t, \" and \\.
 */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const line = lines[i]!.trimStart();
    if (line.trim() === "" || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([^=\s]+)\s*=[ \t]*(.*)$/.exec(line);
    if (!match) throw new Error(`line ${lineNo} isn't NAME=value`);
    const name = match[1]!;
    if (!NAME.test(name)) throw new Error(`line ${lineNo}: the text before "=" isn't a valid variable name (letters, digits and _, not starting with a digit)`);
    const rest = match[2]!;
    const quote = rest[0];
    if (quote === '"' || quote === "'" || quote === "`") {
      const read = readQuoted(rest, quote, lines, i);
      if (!read) throw new Error(`line ${lineNo}: ${name}'s ${quote} quoted value is never closed`);
      const after = read.after.trim();
      if (after !== "" && !after.startsWith("#")) throw new Error(`line ${lineNo}: ${name} has text after its closing quote`);
      out[name] = read.value;
      i = read.endLine;
      continue;
    }
    out[name] = rest.replace(/(^|\s)#.*$/, "").trim();
  }
  return out;
}

/** Scans from an opening quote to its closing one, across lines if need be; undefined if it never closes. */
function readQuoted(first: string, quote: string, lines: string[], startLine: number): { value: string; endLine: number; after: string } | undefined {
  let value = "";
  let segment = first.slice(1);
  for (let line = startLine; ; ) {
    for (let k = 0; k < segment.length; k++) {
      const c = segment[k]!;
      if (quote === '"' && c === "\\" && k + 1 < segment.length) {
        const next = segment[++k]!;
        value += next === "n" ? "\n" : next === "r" ? "\r" : next === "t" ? "\t" : next === '"' || next === "\\" ? next : `\\${next}`;
        continue;
      }
      if (c === quote) return { value, endLine: line, after: segment.slice(k + 1) };
      value += c;
    }
    line++;
    if (line >= lines.length) return undefined;
    value += "\n";
    segment = lines[line]!;
  }
}

/** Resolves repeated `--env` values; later entries win, and they win over the file. */
export function resolveEnvFlags(entries: string[], fromFile: Record<string, string>, processEnv: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = { ...fromFile };
  entries.forEach((entry, index) => {
    const eq = entry.indexOf("=");
    const name = eq === -1 ? entry : entry.slice(0, eq);
    if (!NAME.test(name)) {
      throw new Error(`--env #${index + 1}: the text before "=" isn't a valid variable name (letters, digits and _, not starting with a digit)`);
    }
    if (eq !== -1) {
      out[name] = entry.slice(eq + 1);
      return;
    }
    const value = processEnv[name];
    if (value === undefined) {
      const which = isConventionalEnvName(name) ? `${name} isn't set` : "that name isn't set";
      throw new Error(`--env #${index + 1}: ${which} in this shell (export it first, or use --env-file)`);
    }
    out[name] = value;
  });
  return out;
}

/**
 * Names in `env` that no app declares under `secrets:`. Those are not scoped
 * to one app: a credential-looking name goes to the container's shared
 * secrets file and any other name into its plain environment, and every app
 * in the sandbox can read either.
 */
export function undeclaredEnvNames(env: Record<string, string>, apps: readonly { manifest: { secrets?: readonly string[] } }[]): string[] {
  const declared = new Set(apps.flatMap((a) => a.manifest.secrets ?? []));
  return Object.keys(env).filter((name) => !declared.has(name));
}

/**
 * Names for a message: the conventional-looking ones listed, any others only
 * counted, since a name read from an env file or --env may be a pasted token.
 */
export function describeEnvNames(names: readonly string[]): string {
  const shown = names.filter(isConventionalEnvName);
  const hidden = names.length - shown.length;
  if (hidden === 0) return shown.join(", ");
  const counted = `${hidden} ${shown.length > 0 ? "other " : ""}name${hidden === 1 ? "" : "s"} (not shown: not uppercase)`;
  return shown.length > 0 ? `${shown.join(", ")} and ${counted}` : counted;
}

/** `--env` and `--env-file`, as `berth os up` and `berth dev` take them. */
export const envFlags = {
  env: Flags.string({
    multiple: true,
    description:
      "a variable for the sandbox: NAME (value taken from this shell's environment, so it stays out of shell history and ps) or NAME=value (visible in both, so not for a secret). Repeatable. A name an app declares under secrets: is delivered to that app alone; any other name reaches every app in the sandbox, with a warning.",
  }),
  "env-file": Flags.string({ description: "dotenv file (NAME=value lines) of variables for the sandbox, applied before --env" }),
};

/** The values `envFlags` name. Errors follow this file's rule: never a value. */
export async function readEnvFlags(flags: { env?: string[]; "env-file"?: string }, processEnv: NodeJS.ProcessEnv = process.env): Promise<Record<string, string>> {
  let fromFile: Record<string, string> = {};
  if (flags["env-file"]) {
    try {
      fromFile = parseEnvFile(await readFile(flags["env-file"], "utf-8"));
    } catch (err) {
      throw new Error(`--env-file ${flags["env-file"]}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return resolveEnvFlags(flags.env ?? [], fromFile, processEnv);
}
