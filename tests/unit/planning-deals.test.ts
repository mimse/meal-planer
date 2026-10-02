import { expect, test } from "bun:test";
import { fetchPlanningDealInputs, type PlanningDealsClient } from "../../src/application/planning-deals";
import type { PlannerRecipe } from "../../src/domain/planner";

const recipe: PlannerRecipe = {
  id: "r1", sourceId: "source", title: "Soup", servings: 4,
  prepMinutes: 10, cookMinutes: 10, totalMinutes: 20, cuisineTags: ["danish"],
  proteinTag: "vegetarian", dietaryTags: ["vegetarian"], suitabilityTags: ["quick"],
  extraMealServings: 0, preference: "neutral", needsReview: false,
  ingredients: [{ rawText: "200 g carrots", normalizedName: "carrots", quantity: 200, unit: "g", uncertain: false }],
};
const compatibility = {
  compatible: true, server: { name: "tilbudstrolden", version: "0.5.3" },
  expectedServer: { name: "tilbudstrolden", version: "0.5.3" }, serverCompatible: true,
  toolCount: 18, missingRequiredTools: [], incompatibleToolSchemas: [],
  missingRequiredToolOutputSchemas: [], incompatibleToolOutputSchemas: [],
};
function shopping(name: string) {
  return {
    status: "ok", requestedRecipes: [name], availableRecipes: [name], matchedRecipes: [name],
    householdSize: 4, currency: "DKK", currencySymbol: "kr", estimatedTotal: 10,
    items: [{ name: "carrots", category: "produce", displayQuantity: "200 g",
      requiredQuantity: { amount: 200, unit: "g" }, sourceRecipes: [name],
      contributions: [{ recipeName: name, quantity: "200 g", recipeServings: 4 }],
      confidence: "high", estimatedCost: 10,
      deal: { id: "offer", heading: "Carrots", price: 10, currency: "DKK", quantity: 500,
        unit: "g", pricePerUnit: null, store: "SuperBrugsen", storeId: "live-ID",
        validFrom: "2026-10-01T00:00:00Z", validUntil: "2026-10-10T23:59:59+02:00" },
      purchase: { quantityNeeded: 200, unitNeeded: "g", packSize: 500, packsNeeded: 1,
        pricePerPack: 10, totalCost: 10, leftover: 300, unitPrice: null },
      alternatives: [], expiringSoon: false }], skippedPantry: [],
    providerText: "Deliberately not machine parseable", receivedAt: "2026-10-02T00:00:00Z",
  };
}
function fake() {
  const calls: Array<{ name: string; args: unknown }> = [];
  const client: PlanningDealsClient = {
    async checkCompatibility() { calls.push({ name: "check", args: null }); return compatibility; },
    async listStores(options) { calls.push({ name: "stores", args: options }); return [{ name: "SuperBrugsen", dealerId: "live-ID" }]; },
    async updateHousehold(args) { calls.push({ name: "household", args }); },
    async updatePantry(args) { calls.push({ name: "pantry", args }); },
    async addRecipe(args) { calls.push({ name: "recipe", args }); },
    async generateShoppingList(args) { calls.push({ name: "shopping", args }); return shopping(args.recipes[0]!); },
    async close() { calls.push({ name: "close", args: null }); },
  };
  return { client, calls };
}
test("unavailable provider returns explicit offline fallback and closes", async () => {
  const { client, calls } = fake();
  client.checkCompatibility = async () => { throw new Error("provider unavailable"); };
  const result = await fetchPlanningDealInputs({ ...options, client });
  expect(result.dealSignals).toEqual([]);
  expect(result.packageEstimates).toEqual([]);
  expect(result.warnings.join(" ")).toContain("provider unavailable");
  expect(result.warnings.join(" ")).toContain("without deals");
  expect(calls.at(-1)?.name).toBe("close");
});
test("timeout bounds unavailable calls and even a hanging close", async () => {
  const { client } = fake();
  client.generateShoppingList = () => new Promise(() => {});
  client.close = () => new Promise(() => {});
  const started = performance.now();
  const result = await fetchPlanningDealInputs({ ...options, client, timeoutMs: 20, closeTimeoutMs: 20 });
  expect(performance.now() - started).toBeLessThan(500);
  expect(result.dealSignals).toEqual([]);
  expect(result.warnings.join(" ")).toContain("timeout");
  expect(result.warnings.join(" ")).toContain("close");
});
for (const scenario of ["low", "unpreferred", "expired", "future", "missing-date"] as const) {
  test(`${scenario} offers do not influence planning and carry explicit warnings`, async () => {
    const { client } = fake();
    client.generateShoppingList = async args => {
      const response = shopping(args.recipes[0]!);
      const item = response.items[0]!;
      if (scenario === "low") item.confidence = "low";
      if (scenario === "unpreferred") item.deal.storeId = "other-chain";
      if (scenario === "expired") item.deal.validUntil = "2026-10-02T23:59:59+02:00";
      if (scenario === "future") item.deal.validFrom = "2026-10-04T00:00:00Z";
      if (scenario === "missing-date") item.deal.validUntil = "";
      return response;
    };
    const result = await fetchPlanningDealInputs({ ...options, client });
    expect(result.dealSignals).toEqual([]);
    expect(result.packageEstimates).toEqual([]);
    expect(result.warnings.join(" ")).toContain(scenario);
  });
}
for (const scenario of ["schema", "negative-price", "oversized-pack", "wrong-recipe", "duplicate-item", "invalid-date"] as const) {
  test(`invalid ${scenario} response fails closed`, async () => {
    const { client, calls } = fake();
    client.generateShoppingList = async args => {
      if (scenario === "schema") return { providerText: "Looks valid in Markdown" };
      const response = shopping(args.recipes[0]!);
      if (scenario === "negative-price") response.items[0]!.deal.price = -10;
      if (scenario === "oversized-pack") response.items[0]!.purchase.packSize = 1e100;
      if (scenario === "wrong-recipe") response.matchedRecipes = ["some other recipe"];
      if (scenario === "duplicate-item") response.items.push(response.items[0]!);
      if (scenario === "invalid-date") response.items[0]!.deal.validUntil = "2026-99-99";
      return response;
    };
    const result = await fetchPlanningDealInputs({ ...options, client });
    expect(result.dealSignals).toEqual([]);
    expect(result.packageEstimates).toEqual([]);
    expect(result.warnings.join(" ")).toContain("invalid");
    expect(calls.at(-1)?.name).toBe("close");
  });
}
test("factory failures gracefully fall back", async () => {
  const result = await fetchPlanningDealInputs({ ...options, clientFactory: async () => { throw new Error("cannot launch MCP"); } });
  expect(result.dealSignals).toEqual([]);
  expect(result.warnings.join(" ")).toContain("cannot launch MCP");
});
test("invalid shopping date is rejected before any provider access", async () => {
  const { client, calls } = fake();
  await expect(fetchPlanningDealInputs({ ...options, client, shoppingDate: "2026-02-30" })).rejects.toThrow("shoppingDate");
  expect(calls).toEqual([]);
});
test("unresolved preferred stores never invoke upstream default-chain matching", async () => {
  const { client, calls } = fake();
  client.listStores = async () => [{ name: "Netto", dealerId: "not-preferred" }];
  const result = await fetchPlanningDealInputs({ ...options, client });
  expect(result.dealSignals).toEqual([]);
  expect(calls.some(call => call.name === "shopping")).toBe(false);
  expect(result.warnings.join(" ")).toContain("SuperBrugsen");
});
test("transient read failure gets only one retry", async () => {
  const { client } = fake();
  let attempts = 0;
  client.generateShoppingList = async args => {
    if (++attempts === 1) throw new Error("temporary connection failure");
    return shopping(args.recipes[0]!);
  };
  const result = await fetchPlanningDealInputs({ ...options, client });
  expect(result.dealSignals).toHaveLength(1);
  expect(attempts).toBe(2);
});
test("factory resolving after the budget is still closed", async () => {
  const { client, calls } = fake();
  const result = await fetchPlanningDealInputs({ ...options, timeoutMs: 10, clientFactory: async () => {
    await new Promise(resolve => setTimeout(resolve, 30));
    return client;
  } });
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(result.dealSignals).toEqual([]);
  expect(calls.map(call => call.name)).toEqual(["close"]);
});
test("measured package units match recipe units and repeated packages are deduplicated", async () => {
  const { client } = fake();
  client.generateShoppingList = async args => {
    const response = shopping(args.recipes[0]!);
    response.items[0]!.purchase.packSize = 0.5;
    response.items[0]!.purchase.unitNeeded = "kg";
    return response;
  };
  const result = await fetchPlanningDealInputs({ ...options, recipes: [recipe, { ...recipe, id: "r2" }], client });
  expect(result.dealSignals).toHaveLength(2);
  expect(result.packageEstimates).toEqual([{ normalizedIngredient: "carrots", unit: "g", packageQuantity: 500, perishability: "perishable" }]);
});
test("unknown perishability uses an explicit conservative assumption, not invented package size", async () => {
  const { client } = fake();
  client.generateShoppingList = async args => {
    const response = shopping(args.recipes[0]!);
    response.items[0]!.category = "other";
    return response;
  };
  const result = await fetchPlanningDealInputs({ ...options, client });
  expect(result.packageEstimates[0]).toMatchObject({ packageQuantity: 500, perishability: "short-lived" });
  expect(result.warnings.join(" ")).toContain("conservative");
});
test("pinned provider compact timezone offsets are validated against the Danish shopping day", async () => {
  const { client } = fake();
  client.generateShoppingList = async args => {
    const response = shopping(args.recipes[0]!);
    response.items[0]!.deal.validFrom = "2026-10-02T22:00:00+0000";
    response.items[0]!.deal.validUntil = "2026-10-09T21:59:59+0000";
    return response;
  };
  const result = await fetchPlanningDealInputs({ ...options, client });
  expect(result.dealSignals[0]).toMatchObject({ validUntil: "2026-10-09", value: 1 });
});
test("unreviewed candidates do not disable deals for reviewed candidates", async () => {
  const { client } = fake();
  const result = await fetchPlanningDealInputs({ ...options, recipes: [recipe, { ...recipe, id: "unreviewed", needsReview: true, servings: null }], client });
  expect(result.dealSignals).toHaveLength(1);
  expect(result.warnings.join(" ")).toContain("not planning-ready");
});
test("exact pinned identity is checked even if an injected report claims compatible", async () => {
  const { client, calls } = fake();
  client.checkCompatibility = async () => ({ ...compatibility, server: { name: "tilbudstrolden", version: "0.5.4" } });
  const result = await fetchPlanningDealInputs({ ...options, client });
  expect(result.dealSignals).toEqual([]);
  expect(calls.some(call => call.name === "stores")).toBe(false);
  expect(result.warnings.join(" ")).toContain("Incompatible");
});
test("setup stores with unresolved deal metadata are freshly resolved live", async () => {
  const { client } = fake();
  const configuredStores = [{ id: "local-superbrugsen", name: "SuperBrugsen", dealerId: null, dealsEnabled: false }];
  const result = await fetchPlanningDealInputs({ ...options, preferredStores: configuredStores, client });
  expect(result.dealSignals).toHaveLength(1);
});
const options = { recipes: [recipe], preferredStores: [{ id: "local-superbrugsen", name: "SuperBrugsen" }],
  pantry: [{ normalizedName: "salt", quantity: "1 kg" }], shoppingDate: "2026-10-03" };

test("synchronizes a full-directory resolved chain and produces validated planning inputs", async () => {
  const { client, calls } = fake();
  const result = await fetchPlanningDealInputs({ ...options, client });
  expect(result.dealSignals).toEqual([{ recipeId: "r1", storeId: "local-superbrugsen", value: 1,
    validUntil: "2026-10-10", confidence: "high" }]);
  expect(result.packageEstimates).toEqual([{ normalizedIngredient: "carrots", unit: "g",
    packageQuantity: 500, perishability: "perishable" }]);
  expect(calls.find(c => c.name === "stores")?.args).toEqual({ all: true });
  expect(calls.find(c => c.name === "household")?.args).toMatchObject({ country: "DK", people: [],
    stores: [{ name: "SuperBrugsen", dealerId: "live-ID", priority: 1 }] });
  expect(calls.find(c => c.name === "pantry")?.args).toEqual({ add: ["salt"], remove: [] });
  expect(calls.find(c => c.name === "recipe")?.args).toMatchObject({ servings: 4,
    ingredients: [{ name: "carrots", quantity: "200 g", searchTerms: ["carrots"] }] });
  expect(calls.at(-1)?.name).toBe("close");
  expect(result.warnings.join(" ")).toContain("coverage");
});
