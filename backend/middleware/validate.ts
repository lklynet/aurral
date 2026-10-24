import { sValidator } from "@hono/standard-validator";
import type { ValidationTargets } from "hono";

export const validate = <
  Target extends keyof ValidationTargets,
  Schema extends Parameters<typeof sValidator>[1],
>(
  target: Target,
  schema: Schema,
) =>
  sValidator(target, schema, (result, c) => {
    if (!result.success) {
      const message = result.error.map((issue) => issue.message).join("; ");
      return c.json({ error: "Invalid request", message }, 400);
    }
  });
