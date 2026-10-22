import { useQuery } from "@tanstack/react-query";
import { queryClient } from "../queryClient.ts";
import {
  getLibraryFileOperation,
  getLibraryFiles,
  getReadOnlyFolders,
} from "../utils/api/endpoints/library.ts";

export const ACTIVE_LIBRARY_FILE_STATUSES = new Set(["planning", "running"]);
const POLLING_STATUSES = new Set(["planning", "running"]);

export const libraryFilesQueryKey = ["library-files"];

export function useLibraryFiles({ enabled = true } = {}) {
  return useQuery({
    queryKey: libraryFilesQueryKey,
    queryFn: getLibraryFiles,
    enabled,
    staleTime: 0,
  });
}

export function useLibraryFileOperation(operationId) {
  return useQuery({
    queryKey: [...libraryFilesQueryKey, "operation", operationId],
    queryFn: () => getLibraryFileOperation(operationId).then((result) => result.operation),
    enabled: operationId != null,
    staleTime: 0,
    refetchInterval: (query) => (POLLING_STATUSES.has(query.state.data?.status) ? 1000 : false),
  });
}

export function useReadOnlyFolders() {
  return useQuery({
    queryKey: [...libraryFilesQueryKey, "read-only-folders"],
    queryFn: getReadOnlyFolders,
    staleTime: 0,
    refetchInterval: (query) => (query.state.data?.scanning ? 2000 : false),
  });
}

export function refreshLibraryFiles() {
  return queryClient.invalidateQueries({ queryKey: libraryFilesQueryKey });
}
