import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";

const REQUIRED_TOOLS = [
  "list_stores",
  "update_household",
  "update_pantry",
  "add_recipe",
  "score_recipes",
  "generate_shopping_list",
] as const;

const EXPECTED_SERVER = { name: "tilbudstrolden", version: "0.5.3" } as const;

const DealConfidenceSchema = z.enum(["high", "low", "none"]);

export const ScoreRecipesStructuredContentSchema = z.object({
  currency: z.string(),
  recipes: z.array(z.object({
    name: z.string(),
    servings: z.number(),
    complexity: z.string(),
    proteinType: z.string(),
    cuisineType: z.string(),
    estimatedCost: z.number(),
    dealCoverage: z.number(),
    ingredients: z.array(z.object({
      name: z.string(),
      quantity: z.string(),
      category: z.string(),
      estimatedCost: z.number(),
      confidence: DealConfidenceSchema,
      bestDeal: z.object({
        heading: z.string(),
        price: z.number(),
        store: z.string(),
      }).nullable(),
      candidates: z.array(z.object({
        heading: z.string(),
        price: z.number(),
        store: z.string(),
        score: z.number(),
      })),
    })),
  })),
});

export const ScoreRecipesResponseSchema = ScoreRecipesStructuredContentSchema.extend({
  providerText: z.string(),
  receivedAt: z.iso.datetime(),
});

export type ScoreRecipesResponse = z.infer<typeof ScoreRecipesResponseSchema>;

export type ScoreRecipesOptions = {
  optimize?: boolean;
  days?: number;
  maxPerProtein?: number;
  maxPerCuisine?: number;
  maxSlowDays?: number;
  excludeProteins?: string[];
  allowProteinOnDays?: Record<string, number[]>;
  slowOnlyOnDays?: number[];
  preferCuisines?: Record<string, number>;
};

const ShoppingDealSchema = z.object({
  id: z.string(),
  heading: z.string(),
  price: z.number().nullable(),
  currency: z.string(),
  quantity: z.number().nullable(),
  unit: z.string().nullable(),
  pricePerUnit: z.string().nullable(),
  store: z.string(),
  storeId: z.string(),
  validFrom: z.string().nullable(),
  validUntil: z.string().nullable(),
});

export const GenerateShoppingListStructuredContentSchema = z.object({
  status: z.enum(["ok", "no_matching_recipes"]),
  requestedRecipes: z.array(z.string()),
  availableRecipes: z.array(z.string()),
  matchedRecipes: z.array(z.string()),
  householdSize: z.number().nullable(),
  currency: z.string().nullable(),
  currencySymbol: z.string().nullable(),
  estimatedTotal: z.number(),
  items: z.array(z.object({
    name: z.string(),
    category: z.string(),
    displayQuantity: z.string(),
    requiredQuantity: z.object({
      amount: z.number(),
      unit: z.string(),
    }).nullable(),
    sourceRecipes: z.array(z.string()),
    contributions: z.array(z.object({
      recipeName: z.string(),
      quantity: z.string(),
      recipeServings: z.number(),
    })),
    confidence: DealConfidenceSchema,
    estimatedCost: z.number(),
    deal: ShoppingDealSchema.nullable(),
    purchase: z.object({
      quantityNeeded: z.number(),
      unitNeeded: z.string(),
      packSize: z.number(),
      packsNeeded: z.number(),
      pricePerPack: z.number(),
      totalCost: z.number(),
      leftover: z.number(),
      unitPrice: z.string().nullable(),
    }).nullable(),
    alternatives: z.array(z.object({
      offer: ShoppingDealSchema,
      score: z.number(),
    })),
    expiringSoon: z.boolean(),
  })),
  skippedPantry: z.array(z.string()),
});

export const GenerateShoppingListResponseSchema =
  GenerateShoppingListStructuredContentSchema.extend({
    providerText: z.string(),
    receivedAt: z.iso.datetime(),
  });

export type GenerateShoppingListResponse = z.infer<typeof GenerateShoppingListResponseSchema>;

export type GenerateShoppingListOptions = {
  recipes: string[];
  people?: number;
  excludePantry?: boolean;
};

type SchemaContract = {
  type?: "object" | "array" | "string" | "number" | "boolean" | "null"
    | readonly ("object" | "array" | "string" | "number" | "boolean" | "null")[];
  properties?: Record<string, SchemaContract>;
  required?: readonly string[];
  items?: SchemaContract;
  enum?: readonly string[];
  anyOf?: readonly SchemaContract[];
};

const REQUIRED_TOOL_SCHEMAS: Record<(typeof REQUIRED_TOOLS)[number], SchemaContract> = {
  list_stores: {
    type: "object",
    properties: {
      query: { type: "string" },
      all: { type: "boolean" },
    },
  },
  update_household: {
    type: "object",
    properties: {
      country: { type: "string" },
      people: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            dietaryRestrictions: { type: "array", items: { type: "string" } },
            defaultSchedule: { type: "object" },
          },
          required: ["name", "dietaryRestrictions", "defaultSchedule"],
        },
      },
      stores: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            dealerId: { type: "string" },
            priority: { type: "number" },
          },
          required: ["name", "dealerId", "priority"],
        },
      },
      defaultServings: { type: "number" },
    },
  },
  update_pantry: {
    type: "object",
    properties: {
      add: { type: "array", items: { type: "string" } },
      remove: { type: "array", items: { type: "string" } },
    },
  },
  add_recipe: {
    type: "object",
    properties: {
      name: { type: "string" },
      servings: { type: "number" },
      complexity: { type: "string", enum: ["quick", "medium", "slow"] },
      cuisineType: { type: "string" },
      proteinType: { type: "string" },
      ingredients: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            quantity: { type: "string" },
            searchTerms: { type: "array", items: { type: "string" } },
            category: { type: "string" },
          },
          required: ["name", "quantity"],
        },
      },
    },
    required: ["name", "complexity", "cuisineType", "proteinType", "ingredients"],
  },
  score_recipes: {
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
  generate_shopping_list: {
    type: "object",
    properties: {
      recipes: { type: "array", items: { type: "string" } },
      people: { type: "number" },
      excludePantry: { type: "boolean" },
    },
    required: ["recipes"],
  },
};

const stringSchema = { type: "string" } as const;
const numberSchema = { type: "number" } as const;
const nullableStringSchema = { type: ["string", "null"] } as const;
const nullableNumberSchema = { type: ["number", "null"] } as const;
const stringArraySchema = { type: "array", items: stringSchema } as const;

const shoppingDealSchema: SchemaContract = {
  type: "object",
  properties: {
    id: stringSchema,
    heading: stringSchema,
    price: nullableNumberSchema,
    currency: stringSchema,
    quantity: nullableNumberSchema,
    unit: nullableStringSchema,
    pricePerUnit: nullableStringSchema,
    store: stringSchema,
    storeId: stringSchema,
    validFrom: nullableStringSchema,
    validUntil: nullableStringSchema,
  },
  required: [
    "id",
    "heading",
    "price",
    "currency",
    "quantity",
    "unit",
    "pricePerUnit",
    "store",
    "storeId",
    "validFrom",
    "validUntil",
  ],
};

const REQUIRED_TOOL_OUTPUT_SCHEMAS: Partial<
  Record<(typeof REQUIRED_TOOLS)[number], SchemaContract>
> = {
  score_recipes: {
    type: "object",
    properties: {
      currency: stringSchema,
      recipes: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: stringSchema,
            servings: numberSchema,
            complexity: stringSchema,
            proteinType: stringSchema,
            cuisineType: stringSchema,
            estimatedCost: numberSchema,
            dealCoverage: numberSchema,
            ingredients: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  name: stringSchema,
                  quantity: stringSchema,
                  category: stringSchema,
                  estimatedCost: numberSchema,
                  confidence: { type: "string", enum: ["high", "low", "none"] },
                  bestDeal: {
                    anyOf: [{
                      type: "object",
                      properties: {
                        heading: stringSchema,
                        price: numberSchema,
                        store: stringSchema,
                      },
                      required: ["heading", "price", "store"],
                    }, { type: "null" }],
                  },
                  candidates: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        heading: stringSchema,
                        price: numberSchema,
                        store: stringSchema,
                        score: numberSchema,
                      },
                      required: ["heading", "price", "store", "score"],
                    },
                  },
                },
                required: [
                  "name",
                  "quantity",
                  "category",
                  "estimatedCost",
                  "confidence",
                  "bestDeal",
                  "candidates",
                ],
              },
            },
          },
          required: [
            "name",
            "servings",
            "complexity",
            "proteinType",
            "cuisineType",
            "estimatedCost",
            "dealCoverage",
            "ingredients",
          ],
        },
      },
    },
    required: ["currency", "recipes"],
  },
  generate_shopping_list: {
    type: "object",
    properties: {
      status: { type: "string", enum: ["ok", "no_matching_recipes"] },
      requestedRecipes: stringArraySchema,
      availableRecipes: stringArraySchema,
      matchedRecipes: stringArraySchema,
      householdSize: nullableNumberSchema,
      currency: nullableStringSchema,
      currencySymbol: nullableStringSchema,
      estimatedTotal: numberSchema,
      items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: stringSchema,
            category: stringSchema,
            displayQuantity: stringSchema,
            requiredQuantity: {
              anyOf: [{
                type: "object",
                properties: { amount: numberSchema, unit: stringSchema },
                required: ["amount", "unit"],
              }, { type: "null" }],
            },
            sourceRecipes: stringArraySchema,
            contributions: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  recipeName: stringSchema,
                  quantity: stringSchema,
                  recipeServings: numberSchema,
                },
                required: ["recipeName", "quantity", "recipeServings"],
              },
            },
            confidence: { type: "string", enum: ["high", "low", "none"] },
            estimatedCost: numberSchema,
            deal: { anyOf: [shoppingDealSchema, { type: "null" }] },
            purchase: {
              anyOf: [{
                type: "object",
                properties: {
                  quantityNeeded: numberSchema,
                  unitNeeded: stringSchema,
                  packSize: numberSchema,
                  packsNeeded: numberSchema,
                  pricePerPack: numberSchema,
                  totalCost: numberSchema,
                  leftover: numberSchema,
                  unitPrice: nullableStringSchema,
                },
                required: [
                  "quantityNeeded",
                  "unitNeeded",
                  "packSize",
                  "packsNeeded",
                  "pricePerPack",
                  "totalCost",
                  "leftover",
                  "unitPrice",
                ],
              }, { type: "null" }],
            },
            alternatives: {
              type: "array",
              items: {
                type: "object",
                properties: { offer: shoppingDealSchema, score: numberSchema },
                required: ["offer", "score"],
              },
            },
            expiringSoon: { type: "boolean" },
          },
          required: [
            "name",
            "category",
            "displayQuantity",
            "requiredQuantity",
            "sourceRecipes",
            "contributions",
            "confidence",
            "estimatedCost",
            "deal",
            "purchase",
            "alternatives",
            "expiringSoon",
          ],
        },
      },
      skippedPantry: stringArraySchema,
    },
    required: [
      "status",
      "requestedRecipes",
      "availableRecipes",
      "matchedRecipes",
      "householdSize",
      "currency",
      "currencySymbol",
      "estimatedTotal",
      "items",
      "skippedPantry",
    ],
  },
};

export type TilbudstroldenClientOptions = {
  command: string;
  args: string[];
  cwd: string;
  dataPath: string;
};

export type CompatibilityResult = {
  compatible: boolean;
  server: { name: string; version: string } | null;
  expectedServer: { name: string; version: string };
  serverCompatible: boolean;
  toolCount: number;
  missingRequiredTools: string[];
  incompatibleToolSchemas: Array<{ name: string; issues: string[] }>;
  missingRequiredToolOutputSchemas: string[];
  incompatibleToolOutputSchemas: Array<{ name: string; issues: string[] }>;
};

type McpToolDescription = {
  name: string;
  inputSchema: unknown;
  outputSchema?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function schemaIssues(actual: unknown, expected: SchemaContract, path = ""): string[] {
  const label = path || "schema";
  if (!isRecord(actual)) return [`${label} must be an object schema`];
  const issues: string[] = [];

  if (expected.anyOf) {
    const actualOptions = Array.isArray(actual.anyOf) ? actual.anyOf : [];
    if (actualOptions.length === 0) return [`${label} must use anyOf`];
    for (const expectedOption of expected.anyOf) {
      if (!actualOptions.some((option) => schemaIssues(option, expectedOption, path).length === 0)) {
        issues.push(`${label} has an incompatible anyOf option`);
      }
    }
    return issues;
  }

  const expectedTypes = Array.isArray(expected.type) ? [...expected.type] : [expected.type];
  const actualTypes = Array.isArray(actual.type) ? actual.type : [actual.type];
  if (expectedTypes.length !== actualTypes.length
    || expectedTypes.some((type) => !actualTypes.includes(type))) {
    issues.push(`${label} must have type ${expectedTypes.join(" or ")}`);
    return issues;
  }

  if (expected.enum) {
    const actualEnum = Array.isArray(actual.enum) ? actual.enum : [];
    for (const value of expected.enum) {
      if (!actualEnum.includes(value)) issues.push(`${label} must accept ${value}`);
    }
  }

  if (expected.items) {
    issues.push(...schemaIssues(actual.items, expected.items, `${label}.items`));
  }

  if (expected.properties) {
    const actualProperties = isRecord(actual.properties) ? actual.properties : {};
    for (const [name, contract] of Object.entries(expected.properties)) {
      if (!(name in actualProperties)) {
        issues.push(`${path ? `${path}.` : ""}missing property ${name}`);
        continue;
      }
      issues.push(...schemaIssues(
        actualProperties[name],
        contract,
        `${path ? `${path}.` : ""}property ${name}`,
      ));
    }
  }

  const expectedRequired = new Set(expected.required ?? []);
  const actualRequired = Array.isArray(actual.required)
    ? actual.required.filter((entry): entry is string => typeof entry === "string")
    : [];
  for (const name of expectedRequired) {
    if (!actualRequired.includes(name)) issues.push(`${label} must require ${name}`);
  }
  for (const name of actualRequired) {
    if (!expectedRequired.has(name)) issues.push(`${label} unexpectedly requires ${name}`);
  }

  return issues;
}

function outputSchemaIssues(actual: unknown, expected: SchemaContract, path = ""): string[] {
  const label = path || "schema";
  if (!isRecord(actual)) return [`${label} must be an object schema`];
  const issues: string[] = [];

  const actualOptions = Array.isArray(actual.anyOf) ? actual.anyOf : [actual];
  const expectedOptions = expected.anyOf ?? [expected];
  if (expected.anyOf || Array.isArray(actual.anyOf)) {
    if (actualOptions.length === 0) return [`${label} must describe at least one output shape`];
    for (const actualOption of actualOptions) {
      if (!expectedOptions.some((option) =>
        outputSchemaIssues(actualOption, option, path).length === 0)) {
        issues.push(`${label} has an incompatible anyOf option`);
      }
    }
    return issues;
  }

  const expectedTypes = Array.isArray(expected.type) ? [...expected.type] : [expected.type];
  const actualTypes = Array.isArray(actual.type) ? actual.type : [actual.type];
  if (actualTypes.some((type) => !expectedTypes.includes(type))) {
    issues.push(`${label} must have type ${expectedTypes.join(" or ")}`);
    return issues;
  }

  if (expected.enum) {
    if (!Array.isArray(actual.enum) || actual.enum.length === 0) {
      issues.push(`${label} must constrain output to accepted enum values`);
    } else {
      for (const value of actual.enum) {
        if (typeof value !== "string" || !expected.enum.includes(value)) {
          issues.push(`${label} must not emit ${String(value)}`);
        }
      }
    }
  }

  if (expected.items) {
    issues.push(...outputSchemaIssues(actual.items, expected.items, `${label}.items`));
  }

  if (expected.properties) {
    const actualProperties = isRecord(actual.properties) ? actual.properties : {};
    for (const [name, contract] of Object.entries(expected.properties)) {
      if (!(name in actualProperties)) {
        issues.push(`${path ? `${path}.` : ""}missing property ${name}`);
        continue;
      }
      issues.push(...outputSchemaIssues(
        actualProperties[name],
        contract,
        `${path ? `${path}.` : ""}property ${name}`,
      ));
    }
  }

  const expectedRequired = new Set(expected.required ?? []);
  const actualRequired = Array.isArray(actual.required)
    ? actual.required.filter((entry): entry is string => typeof entry === "string")
    : [];
  for (const name of expectedRequired) {
    if (!actualRequired.includes(name)) issues.push(`${label} must require ${name}`);
  }

  return issues;
}

export function evaluateCompatibility(
  server: { name: string; version: string } | null,
  tools: readonly McpToolDescription[],
): CompatibilityResult {
  const availableTools = new Map(tools.map((tool) => [tool.name, tool]));
  const missingRequiredTools = REQUIRED_TOOLS.filter((name) => !availableTools.has(name));
  const incompatibleToolSchemas = REQUIRED_TOOLS.flatMap((name) => {
    const tool = availableTools.get(name);
    if (!tool) return [];
    const issues = schemaIssues(tool.inputSchema, REQUIRED_TOOL_SCHEMAS[name]);
    return issues.length > 0 ? [{ name, issues }] : [];
  });
  const outputSchemaEntries = Object.entries(REQUIRED_TOOL_OUTPUT_SCHEMAS) as Array<
    [(typeof REQUIRED_TOOLS)[number], SchemaContract]
  >;
  const missingRequiredToolOutputSchemas = outputSchemaEntries.flatMap(([name]) => {
    const tool = availableTools.get(name);
    return tool && tool.outputSchema === undefined ? [name] : [];
  });
  const incompatibleToolOutputSchemas = outputSchemaEntries.flatMap(([name, expected]) => {
    const tool = availableTools.get(name);
    if (!tool || tool.outputSchema === undefined) return [];
    const issues = outputSchemaIssues(tool.outputSchema, expected);
    return issues.length > 0 ? [{ name, issues }] : [];
  });
  const serverCompatible = server?.name === EXPECTED_SERVER.name
    && server.version === EXPECTED_SERVER.version;

  return {
    compatible: serverCompatible
      && missingRequiredTools.length === 0
      && incompatibleToolSchemas.length === 0
      && missingRequiredToolOutputSchemas.length === 0
      && incompatibleToolOutputSchemas.length === 0,
    server,
    expectedServer: { ...EXPECTED_SERVER },
    serverCompatible,
    toolCount: tools.length,
    missingRequiredTools,
    incompatibleToolSchemas,
    missingRequiredToolOutputSchemas,
    incompatibleToolOutputSchemas,
  };
}

export type StoreDirectoryEntry = {
  name: string;
  dealerId: string;
};

export function parseStoreDirectory(text: string): StoreDirectoryEntry[] {
  return text.split("\n").flatMap((line) => {
    const match = /^- (.+) \(id: ([^)]+)\)(?:\s|$)/.exec(line.trim());
    return match?.[1] && match[2]
      ? [{ name: match[1], dealerId: match[2] }]
      : [];
  });
}

export class TilbudstroldenBoundaryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TilbudstroldenBoundaryError";
  }
}

type ParsedToolResponse<T> = T & {
  providerText: string;
  receivedAt: string;
};

function parseStructuredToolResponse<T extends Record<string, unknown>>(
  toolName: string,
  result: unknown,
  schema: z.ZodType<T>,
  receivedAt: string,
): ParsedToolResponse<T> {
  const record = isRecord(result) ? result : {};
  const textParts = Array.isArray(record.content)
    ? record.content.flatMap((item) =>
        isRecord(item) && item.type === "text" && typeof item.text === "string"
          ? [item.text]
          : [])
    : [];
  const providerText = textParts.join("\n");

  if (record.isError === true) {
    throw new TilbudstroldenBoundaryError(
      `${toolName} returned an MCP error${providerText ? `: ${providerText}` : " without text"}`,
    );
  }
  if (textParts.length === 0) {
    throw new TilbudstroldenBoundaryError(`${toolName} response is missing text content`);
  }
  if (record.structuredContent === undefined) {
    throw new TilbudstroldenBoundaryError(`${toolName} response is missing structuredContent`);
  }

  const parsed = schema.safeParse(record.structuredContent);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "structuredContent"}: ${issue.message}`)
      .join("; ");
    throw new TilbudstroldenBoundaryError(
      `${toolName} structuredContent validation failed: ${details}`,
    );
  }

  return { ...parsed.data, providerText, receivedAt };
}

export function parseScoreRecipesResponse(
  result: unknown,
  receivedAt = new Date().toISOString(),
): ScoreRecipesResponse {
  return ScoreRecipesResponseSchema.parse(parseStructuredToolResponse(
    "score_recipes",
    result,
    ScoreRecipesStructuredContentSchema,
    receivedAt,
  ));
}

export function parseGenerateShoppingListResponse(
  result: unknown,
  receivedAt = new Date().toISOString(),
): GenerateShoppingListResponse {
  return GenerateShoppingListResponseSchema.parse(parseStructuredToolResponse(
    "generate_shopping_list",
    result,
    GenerateShoppingListStructuredContentSchema,
    receivedAt,
  ));
}

type TilbudstroldenSessionOptions = {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly dataPath: string;
};

type TilbudstroldenSession = {
  client: Client;
  transport: StdioClientTransport;
};

export class TilbudstroldenClient implements AsyncDisposable {
  readonly #options: TilbudstroldenSessionOptions;
  #session: TilbudstroldenSession | undefined;
  #connected = false;
  #connectionPromise: Promise<Client> | undefined;
  #closePromise: Promise<void> | undefined;

  constructor(options: TilbudstroldenClientOptions) {
    this.#options = Object.freeze({
      command: options.command,
      args: Object.freeze([...options.args]),
      cwd: options.cwd,
      dataPath: options.dataPath,
    });
  }

  #createSession(): TilbudstroldenSession {
    const client = new Client(
      { name: "meal-planer", version: "0.1.0" },
      { capabilities: {} },
    );
    const transport = new StdioClientTransport({
      command: this.#options.command,
      args: [...this.#options.args],
      cwd: this.#options.cwd,
      env: {
        ...getDefaultEnvironment(),
        TILBUDSTROLDEN_DATA: this.#options.dataPath,
      },
      stderr: "pipe",
    });
    transport.stderr?.on("data", () => {
      // Drain server diagnostics so a full stderr pipe cannot deadlock the MCP process.
    });
    return { client, transport };
  }

  async checkCompatibility(): Promise<CompatibilityResult> {
    const client = await this.#connect();
    const { tools } = await client.listTools();
    const server = client.getServerVersion();

    return evaluateCompatibility(
      server ? { name: server.name, version: server.version } : null,
      tools,
    );
  }

  async scoreRecipes(options: ScoreRecipesOptions = {}): Promise<ScoreRecipesResponse> {
    const client = await this.#connect();
    const result = await client.callTool({
      name: "score_recipes",
      arguments: options,
    });
    const receivedAt = new Date().toISOString();
    return parseScoreRecipesResponse(result, receivedAt);
  }

  async generateShoppingList(
    options: GenerateShoppingListOptions,
  ): Promise<GenerateShoppingListResponse> {
    const client = await this.#connect();
    const result = await client.callTool({
      name: "generate_shopping_list",
      arguments: options,
    });
    const receivedAt = new Date().toISOString();
    return parseGenerateShoppingListResponse(result, receivedAt);
  }

  async #connect(): Promise<Client> {
    if (this.#closePromise) await this.#closePromise;
    if (this.#connected && this.#session) return this.#session.client;
    this.#connectionPromise ??= this.#establishConnection();
    return await this.#connectionPromise;
  }

  async #establishConnection(): Promise<Client> {
    const session = this.#createSession();
    this.#session = session;
    try {
      await session.client.connect(session.transport);
      this.#connected = true;
      return session.client;
    } catch (error) {
      if (this.#session === session) this.#session = undefined;
      throw error;
    } finally {
      this.#connectionPromise = undefined;
    }
  }

  async close(): Promise<void> {
    this.#closePromise ??= this.#finishClose();
    try {
      await this.#closePromise;
    } finally {
      this.#closePromise = undefined;
    }
  }

  async #finishClose(): Promise<void> {
    try {
      await this.#connectionPromise;
    } catch {
      return;
    }
    if (!this.#connected || !this.#session) return;
    const session = this.#session;
    try {
      await session.client.close();
    } finally {
      if (this.#session === session) {
        this.#session = undefined;
        this.#connected = false;
      }
    }
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}
