export const DIETARY_TAGS = [
  // Explicit review classification; does not certify any special diet.
  "unrestricted",
  "diabetic",
  "gluten-free",
  "halal",
  "hindu",
  "kosher",
  "low-calorie",
  "low-fat",
  "low-lactose",
  "low-salt",
  "vegan",
  "vegetarian",
] as const;

export type DietaryTag = (typeof DIETARY_TAGS)[number];
