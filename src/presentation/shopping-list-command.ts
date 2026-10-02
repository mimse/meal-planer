import type { Command } from "commander";
import { buildShoppingList, type ShoppingList } from "../application/build-shopping-list";
import { localDateInDenmark, resolvePlanWeekStart } from "../application/create-plan";
import { openExistingDatabase } from "../infrastructure/database";

const safeText = (value: string) => value.replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ");
const amount = (quantity: number, unit: string | null) => `${Number(quantity.toFixed(6))}${unit ? ` ${unit}` : ""}`;

export function renderShoppingList(list: ShoppingList): string {
  const lines = [`Shopping list for ${list.weekStart}`, `Saturday shopping: ${list.shoppingDate}`, ""];
  for (const group of list.groups) {
    lines.push(safeText(group.storeName));
    for (const item of group.items) {
      const name = item.normalizedIngredient ?? item.contributions[0]?.rawText ?? "Ingredient needing review";
      lines.push(`  ${safeText(name)}: ${item.purchaseQuantity === null ? "quantity needs review" : amount(item.purchaseQuantity, item.unit)}`);
      if (item.pantryDeduction > 0) lines.push(`    Pantry deduction: ${amount(item.pantryDeduction, item.unit)}`);
      if (item.preparedDeduction > 0) lines.push(`    Planned prep / leftover deduction: ${amount(item.preparedDeduction, item.unit)}`);
      if (item.match !== null) {
        const deal = item.match.deal;
        lines.push(`    Offer: ${safeText(deal.heading)} — ${deal.price === null ? "price unknown" : `${deal.price.toFixed(2)} ${safeText(deal.currency)}`}${deal.quantity === null ? "" : ` per ${amount(deal.quantity, deal.unit)}`}`);
        if (deal.pricePerUnit !== null) lines.push(`    Unit price: ${safeText(deal.pricePerUnit)}`);
        lines.push(`    Valid: ${deal.validFrom} through ${deal.validUntil}; confidence: ${deal.confidence}`);
        lines.push(`    Retrieved: ${deal.retrievedAt}`);
        if (item.pricing === "needs-confirmation") lines.push("    Needs confirmation; excluded from automatic price estimates");
      }
      if (item.package !== null) {
        lines.push(`    Buy ${item.package.packageCount} package(s): ${amount(item.package.purchasedQuantity, item.unit)}${item.estimatedCost === null ? "" : `; estimated ${item.estimatedCost.toFixed(2)} DKK`}`);
        lines.push(`    Final package remainder: ${amount(item.package.remainder, item.unit)}; storage life unverified`);
        for (const use of item.package.uses) {
          const consumer = list.meals.find(meal => meal.id === use.toMealId)!;
          const producer = list.meals.find(meal => meal.id === use.fromMealId)!;
          lines.push(`    Reused by ${consumer.day}: ${safeText(consumer.title)} — ${amount(use.quantity, use.unit)} from ${producer.day} package remainder`);
        }
      }
      for (const contribution of item.contributions) {
        lines.push(`    ${contribution.day}: ${safeText(contribution.recipeTitle)} — ${safeText(contribution.rawText)}${contribution.quantity === null ? " (unquantified)" : `; scaled ${amount(contribution.quantity, contribution.unit)}`}`);
        lines.push(`      ${safeText(contribution.sourceUrl)}`);
      }
      for (const warning of item.warnings) lines.push(`    Review: ${safeText(warning)}`);
    }
    lines.push("");
  }
  if (list.prepTransfers.length > 0) {
    lines.push("Planned prep / leftover transfers");
    for (const transfer of list.prepTransfers) {
      lines.push(`  ${transfer.direction}: ${amount(transfer.quantity, transfer.unit)} ${safeText(transfer.normalizedIngredient)} (${transfer.kind}, producer ${transfer.producerDate})`);
      lines.push(`    Reserved for ${transfer.targetDate}: ${safeText(transfer.targetRecipeTitle)}`);
      lines.push(`    ${safeText(transfer.targetSourceUrl)} — ${safeText(transfer.note)}`);
    }
    lines.push("");
  }
  lines.push(`Matched-offer subtotal: ${list.totals.matchedOfferSubtotal.toFixed(2)} DKK — not a checkout total`);
  lines.push(`${list.totals.pricedItemCount} priced item(s); ${list.totals.unpricedItemCount} unpriced item(s).`);
  return `${lines.join("\n")}\n`;
}

export function registerShoppingListCommand(program: Command, databasePath: () => string): void {
  program.command("shopping-list")
    .description("Rebuild groceries from the accepted seven meals, with fresh preferred-store offers")
    .option("--week <week>", "next or a date in the requested week", (value: string, previous: string[]) => [...previous, value], [])
    .option("--refresh-deals", "Fetch fresh offers (also the default; no stale deal cache is used)")
    .option("--no-deals", "Use the complete local list without contacting the provider")
    .option("--json", "Print structured groceries with provenance and warnings")
    .action(async (options: { week: string[]; refreshDeals?: boolean; deals?: boolean; json?: boolean }) => {
      if (options.week.length > 1) throw new Error("--week may be specified only once");
      if (options.refreshDeals && options.deals === false) throw new Error("--refresh-deals cannot be combined with --no-deals");
      const generatedAt = new Date().toISOString();
      const week = resolvePlanWeekStart(options.week[0], localDateInDenmark(new Date(generatedAt)));
      const database = openExistingDatabase(databasePath());
      try {
        const list = await buildShoppingList(database, { week, generatedAt, noDeals: options.deals === false });
        for (const warning of list.warnings) process.stderr.write(`Warning: ${safeText(warning)}\n`);
        process.stdout.write(options.json ? `${JSON.stringify(list, null, 2)}\n` : renderShoppingList(list));
      } finally { database.close(); }
    });
}
