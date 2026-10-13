import { Headphones, Star } from "lucide-react";

export function ReleaseMetric({ metric }) {
  const Icon = metric.type === "rating" ? Star : Headphones;
  return (
    <>
      <Icon className="artist-release-metric-icon" aria-hidden="true" />
      <span aria-hidden="true">{metric.label}</span>
      <span className="sr-only">{metric.title}</span>
    </>
  );
}
