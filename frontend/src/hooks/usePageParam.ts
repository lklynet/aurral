import { useCallback, useEffect } from "react";
import { useLocation, useSearchParams } from "react-router";

export function usePageParam() {
  const [searchParams, setSearchParams] = useSearchParams();
  const state: unknown = useLocation().state;
  const requested = Number(searchParams.get("page"));
  const page = Number.isSafeInteger(requested) && requested > 1 ? requested : 1;

  const setPage = useCallback(
    (next: number, { replace = false } = {}) =>
      setSearchParams(
        (current) => {
          const params = new URLSearchParams(current);
          if (next > 1) params.set("page", String(next));
          else params.delete("page");
          return params;
        },
        { replace, state },
      ),
    [setSearchParams, state],
  );

  return [page, setPage] as const;
}

export function useClampPage(
  page: number,
  lastPage: number | undefined,
  setPage: ReturnType<typeof usePageParam>[1],
) {
  useEffect(() => {
    if (lastPage !== undefined && page > lastPage) setPage(lastPage, { replace: true });
  }, [lastPage, page, setPage]);
}
