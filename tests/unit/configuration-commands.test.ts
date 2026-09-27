import { describe, expect, test } from "bun:test";
import { createRecipeSource } from "../../src/commands/sources";

describe("recipe source command input", () => {
  test("derives a stable source identity and canonical HTTP URL", () => {
    expect(createRecipeSource({ baseUrl: "https://www.Example.com/recipes#catalog" })).toEqual({
      id: "example-com-recipes",
      name: "example.com",
      baseUrl: "https://www.example.com/recipes",
      adapter: "auto",
      enabled: true,
    });
  });

  test("rejects unsupported adapters and URLs with embedded credentials", () => {
    expect(() => createRecipeSource({
      baseUrl: "https://example.com/",
      adapter: "custom-extractor",
    })).toThrow();
    expect(() => createRecipeSource({ baseUrl: "https://user:secret@example.com/" }))
      .toThrow("Recipe source URL must not contain credentials");
  });
});
