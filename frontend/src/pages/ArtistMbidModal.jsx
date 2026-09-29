import { useEffect, useState } from "react";
import { Check } from "lucide-react";
import { ModalShell } from "../components/PlaylistModals";
import { DotLoader } from "../components/DotLoader";
import { updateLibraryArtistMbid } from "../utils/api/endpoints/library.js";

const MBID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

export default function ArtistMbidModal({ artist, onClose, onSaved }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState("");

  useEffect(() => {
    setValue(artist?.mbid || "");
    setError("");
    setSaving("");
  }, [artist]);

  const save = async (mbid) => {
    setSaving(mbid ? "save" : "clear");
    setError("");
    try {
      const result = await updateLibraryArtistMbid(artist.id, mbid);
      onSaved?.(result);
    } catch (requestError) {
      setError(
        requestError.response?.data?.error ||
          requestError.message ||
          "Could not update the MusicBrainz ID",
      );
    } finally {
      setSaving("");
    }
  };

  const handleSubmit = () => {
    const mbid = String(value || "").match(MBID_PATTERN)?.[0]?.toLowerCase();
    if (!mbid) {
      setError("Enter a MusicBrainz artist ID or musicbrainz.org artist link");
      return;
    }
    void save(mbid);
  };

  return (
    <ModalShell
      open={Boolean(artist)}
      title="MusicBrainz ID"
      description={`Choose which MusicBrainz artist ${artist?.name || "this artist"} is. Scans will keep your choice.`}
      onClose={onClose}
      disableClose={Boolean(saving)}
      footer={
        <>
          {artist?.mbid ? (
            <button
              type="button"
              onClick={() => void save(null)}
              className="btn btn-secondary btn-sm"
              disabled={Boolean(saving)}
            >
              {saving === "clear" ? <DotLoader size="sm" label={null} /> : null}
              Remove ID
            </button>
          ) : null}
          <button
            type="button"
            onClick={onClose}
            className="btn btn-secondary btn-sm"
            disabled={Boolean(saving)}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            className="btn btn-primary btn-sm"
            disabled={Boolean(saving)}
          >
            {saving === "save" ? (
              <DotLoader size="sm" label={null} />
            ) : (
              <Check className="artist-icon-sm" />
            )}
            Save
          </button>
        </>
      }
    >
      <div className="playlist-modal__fields">
        <label className="artist-field-label" htmlFor="artist-mbid-input">
          MusicBrainz artist ID or link
        </label>
        <input
          id="artist-mbid-input"
          type="text"
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
            if (error) setError("");
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              handleSubmit();
            }
          }}
          className="input input--tall"
          placeholder="https://musicbrainz.org/artist/…"
          spellCheck={false}
          autoComplete="off"
          autoFocus
        />
        {error ? <p className="artist-error-text" role="alert">{error}</p> : null}
      </div>
    </ModalShell>
  );
}
