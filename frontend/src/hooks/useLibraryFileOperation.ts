import { useQuery } from "@tanstack/react-query";
import { parseResponse } from "hono/client";
import { queryClient } from "../queryClient.ts";
import { libraryFilesClient } from "../utils/api/clients/libraryFiles.ts";

export const ACTIVE_LIBRARY_FILE_STATUSES = new Set(["planning", "running"]);
const POLLING_STATUSES = new Set<string | undefined>(["planning", "running"]);

export const libraryFilesQueryKey = ["library-files"];

export function useLibraryFiles({ enabled = true } = {}) {
  return useQuery({
    queryKey: libraryFilesQueryKey,
    queryFn: () => parseResponse(libraryFilesClient.files.$get()),
    enabled,
    staleTime: 0,
  });
}

export function useLibraryFileOperation(operationId: number | null | undefined) {
  return useQuery({
    queryKey: [...libraryFilesQueryKey, "operation", operationId],
    queryFn: () =>
      parseResponse(
        libraryFilesClient.files.operations[":id"].$get({
          param: { id: encodeURIComponent(operationId!) },
        }),
      ).then((result) => result.operation),
    enabled: operationId != null,
    staleTime: 0,
    refetchInterval: (query) => (POLLING_STATUSES.has(query.state.data?.status) ? 1000 : false),
  });
}

export function useReadOnlyFolders() {
  return useQuery({
    queryKey: [...libraryFilesQueryKey, "read-only-folders"],
    queryFn: () => parseResponse(libraryFilesClient.files["read-only-folders"].$get()),
    staleTime: 0,
    refetchInterval: (query) => (query.state.data?.scanning ? 2000 : false),
  });
}

export function refreshLibraryFiles() {
  return queryClient.invalidateQueries({ queryKey: libraryFilesQueryKey });
}
