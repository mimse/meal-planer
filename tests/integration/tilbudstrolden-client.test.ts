import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import {
  evaluateCompatibility,
  GenerateShoppingListStructuredContentSchema,
  parseStoreDirectory,
  parseScoreRecipesResponse,
  ScoreRecipesStructuredContentSchema,
  TilbudstroldenClient,
  TilbudstroldenBoundaryError,
} from "../../src/adapters/deals/tilbudstrolden-client";

const projectRoot = resolve(import.meta.dir, "../..");
const temporaryDirectories: string[] = [];

function nestedPropertySchema(schema: unknown, ...propertyNames: string[]): Record<string, unknown> {
  let current = schema;
  for (const propertyName of propertyNames) {
    if (typeof current !== "object" || current === null || Array.isArray(current)) {
      throw new Error(`Expected object schema before ${propertyName}`);
    }
    if (Reflect.get(current, "type") === "array") {
      current = Reflect.get(current, "items");
    }
    if (typeof current !== "object" || current === null || Array.isArray(current)) {
      throw new Error(`Expected object schema before ${propertyName}`);
    }
    const properties = Reflect.get(current, "properties");
    if (typeof properties !== "object" || properties === null || Array.isArray(properties)) {
      throw new Error(`Expected properties before ${propertyName}`);
    }
    current = Reflect.get(properties, propertyName);
  }
  if (typeof current !== "object" || current === null || Array.isArray(current)) {
    throw new Error(`Expected object schema at ${propertyNames.join(".")}`);
  }
  return current as Record<string, unknown>;
}

function scoreOutputIssues(outputSchema: unknown) {
  return toolOutputIssues("score_recipes", outputSchema);
}

function toolOutputIssues(name: string, outputSchema: unknown) {
  return evaluateCompatibility(
    { name: "tilbudstrolden", version: "0.5.3" },
    [{ name, inputSchema: {}, outputSchema }],
  ).incompatibleToolOutputSchemas;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("TilbudstroldenClient", () => {
  test("connects to the pinned server and validates the required MCP tools", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "meal-planer-mcp-"));
    temporaryDirectories.push(dataDirectory);
    const dataPath = join(dataDirectory, "tilbudstrolden.json");
    await writeFile(dataPath, JSON.stringify({
      household: { people: [], stores: [], defaultServings: 2, country: "XX" },
      pantry: [],
      recipes: [],
      mealHistory: [],
      spendLog: [],
    }));

    await using client = new TilbudstroldenClient({
      command: "node",
      args: ["dist/server.js"],
      cwd: join(projectRoot, "vendor/tilbudstrolden-mcp"),
      dataPath,
    });

    const compatibility = await client.checkCompatibility();
    const requestedAt = new Date().toISOString();
    const scores = await client.scoreRecipes();
    const shoppingList = await client.generateShoppingList({ recipes: ["Missing recipe"] });

    expect(compatibility).toEqual({
      compatible: true,
      server: { name: "tilbudstrolden", version: "0.5.3" },
      expectedServer: { name: "tilbudstrolden", version: "0.5.3" },
      serverCompatible: true,
      toolCount: 18,
      missingRequiredTools: [],
      incompatibleToolSchemas: [],
      missingRequiredToolOutputSchemas: [],
      incompatibleToolOutputSchemas: [],
    });
    expect(scores).toMatchObject({
      currency: "DKK",
      recipes: [],
    });
    expect(scores.providerText).toContain("No recipes to score. Add recipes first.");
    expect(scores.receivedAt >= requestedAt).toBe(true);
    expect(shoppingList).toMatchObject({
      status: "no_matching_recipes",
      requestedRecipes: ["Missing recipe"],
      availableRecipes: [],
      matchedRecipes: [],
      householdSize: null,
      currency: null,
      currencySymbol: null,
      estimatedTotal: 0,
      items: [],
      skippedPantry: [],
    });
    expect(shoppingList.providerText).toBe(
      "No matching recipes found. Available: none (add recipes first)",
    );
    expect(shoppingList.receivedAt >= requestedAt).toBe(true);
  });

  test("shares one connection across concurrent first use", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "meal-planer-mcp-concurrent-"));
    temporaryDirectories.push(dataDirectory);
    const dataPath = join(dataDirectory, "tilbudstrolden.json");
    await writeFile(dataPath, JSON.stringify({
      household: { people: [], stores: [], defaultServings: 2, country: "XX" },
      pantry: [],
      recipes: [],
      mealHistory: [],
      spendLog: [],
    }));

    await using client = new TilbudstroldenClient({
      command: "node",
      args: ["dist/server.js"],
      cwd: join(projectRoot, "vendor/tilbudstrolden-mcp"),
      dataPath,
    });

    const [scores, shoppingList] = await Promise.all([
      client.scoreRecipes(),
      client.generateShoppingList({ recipes: ["Missing recipe"] }),
    ]);

    expect(scores.recipes).toEqual([]);
    expect(shoppingList.status).toBe("no_matching_recipes");
  });

  test("uses a fresh SDK session when initialization is retried immediately", async () => {
    const serverDirectory = await mkdtemp(join(tmpdir(), "meal-planer-mcp-invalid-protocol-"));
    temporaryDirectories.push(serverDirectory);
    const serverPath = join(serverDirectory, "server.mjs");
    await writeFile(serverPath, `
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const lineEnd = buffer.indexOf("\\n");
    if (lineEnd === -1) break;
    const message = JSON.parse(buffer.slice(0, lineEnd));
    buffer = buffer.slice(lineEnd + 1);
    if (message.method === "initialize") {
      process.stdout.write(JSON.stringify({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: "2099-01-01",
          capabilities: {},
          serverInfo: { name: "invalid-protocol-server", version: "1.0.0" },
        },
      }) + "\\n");
    }
  }
});
process.stdin.on("end", () => setTimeout(() => process.exit(0), 250));
`);

    await using client = new TilbudstroldenClient({
      command: "node",
      args: [serverPath],
      cwd: serverDirectory,
      dataPath: join(serverDirectory, "unused.json"),
    });
    const protocolError = "Server's protocol version is not supported: 2099-01-01";

    await expect(client.checkCompatibility()).rejects.toThrow(protocolError);
    await expect(client.checkCompatibility()).rejects.toThrow(protocolError);
  });

  test("marks a different server identity as incompatible", () => {
    const compatibility = evaluateCompatibility(
      { name: "tilbudstrolden", version: "0.5.4" },
      [],
    );

    expect(compatibility).toMatchObject({
      compatible: false,
      expectedServer: { name: "tilbudstrolden", version: "0.5.3" },
      serverCompatible: false,
    });
  });

  test("reports incompatible required tool input schemas", () => {
    const compatibility = evaluateCompatibility(
      { name: "tilbudstrolden", version: "0.5.3" },
      [{
        name: "list_stores",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
            all: { type: "string" },
          },
        },
      }],
    );

    expect(compatibility.compatible).toBe(false);
    expect(compatibility.incompatibleToolSchemas).toContainEqual({
      name: "list_stores",
      issues: ["property all must have type boolean"],
    });
  });

  test("reports a missing required tool output schema separately", () => {
    const compatibility = evaluateCompatibility(
      { name: "tilbudstrolden", version: "0.5.3" },
      [{
        name: "score_recipes",
        inputSchema: {
          type: "object",
          properties: {
            optimize: { type: "boolean" },
            days: { type: "number" },
            maxPerProtein: { type: "number" },
            maxPerCuisine: { type: "number" },
            maxSlowDays: { type: "number" },
            excludeProteins: { type: "array", items: { type: "string" } },
            allowProteinOnDays: { type: "object" },
            slowOnlyOnDays: { type: "array", items: { type: "number" } },
            preferCuisines: { type: "object" },
          },
        },
      }],
    );

    expect(compatibility.compatible).toBe(false);
    expect(compatibility.missingRequiredToolOutputSchemas).toEqual(["score_recipes"]);
    expect(compatibility.incompatibleToolOutputSchemas).toEqual([]);
  });

  test("reports an incompatible required tool output schema separately", () => {
    const compatibility = evaluateCompatibility(
      { name: "tilbudstrolden", version: "0.5.3" },
      [{
        name: "score_recipes",
        inputSchema: {
          type: "object",
          properties: {
            optimize: { type: "boolean" },
            days: { type: "number" },
            maxPerProtein: { type: "number" },
            maxPerCuisine: { type: "number" },
            maxSlowDays: { type: "number" },
            excludeProteins: { type: "array", items: { type: "string" } },
            allowProteinOnDays: { type: "object" },
            slowOnlyOnDays: { type: "array", items: { type: "number" } },
            preferCuisines: { type: "object" },
          },
        },
        outputSchema: {
          type: "object",
          properties: {
            currency: { type: "number" },
            recipes: { type: "array", items: { type: "string" } },
          },
          required: ["currency", "recipes"],
        },
      }],
    );

    expect(compatibility.compatible).toBe(false);
    expect(compatibility.missingRequiredToolOutputSchemas).toEqual([]);
    expect(compatibility.incompatibleToolOutputSchemas).toContainEqual({
      name: "score_recipes",
      issues: expect.arrayContaining([
        "property currency must have type string",
        "property recipes.items must have type object",
      ]),
    });
  });

  test("rejects output schemas with enum members the client cannot parse", () => {
    const outputSchema = z.toJSONSchema(ScoreRecipesStructuredContentSchema);
    nestedPropertySchema(outputSchema, "recipes", "ingredients", "confidence").enum = [
      "high",
      "low",
      "none",
      "unknown",
    ];

    expect(scoreOutputIssues(outputSchema)).toEqual([{
      name: "score_recipes",
      issues: expect.arrayContaining([expect.stringContaining("confidence")]),
    }]);
  });

  test("rejects output schemas that omit a client enum constraint", () => {
    const outputSchema = z.toJSONSchema(ScoreRecipesStructuredContentSchema);
    delete nestedPropertySchema(outputSchema, "recipes", "ingredients", "confidence").enum;

    expect(scoreOutputIssues(outputSchema)).toEqual([{
      name: "score_recipes",
      issues: expect.arrayContaining([expect.stringContaining("confidence")]),
    }]);
  });

  test("rejects output schemas with anyOf branches the client cannot parse", () => {
    const outputSchema = z.toJSONSchema(ScoreRecipesStructuredContentSchema);
    const bestDealSchema = nestedPropertySchema(outputSchema, "recipes", "ingredients", "bestDeal");
    if (!Array.isArray(bestDealSchema.anyOf)) throw new Error("Expected bestDeal anyOf schema");
    bestDealSchema.anyOf = [...bestDealSchema.anyOf, { type: "string" }];

    expect(scoreOutputIssues(outputSchema)).toEqual([{
      name: "score_recipes",
      issues: expect.arrayContaining([expect.stringContaining("bestDeal")]),
    }]);
  });

  test("accepts output schemas whose values are a stricter client-compatible subset", () => {
    const outputSchema = z.toJSONSchema(ScoreRecipesStructuredContentSchema);
    nestedPropertySchema(outputSchema, "recipes", "ingredients", "confidence").enum = ["high"];
    const bestDealSchema = nestedPropertySchema(outputSchema, "recipes", "ingredients", "bestDeal");
    if (!Array.isArray(bestDealSchema.anyOf)) throw new Error("Expected bestDeal anyOf schema");
    const [onlyBestDealShape] = bestDealSchema.anyOf;
    delete bestDealSchema.anyOf;
    Object.assign(bestDealSchema, onlyBestDealShape);

    expect(scoreOutputIssues(outputSchema)).toEqual([]);
  });

  test("accepts narrower output type unions", () => {
    const outputSchema = z.toJSONSchema(GenerateShoppingListStructuredContentSchema);
    nestedPropertySchema(outputSchema, "currency").type = "string";

    expect(toolOutputIssues("generate_shopping_list", outputSchema)).toEqual([]);
  });

  test("accepts additional required output fields ignored by the client", () => {
    const outputSchema = z.toJSONSchema(ScoreRecipesStructuredContentSchema);
    if (!outputSchema.properties || !Array.isArray(outputSchema.required)) {
      throw new Error("Expected object output schema");
    }
    outputSchema.properties.providerMetadata = { type: "string" };
    outputSchema.required.push("providerMetadata");

    expect(scoreOutputIssues(outputSchema)).toEqual([]);
  });

  test("reports null as an incompatible required tool output schema", () => {
    const compatibility = evaluateCompatibility(
      { name: "tilbudstrolden", version: "0.5.3" },
      [{ name: "score_recipes", inputSchema: {}, outputSchema: null }],
    );

    expect(compatibility.compatible).toBe(false);
    expect(compatibility.missingRequiredToolOutputSchemas).toEqual([]);
    expect(compatibility.incompatibleToolOutputSchemas).toEqual([{
      name: "score_recipes",
      issues: ["schema must be an object schema"],
    }]);
  });

  test("validates every nested score response field", () => {
    expect(ScoreRecipesStructuredContentSchema.parse({
      currency: "DKK",
      recipes: [{
        name: "Dinner",
        servings: 4,
        complexity: "medium",
        proteinType: "beans",
        cuisineType: "danish",
        estimatedCost: 12.5,
        dealCoverage: 100,
        ingredients: [{
          name: "Beans",
          quantity: "400 g",
          category: "pantry",
          estimatedCost: 12.5,
          confidence: "low",
          bestDeal: { heading: "Beans", price: 12.5, store: "Netto" },
          candidates: [{ heading: "Other beans", price: 10, store: "REMA 1000", score: 42 }],
        }],
      }],
    })).toMatchObject({ recipes: [{ ingredients: [{ confidence: "low" }] }] });
  });

  test("validates every nested shopping response field", () => {
    const deal = {
      id: "offer-1",
      heading: "Beans",
      price: 12.5,
      currency: "DKK",
      quantity: 400,
      unit: "g",
      pricePerUnit: "31.25 kr/kg",
      store: "Netto",
      storeId: "netto",
      validFrom: "2026-09-20",
      validUntil: "2026-09-30",
    };

    expect(GenerateShoppingListStructuredContentSchema.parse({
      status: "ok",
      requestedRecipes: ["Dinner"],
      availableRecipes: ["Dinner"],
      matchedRecipes: ["Dinner"],
      householdSize: 4,
      currency: "DKK",
      currencySymbol: "kr",
      estimatedTotal: 12.5,
      items: [{
        name: "Beans",
        category: "pantry",
        displayQuantity: "400 g",
        requiredQuantity: { amount: 400, unit: "g" },
        sourceRecipes: ["Dinner"],
        contributions: [{ recipeName: "Dinner", quantity: "400 g", recipeServings: 4 }],
        confidence: "high",
        estimatedCost: 12.5,
        deal,
        purchase: {
          quantityNeeded: 400,
          unitNeeded: "g",
          packSize: 400,
          packsNeeded: 1,
          pricePerPack: 12.5,
          totalCost: 12.5,
          leftover: 0,
          unitPrice: "31.25 kr/kg",
        },
        alternatives: [{ offer: { ...deal, price: null, quantity: null, unit: null }, score: 42 }],
        expiringSoon: true,
      }],
      skippedPantry: ["Salt"],
    })).toMatchObject({ items: [{ purchase: { packsNeeded: 1 } }] });
  });

  test("throws precise boundary errors for unusable score responses", () => {
    const receivedAt = "2026-09-27T10:00:00.000Z";
    const validStructuredContent = { currency: "DKK", recipes: [] };

    expect(() => parseScoreRecipesResponse({
      isError: true,
      content: [{ type: "text", text: "provider failed" }],
      structuredContent: validStructuredContent,
    }, receivedAt)).toThrow(new TilbudstroldenBoundaryError(
      "score_recipes returned an MCP error: provider failed",
    ));
    expect(() => parseScoreRecipesResponse({
      content: [],
      structuredContent: validStructuredContent,
    }, receivedAt)).toThrow("score_recipes response is missing text content");
    expect(() => parseScoreRecipesResponse({
      content: [{ type: "text", text: "markdown only" }],
    }, receivedAt)).toThrow("score_recipes response is missing structuredContent");
    expect(() => parseScoreRecipesResponse({
      content: [{ type: "text", text: "undefined structured content" }],
      structuredContent: undefined,
    }, receivedAt)).toThrow("score_recipes response is missing structuredContent");
    expect(() => parseScoreRecipesResponse({
      content: [{ type: "text", text: "not parsed" }],
      structuredContent: { currency: "DKK", recipes: "invalid" },
    }, receivedAt)).toThrow(
      "score_recipes structuredContent validation failed: recipes: Invalid input: expected array, received string",
    );
  });

  test("parses store names and case-sensitive dealer IDs from the text-only protocol", () => {
    const stores = parseStoreDirectory(`3 stores:

- netto (id: 9ba51)
- rema 1000 (id: 11deC)
- SuperBrugsen (id: 0b1e8)`);

    expect(stores).toEqual([
      { name: "netto", dealerId: "9ba51" },
      { name: "rema 1000", dealerId: "11deC" },
      { name: "SuperBrugsen", dealerId: "0b1e8" },
    ]);
  });
});
