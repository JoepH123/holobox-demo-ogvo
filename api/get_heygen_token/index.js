// Azure Functions v4 (Node 18+) – fetch is available globally
export default async function (context, req) {

  if (req.method !== "POST") {
    return {
      status: 405,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ error: "Method Not Allowed. Use POST." })
    };
  }

  const HEYGEN_API_KEY = process.env.HEYGEN_API_KEY;
  if (!HEYGEN_API_KEY) {
    return {
      status: 500,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ error: "Missing HEYGEN_API_KEY environment variable." })
    };
  }

  const url = "https://api.heygen.com/v1/streaming.create_token";
  const headers = {
    accept: "application/json",
    "content-type": "application/json",
    "x-api-key": HEYGEN_API_KEY
  };

  try {
    const resp = await fetch(url, { method: "POST", headers });
    const data = await resp.json().catch(() => ({}));

    return {
      status: resp.status,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(data)
    };
  } catch (err) {
    context.log.error("Heygen token request failed:", err);
    return {
      status: 500,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ error: String(err) })
    };
  }
}
