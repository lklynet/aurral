export const stripTrailingSlashes = (value: unknown) => {
  const text = String(value ?? "");
  let end = text.length;
  while (end > 0 && text[end - 1] === "/") end -= 1;
  return text.slice(0, end);
};

export const stripTrailingSeparators = (value: unknown) => {
  const text = String(value ?? "");
  let end = text.length;
  while (end > 0 && (text[end - 1] === "/" || text[end - 1] === "\\")) end -= 1;
  return text.slice(0, end);
};

export const normalizeSeparators = (value: unknown) =>
  stripTrailingSlashes(String(value ?? "").replaceAll("\\", "/"));
