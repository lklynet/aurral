import * as v from "valibot";

export const lenient = <Schema extends v.GenericSchema>(schema: Schema) =>
  v.fallback(v.optional(schema), undefined);

export const listOf = <Schema extends v.GenericSchema>(schema: Schema) =>
  v.pipe(
    v.array(v.unknown()),
    v.transform((items) =>
      items.flatMap((item) => {
        const result = v.safeParse(schema, item);
        return result.success ? [result.output] : [];
      }),
    ),
  );

export const recordOf = <Schema extends v.GenericSchema>(schema: Schema) =>
  v.pipe(
    v.record(v.string(), v.unknown()),
    v.transform((entries) =>
      Object.fromEntries(
        Object.entries(entries).flatMap(([key, value]) => {
          const result = v.safeParse(schema, value);
          return result.success ? [[key, result.output] as const] : [];
        }),
      ),
    ),
  );

export const orNull = <Schema extends v.GenericSchema>(schema: Schema) =>
  v.fallback(v.optional(v.nullable(schema), null), null);
