export const readRouteSeed = (state) =>
  state?.seed && typeof state.seed === "object" && !Array.isArray(state.seed) ? state.seed : null;
