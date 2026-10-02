import { runSourceSync as syncSource } from "../../src/application/source-sync";
import { runSourceTest as testSource } from "../../src/application/test-source";
import { runCli } from "../../src/cli";
import { createFixtureRecipeTransport } from "../e2e/support/fixture-recipe-transport";

const transport = createFixtureRecipeTransport();

await runCli(["bun", "mealplan", ...process.argv.slice(2)], {
  runSourceTest: (database, sourceId) => testSource(database, sourceId, {
    discoveryFetcher: transport,
    minimumSpacingMs: 0,
  }),
  runSourceSync: (database, input) => syncSource(database, input, {
    resourceFetcher: transport,
    minimumSpacingMs: 0,
    now: () => "2026-10-02T10:00:00.000Z",
  }),
});
