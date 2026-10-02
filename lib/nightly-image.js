const MANIFEST_TYPES = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

function requireDigest(value) {
  if (!/^sha256:[0-9a-f]{64}$/.test(value || "")) {
    throw new Error("Invalid nightly image digest");
  }
  return value;
}

export async function getPublishedNightlyImage(repository) {
  if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(repository || "")) {
    throw new Error("Invalid nightly image repository");
  }
  const signal = AbortSignal.timeout(15000);
  const request = async (url, headers = {}) => {
    const response = await fetch(url, { headers, signal });
    if (!response.ok) {
      const error = new Error(`Nightly registry request failed with ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return response.json();
  };
  const auth = await request(`https://ghcr.io/token?service=ghcr.io&scope=repository:${repository}:pull`);
  if (!auth.token) throw new Error("Nightly registry authentication failed");
  const headers = { Authorization: `Bearer ${auth.token}`, Accept: MANIFEST_TYPES };
  const base = `https://ghcr.io/v2/${repository}`;
  let manifest;
  try {
    manifest = await request(`${base}/manifests/nightly`, headers);
  } catch (error) {
    if (error.status === 404) return null;
    throw error;
  }
  if (Array.isArray(manifest.manifests)) {
    const image = manifest.manifests.find(
      (item) => item.platform?.os === "linux" && item.platform?.architecture === "amd64",
    );
    manifest = await request(`${base}/manifests/${requireDigest(image?.digest)}`, headers);
  }
  const image = await request(`${base}/blobs/${requireDigest(manifest.config?.digest)}`, headers);
  const version = image.config?.Env?.find((item) => item.startsWith("APP_VERSION="))?.slice(12);
  const match = /^nightly\.\d+\+([0-9a-f]{7,40})$/.exec(version || "");
  if (!match) throw new Error("Published nightly image has no valid version");
  return { version, sha: match[1] };
}
