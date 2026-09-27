import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  evaluateCompatibility,
  parseStoreDirectory,
  TilbudstroldenClient,
} from "../../src/adapters/deals/tilbudstrolden-client";

const projectRoot = resolve(import.meta.dir, "../..");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("TilbudstroldenClient", () => {
  test("connects to the pinned server and validates the required MCP tools", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "meal-planer-mcp-"));
    temporaryDirectories.push(dataDirectory);

    await using client = new TilbudstroldenClient({
      command: "node",
      args: ["dist/server.js"],
      cwd: join(projectRoot, "vendor/tilbudstrolden-mcp"),
      dataPath: join(dataDirectory, "tilbudstrolden.json"),
    });

    const compatibility = await client.checkCompatibility();

    expect(compatibility).toEqual({
      compatible: true,
      server: { name: "tilbudstrolden", version: "0.5.3" },
      expectedServer: { name: "tilbudstrolden", version: "0.5.3" },
      serverCompatible: true,
      toolCount: 18,
      missingRequiredTools: [],
      incompatibleToolSchemas: [],
    });
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
