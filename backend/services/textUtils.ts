export const stripTrailingSlashes = (value) => {
  const text = String(value ?? "");
  let end = text.length;
  while (end > 0 && text[end - 1] === "/") end -= 1;
  return text.slice(0, end);
};

export const stripTrailingSeparators = (value) => {
  const text = String(value ?? "");
  let end = text.length;
  while (end > 0 && (text[end - 1] === "/" || text[end - 1] === "\\")) end -= 1;
  return text.slice(0, end);
};

export const normalizeSeparators = (value) =>
  stripTrailingSlashes(String(value ?? "").replaceAll("\\", "/"));
