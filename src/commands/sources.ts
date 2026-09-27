import type { Database } from "bun:sqlite";
import { z } from "zod";
import { RECIPE_SOURCE_ADAPTERS } from "../domain/configuration";
import {
  createConfigurationRepositories,
  type RecipeSource,
} from "../infrastructure/configuration-repositories";


const identifierSchema = z.string().trim().min(1).max(100).regex(/^[a-z0-9][a-z0-9_-]*$/i);
const nameSchema = z.string().trim().min(1).max(200);
const adapterSchema = z.enum(RECIPE_SOURCE_ADAPTERS);
const baseUrlSchema = z.string().trim().min(1).max(2_048).url().transform((value, context) => {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    context.addIssue({ code: "custom", message: "Recipe source URL must use HTTP or HTTPS" });
    return z.NEVER;
  }
  if (url.username !== "" || url.password !== "") {
    context.addIssue({ code: "custom", message: "Recipe source URL must not contain credentials" });
    return z.NEVER;
  }
  url.hash = "";
  return url.href;
});

const sourceAddSchema = z.object({
  baseUrl: baseUrlSchema,
  id: identifierSchema.optional(),
  name: nameSchema.optional(),
  adapter: adapterSchema.default("auto"),
}).strict();

function sourceIdFromUrl(url: URL): string {
  const raw = `${url.hostname.replace(/^www\./i, "")}${url.pathname === "/" ? "" : `-${url.pathname}`}`;
  const id = raw.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 100).replace(/-$/g, "");
  return identifierSchema.parse(id);
}

export function createRecipeSource(input: unknown): RecipeSource {
  const parsed = sourceAddSchema.parse(input);
  const url = new URL(parsed.baseUrl);
  return {
    id: parsed.id ?? sourceIdFromUrl(url),
    name: parsed.name ?? url.hostname.replace(/^www\./i, ""),
    baseUrl: parsed.baseUrl,
    adapter: parsed.adapter,
    enabled: true,
  };
}

export function readRecipeSources(database: Database): RecipeSource[] {
  return createConfigurationRepositories(database).recipeSources.list().map((source) => ({
    id: source.id,
    name: source.name,
    baseUrl: source.baseUrl,
    adapter: source.adapter,
    enabled: source.enabled,
  }));
}

export function addRecipeSource(database: Database, input: RecipeSource): RecipeSource {
  const source = createRecipeSource({
    baseUrl: input.baseUrl,
    id: input.id,
    name: input.name,
    adapter: input.adapter,
  });
  const sources = createConfigurationRepositories(database).recipeSources;
  return database.transaction(() => {
    if (sources.get(source.id) !== null) {
      throw new Error(`Recipe source id already exists: ${source.id}`);
    }
    const conflictingUrl = sources.list().find(({ baseUrl }) => baseUrl === source.baseUrl);
    if (conflictingUrl !== undefined) {
      throw new Error(`Recipe source URL already exists as ${conflictingUrl.id}: ${source.baseUrl}`);
    }
    return sources.upsert(source);
  }).immediate();
}

export function validateRecipeSourceId(input: unknown): string {
  return identifierSchema.parse(input);
}

export function setRecipeSourceEnabled(database: Database, input: unknown, enabled: boolean): RecipeSource {
  const id = validateRecipeSourceId(input);
  const sources = createConfigurationRepositories(database).recipeSources;
  return database.transaction(() => {
    const source = sources.get(id);
    if (source === null) throw new Error(`Recipe source does not exist: ${id}`);
    return sources.upsert({ ...source, enabled });
  }).immediate();
}

export function removeRecipeSource(database: Database, input: unknown): void {
  const id = validateRecipeSourceId(input);
  const sources = createConfigurationRepositories(database).recipeSources;
  database.transaction(() => {
    if (sources.get(id) === null) throw new Error(`Recipe source does not exist: ${id}`);
    const referencedRecipes = database.query<{ count: number }, [string]>(
      "SELECT COUNT(*) AS count FROM recipes WHERE source_id = ?",
    ).get(id)?.count ?? 0;
    if (referencedRecipes > 0) {
      throw new Error(
        `Cannot remove recipe source ${id} while ${referencedRecipes} imported recipe${referencedRecipes === 1 ? "" : "s"} references it; disable it instead`,
      );
    }
    sources.remove(id);
  }).immediate();
}
