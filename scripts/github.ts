import { setTimeout as sleep } from "node:timers/promises";

export function env(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export async function github(path: string, init: RequestInit = {}) {
  for (let attempt = 1; ; attempt++) {
    const response = await fetch(
      `${process.env.GITHUB_API_URL ?? "https://api.github.com"}${path}`,
      {
        ...init,
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${env("GH_TOKEN")}`,
          "x-github-api-version": "2022-11-28",
          ...init.headers,
        },
      },
    );
    const retryAfter = Number(response.headers.get("retry-after"));
    if ([403, 429].includes(response.status) && retryAfter > 0 && attempt < 3) {
      await sleep(retryAfter * 1000);
      continue;
    }
    if (!response.ok) {
      throw new Error(
        `${init.method ?? "GET"} ${path} returned ${response.status}: ${await response.text()}`,
      );
    }
    return response;
  }
}

export async function graphql<T>(query: string, variables: Record<string, unknown> = {}) {
  const response = await github("/graphql", {
    method: "POST",
    body: JSON.stringify({ query, variables }),
  });
  const result: { data: T; errors?: { message: string }[] } = await response.json();
  if (result.errors?.length)
    throw new Error(result.errors.map((error) => error.message).join("\n"));
  return result.data;
}
