export function shuffle<T extends {} | null>(
  items: readonly T[],
  pick = (bound: number) => Math.floor(Math.random() * bound),
) {
  const out = [...items];
  for (let index = out.length - 1; index > 0; index -= 1) {
    const swap = pick(index + 1);
    const value = out[index];
    const other = out[swap];
    if (value === undefined || other === undefined) continue;
    out[index] = other;
    out[swap] = value;
  }
  return out;
}
