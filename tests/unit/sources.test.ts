import { describe, expect, test } from "bun:test";
import { BUILT_IN_RECIPE_SOURCES } from "../../src/adapters/recipes/sources";

describe("built-in recipe sources", () => {
  test("registers all six planned sources with evidence-based adapters", () => {
    expect(BUILT_IN_RECIPE_SOURCES).toHaveLength(6);
    expect(BUILT_IN_RECIPE_SOURCES.map((source) => source.host)).toEqual([
      "valdemarsro.dk",
      "gourministeriet.dk",
      "spisbedre.dk",
      "juliebruun.com",
      "juliekarla.dk",
      "mummum.dk",
    ]);
    expect(BUILT_IN_RECIPE_SOURCES.map((source) => source.extraction)).toEqual([
      "microdata",
      "jsonld",
      "spisbedre-inertia",
      "jsonld",
      "jsonld",
      "jsonld",
    ]);
  });
});
