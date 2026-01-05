// Azure Functions v4 (Node 18+) – fetch is available globally
export default async function (context, req) {
  if (req.method !== "POST") {
    return {
      status: 405,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ error: "Method Not Allowed. Use POST." }),
    };
  }

  const SPEECH_KEY = process.env.SPEECH_KEY;
  const SPEECH_REGION = process.env.SPEECH_REGION;

  if (!SPEECH_KEY || !SPEECH_REGION) {
    return {
      status: 500,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ error: "Missing SPEECH_KEY or SPEECH_REGION." }),
    };
  }

  // Token endpoint (returns a plain text token)
  const url = `https://${SPEECH_REGION}.api.cognitive.microsoft.com/sts/v1.0/issueToken`;

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Ocp-Apim-Subscription-Key": SPEECH_KEY,
      },
      body: "", // required by some environments
    });

    const tokenText = await resp.text();

    if (!resp.ok) {
      context.log.error("Speech token request failed:", resp.status, tokenText);
      return {
        status: resp.status,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ error: tokenText || "Token request failed" }),
      };
    }

    // Return token + region to the client
    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: tokenText, region: SPEECH_REGION }),
    };
  } catch (err) {
    context.log.error("Speech token request threw:", err);
    return {
      status: 500,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ error: String(err) }),
    };
  }
}
