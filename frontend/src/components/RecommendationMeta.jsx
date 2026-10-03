import Tooltip from "./Tooltip";

export const getMatchPercent = (artist) => {
  const value = Number(artist?.matchPercent);
  return Number.isFinite(value) && value > 0 ? Math.round(value) : null;
};

export default function RecommendationMeta({ artist, text, className }) {
  const matchPercent = getMatchPercent(artist);
  const matchLabel = matchPercent ? `${matchPercent}% match` : null;
  const label = [matchLabel, text].filter(Boolean).join(" • ");
  if (!label) return null;
  return (
    <Tooltip content={label}>
      <p className={className}>
        {matchLabel ? <span className="artist-match-percent">{matchLabel}</span> : null}
        {matchLabel && text ? " • " : null}
        {text}
      </p>
    </Tooltip>
  );
}
