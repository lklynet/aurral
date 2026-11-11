import * as v from "valibot";
import { json, jsonBody } from "./service.ts";

const schemas = v.array(
  v.looseObject({
    implementation: v.string(),
    fields: v.array(v.looseObject({ name: v.string(), value: v.optional(v.unknown()) })),
  }),
);

// Prowlarr and Lidarr describe each indexer and download client type as a form. This
// fills one in and saves it.
export async function addFromSchema(
  base: string,
  headers: Record<string, string>,
  kind: "indexer" | "downloadclient",
  implementation: string,
  entry: Record<string, unknown>,
  values: Record<string, unknown>,
) {
  const available = v.parse(schemas, await json(`${base}/${kind}/schema`, { headers }));
  const schema = available.find((candidate) => candidate.implementation === implementation);
  if (!schema) throw new Error(`${base} has no ${implementation} ${kind} type`);
  await json(
    `${base}/${kind}`,
    jsonBody(
      "POST",
      {
        ...schema,
        ...entry,
        fields: schema.fields.map((field) =>
          Object.hasOwn(values, field.name) ? { ...field, value: values[field.name] } : field,
        ),
      },
      headers,
    ),
  );
}
