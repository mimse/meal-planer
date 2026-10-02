import { describe, expect, test } from "bun:test";
import { normalizeIngredient, normalizeMeasuredQuantity } from "../../src/domain/ingredients";

describe("ingredient normalization", () => {
  test("parses exact Danish and English metric aliases and fractions into base units", () => {
    for (const [text, quantity, unit] of [
      ["500g", 500, "g"], ["0,5 kg", 500, "g"], ["1.5 kilograms", 1500, "g"],
      ["20 grams", 20, "g"], ["1 gram", 1, "g"], ["2 kilogram", 2000, "g"],
      ["250 milliliters", 250, "ml"], ["1 liter", 1000, "ml"], ["1 litre", 1000, "ml"],
      ["2 litres", 2000, "ml"], ["2 liter", 2000, "ml"], ["1 millilitre", 1, "ml"],
      ["2 dl", 200, "ml"], ["3 cl", 30, "ml"], ["1/2 l", 500, "ml"],
      ["1 1/2 kg", 1500, "g"], ["½ l", 500, "ml"], ["1½ kg", 1500, "g"],
      ["2 stk.", 2, "stk"], ["2 pieces", 2, "stk"], ["1 piece", 1, "stk"],
    ] as const) {
      expect(normalizeMeasuredQuantity(text)).toEqual({ quantity, unit });
      const rawText = `  ${text} Røde   Linser  `;
      expect(normalizeIngredient(rawText)).toEqual({ rawText, normalizedName: "røde linser", quantity, unit, uncertain: false });
    }
  });

  test("falls back without guessing for ranges, approximate amounts, packages and invalid bounds", () => {
    for (const rawText of [
      "200-300 g mel", "200–300 g mel", "200 til 300 g mel", "ca. 200 g mel", "about 200 g flour",
      "200 g mel cirka", "200 g flour approximately", "200 g flour or more", "200 g flour to taste",
      "200 g flour package", "200 g mel pakke", "2 dåser tomater", "2 x 400 g tomater", "400 g tomater (1 dåse)",
      "1 cup flour", "1 tbsp oil", "1 tsk salt", "1 håndfuld spinat", "Salt efter smag", "1 tomato", "1 mel",
      "1.000 g mel", "1,000 g mel", "01.000 g mel", "01,000 g mel", "200 g mel eller sukker", "200 g flour or sugar", "0 g mel", "-1 g mel", "1/0 l vand", "0/2 g mel",
      "1000000001 g mel", "1000001 kg mel", "1e3 g mel", "500gmel", "500 g", "1 g __proto__",
      `1 g ${"a".repeat(301)}`, `1 g ${"ﷺ".repeat(40)}`,
    ]) {
      expect(normalizeIngredient(rawText)).toEqual({ rawText, normalizedName: null, quantity: null, unit: null, uncertain: true });
    }
    for (const text of ["ca. 500g", "1-2 kg", "1.000 g", "1,000 g", "1 pack", "500 g mel", "0 ml", "1/0 l", "1000001 kg"]) {
      expect(normalizeMeasuredQuantity(text)).toBeNull();
    }
  });
});
