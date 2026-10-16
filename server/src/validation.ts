import { z } from "zod";
import { AppError } from "./errors.js";
import type { MonitorInput, Rule } from "../../shared/types.js";

const selector = z.string().trim().min(1).max(2000);
export const ruleShape = {
  url: z
    .string()
    .trim()
    .max(4096)
    .refine((value) => {
      try {
        const url = new URL(value);
        return (
          ["http:", "https:"].includes(url.protocol) &&
          !url.username &&
          !url.password
        );
      } catch {
        return false;
      }
    }, "仅支持不含凭据的 HTTP(S) URL"),
  mode: z.enum(["TEXT", "LIST"]),
  selector,
  ignoreSelectors: z.array(selector).max(20).optional(),
  titleSelector: z
    .union([selector, z.literal("")])
    .transform((s) => s || undefined)
    .optional(),
  linkSelector: z
    .union([selector, z.literal("")])
    .transform((s) => s || undefined)
    .optional(),
};
const ruleSchema = z.strictObject(ruleShape);
const intervalSchema = z.number().int().min(1).max(1500);
const inputSchema = ruleSchema.extend({
  name: z.string().trim().min(1).max(120),
  intervalMinutes: intervalSchema.default(30),
  enabled: z.boolean().default(true),
});
// Creation defaults must not turn omitted PATCH fields into updates.
const patchSchema = inputSchema
  .extend({ intervalMinutes: intervalSchema, enabled: z.boolean() })
  .partial();

export function validateRule(input: unknown): Rule {
  const result = ruleSchema.safeParse(input);
  if (!result.success)
    throw new AppError(
      "VALIDATION_ERROR",
      result.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("；"),
      400,
    );
  return result.data;
}
export function validateInput(input: unknown): MonitorInput {
  const result = inputSchema.safeParse(input);
  if (!result.success)
    throw new AppError(
      "VALIDATION_ERROR",
      result.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("；"),
      400,
    );
  return result.data;
}
export function validatePatch(input: unknown): Partial<MonitorInput> {
  const result = patchSchema.safeParse(input);
  if (!result.success)
    throw new AppError(
      "VALIDATION_ERROR",
      "任务配置不合法，请检查字段和检查间隔。",
      400,
    );
  return result.data;
}
