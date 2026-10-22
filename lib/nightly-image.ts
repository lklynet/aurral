import { asAppError } from "./errors.ts";

interface RegistryManifest {
  manifests?: { digest?: string; platform?: { os?: string; architecture?: string } }[];
  config?: { digest?: string };
}

const MANIFEST_TYPES = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

function requireDigest(value: string | undefined) {
  if (!/^sha256:[0-9a-f]{64}$/.test(value || "")) {
    throw new Error("Invalid nightly image digest");
  }
  return value;
}

export async function getPublishedNightlyImage(repository: string | undefined) {
  if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(repository || "")) {
    throw new Error("Invalid nightly image repository");
  }
  const signal = AbortSignal.timeout(15000);
  const request = async (url: string, headers: Record<string, string> = {}) => {
    const response = await fetch(url, { headers, signal });
    if (!response.ok) {
      const error: Error & { status?: number } = new Error(
        `Nightly registry request failed with ${response.status}`,
      );
      error.status = response.status;
      throw error;
    }
    return response.json();
  };
  const auth: { token?: string } = await request(
    `https://ghcr.io/token?service=ghcr.io&scope=repository:${repository}:pull`,
  );
  if (!auth.token) throw new Error("Nightly registry authentication failed");
  const headers = { Authorization: `Bearer ${auth.token}`, Accept: MANIFEST_TYPES };
  const base = `https://ghcr.io/v2/${repository}`;
  let manifest: RegistryManifest;
  try {
    manifest = await request(`${base}/manifests/nightly`, headers);
  } catch (error) {
    if (asAppError(error)?.status === 404) return null;
    throw error;
  }
  if (Array.isArray(manifest.manifests)) {
    const image = manifest.manifests.find(
      (item) => item.platform?.os === "linux" && item.platform?.architecture === "amd64",
    );
    manifest = await request(`${base}/manifests/${requireDigest(image?.digest)}`, headers);
  }
  const image: { config?: { Env?: string[] } } = await request(
    `${base}/blobs/${requireDigest(manifest.config?.digest)}`,
    headers,
  );
  const version = image.config?.Env?.find((item) => item.startsWith("APP_VERSION="))?.slice(12);
  const match = /^nightly\.\d+\+([0-9a-f]{7,40})$/.exec(version || "");
  if (!match) throw new Error("Published nightly image has no valid version");
  return { version, sha: match[1] };
}
