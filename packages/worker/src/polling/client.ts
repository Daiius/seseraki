import { hc } from "hono/client";
import type { AppType } from "server";

export function createClient(baseUrl: string) {
  return hc<AppType>(baseUrl);
}
