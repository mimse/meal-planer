import { describe, expect, test } from "bun:test";
import {
  createRequiredTextPromptOptions,
  MAX_HOUSEHOLD_MEMBERS,
  validateHouseholdMemberCount,
} from "../../src/presentation/prompts";

describe("prompt option construction", () => {
  test("required text submits displayed defaults through initialValue rather than placeholder", () => {
    const options = createRequiredTextPromptOptions("Member id", "alex");

    expect(options).toMatchObject({ message: "Member id", initialValue: "alex" });
    expect("placeholder" in options).toBe(false);
    expect(options.validate(options.initialValue)).toBeUndefined();
  });

  test("required text without a default remains required", () => {
    const options = createRequiredTextPromptOptions("Member name");

    expect("initialValue" in options).toBe(false);
    expect(options.validate(undefined)).toBe("A value is required");
    expect(options.validate("   ")).toBe("A value is required");
    expect(options.validate("Alex")).toBeUndefined();
  });
});

describe("household member count validation", () => {
  test("accepts only decimal safe integers within the practical household limit", () => {
    expect(MAX_HOUSEHOLD_MEMBERS).toBe(50);
    expect(validateHouseholdMemberCount("1")).toBeUndefined();
    expect(validateHouseholdMemberCount("50")).toBeUndefined();

    for (const invalid of [undefined, "", "0", "51", "1.5", "1e2", "9".repeat(400)]) {
      expect(validateHouseholdMemberCount(invalid)).toBe("Enter a whole number from 1 to 50");
    }
  });
});
