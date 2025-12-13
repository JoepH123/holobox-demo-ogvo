// Azure Functions v4 (Node 18+) – fetch is available globally
export default async function (context, req) {

  if (req.method !== "POST") {
    return {
      status: 405,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ error: "Method Not Allowed. Use POST." })
    };
  }

  const LIVEAVATAR_API_KEY = process.env.LIVEAVATAR_API_KEY;
  const LIVEAVATAR_ID = process.env.LIVEAVATAR_ID;
  const LIVEAVATAR_CONTEXT = process.env.LIVEAVATAR_CONTEXT;
  console.log(LIVEAVATAR_CONTEXT)
  if (!LIVEAVATAR_API_KEY || !LIVEAVATAR_ID || !LIVEAVATAR_CONTEXT) {
    return {
      status: 500,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ error: "Missing environment variable(s)." })
    };
  }

  const url = "https://api.liveavatar.com/v1/sessions/token";
  const headers = {
    accept: "application/json",
    "content-type": "application/json",
    "X-API-KEY": LIVEAVATAR_API_KEY
  };
  const body = JSON.stringify({
    avatar_id: LIVEAVATAR_ID,
    avatar_persona: { context_id: LIVEAVATAR_CONTEXT, language: 'nl' },
    mode: 'FULL'
  });

  try {
    const resp = await fetch(url, { method: "POST", headers, body });
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
