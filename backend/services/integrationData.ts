import * as v from "valibot";
import { logger } from "./logger.ts";

type Source = { service: string; endpoint: string };

const unreadable = ({ service, endpoint }: Source, reason: string) =>
  new Error(`${service} sent ${endpoint.split("?")[0]} data Aurral can't read: ${reason}`);

export function readOne<Schema extends v.GenericSchema>(
  schema: Schema,
  data: unknown,
  source: Source,
): v.InferOutput<Schema> {
  const result = v.safeParse(schema, data);
  if (!result.success) throw unreadable(source, v.summarize(result.issues));
  return result.output;
}

export function readMany<Schema extends v.GenericSchema>(
  schema: Schema,
  data: unknown,
  source: Source,
): v.InferOutput<Schema>[] {
  if (!Array.isArray(data)) throw unreadable(source, "expected a list");
  const items: v.InferOutput<Schema>[] = [];
  let skipped = 0;
  let issue = "";
  for (const record of data) {
    const result = v.safeParse(schema, record);
    if (result.success) {
      items.push(result.output);
    } else {
      skipped += 1;
      issue ||= v.summarize(result.issues);
    }
  }
  if (skipped > 0) {
    logger.warn(
      source.service.toLowerCase(),
      `Skipped ${source.service} records Aurral can't read`,
      {
        endpoint: source.endpoint.split("?")[0],
        skipped,
        issue,
      },
    );
  }
  return items;
}
