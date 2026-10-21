import { useRef, useCallback } from "react";

export function useDebouncedTask() {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const generationRef = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);

  const cancel = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    controllerRef.current?.abort();
    controllerRef.current = null;
    generationRef.current += 1;
  }, []);

  const schedule = useCallback(
    (task: (isCurrent: () => boolean, signal: AbortSignal) => void, delayMs: number) => {
      if (timerRef.current) clearTimeout(timerRef.current);
      controllerRef.current?.abort();
      const generation = generationRef.current + 1;
      generationRef.current = generation;
      const controller = new AbortController();
      controllerRef.current = controller;
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        task(
          () => generation === generationRef.current && !controller.signal.aborted,
          controller.signal,
        );
      }, delayMs);
    },
    [],
  );

  return { schedule, cancel };
}
