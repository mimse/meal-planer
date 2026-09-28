export const DIETARY_TAGS = [
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
