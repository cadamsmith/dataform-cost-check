import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Model, ModelType } from "@dataform-cost-check/core";

/** Options for compiling a Dataform project. */
export interface CompileOptions {
  /** Directory containing `workflow_settings.yaml` (or legacy `dataform.json`). */
  readonly projectDir: string;
  /** The Dataform CLI to run (the `@dataform/cli` package). Defaults to `dataform` on PATH. */
  readonly command?: string;
  /**
   * Compile as production does: the settings a release config overrides. Each unset
   * value keeps `workflow_settings.yaml`'s.
   */
  readonly overrides?: CompileOverrides;
}

/** The `dataform compile` settings a release config can override. */
export interface CompileOverrides {
  readonly defaultDatabase?: string;
  readonly defaultSchema?: string;
  readonly defaultLocation?: string;
  readonly schemaSuffix?: string;
  readonly tablePrefix?: string;
  /** `key=value` pairs, comma-separated, as the CLI's `--vars` takes them. */
  readonly vars?: string;
}

const OVERRIDE_FLAGS: Readonly<Record<keyof CompileOverrides, string>> = {
  defaultDatabase: "--default-database",
  defaultSchema: "--default-schema",
  defaultLocation: "--default-location",
  schemaSuffix: "--schema-suffix",
  tablePrefix: "--table-prefix",
  vars: "--vars",
};

/** CLI arguments for `dataform compile`, overrides included. */
export function compileArgs(overrides: CompileOverrides = {}): string[] {
  const args = ["compile", "--json"];
  for (const [key, flag] of Object.entries(OVERRIDE_FLAGS)) {
    const value = overrides[key as keyof CompileOverrides];
    if (value) args.push(`${flag}=${value}`);
  }
  return args;
}

/** The subset of `dataform compile --json` output (CLI 3.x) this adapter reads. */
interface CompileOutput {
  readonly projectConfig?: { readonly defaultLocation?: string };
  readonly tables?: readonly CompiledAction[];
  readonly assertions?: readonly CompiledAction[];
  readonly operations?: readonly CompiledAction[];
  readonly graphErrors?: { readonly compilationErrors?: readonly CompilationErrorEntry[] };
}

interface CompiledAction {
  readonly type?: string;
  readonly target?: {
    readonly database?: string;
    readonly schema?: string;
    readonly name?: string;
  };
  /** The target before release-config overrides: `name` carries no table prefix. */
  readonly canonicalTarget?: { readonly name?: string };
  readonly query?: string;
  readonly incrementalQuery?: string;
  readonly preOps?: readonly string[];
  readonly incrementalPreOps?: readonly string[];
  /** Operations only: one entry per statement. */
  readonly queries?: readonly string[];
  readonly tags?: readonly string[];
  readonly disabled?: boolean;
  readonly uniqueKey?: readonly string[];
  readonly bigquery?: { readonly updatePartitionFilter?: string };
}

interface CompilationErrorEntry {
  readonly fileName?: string;
  readonly message?: string;
}

/** The Dataform CLI could not be started at all, as opposed to a project that fails to compile. */
export class DataformCliNotFoundError extends Error {
  constructor(readonly command: string) {
    super(`Dataform CLI not found: ${command}. Install it with \`npm install -g @dataform/cli\`.`);
    this.name = "DataformCliNotFoundError";
  }
}

/**
 * The project pins `@dataform/core` in a `package.json`, but its dependencies are not
 * installed. The CLI would only say it "could not find a recent installed version".
 */
export class DataformDependenciesMissingError extends Error {
  constructor(readonly projectDir: string) {
    super(
      `${projectDir} has a package.json but no node_modules. Run \`npm ci\` (or \`dataform install\`) in the project directory before Dataform Cost Check.`,
    );
    this.name = "DataformDependenciesMissingError";
  }
}

/** The project ran through the CLI but did not compile. One `file: message` line per error. */
export class DataformCompilationError extends Error {
  constructor(readonly errors: readonly CompilationErrorEntry[]) {
    super(
      errors
        .map((e) =>
          e.fileName ? `${e.fileName}: ${e.message ?? "error"}` : (e.message ?? "error"),
        )
        .join("\n"),
    );
    this.name = "DataformCompilationError";
  }
}

const execFileAsync = promisify(execFile);

function compilationErrors(output: unknown): readonly CompilationErrorEntry[] {
  return (output as CompileOutput | null)?.graphErrors?.compilationErrors ?? [];
}

function compilationErrorsIn(stdout: string | undefined): readonly CompilationErrorEntry[] {
  if (!stdout) return [];
  try {
    return compilationErrors(parseCliJson(stdout));
  } catch {
    return [];
  }
}

/**
 * The JSON document in the CLI's output. The Dataform 2.x CLI prints a one-line JSON log
 * message before it, so when the whole output does not parse, the document is taken to
 * start at the first line that is a lone `{`.
 */
export function parseCliJson(stdout: string): unknown {
  try {
    return JSON.parse(stdout);
  } catch (error) {
    const start = stdout.search(/^\{\s*$/m);
    if (start <= 0) throw error;
    return JSON.parse(stdout.slice(start));
  }
}

/**
 * Run `dataform compile --json` in `projectDir` and return the parsed output.
 *
 * Throws `DataformCliNotFoundError` when the CLI is missing and `DataformCompilationError`
 * when the project does not compile. The CLI prints JSON with `graphErrors` in that case,
 * and not every version exits non-zero, so the errors are checked either way.
 */
export async function compileProject(options: CompileOptions): Promise<unknown> {
  const command = options.command ?? "dataform";
  if (
    existsSync(join(options.projectDir, "package.json")) &&
    !existsSync(join(options.projectDir, "node_modules"))
  ) {
    throw new DataformDependenciesMissingError(options.projectDir);
  }
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(command, compileArgs(options.overrides), {
      cwd: options.projectDir,
      maxBuffer: 64 * 1024 * 1024,
      // The npm shim on Windows is a .cmd file, which only the shell can run.
      shell: process.platform === "win32",
    }));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT")
      throw new DataformCliNotFoundError(command);
    const errors = compilationErrorsIn((err as { stdout?: string }).stdout);
    if (errors.length > 0) throw new DataformCompilationError(errors);
    throw err;
  }
  const output: unknown = parseCliJson(stdout);
  const errors = compilationErrors(output);
  if (errors.length > 0) throw new DataformCompilationError(errors);
  return output;
}

const TABLE_TYPES: Readonly<Record<string, ModelType>> = {
  table: "table",
  incremental: "incremental",
  view: "view",
};

function toModel(
  action: CompiledAction,
  type: ModelType,
  location: string | undefined,
  query: string | undefined,
): Model {
  const { database, schema, name } = action.target ?? {};
  if (!schema || !name) {
    throw new Error(`Compiled action has no target: ${JSON.stringify(action.target)}`);
  }
  if (query === undefined) {
    throw new Error(`Compiled action ${schema}.${name} has no query`);
  }
  return {
    target: [database, schema, name].filter(Boolean).join("."),
    // The name as written in the project, so a `table-prefix` override does not stop
    // `runs_per_day` entries from matching.
    name: action.canonicalTarget?.name ?? name,
    type,
    query,
    ...(action.incrementalQuery !== undefined && { incrementalQuery: action.incrementalQuery }),
    ...(action.preOps !== undefined && action.preOps.length > 0 && { preOps: action.preOps }),
    ...(action.incrementalPreOps !== undefined &&
      action.incrementalPreOps.length > 0 && { incrementalPreOps: action.incrementalPreOps }),
    tags: action.tags ?? [],
    ...(type === "incremental" &&
      (action.uniqueKey?.length ?? 0) > 0 && {
        merge: { partitionFiltered: Boolean(action.bigquery?.updatePartitionFilter) },
      }),
    ...(location !== undefined && { location }),
  };
}

/**
 * Convert `dataform compile --json` output (CLI 3.x) into core models.
 *
 * - Declarations are sources, not models, and are left out.
 * - Disabled actions never run, so they cost nothing and are left out.
 * - Dataform 3 has no per-action location, so every model takes
 *   `projectConfig.defaultLocation`. When the project sets none, models carry no location
 *   and BigQuery picks it from the datasets each query reads.
 * - Operations hold one query per statement; they are joined into one script.
 */
export function parseCompileOutput(compiled: unknown): Model[] {
  if (typeof compiled !== "object" || compiled === null) {
    throw new Error("Dataform compile output is not a JSON object");
  }
  const errors = compilationErrors(compiled);
  if (errors.length > 0) throw new DataformCompilationError(errors);

  const output = compiled as CompileOutput;
  const location = output.projectConfig?.defaultLocation || undefined;
  const enabled = (actions: readonly CompiledAction[] | undefined) =>
    (actions ?? []).filter((a) => a.disabled !== true);

  const tables = enabled(output.tables).map((action) => {
    const type = TABLE_TYPES[action.type ?? ""];
    if (!type) throw new Error(`Unknown Dataform table type: ${String(action.type)}`);
    return toModel(action, type, location, action.query);
  });
  const assertions = enabled(output.assertions).map((action) =>
    toModel(action, "assertion", location, action.query),
  );
  const operations = enabled(output.operations).map((action) =>
    toModel(action, "operations", location, action.queries?.join(";\n")),
  );
  return [...tables, ...assertions, ...operations];
}

/** Compile and parse in one step. */
export async function loadModels(options: CompileOptions): Promise<Model[]> {
  return parseCompileOutput(await compileProject(options));
}
