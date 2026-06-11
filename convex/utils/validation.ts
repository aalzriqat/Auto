import { ConvexError } from "convex/values";
import { z } from "zod";

/**
 * Validates data against a given Zod schema.
 * Throws a formatted ConvexError if validation fails, which can be
 * safely caught and displayed by the frontend.
 */
export function validateInput<T>(schema: z.ZodSchema<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    const errorMessage = result.error.errors
      .map((e) => `${e.path.join(".")}: ${e.message}`)
      .join(", ");
    throw new ConvexError(`Validation failed: ${errorMessage}`);
  }
  return result.data;
}
