import type { CohorlyTransport } from "./types.js";

/** Default transport: POST JSON via fetch. Thrown/rejected on non-2xx or network error. */
export const fetchTransport: CohorlyTransport = async (url, body) => {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`cohorly: request to ${url} failed with status ${res.status}`);
  }
};
