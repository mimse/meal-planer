import { describe, expect, test } from "bun:test";
import { resolveDatabasePath } from "../../src/infrastructure/database-path";

describe("resolveDatabasePath", () => {
  test("uses an explicit path before the environment and resolves it from the working directory", () => {
    expect(resolveDatabasePath({
      explicitPath: "state/test.sqlite",
      environment: { MEALPLAN_DATABASE: "/ignored/environment.sqlite" },
      homeDirectory: "/home/tester",
      workingDirectory: "/workspace/app",
    })).toBe("/workspace/app/state/test.sqlite");
  });

  test("uses the environment override and otherwise follows XDG data-directory conventions", () => {
    expect(resolveDatabasePath({
      environment: { MEALPLAN_DATABASE: "state/environment.sqlite" },
      homeDirectory: "/home/tester",
      workingDirectory: "/workspace/app",
    })).toBe("/workspace/app/state/environment.sqlite");
    expect(resolveDatabasePath({
      environment: { XDG_DATA_HOME: "/custom/data" },
      homeDirectory: "/home/tester",
      workingDirectory: "/workspace/app",
    })).toBe("/custom/data/mealplaner/mealplan.sqlite");
    expect(resolveDatabasePath({
      environment: {},
      homeDirectory: "/home/tester",
      workingDirectory: "/workspace/app",
    })).toBe("/home/tester/.local/share/mealplaner/mealplan.sqlite");
  });

  test("treats an empty XDG data home as unset", () => {
    expect(resolveDatabasePath({
      environment: { XDG_DATA_HOME: "" },
      homeDirectory: "/home/tester",
      workingDirectory: "/workspace/app",
    })).toBe("/home/tester/.local/share/mealplaner/mealplan.sqlite");
  });
});
