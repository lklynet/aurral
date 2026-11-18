export const hostedBuildPath = (version: string) => `/r/${version.replace(/[^\w.-]/g, "-")}/`;
