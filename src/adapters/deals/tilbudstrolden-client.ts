import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";

const REQUIRED_TOOLS = [
  "list_stores",
  "update_household",
  "update_pantry",
  "add_recipe",
  "score_recipes",
  "generate_shopping_list",
] as const;

const EXPECTED_SERVER = { name: "tilbudstrolden", version: "0.5.3" } as const;

type SchemaContract = {
  type: "object" | "array" | "string" | "number" | "boolean";
  properties?: Record<string, SchemaContract>;
  required?: readonly string[];
  items?: SchemaContract;
  enum?: readonly string[];
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
};

type McpToolDescription = {
  name: string;
  inputSchema: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function schemaIssues(actual: unknown, expected: SchemaContract, path = ""): string[] {
  const label = path || "schema";
  if (!isRecord(actual)) return [`${label} must be an object schema`];
  const issues: string[] = [];

  if (actual.type !== expected.type) {
    issues.push(`${label} must have type ${expected.type}`);
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
  const serverCompatible = server?.name === EXPECTED_SERVER.name
    && server.version === EXPECTED_SERVER.version;

  return {
    compatible: serverCompatible
      && missingRequiredTools.length === 0
      && incompatibleToolSchemas.length === 0,
    server,
    expectedServer: { ...EXPECTED_SERVER },
    serverCompatible,
    toolCount: tools.length,
    missingRequiredTools,
    incompatibleToolSchemas,
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

export class TilbudstroldenClient implements AsyncDisposable {
  readonly #client = new Client(
    { name: "meal-planer", version: "0.1.0" },
    { capabilities: {} },
  );
  readonly #transport: StdioClientTransport;
  #connected = false;

  constructor(options: TilbudstroldenClientOptions) {
    this.#transport = new StdioClientTransport({
      command: options.command,
      args: options.args,
      cwd: options.cwd,
      env: {
        ...getDefaultEnvironment(),
        TILBUDSTROLDEN_DATA: options.dataPath,
      },
      stderr: "pipe",
    });
    this.#transport.stderr?.on("data", () => {
      // Drain server diagnostics so a full stderr pipe cannot deadlock the MCP process.
    });
  }

  async checkCompatibility(): Promise<CompatibilityResult> {
    await this.#connect();
    const { tools } = await this.#client.listTools();
    const server = this.#client.getServerVersion();

    return evaluateCompatibility(
      server ? { name: server.name, version: server.version } : null,
      tools,
    );
  }

  async #connect(): Promise<void> {
    if (this.#connected) return;
    await this.#client.connect(this.#transport);
    this.#connected = true;
  }

  async close(): Promise<void> {
    if (!this.#connected) return;
    await this.#client.close();
    this.#connected = false;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}
