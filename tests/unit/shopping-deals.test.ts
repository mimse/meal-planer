import { expect, test } from "bun:test";
import { fetchShoppingDealMatches } from "../../src/application/shopping-deals";
import type { PlanningDealsClient } from "../../src/application/planning-deals";
import type { WeeklyPlan } from "../../src/infrastructure/plan-repository";
import type { Recipe } from "../../src/infrastructure/recipe-repository";
import type { ShoppingIngredient } from "../../src/domain/shopping-list";

const days = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
const plan = { id: "plan:test", shoppingDate: "2026-10-03", meals: days.map((day, i) => ({ id: `m${i}`, recipeId: `r${i}`, day, date: `2026-10-${String(i + 5).padStart(2, "0")}`, servings: i === 6 ? 8 : 3 })) } as unknown as WeeklyPlan;
const recipes = plan.meals.map(meal => ({ id: meal.recipeId, title: `Soup ${meal.id}`, totalMinutes: 20, cuisineTags: ["danish"], proteinTag: "vegetarian", servings: 4, ingredients: [] })) as unknown as Recipe[];
function ingredients(): ShoppingIngredient[] {
  return [{ key: "carrots:g", normalizedIngredient: "carrots", unit: "g", requiredQuantity: 2600, pantryDeduction: 100, preparedDeduction: 50, purchaseQuantity: 2450, warnings: [],
    contributions: plan.meals.map(meal => ({ mealId: meal.id, recipeId: meal.recipeId, recipeTitle: `Soup ${meal.id}`, sourceUrl: "https://example.com/soup", day: meal.day, date: meal.date,
      rawText: "400 g carrots", quantity: meal.servings * 100, unit: "g", preparedDeduction: meal.id === "m1" ? 50 : 0, kind: "recipe" as const })) }];
}
const options = { plan, recipes, items: ingredients(), householdServings: 3, preferredStores: [{ id: "local-super", name: "SuperBrugsen" }], pantry: [{ normalizedName: "carrots", quantity: "100 g" }] };

test("preserves fractional household servings supported by local configuration and MCP", async () => {
  const { client, calls } = fake();
  client.generateShoppingList = async args => ({ ...response(args.recipes), householdSize: args.people });
  const result = await fetchShoppingDealMatches({ ...options, householdServings: 3.75, client });
  expect(result.warnings.join(" ")).not.toContain("offline");
  expect(calls.find(call => call.name === "household")!.args.defaultServings).toBe(3.75);
  expect(calls.filter(call => call.name === "recipe").every(call => call.args.servings === 3.75)).toBe(true);
});
const compatibility = { compatible: true, server: { name: "tilbudstrolden", version: "0.5.3" }, expectedServer: { name: "tilbudstrolden", version: "0.5.3" }, serverCompatible: true, toolCount: 18, missingRequiredTools: [], incompatibleToolSchemas: [], missingRequiredToolOutputSchemas: [], incompatibleToolOutputSchemas: [] };
function response(names: string[]) {
  return { status: "ok", requestedRecipes: names, availableRecipes: names, matchedRecipes: names, householdSize: 3, currency: "DKK", currencySymbol: "kr", estimatedTotal: 999,
    items: [] as any[], skippedPantry: [], providerText: "Raw provider diagnostic, not safe shopping output", receivedAt: "2026-10-02T00:00:00Z" };
}
function fake() {
  const calls: { name: string; args: any }[] = [];
  const client: PlanningDealsClient = {
    async checkCompatibility() { calls.push({ name: "check", args: null }); return compatibility; },
    async listStores(args) { calls.push({ name: "stores", args }); return [{ name: "SuperBrugsen", dealerId: "live-ID" }]; },
    async updateHousehold(args) { calls.push({ name: "household", args }); },
    async updatePantry(args) { calls.push({ name: "pantry", args }); },
    async addRecipe(args) { calls.push({ name: "recipe", args }); },
    async generateShoppingList(args) { calls.push({ name: "shopping", args }); return response(args.recipes); },
    async close() { calls.push({ name: "close", args: null }); },
  };
  return { client, calls };
}
function dealItem(names: string[]) {
  return { name: "carrots", category: "produce", displayQuantity: "999 g", requiredQuantity: { amount: 999, unit: "g" }, sourceRecipes: names,
    contributions: names.map(recipeName => ({ recipeName, quantity: "999 g", recipeServings: 3 })), confidence: "high", estimatedCost: 999,
    deal: { id: "offer-current", heading: "Carrots 500g", price: 10, currency: "DKK", quantity: 0.5, unit: "kg", pricePerUnit: "20 kr/kg", store: "SuperBrugsen", storeId: "live-ID", validFrom: "2026-10-02T22:00:00+0000", validUntil: "2026-10-10T21:59:59+0000" },
    purchase: { quantityNeeded: 999, unitNeeded: "g", packSize: 42, packsNeeded: 42, pricePerPack: 999, totalCost: 999, leftover: 99, unitPrice: null }, alternatives: [], expiringSoon: false };
}
test("maps current offer metadata and converts package evidence rather than provider arithmetic", async () => {
  const { client } = fake();
  client.generateShoppingList = async args => ({ ...response(args.recipes), items: [dealItem(args.recipes)] });
  const result = await fetchShoppingDealMatches({ ...options, client });
  expect(result.matches).toEqual([{ itemKey: "carrots:g", packageQuantity: 500, automatic: true,
    deal: { offerId: "offer-current", heading: "Carrots 500g", price: 10, currency: "DKK", quantity: 0.5, unit: "kg", pricePerUnit: "20 kr/kg", store: "SuperBrugsen", storeId: "local-super", validFrom: "2026-10-03", validUntil: "2026-10-10", confidence: "high", retrievedAt: "2026-10-02T00:00:00Z" } }]);
  expect(options.items[0]!.purchaseQuantity).toBe(2450);
});

for (const scenario of ["expired", "future", "undated", "unpreferred", "low", "no-deal", "unknown-pack", "incompatible-pack"] as const) {
  test(`${scenario} offer is filtered or explicitly nonautomatic without changing the local list`, async () => {
    const { client } = fake();
    client.generateShoppingList = async args => {
      const item = dealItem(args.recipes);
      if (scenario === "expired") { item.deal.validFrom = "2026-10-01"; item.deal.validUntil = "2026-10-02"; }
      if (scenario === "future") item.deal.validFrom = "2026-10-04";
      if (scenario === "undated") item.deal.validUntil = "";
      if (scenario === "unpreferred") item.deal.storeId = "other";
      if (scenario === "low") item.confidence = "low";
      if (scenario === "no-deal") (item as any).deal = null;
      if (scenario === "unknown-pack") (item.deal as any).quantity = null;
      if (scenario === "incompatible-pack") item.deal.unit = "l";
      return { ...response(args.recipes), items: [item] };
    };
    const items = ingredients();
    const snapshot = JSON.stringify(items);
    const result = await fetchShoppingDealMatches({ ...options, items, client });
    expect(JSON.stringify(items)).toBe(snapshot);
    expect(result.warnings.join(" ")).toContain(scenario);
    if (["low", "unknown-pack", "incompatible-pack"].includes(scenario)) {
      expect(result.matches).toHaveLength(1);
      expect(result.matches[0]!.automatic).toBe(false);
      if (scenario !== "low") expect(result.matches[0]!.packageQuantity).toBeNull();
    } else expect(result.matches).toEqual([]);
    expect(result.providerText).toBe("Raw provider diagnostic, not safe shopping output");
  });
}

for (const scenario of ["schema", "wrong-request", "wrong-match", "wrong-people", "currency", "deal-currency", "negative", "oversized", "invalid-date", "reversed-date", "unknown-item", "wrong-source", "wrong-contribution", "missing-contribution", "duplicate"] as const) {
  test(`malformed ${scenario} provider response fails closed with offline warning`, async () => {
    const { client } = fake();
    client.generateShoppingList = async args => {
      if (scenario === "schema") return { providerText: "Unsafe markdown must not become matches" };
      const raw = { ...response(args.recipes), items: [dealItem(args.recipes)] };
      const item = raw.items[0]!;
      if (scenario === "wrong-request") raw.requestedRecipes = ["stranger"];
      if (scenario === "wrong-match") raw.matchedRecipes = raw.matchedRecipes.slice(1);
      if (scenario === "wrong-people") raw.householdSize = 4;
      if (scenario === "currency") raw.currency = "EUR";
      if (scenario === "deal-currency") item.deal.currency = "EUR";
      if (scenario === "negative") item.deal.price = -1;
      if (scenario === "oversized") item.purchase.packSize = 1e99;
      if (scenario === "invalid-date") item.deal.validUntil = "2026-99-99";
      if (scenario === "reversed-date") item.deal.validFrom = "2026-10-11";
      if (scenario === "unknown-item") item.name = "unrelated";
      if (scenario === "wrong-source") item.sourceRecipes = ["stranger"];
      if (scenario === "wrong-contribution") item.contributions[0]!.recipeName = "stranger";
      if (scenario === "missing-contribution") item.contributions = [];
      if (scenario === "duplicate") raw.items.push(item);
      return raw;
    };
    const result = await fetchShoppingDealMatches({ ...options, client });
    expect(result.matches).toEqual([]);
    expect(result.warnings.join(" ")).toContain("offline");
    expect(result.warnings.join(" ")).toContain("invalid");
  });
}

for (const scenario of ["identity", "version", "input-schema", "output-schema", "missing-tool", "missing-output"] as const) {
  test(`rejects incompatible pinned ${scenario} before syncing`, async () => {
    const { client, calls } = fake();
    client.checkCompatibility = async () => ({ ...compatibility,
      server: { name: scenario === "identity" ? "fake" : "tilbudstrolden", version: scenario === "version" ? "0.5.4" : "0.5.3" },
      incompatibleToolSchemas: scenario === "input-schema" ? [{ name: "add_recipe", issues: ["wrong schema"] }] : [],
      incompatibleToolOutputSchemas: scenario === "output-schema" ? [{ name: "generate_shopping_list", issues: ["wrong schema"] }] : [],
      missingRequiredTools: scenario === "missing-tool" ? ["list_stores"] : [],
      missingRequiredToolOutputSchemas: scenario === "missing-output" ? ["generate_shopping_list"] : [],
    });
    const result = await fetchShoppingDealMatches({ ...options, client });
    expect(result.matches).toEqual([]);
    expect(result.warnings.join(" ")).toContain("Incompatible");
    expect(calls.map(call => call.name)).toEqual(["close"]);
  });
}
test("unresolved directory chains never substitute or trigger provider defaults", async () => {
  const { client, calls } = fake();
  client.listStores = async () => [{ name: "Netto", dealerId: "other-chain" }];
  const result = await fetchShoppingDealMatches({ ...options, client });
  expect(result.matches).toEqual([]);
  expect(result.warnings.join(" ")).toContain("no substitute");
  expect(calls.some(c => c.name === "shopping")).toBe(false);
});

test("one bounded retry recovers a transient shopping read without repeating writes", async () => {
  const { client, calls } = fake();
  let attempts = 0;
  client.generateShoppingList = async args => { if (++attempts === 1) throw new Error("temporary connection"); return { ...response(args.recipes), items: [dealItem(args.recipes)] }; };
  const result = await fetchShoppingDealMatches({ ...options, client });
  expect(result.matches).toHaveLength(1);
  expect(attempts).toBe(2);
  expect(calls.filter(c => c.name === "recipe")).toHaveLength(7);
});
test("read failures stop after one retry and writes are never retried", async () => {
  const { client } = fake();
  let attempts = 0;
  client.listStores = async () => { attempts++; throw new Error("temporary connection"); };
  const result = await fetchShoppingDealMatches({ ...options, client });
  expect(attempts).toBe(2);
  expect(result.warnings.join(" ")).toContain("offline");
  const write = fake();
  let writes = 0;
  write.client.updateHousehold = async () => { writes++; throw new Error("temporary write failure"); };
  await fetchShoppingDealMatches({ ...options, client: write.client });
  expect(writes).toBe(1);
});
test("timeout bounds the whole lookup and hanging close", async () => {
  const { client } = fake();
  client.generateShoppingList = () => new Promise(() => {});
  client.close = () => new Promise(() => {});
  const start = performance.now();
  const result = await fetchShoppingDealMatches({ ...options, client, timeoutMs: 20, closeTimeoutMs: 20 });
  expect(performance.now() - start).toBeLessThan(500);
  expect(result.matches).toEqual([]);
  expect(result.warnings.join(" ")).toContain("timeout");
  expect(result.warnings.join(" ")).toContain("close");
}, 1000);
test("late factory resolution is closed once without any provider access", async () => {
  const { client, calls } = fake();
  const result = await fetchShoppingDealMatches({ ...options, timeoutMs: 10, closeTimeoutMs: 20, clientFactory: async () => {
    await new Promise(resolve => setTimeout(resolve, 40)); return client;
  } });
  await new Promise(resolve => setTimeout(resolve, 60));
  expect(result.matches).toEqual([]);
  expect(result.warnings.join(" ")).toContain("timeout");
  expect(calls.map(call => call.name)).toEqual(["close"]);
});
test("close rejection returns explicit warning rather than throwing", async () => {
  const { client } = fake();
  client.close = async () => { throw new Error("close broken"); };
  const result = await fetchShoppingDealMatches({ ...options, client });
  expect(result.warnings.join(" ")).toContain("close broken");
});

test("same-name different-unit purchases remain unmatched rather than guessed", async () => {
  const { client } = fake();
  const items = ingredients();
  items.push({ ...items[0]!, key: "carrots:stk", unit: "stk", requiredQuantity: 7, preparedDeduction: 0, pantryDeduction: 0, purchaseQuantity: 7,
    contributions: items[0]!.contributions.map(c => ({ ...c, quantity: 1, unit: "stk", preparedDeduction: 0 })) });
  client.generateShoppingList = async args => ({ ...response(args.recipes), items: [dealItem(args.recipes)] });
  const result = await fetchShoppingDealMatches({ ...options, items, client });
  expect(result.matches).toEqual([]);
  expect(result.warnings.join(" ")).toContain("ambiguous");
});
test("uncertain raw lines are preserved explicitly and never auto-priced", async () => {
  const { client, calls } = fake();
  const items = ingredients();
  const contribution = items[0]!.contributions[0]!;
  items.push({ key: "unknown", normalizedIngredient: "salt", unit: null, requiredQuantity: null, purchaseQuantity: null,
    pantryDeduction: 0, preparedDeduction: 0, warnings: ["existing local warning"],
    contributions: [{ ...contribution, rawText: "salt to taste", quantity: null, unit: null, preparedDeduction: 0 }] });
  client.generateShoppingList = async args => {
    const unknown = dealItem([args.recipes[0]!]); unknown.name = "salt to taste";
    return { ...response(args.recipes), items: [dealItem(args.recipes), unknown] };
  };
  const result = await fetchShoppingDealMatches({ ...options, items, client });
  expect(calls.filter(c => c.name === "recipe")[0]!.args.ingredients).toContainEqual({ name: "salt to taste", quantity: "salt to taste", searchTerms: ["salt to taste"] });
  expect(result.matches.map(match => match.itemKey)).toEqual(["carrots:g"]);
  expect(result.warnings.join(" ")).toContain("existing local warning");
  expect(result.warnings.join(" ")).toContain("uncertain");
});
test("fully pantry-covered measured items do not receive shopping matches", async () => {
  const { client } = fake();
  const items = ingredients(); items[0]!.purchaseQuantity = 0; items[0]!.pantryDeduction = items[0]!.requiredQuantity! - items[0]!.preparedDeduction;
  client.generateShoppingList = async args => ({ ...response(args.recipes), items: [dealItem(args.recipes)] });
  const result = await fetchShoppingDealMatches({ ...options, items, client });
  expect(result.matches).toEqual([]);
});

for (const scenario of ["date", "people", "six-meals", "duplicate-meal", "missing-recipe", "duplicate-store", "contribution-meal", "contribution-date", "negative-quantity", "over-deduction", "bad-timeout"] as const) {
  test(`invalid local ${scenario} is rejected before provider access`, async () => {
    const { client, calls } = fake();
    const input = { ...options, plan: { ...plan, meals: plan.meals.map(m => ({ ...m })) }, recipes: [...recipes], items: ingredients(), preferredStores: [...options.preferredStores], client };
    if (scenario === "date") input.plan.shoppingDate = "2026-02-30";
    if (scenario === "people") input.householdServings = 0;
    if (scenario === "six-meals") input.plan.meals.pop();
    if (scenario === "duplicate-meal") input.plan.meals[1]!.id = input.plan.meals[0]!.id;
    if (scenario === "missing-recipe") input.recipes = input.recipes.slice(1);
    if (scenario === "duplicate-store") input.preferredStores.push(input.preferredStores[0]!);
    if (scenario === "contribution-meal") input.items[0]!.contributions[0]!.mealId = "stranger";
    if (scenario === "contribution-date") input.items[0]!.contributions[0]!.date = "2026-10-06";
    if (scenario === "negative-quantity") input.items[0]!.purchaseQuantity = -1;
    if (scenario === "over-deduction") input.items[0]!.contributions[0]!.preparedDeduction = 999;
    if (scenario === "bad-timeout") Object.assign(input, { timeoutMs: NaN });
    await expect(fetchShoppingDealMatches(input)).rejects.toThrow();
    expect(calls).toEqual([]);
  });
}

test("converted package bounds fail closed", async () => {
  const { client } = fake();
  client.generateShoppingList = async args => { const item = dealItem(args.recipes); item.deal.quantity = 10_000_000; return { ...response(args.recipes), items: [item] }; };
  const result = await fetchShoppingDealMatches({ ...options, client });
  expect(result.matches).toEqual([]);
  expect(result.warnings.join(" ")).toContain("offline");
});
test("provider-omitted purchases remain explicit unmatched warnings", async () => {
  const { client } = fake();
  const result = await fetchShoppingDealMatches({ ...options, client });
  expect(result.matches).toEqual([]);
  expect(result.warnings.join(" ")).toContain("carrots");
  expect(result.warnings.join(" ")).toContain("unmatched");
});
test("successful lookup followed by failed close falls back offline", async () => {
  const { client } = fake();
  client.generateShoppingList = async args => ({ ...response(args.recipes), items: [dealItem(args.recipes)] });
  client.close = async () => { throw new Error("close broken"); };
  const result = await fetchShoppingDealMatches({ ...options, client });
  expect(result.matches).toEqual([]);
  expect(result.warnings.join(" ")).toContain("offline");
});
test("synchronizes combined Sunday recipe and prep production before pantry deduction", async () => {
  const { client, calls } = fake();
  const items = ingredients();
  const sunday = items[0]!.contributions[6]!;
  items[0]!.contributions.push({ ...sunday, quantity: 250, rawText: "Prep carrots for next week", kind: "prep" });
  items[0]!.requiredQuantity! += 250; items[0]!.purchaseQuantity! += 250;
  await fetchShoppingDealMatches({ ...options, items, client });
  expect(calls.filter(c => c.name === "recipe")[6]!.args.ingredients).toEqual([{ name: "carrots", quantity: "1050 g", searchTerms: ["carrots"] }]);
});

test("startup handshake timeout still closes the injected client", async () => {
  const { client, calls } = fake();
  client.checkCompatibility = () => new Promise(() => {});
  const result = await fetchShoppingDealMatches({ ...options, client, timeoutMs: 10, closeTimeoutMs: 10 });
  expect(result.matches).toEqual([]);
  expect(result.warnings.join(" ")).toContain("timeout");
  expect(calls.map(c => c.name)).toEqual(["close"]);
});
test("startup factory rejection returns offline result without pretending to connect", async () => {
  const result = await fetchShoppingDealMatches({ ...options, clientFactory: async () => { throw new Error("cannot start MCP"); } });
  expect(result.matches).toEqual([]);
  expect(result.providerText).toBeNull();
  expect(result.warnings.join(" ")).toContain("offline");
  expect(result.warnings.join(" ")).toContain("cannot start MCP");
});
test("unknown offer price is retained for review but never automatically estimated", async () => {
  const { client } = fake();
  client.generateShoppingList = async args => { const item = dealItem(args.recipes); (item.deal as any).price = null; return { ...response(args.recipes), items: [item] }; };
  const result = await fetchShoppingDealMatches({ ...options, client });
  expect(result.matches[0]!.automatic).toBe(false);
  expect(result.matches[0]!.deal.price).toBeNull();
  expect(result.warnings.join(" ")).toContain("price unknown");
});

test("malformed numeric payload still retains bounded raw diagnostic text separately", async () => {
  const { client } = fake();
  client.generateShoppingList = async args => { const item = dealItem(args.recipes); item.deal.price = -1; return { ...response(args.recipes), items: [item] }; };
  const result = await fetchShoppingDealMatches({ ...options, client });
  expect(result.matches).toEqual([]);
  expect(result.providerText).toBe("Raw provider diagnostic, not safe shopping output");
  expect(result.receivedAt).toBeNull();
});

test("syncs exactly seven saved production meals without upstream pantry skipping", async () => {
  const { client, calls } = fake();
  const result = await fetchShoppingDealMatches({ ...options, client });
  expect(calls.filter(c => c.name === "recipe").map(c => c.args)).toEqual(plan.meals.map(meal => ({ name: `mealplan:${meal.id}`, servings: 3, complexity: "quick", cuisineType: "danish", proteinType: "vegetarian",
    ingredients: [{ name: "carrots", quantity: `${meal.servings * 100 - (meal.id === "m1" ? 50 : 0)} g`, searchTerms: ["carrots"] }] })));
  expect(calls.find(c => c.name === "household")?.args).toEqual({ country: "DK", people: [], defaultServings: 3, stores: [{ name: "SuperBrugsen", dealerId: "live-ID", priority: 1 }] });
  expect(calls.find(c => c.name === "pantry")?.args).toEqual({ add: ["carrots"], remove: [] });
  expect(calls.filter(c => c.name === "shopping").map(c => c.args)).toEqual([{ recipes: plan.meals.map(m => `mealplan:${m.id}`), people: 3, excludePantry: false }]);
  expect(calls.find(c => c.name === "stores")?.args).toEqual({ all: true });
  expect(calls.at(-1)?.name).toBe("close");
  expect(result.providerText).toBe("Raw provider diagnostic, not safe shopping output");
  expect(result.receivedAt).toBe("2026-10-02T00:00:00Z");
  expect(result.matches).toEqual([]);
});
