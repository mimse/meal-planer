#!/usr/bin/env bun

import { Command } from "commander";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import packageJson from "../package.json";
import { TilbudstroldenClient } from "./adapters/deals/tilbudstrolden-client";
import { inspectRecipeUrl } from "./commands/inspect-recipe";

const program = new Command()
  .name("mealplan")
  .description("Family-aware weekly meal planning for Denmark")
  .version(packageJson.version);

const recipes = program
  .command("recipes")
  .description("Import, inspect, and manage recipes");

recipes
  .command("inspect")
  .description("Fetch a recipe URL and inspect its Schema.org Recipe data")
  .argument("<url>", "recipe page URL")
  .option("--json", "emit stable JSON")
  .action(async (urlValue: string, options: { json?: boolean }) => {
    const url = new URL(urlValue);
    const recipe = await inspectRecipeUrl(url, {
      requestInit: {
        headers: { "user-agent": `meal-planer/${packageJson.version}` },
        signal: AbortSignal.timeout(15_000),
      },
    });
    if (options.json) {
      process.stdout.write(`${JSON.stringify(recipe, null, 2)}\n`);
      return;
    }

    console.log(`${recipe.title}\n${recipe.canonicalUrl}`);
  });

const integrations = program
  .command("integrations")
  .description("Inspect external recipe and deal integrations");

integrations
  .command("verify-deals")
  .description("Verify compatibility with the pinned TilbudsTrolden MCP server")
  .option("--server <path>", "server entry point", "vendor/tilbudstrolden-mcp/dist/server.js")
  .option("--data <path>", "isolated TilbudsTrolden data file", ".data/tilbudstrolden.json")
  .option("--json", "emit stable JSON")
  .action(async (options: { server: string; data: string; json?: boolean }) => {
    const serverPath = resolve(options.server);
    const dataPath = resolve(options.data);
    await mkdir(dirname(dataPath), { recursive: true });

    await using client = new TilbudstroldenClient({
      command: "node",
      args: [serverPath],
      cwd: process.cwd(),
      dataPath,
    });
    const result = await client.checkCompatibility();

    if (options.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      const server = result.server
        ? `${result.server.name} ${result.server.version}`
        : "unknown server";
      console.log(`${server}: ${result.toolCount} tools`);
      console.log(
        result.missingRequiredTools.length === 0
          ? "All required tools are available."
          : `Missing required tools: ${result.missingRequiredTools.join(", ")}`,
      );
      if (result.incompatibleToolSchemas.length > 0) {
        console.log(`Incompatible tool input schemas: ${result.incompatibleToolSchemas
          .map(({ name, issues }) => `${name} (${issues.join("; ")})`)
          .join(", ")}`);
      }
      if (result.missingRequiredToolOutputSchemas.length > 0) {
        console.log(
          `Missing required tool output schemas: ${result.missingRequiredToolOutputSchemas.join(", ")}`,
        );
      }
      if (result.incompatibleToolOutputSchemas.length > 0) {
        console.log(`Incompatible tool output schemas: ${result.incompatibleToolOutputSchemas
          .map(({ name, issues }) => `${name} (${issues.join("; ")})`)
          .join(", ")}`);
      } else if (result.missingRequiredToolOutputSchemas.length === 0) {
        console.log("All required tool output schemas are compatible.");
      }
    }

    if (!result.compatible) process.exitCode = 1;
  });

await program.parseAsync();
