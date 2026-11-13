export function reorderInPlace<T>(items: T[], keyOf: (item: T) => string, order: string[]) {
  const rank = new Map(order.map((key, index) => [key, index]));
  const moved = items
    .filter((item) => rank.has(keyOf(item)))
    .sort((left, right) => rank.get(keyOf(left))! - rank.get(keyOf(right))!);
  let next = 0;
  return items.map((item) => (rank.has(keyOf(item)) ? moved[next++]! : item));
}
