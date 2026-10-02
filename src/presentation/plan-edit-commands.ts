import * as clack from "@clack/prompts";
import type { Command } from "commander";
import { localDateInDenmark, resolvePlanWeekStart } from "../application/create-plan";
import { fetchPlanningDealInputs, type PlanningDealInputs } from "../application/planning-deals";
import { confirmPlanMealReplacement, previewPlanMealReplacement, type ReplacementCandidate } from "../application/replace-plan-meal";
import { readFamilyConfiguration } from "../commands/family";
import { readPantry } from "../commands/pantry";
import { DAYS, type Day } from "../domain/planner";
import { openExistingDatabase } from "../infrastructure/database";
import { createPlanRepository } from "../infrastructure/plan-repository";
import { createRecipeRepository } from "../infrastructure/recipe-repository";

const fullDays = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
type EditOptions = { week?: string; with?: string; recipe?: string; preview?: boolean; yes?: boolean; rejection?: string; json?: boolean; deals?: boolean };
function validate(day: string, options: EditOptions, command: Command): { day: Day; week: string; recipeId: string | undefined } {
  const index = fullDays.indexOf(day);
  const selected = index >= 0 ? DAYS[index]! : day;
  if (!DAYS.includes(selected as Day)) throw new Error("Invalid day: use mon/monday through sun/sunday");
  let root = command;
  while (root.parent) root = root.parent;
  const flags = new Set<string>();
  // Commander retains rawArgs at runtime, but omits it from its public type.
  for (const argument of (root as Command & { rawArgs: readonly string[] }).rawArgs) {
    const flag = argument.split("=")[0]!;
    if (!["--week", "--with", "--recipe", "--preview", "--yes", "--rejection", "--json", "--no-deals"].includes(flag)) continue;
    if (flags.has(flag)) throw new Error(`Duplicate option: ${flag}`);
    flags.add(flag);
  }
  if (options.with !== undefined && options.recipe !== undefined) throw new Error("Use only one of --with or --recipe");
  const recipeId = options.with ?? options.recipe;
  if (recipeId !== undefined && !/^recipe:[a-f0-9]{64}$/.test(recipeId)) throw new Error("Invalid recipe id: expected recipe: followed by 64 lowercase hex characters");
  if (options.rejection !== undefined && !["not-this-week", "disliked", "none"].includes(options.rejection)) throw new Error("Invalid rejection: use not-this-week, disliked, or none");
  if (options.preview && options.yes) throw new Error("--preview and --yes cannot be combined");
  return { day: selected as Day, week: resolvePlanWeekStart(options.week, localDateInDenmark()), recipeId };
}
function printCandidate(candidate: ReplacementCandidate): void {
  console.log(`\n${candidate.title} [${candidate.recipeId}]`);
  console.log("Ingredient changes:");
  for (const [sign, ingredients] of [["+", candidate.ingredientDelta.additions], ["-", candidate.ingredientDelta.removals]] as const) {
    for (const ingredient of ingredients) console.log(`  ${sign} ${ingredient.quantity} ${ingredient.unit} ${ingredient.normalizedIngredient}`);
  }
  if (!candidate.ingredientDelta.additions.length && !candidate.ingredientDelta.removals.length) console.log("  No quantified changes");
  console.log(`Deal changes: +${candidate.dealDelta.additions.length} / -${candidate.dealDelta.removals.length}; coverage delta ${candidate.dealDelta.value} (not monetary savings)`);
  console.log(`Waste delta: ${candidate.scoreDelta.wastePenalty}; package remainder penalty: ${candidate.scoreDelta.remainderPenalty}; one-off penalty: ${candidate.scoreDelta.oneOffPenalty}; reuse credit: ${candidate.scoreDelta.reuseCredit}`);
  for (const warning of candidate.ingredientDelta.warnings) console.log(`Warning: ${warning}`);
}

/** Register on the existing plan command; importing this module has no I/O. */
export function registerPlanEditCommands(plan: Command, databasePath: () => string): void {
  plan.command("replace")
    .description("Preview or atomically replace one saved meal, preserving the other six")
    .argument("<day>", "mon/monday through sun/sunday")
    .option("--week <date>", "week containing YYYY-MM-DD, or next")
    .option("--with <recipe-id>", "replacement recipe id")
    .option("--recipe <recipe-id>", "alias for --with")
    .option("--preview", "read-only preview")
    .option("--yes", "explicitly confirm the selected recipe")
    .option("--rejection <choice>", "not-this-week, disliked, or none")
    .option("--json", "emit ReplacementPreview (or saved WeeklyPlan with --yes)")
    .option("--no-deals", "skip live offers and package estimates")
    .action(async (day: string, options: EditOptions, command: Command) => {
      const parsed = validate(day, options, command);
      if (options.yes && parsed.recipeId === undefined) throw new Error("--yes requires --with or --recipe to identify a candidate");
      const database = openExistingDatabase(databasePath());
      try {
        const saved = createPlanRepository(database).getForWeek(parsed.week);
        if (saved === null) throw new Error(`No saved plan for week ${parsed.week}`);
        let inputs: PlanningDealInputs;
        if (options.deals === false) {
          inputs = { dealSignals: [], packageEstimates: [], warnings: ["Offline (--no-deals): live deal and package inputs omitted; price and package-waste estimates are incomplete"] };
        } else {
          try {
            inputs = await fetchPlanningDealInputs({ recipes: createRecipeRepository(database).list({ limit: 500 }), preferredStores: readFamilyConfiguration(database).preferredStores, pantry: readPantry(database), shoppingDate: saved.shoppingDate });
          } catch (error) {
            inputs = { dealSignals: [], packageEstimates: [], warnings: [`Replacement continues without deals: ${error instanceof Error ? error.message.slice(0, 300) : "provider unavailable"}`] };
          }
        }
        const preview = previewPlanMealReplacement(database, { planId: saved.id, day: parsed.day, dealSignals: inputs.dealSignals, packageEstimates: inputs.packageEstimates, warnings: inputs.warnings });
        for (const warning of inputs.warnings) console.error(`Warning: ${warning}`);
        if (parsed.recipeId !== undefined && !preview.candidates.some(candidate => candidate.recipeId === parsed.recipeId)) {
          const blocked = preview.blockedCandidates.find(candidate => candidate.recipeId === parsed.recipeId);
          throw new Error(`Replacement candidate is not eligible${blocked ? `: ${blocked.reasons.join("; ")}` : " (missing, assigned, disliked, or rejected for this week)"}`);
        }
        const interactive = !options.json && !options.preview && !options.yes && process.stdin.isTTY && process.stdout.isTTY;
        let selectedId = parsed.recipeId;
        let rejection = (options.rejection ?? "not-this-week") as "not-this-week" | "disliked" | "none";
        let confirmed = Boolean(options.yes);
        if (interactive && preview.candidates.length > 0) {
          const cancel = () => console.log("Cancelled; no changes saved.");
          if (selectedId === undefined) {
            const choice = await clack.select({ message: "Choose replacement", options: preview.candidates.map(candidate => ({ value: candidate.recipeId, label: candidate.title, hint: `waste delta ${candidate.scoreDelta.wastePenalty}` })) });
            if (clack.isCancel(choice)) { cancel(); return; }
            selectedId = choice;
          }
          printCandidate(preview.candidates.find(candidate => candidate.recipeId === selectedId)!);
          if (options.rejection === undefined) {
            const choice = await clack.select({ message: "Rejected meal: how should the original recipe be recorded?", initialValue: "not-this-week" as const, options: [
              { value: "not-this-week" as const, label: "Not this week", hint: "exclude only for this week" },
              { value: "disliked" as const, label: "Disliked", hint: "persistent preference; excludes future plans" },
              { value: "none" as const, label: "No rejection", hint: "keep eligible for later replacements" },
            ] });
            if (clack.isCancel(choice)) { cancel(); return; }
            rejection = choice;
          }
          const choice = await clack.confirm({ message: `Confirm replacement for ${parsed.day}?`, initialValue: false });
          if (clack.isCancel(choice) || !choice) { cancel(); return; }
          confirmed = true;
        }
        if (confirmed) {
          const selected = preview.candidates.find(candidate => candidate.recipeId === selectedId)!;
          if (!options.json && !interactive) printCandidate(selected);
          const result = confirmPlanMealReplacement(database, preview, { recipeId: selected.recipeId, rejection, recordedAt: new Date().toISOString() });
          const readBack = createPlanRepository(database).get(result.id);
          if (JSON.stringify(readBack) !== JSON.stringify(result)) throw new Error("Saved plan read-back verification failed");
          if (options.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
          else console.log(`Saved replacement for ${parsed.day}; other six meals unchanged.`);
          return;
        }
        if (options.json) process.stdout.write(`${JSON.stringify(preview, null, 2)}\n`);
        else {
          console.log(`Replacement preview for ${parsed.day}, week ${saved.weekStart}`);
          for (const candidate of preview.candidates.filter(candidate => parsed.recipeId === undefined || candidate.recipeId === parsed.recipeId)) printCandidate(candidate);
          if (!preview.candidates.length) console.log("No eligible candidates");
          console.log("Preview only; no changes saved. Use --with <recipe-id> --yes to confirm.");
        }
      } finally { database.close(); }
    });
  for (const operation of ["lock", "unlock"] as const) {
    plan.command(operation)
      .description(`${operation === "lock" ? "Lock" : "Unlock"} one saved meal using its current content hash`)
      .argument("<day>", "mon/monday through sun/sunday")
      .option("--week <date>", "week containing YYYY-MM-DD, or next")
      .option("--json", "emit the saved WeeklyPlan")
      .action((day: string, options: EditOptions, command: Command) => {
        const parsed = validate(day, options, command);
        const database = openExistingDatabase(databasePath());
        try {
          const repository = createPlanRepository(database);
          const current = repository.getForWeek(parsed.week);
          if (current === null) throw new Error(`No saved plan for week ${parsed.week}`);
          const target = current.meals.find(meal => meal.day === parsed.day)!;
          const saved = repository[operation](current.id, parsed.day, target.contentHash);
          if (JSON.stringify(repository.get(saved.id)) !== JSON.stringify(saved)) throw new Error("Saved plan read-back verification failed");
          if (options.json) process.stdout.write(`${JSON.stringify(saved, null, 2)}\n`);
          else console.log(`${operation === "lock" ? "Locked" : "Unlocked"} ${parsed.day}, week ${saved.weekStart}.`);
        } finally { database.close(); }
      });
  }
}
