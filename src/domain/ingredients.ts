import type { RecipeIngredient } from "../infrastructure/recipe-repository";

export type MeasuredQuantity = { readonly quantity: number; readonly unit: "g" | "ml" | "stk" };

const UNITS: Readonly<Record<string, readonly [MeasuredQuantity["unit"], number]>> = {
  g: ["g", 1], gram: ["g", 1], grams: ["g", 1],
  kg: ["g", 1_000], kilogram: ["g", 1_000], kilograms: ["g", 1_000],
  ml: ["ml", 1], milliliter: ["ml", 1], milliliters: ["ml", 1], millilitre: ["ml", 1], millilitres: ["ml", 1],
  cl: ["ml", 10], dl: ["ml", 100],
  l: ["ml", 1_000], liter: ["ml", 1_000], liters: ["ml", 1_000], litre: ["ml", 1_000], litres: ["ml", 1_000],
  stk: ["stk", 1], piece: ["stk", 1], pieces: ["stk", 1], count: ["stk", 1],
};
const VULGAR_FRACTIONS: Readonly<Record<string, string>> = {
  "¼": "1/4", "½": "1/2", "¾": "3/4", "⅓": "1/3", "⅔": "2/3", "⅛": "1/8", "⅜": "3/8", "⅝": "5/8", "⅞": "7/8",
};
const MEASUREMENT = /^(\d+\s+\d+\/\d+|\d+\/\d+|\d+(?:[.,]\d+)?)\s*([a-z]+)(?:\.(?=\s|$))?(?:\s+(.*))?$/iu;

function parseMeasurement(text: string): (MeasuredQuantity & { name: string }) | null {
  const expanded = text.trim().replace(/([0-9]?)([¼½¾⅓⅔⅛⅜⅝⅞])/gu,
    (_match, whole: string, fraction: string) => `${whole}${whole === "" ? "" : " "}${VULGAR_FRACTIONS[fraction]}`);
  const match = MEASUREMENT.exec(expanded);
  if (match === null) return null;
  const conversion = UNITS[match[2]!.toLowerCase()];
  if (conversion === undefined) return null;
  const amountText = match[1]!;
  // A three-digit fractional group may be a thousands separator in the other locale.
  if (/^\d*[1-9]\d*[.,]\d{3}$/u.test(amountText)) return null;
  const fraction = /^(?:(\d+)\s+)?(\d+)\/(\d+)$/u.exec(amountText);
  const amount = fraction === null ? Number(amountText.replace(",", "."))
    : Number(fraction[1] ?? 0) + Number(fraction[2]) / Number(fraction[3]);
  const quantity = amount * conversion[1];
  if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 1_000_000_000) return null;
  return { quantity, unit: conversion[0], name: match[3] ?? "" };
}

/** Parse a complete measurement, not an ingredient or a package estimate. */
export function normalizeMeasuredQuantity(text: string): MeasuredQuantity | null {
  const measured = parseMeasurement(text);
  return measured !== null && measured.name === "" ? { quantity: measured.quantity, unit: measured.unit } : null;
}

/** Preserve source text verbatim; unsupported or ambiguous lines remain unknown. */
export function normalizeIngredient(rawText: string): RecipeIngredient {
  const unknown: RecipeIngredient = { rawText, normalizedName: null, quantity: null, unit: null, uncertain: true };
  const measured = parseMeasurement(rawText);
  if (measured === null) return unknown;
  const name = measured.name.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("da-DK");
  if (name.length === 0 || name.length > 300 || !/^[\p{L}][\p{L}\p{M} '\-]*$/u.test(name)) return unknown;
  if (/\b(?:ca|cirka|approx|approximately|about|roughly|omkring|pakke|pakker|package|packages|pack|packs|dåse|dåser|can|cans)\b/iu.test(name)
    || /\b(?:or|eller|to taste|efter smag)\b/iu.test(name)) return unknown;
  return { rawText, normalizedName: name, quantity: measured.quantity, unit: measured.unit, uncertain: false };
}
