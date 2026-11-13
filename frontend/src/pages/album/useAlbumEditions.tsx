import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation, useSearchParams } from "react-router";
import { Select } from "../../components/Select";
import { useToast } from "../../contexts/ToastContext";
import { queryClient, queryKeys } from "../../queryClient.ts";
import { getReleaseGroupEditions } from "../../utils/api/endpoints/artists.ts";
import { setAlbumEdition } from "../../utils/api/endpoints/library.ts";
import { getApiErrorMessage } from "../../utils/api/errors.ts";

const NO_EDITIONS: never[] = [];

export function useAlbumEditions({
  releaseGroupMbid,
  libraryAlbumId,
  enabled,
  canChoose,
  onChosen,
}: {
  releaseGroupMbid: string | null;
  libraryAlbumId: string | number | null;
  enabled: boolean;
  canChoose: boolean;
  onChosen: () => Promise<unknown>;
}) {
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const { showError } = useToast();
  const [saving, setSaving] = useState(false);
  const { data } = useQuery({
    queryKey: [...queryKeys.releaseGroupEditions(releaseGroupMbid), libraryAlbumId],
    queryFn: ({ signal }) => getReleaseGroupEditions(releaseGroupMbid ?? "", { signal }),
    enabled: enabled && Boolean(releaseGroupMbid),
    staleTime: 5 * 60 * 1000,
  });
  const editions = data?.editions ?? NO_EDITIONS;
  const library = data?.library ?? null;
  const fallback = library ?? editions[0]?.id ?? null;
  const visible = editions.length > 1 && (libraryAlbumId == null || library != null);
  const requested = searchParams.get("edition");
  const viewing =
    (visible && editions.find((edition) => edition.id === requested)) ||
    editions.find((edition) => edition.id === fallback) ||
    null;
  const previewRelease = visible && viewing && viewing.id !== fallback ? viewing.id : undefined;
  const libraryEdition = editions.find((edition) => edition.id === library) ?? null;

  const view = (id: string | null) => {
    const state: unknown = location.state;
    setSearchParams(
      (params) => {
        const next = new URLSearchParams(params);
        if (id && id !== fallback) next.set("edition", id);
        else next.delete("edition");
        return next;
      },
      { replace: true, state },
    );
  };

  const adopt = async () => {
    if (saving || libraryAlbumId == null || !previewRelease) return;
    setSaving(true);
    try {
      await setAlbumEdition(libraryAlbumId, previewRelease);
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: queryKeys.releaseGroupEditions(releaseGroupMbid),
        }),
        queryClient.invalidateQueries({
          queryKey: queryKeys.releaseGroupTracks(releaseGroupMbid).slice(0, 3),
        }),
        onChosen(),
      ]);
      view(null);
    } catch (error) {
      showError(getApiErrorMessage(error, "Could not change the edition"));
    } finally {
      setSaving(false);
    }
  };

  const select =
    visible && viewing ? (
      <Select
        className="native-library-detail__edition"
        aria-label="Edition"
        value={viewing.id}
        onChange={view}
        options={editions.map((edition) => ({
          value: edition.id,
          label: edition.name,
          detail: (
            <>
              {[
                edition.date?.slice(0, 4),
                `${edition.trackCount} ${edition.trackCount === 1 ? "track" : "tracks"}`,
              ]
                .filter(Boolean)
                .join(" · ")}
              {edition.id === library ? (
                <>
                  {" · "}
                  <span className="native-library-detail__edition-owned">In Library</span>
                </>
              ) : null}
            </>
          ),
        }))}
      />
    ) : null;

  const note =
    libraryAlbumId != null && previewRelease && libraryEdition
      ? {
          name: libraryEdition.name,
          action: canChoose ? (
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => void adopt()}
              disabled={saving}
              aria-busy={saving}
            >
              Use this edition
            </button>
          ) : null,
        }
      : null;

  return { visible, viewing, previewRelease, select, note };
}
