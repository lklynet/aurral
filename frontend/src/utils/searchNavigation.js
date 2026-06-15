export function getSearchResultLabel(item) {
  if (!item) return "";
  if (item.type === "artist") return item.name || "";
  if (item.type === "playlist") return item.name || "";
  if (item.type === "album") {
    const title = item.title || "";
    const artist = item.artistName || "";
    return artist ? `${title} — ${artist}` : title;
  }
  if (item.type === "track") {
    const title = item.title || "";
    const artist = item.artistName || "";
    return artist ? `${title} — ${artist}` : title;
  }
  return "";
}

export function getSearchResultKey(item, index = 0) {
  if (!item) return `search-item-${index}`;
  return (
    item.key ||
    item.id ||
    `${item.type}:${getSearchResultLabel(item).toLowerCase()}:${index}`
  );
}

export function buildArtistFocusState(item, overrides = {}) {
  const state = { ...overrides };
  if (item?.artistName) state.artistName = item.artistName;
  if (typeof item?.inLibrary === "boolean") state.inLibrary = item.inLibrary;
  return state;
}

function buildReleaseFocusState(item, releaseGroupMbid) {
  const releaseTitle = item?.type === "album" ? item.title : item?.albumTitle;
  const releaseDate =
    item?.releaseDate ||
    item?.firstReleaseDate ||
    (item?.releaseYear ? String(item.releaseYear) : "");
  return {
    id: releaseGroupMbid,
    title: releaseTitle || "",
    firstReleaseDate: releaseDate || "",
    primaryType: item?.primaryType || item?.releaseType || "Album",
    secondaryTypes: Array.isArray(item?.secondaryTypes)
      ? item.secondaryTypes
      : [],
    coverUrl: item?.coverUrl || item?.imageUrl || item?.image || "",
    deezerAlbumId: item?._deezerAlbumId || item?.deezerAlbumId || "",
    rating: item?.rating || null,
  };
}

export function buildReleaseGroupNavigationItem(
  releaseGroup,
  { artistMbid, artistName, coverUrl = "" } = {},
) {
  if (!releaseGroup?.id || !artistMbid) return null;
  return {
    type: "album",
    id: releaseGroup.id,
    title: releaseGroup.title || "",
    artistMbid,
    artistName: artistName || "",
    releaseDate: releaseGroup["first-release-date"] || "",
    primaryType: releaseGroup["primary-type"] || "Album",
    secondaryTypes: Array.isArray(releaseGroup["secondary-types"])
      ? releaseGroup["secondary-types"]
      : [],
    coverUrl: coverUrl || releaseGroup._coverUrl || releaseGroup.coverUrl || "",
    deezerAlbumId: releaseGroup._deezerAlbumId || "",
    rating: releaseGroup.rating || null,
  };
}

export function buildLibraryAlbumNavigationItem(
  libraryAlbum,
  { artistMbid, artistName, coverUrl = "" } = {},
) {
  const releaseGroupMbid =
    libraryAlbum?.mbid || libraryAlbum?.foreignAlbumId || null;
  if (!releaseGroupMbid || !artistMbid) return null;
  return {
    type: "album",
    id: releaseGroupMbid,
    title: libraryAlbum.albumName || "",
    artistMbid,
    artistName: artistName || libraryAlbum.artistName || "",
    releaseDate: libraryAlbum.releaseDate || "",
    primaryType: libraryAlbum.albumType || "Album",
    coverUrl,
  };
}

export function navigateToReleaseGroup(
  navigate,
  releaseGroup,
  { artistMbid, artistName, coverUrl = "" } = {},
) {
  const target = getReleaseNavigationTarget(
    buildReleaseGroupNavigationItem(releaseGroup, {
      artistMbid,
      artistName,
      coverUrl,
    }),
  );
  if (!target) return false;
  navigate(target.pathname, { state: target.state });
  return true;
}

export function navigateToLibraryAlbum(
  navigate,
  libraryAlbum,
  { artistMbid, artistName, coverUrl = "" } = {},
) {
  const target = getReleaseNavigationTarget(
    buildLibraryAlbumNavigationItem(libraryAlbum, {
      artistMbid,
      artistName,
      coverUrl,
    }),
  );
  if (!target) return false;
  navigate(target.pathname, { state: target.state });
  return true;
}

export function getReleaseNavigationTarget(item) {
  if (!item?.artistMbid) return null;
  const releaseGroupMbid = item.type === "album" ? item.id : item.albumMbid;
  if (!releaseGroupMbid) return null;
  const state = buildArtistFocusState(item, {
    focusReleaseGroupMbid: releaseGroupMbid,
    focusReleaseGroup: buildReleaseFocusState(item, releaseGroupMbid),
  });
  if (item.type === "track") {
    const trackMbid = item.id || item.trackMbid;
    if (trackMbid) state.focusTrackMbid = trackMbid;
    if (item.title) state.focusTrackTitle = item.title;
  }
  return {
    pathname: `/artist/${item.artistMbid}/release/${releaseGroupMbid}`,
    state,
  };
}

export function navigateFromSearchResult(
  navigate,
  item,
  { query = "" } = {},
) {
  if (!item || typeof navigate !== "function") return;

  if (item.type === "artist") {
    if (item.id) {
      navigate(`/artist/${item.id}`, {
        state: buildArtistFocusState(item),
      });
      return;
    }
    navigate(`/search?q=${encodeURIComponent(item.name || query)}&filter=artists`);
    return;
  }

  if (item.type === "album") {
    const target = getReleaseNavigationTarget(item);
    if (target) {
      navigate(target.pathname, { state: target.state });
      return;
    }
    navigate(
      `/search?q=${encodeURIComponent(item.title || query)}&filter=albums`,
    );
    return;
  }

  if (item.type === "track") {
    if (item.source === "library" && item.streamPath && !item.albumMbid) {
      navigate("/library");
      return;
    }
    const target = getReleaseNavigationTarget(item);
    if (target) {
      navigate(target.pathname, { state: target.state });
      return;
    }
    if (item.artistMbid) {
      navigate(`/artist/${item.artistMbid}`, {
        state: buildArtistFocusState(item),
      });
      return;
    }
    navigate(
      `/search?q=${encodeURIComponent(
        [item.artistName, item.title].filter(Boolean).join(" ") || query,
      )}&filter=tracks`,
    );
    return;
  }

  if (item.type === "playlist" && item.id) {
    if (item.discoverPresetId && item.source === "discover") {
      navigate("/discover");
      return;
    }
    if (item.sourceFlowId) {
      navigate("/flows", { state: { selectedFlowId: item.sourceFlowId } });
      return;
    }
    navigate("/playlists", { state: { selectedPlaylistId: item.id } });
  }
}

function normalizeSearchText(value) {
  return String(value || "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function applyLibraryFlags(item, libraryFlags = {}) {
  if (!item || item.inLibrary) return item;
  const artistIds = libraryFlags.artistIds;
  const albumIds = libraryFlags.albumIds;
  if (item.type === "artist" && item.id && artistIds?.has(item.id)) {
    return { ...item, inLibrary: true };
  }
  if (item.type === "album" && item.id && albumIds?.has(item.id)) {
    return { ...item, inLibrary: true };
  }
  if (
    item.type === "track" &&
    item.albumMbid &&
    albumIds?.has(item.albumMbid)
  ) {
    return { ...item, inLibrary: true };
  }
  return item;
}

function prepareSearchCandidates(items, libraryFlags) {
  return items
    .filter(Boolean)
    .map((item) => applyLibraryFlags(item, libraryFlags));
}

function getResultIdentity(item) {
  if (!item) return null;
  if (item.id) return `${item.type}:${item.id}`;
  if (item.key) return String(item.key);
  return null;
}

function dedupeItems(items, seen, seenArtistNames = null) {
  const unique = [];
  for (const item of items) {
    if (item.type === "artist" && seenArtistNames) {
      const nameKey = normalizeSearchText(item.name);
      if (nameKey) {
        if (seenArtistNames.has(nameKey)) continue;
        seenArtistNames.add(nameKey);
      }
    }
    const identity = getResultIdentity(item);
    if (identity) {
      if (seen.has(identity)) continue;
      seen.add(identity);
    }
    unique.push(item);
  }
  return unique;
}

export function dedupeArtistsByName(artists) {
  const seen = new Set();
  const result = [];
  for (const artist of artists) {
    const key = normalizeSearchText(artist?.name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(artist);
  }
  return result;
}

function findArtistMatch(artists, { id, name }) {
  if (id) {
    const byId = artists.find(
      (artist) => artist?.id === id || artist?.key === id,
    );
    if (byId) return byId;
  }
  if (name) {
    const normalizedName = normalizeSearchText(name);
    return artists.find(
      (artist) => normalizeSearchText(artist?.name) === normalizedName,
    );
  }
  return null;
}

function compactSearchText(value) {
  return normalizeSearchText(value).replace(/\s+/g, "");
}

function queryMatchesArtistName(query, artistName) {
  const normalizedQuery = normalizeSearchText(query);
  const normalizedName = normalizeSearchText(artistName);
  if (!normalizedQuery || !normalizedName) return false;
  if (normalizedQuery === normalizedName) return true;
  return compactSearchText(normalizedQuery) === compactSearchText(normalizedName);
}

function findQueryArtist(allArtists, query) {
  const exact = findArtistMatch(allArtists, { name: query });
  if (exact) return exact;

  const compactQuery = compactSearchText(query);
  if (!compactQuery) return null;
  return (
    allArtists.find(
      (artist) => compactSearchText(artist?.name) === compactQuery,
    ) || null
  );
}

function artistFromAlbumTop(album) {
  if (!album?.artistName) return null;
  return {
    type: "artist",
    source: album.source,
    id: album.artistMbid || null,
    key: album.artistMbid || album.artistName,
    name: album.artistName,
    sortName: album.artistName,
    inLibrary: Boolean(album.inLibrary),
    hasMbid: Boolean(album.artistMbid),
    score: album.score,
  };
}

function artistFromPerformerFields(item) {
  if (!item?.artistName && !item?.artistMbid) return null;
  return {
    type: "artist",
    id: item.artistMbid || null,
    key: item.artistMbid || item.artistName,
    name: item.artistName,
    sortName: item.artistName,
    inLibrary: Boolean(item.artistInLibrary || item.inLibrary),
    score: item.score,
  };
}

export function resolveSearchTopResult(data, libraryFlags = {}) {
  if (!data) return null;

  const query = String(data.query || "").trim();
  const top = data.top;
  const catalogArtists = data.catalog?.artists || [];
  const queryArtist = findQueryArtist(catalogArtists, query);

  if (top?.type === "artist" && top.name) {
    return prepareSearchCandidates([top], libraryFlags)[0];
  }

  if (top?.type === "album" && queryMatchesArtistName(query, top.artistName)) {
    const artist =
      findArtistMatch(catalogArtists, {
        id: top.artistMbid,
        name: top.artistName,
      }) || artistFromAlbumTop(top);
    if (artist?.name) {
      return prepareSearchCandidates([artist], libraryFlags)[0];
    }
  }

  if (
    queryArtist &&
    (top?.type === "album" || top?.type === "track" || !top)
  ) {
    return prepareSearchCandidates([queryArtist], libraryFlags)[0];
  }

  if (top?.type && (top.name || top.title)) {
    return prepareSearchCandidates([top], libraryFlags)[0];
  }

  const fallback =
    queryArtist ||
    catalogArtists[0] ||
    data.catalog?.albums?.[0] ||
    data.catalog?.tracks?.[0];
  if (!fallback) return null;
  return prepareSearchCandidates([fallback], libraryFlags)[0];
}

export function resolveSearchTopArtist(data, libraryFlags = {}) {
  const top = resolveSearchTopResult(data, libraryFlags);
  if (!top) return null;
  if (top.type === "artist") return top;

  const catalogArtists = data.catalog?.artists || [];
  const matched =
    findArtistMatch(catalogArtists, {
      id: top.artistMbid,
      name: top.artistName,
    }) || artistFromPerformerFields(top);
  if (matched?.name) {
    return prepareSearchCandidates([matched], libraryFlags)[0];
  }

  return catalogArtists[0] || null;
}

export function buildSearchArtistResults(data, libraryFlags = {}) {
  if (!data) return [];

  const candidates = [...(data.catalog?.artists || [])];
  const topArtist = resolveSearchTopArtist(data, libraryFlags);
  if (topArtist?.name) {
    const topId = topArtist.id || topArtist.mbid;
    const alreadyListed =
      topId &&
      candidates.some((artist) => (artist?.id || artist?.mbid) === topId);
    if (!alreadyListed) {
      candidates.push(topArtist);
    }
  }

  return dedupeArtistsByName(
    prepareSearchCandidates(candidates, libraryFlags).filter(
      (artist) => artist?.id || artist?.mbid || artist?.foreignArtistId,
    ),
  );
}

function getSearchResultBuckets(data) {
  return [
    ...(data.catalog?.artists || []),
    ...(data.catalog?.albums || []),
    ...(data.catalog?.tracks || []),
  ];
}

export function buildMixedSearchPageItems(
  data,
  { limit = 24, excludeArtist = null, excludeItem = null, libraryFlags = {} } = {},
) {
  if (!data) return [];

  const excluded = excludeItem || excludeArtist;
  const excludeName = excluded?.type === "artist"
    ? normalizeSearchText(excluded.name)
    : "";
  const excludeId = excluded?.id || null;
  const excludeIdentity = getResultIdentity(excluded);

  const candidates = prepareSearchCandidates(
    getSearchResultBuckets(data),
    libraryFlags,
  ).filter((item) => {
    if (!excluded) return true;
    if (excludeIdentity && getResultIdentity(item) === excludeIdentity) {
      return false;
    }
    if (excludeId && item.id === excludeId && item.type === excluded.type) {
      return false;
    }
    if (item.type !== "artist") return true;
    if (excludeName && normalizeSearchText(item.name) === excludeName) {
      return false;
    }
    return true;
  });

  const seen = new Set();
  const seenArtistNames = new Set();
  if (excludeName) seenArtistNames.add(excludeName);
  return dedupeItems(candidates, seen, seenArtistNames).slice(0, limit);
}

export function buildMixedSuggestionItems(data, limit = 8, libraryFlags = {}) {
  if (!data) return [];

  const seen = new Set();
  const seenArtistNames = new Set();
  const result = [];

  const topItem = data.top
    ? prepareSearchCandidates([data.top], libraryFlags)[0]
    : null;
  if (topItem) {
    result.push(topItem);
    const identity = getResultIdentity(topItem);
    if (identity) seen.add(identity);
    if (topItem.type === "artist") {
      const nameKey = normalizeSearchText(topItem.name);
      if (nameKey) seenArtistNames.add(nameKey);
    }
  }

  const candidates = prepareSearchCandidates(
    getSearchResultBuckets(data),
    libraryFlags,
  );
  for (const item of dedupeItems(candidates, seen, seenArtistNames)) {
    if (result.length >= limit) break;
    result.push(item);
  }
  return result.slice(0, limit);
}

export function buildUnifiedSuggestionSections(data) {
  if (!data) return [];

  const seen = new Set();
  const seenArtistNames = new Set();
  const sections = [];

  if (data.top) {
    const identity = getResultIdentity(data.top);
    if (identity) seen.add(identity);
    if (data.top.type === "artist") {
      const nameKey = normalizeSearchText(data.top.name);
      if (nameKey) seenArtistNames.add(nameKey);
    }
    sections.push({ key: "top", label: "Top result", items: [data.top] });
  }

  const libraryItems = dedupeItems(
    data.library?.tracks || [],
    seen,
    seenArtistNames,
  );
  if (libraryItems.length > 0) {
    sections.push({
      key: "library",
      label: "Your Library",
      items: libraryItems,
    });
  }

  const artists = dedupeItems(
    data.catalog?.artists || [],
    seen,
    seenArtistNames,
  );
  if (artists.length > 0) {
    sections.push({
      key: "artists",
      label: "Artists",
      items: artists,
    });
  }

  const albums = dedupeItems(data.catalog?.albums || [], seen, seenArtistNames);
  if (albums.length > 0) {
    sections.push({
      key: "albums",
      label: "Albums",
      items: albums,
    });
  }

  const tracks = dedupeItems(
    data.catalog?.tracks || [],
    seen,
    seenArtistNames,
  );
  if (tracks.length > 0) {
    sections.push({
      key: "tracks",
      label: "Songs",
      items: tracks,
    });
  }

  return sections;
}

export function flattenSuggestionSections(sections) {
  const rows = [];
  for (const section of sections) {
    rows.push({
      kind: "header",
      key: `header:${section.key}`,
      label: section.label,
    });
    section.items.forEach((item, index) => {
      rows.push({
        kind: "item",
        key: `${section.key}:${getSearchResultKey(item, index)}`,
        item,
      });
    });
  }
  return rows;
}

