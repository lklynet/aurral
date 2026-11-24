export const genreKey = (value: unknown) =>
  String(value || "")
    .toLowerCase()
    .replace(/[\s_-]+/g, "");
