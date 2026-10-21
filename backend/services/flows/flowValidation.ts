type FlowMixInput = { discover?: unknown; mix?: unknown; trending?: unknown; focus?: unknown };

export function normalizeFlowMixForValidation(mix: unknown) {
  const source: FlowMixInput = mix && typeof mix === "object" && !Array.isArray(mix) ? mix : {};
  return {
    discover: Math.max(0, Number(source?.discover || 0) || 0),
    mix: Math.max(0, Number(source?.mix || 0) || 0),
    trending: Math.max(0, Number(source?.trending || 0) || 0),
    focus: Math.max(0, Number(source?.focus || 0) || 0),
  };
}
