import { Headphones, Star } from "../../../components/icons";
import type { ReleaseMetricValue } from "../utils";

export function ReleaseMetric({ metric }: { metric: ReleaseMetricValue }) {
  const Icon = metric.type === "rating" ? Star : Headphones;
  return (
    <>
      <Icon className="artist-release-metric-icon" aria-hidden="true" />
      <span aria-hidden="true">{metric.label}</span>
      <span className="sr-only">{metric.title}</span>
    </>
  );
}
