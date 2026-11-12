import { useCallback, useEffect, useState } from "react";

export function useShelfScroll(itemCount: number) {
  const [node, setNode] = useState<HTMLDivElement | null>(null);
  const [edges, setEdges] = useState({ left: false, right: false });

  useEffect(() => {
    if (!node) return undefined;
    const update = () => {
      const max = Math.max(node.scrollWidth - node.clientWidth, 0);
      setEdges({ left: node.scrollLeft > 2, right: node.scrollLeft < max - 2 });
    };
    update();
    node.addEventListener("scroll", update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => {
      node.removeEventListener("scroll", update);
      observer.disconnect();
    };
  }, [node, itemCount]);

  const scrollBy = useCallback(
    (direction: -1 | 1) =>
      node?.scrollBy({
        left: direction * Math.max(node.clientWidth * 0.85, 280),
        behavior: "smooth",
      }),
    [node],
  );

  return {
    ref: setNode,
    canScrollLeft: edges.left,
    canScrollRight: edges.right,
    scrollBy,
  };
}
