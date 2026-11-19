import type { Model } from "@dataform-cost-check/core";

/** Options for compiling a Dataform project. */
export interface CompileOptions {
  /** Directory containing `workflow_settings.yaml` (or legacy `dataform.json`). */
  readonly projectDir: string;
}

/**
 * Run `dataform compile --json` in `projectDir` and return the parsed output.
 *
 * TODO(milestone 1): spawn the Dataform CLI. Verify the current package name and
 * whether it must be installed per project before relying on it.
 */
export function compileProject(options: CompileOptions): Promise<unknown> {
  return Promise.reject(
    new Error(`compileProject is not implemented yet (projectDir: ${options.projectDir})`),
  );
}

/**
 * Convert `dataform compile --json` output into core models.
 *
 * TODO(milestone 1): map tables, incrementals (both queries), views, assertions and
 * operations. Verify the JSON shape against the current CLI first; it has changed
 * between Dataform major versions.
 */
export function parseCompileOutput(_compiled: unknown): Model[] {
  throw new Error("parseCompileOutput is not implemented yet");
}

/** Compile and parse in one step. */
export async function loadModels(options: CompileOptions): Promise<Model[]> {
  return parseCompileOutput(await compileProject(options));
}
