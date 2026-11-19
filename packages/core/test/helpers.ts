import type { Model } from "../src/index.ts";

export function model(overrides: Partial<Model> & Pick<Model, "name">): Model {
  return {
    target: `proj.analytics.${overrides.name}`,
    type: "table",
    query: `SELECT * FROM src.${overrides.name}`,
    tags: [],
    location: "US",
    ...overrides,
  };
}
