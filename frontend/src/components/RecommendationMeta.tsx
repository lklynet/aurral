import Tooltip from "./Tooltip";

interface RecommendationMetaProps {
  artist?: { matchPercent?: number | null } | null;
  text?: string;
  className?: string;
}

export const getMatchPercent = (artist: RecommendationMetaProps["artist"]) => {
  const value = Number(artist?.matchPercent);
  return Number.isFinite(value) && value > 0 ? Math.round(value) : null;
};

export default function RecommendationMeta({ artist, text, className }: RecommendationMetaProps) {
  const matchPercent = getMatchPercent(artist);
  const matchLabel = matchPercent ? `${matchPercent}% match` : null;
  const visibleText = matchLabel || text;
  if (!visibleText) return null;
  return (
    <Tooltip content={[matchLabel, text].filter(Boolean).join(" • ")}>
      <p className={matchLabel ? `${className} artist-match-percent` : className}>{visibleText}</p>
    </Tooltip>
  );
}
