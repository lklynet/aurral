const COARSE_TILE_SIZE = 16;
const COARSE_GAP = 7;
const COARSE_FOOTPRINT = 3 * COARSE_TILE_SIZE + 2 * COARSE_GAP;
const DOT_COUNT = 9;

const LOADER_FOOTPRINTS = {
  xs: 14,
  sm: 16,
  md: 20,
  lg: 28,
  xl: 32,
  "2xl": 62,
};

export function DotLoader({ size = "sm", label = "Loading", className = "" }) {
  const classes = ["aurral-dot-loader", className].filter(Boolean).join(" ");
  const footprint = LOADER_FOOTPRINTS[size] || LOADER_FOOTPRINTS.sm;
  const tileSize = (footprint * COARSE_TILE_SIZE) / COARSE_FOOTPRINT;
  const gap = (footprint * COARSE_GAP) / COARSE_FOOTPRINT;
  const style = {
    width: `${footprint}px`,
    height: `${footprint}px`,
    "--aurral-dot-loader-tile-size": `${tileSize}px`,
    "--aurral-dot-loader-gap": `${gap}px`,
  };

  return (
    <span
      className={classes}
      style={style}
      role={label === null ? undefined : "status"}
      aria-label={label === null ? undefined : label}
      aria-hidden={label === null ? "true" : undefined}
    >
      {Array.from({ length: DOT_COUNT }, (_, index) => (
        <span key={index} className="aurral-dot-loader__dot" aria-hidden="true" />
      ))}
    </span>
  );
}
