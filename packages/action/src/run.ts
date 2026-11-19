import { diffModels, estimateChanges, renderComment } from "@dataform-cost-check/core";
import type { Config, DryRunner, Model, Report } from "@dataform-cost-check/core";

export interface RunDeps {
  readonly config: Config;
  /** Compiled models at the base and head commits. */
  readonly loadModels: (side: "base" | "head") => Promise<Model[]>;
  readonly runner: DryRunner;
}

export interface RunResult {
  readonly report: Report;
  readonly comment: string;
}

/** The whole check, minus I/O: diff, estimate, render. */
export async function runCheck(deps: RunDeps): Promise<RunResult> {
  const [base, head] = await Promise.all([deps.loadModels("base"), deps.loadModels("head")]);
  const report = await estimateChanges(diffModels(base, head), deps.runner, deps.config);
  return { report, comment: renderComment(report) };
}
