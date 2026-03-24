const https = require("https");

module.exports = async function (context, req) {
  const allowedOrigin = process.env.ALLOWED_ORIGIN || "*";

  context.res = {
    headers: {
      "Access-Control-Allow-Origin": allowedOrigin,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, x-functions-key",
      "Content-Type": "application/json",
    },
  };

  if (req.method === "OPTIONS") {
    context.res.status = 204;
    context.res.body = "";
    return;
  }

  if (req.method !== "POST") {
    context.res.status = 405;
    context.res.body = JSON.stringify({ error: "Method not allowed" });
    return;
  }

  const { candidateName, role, resumeText, analysisContext } = req.body || {};

  if (!candidateName) {
    context.res.status = 400;
    context.res.body = JSON.stringify({ error: "candidateName is required" });
    return;
  }

  const endpoint = process.env.AZURE_OPENAI_ENDPOINT;
  const apiKey = process.env.AZURE_OPENAI_KEY;
  const deploymentName = process.env.AZURE_OPENAI_DEPLOYMENT || "gpt-4o";

  if (!endpoint || !apiKey) {
    context.res.status = 500;
    context.res.body = JSON.stringify({
      error: "Azure OpenAI credentials not configured on the server.",
    });
    return;
  }

  const systemPrompt = `You are a professional staffing recruiter at Employbridge writing an email to present a candidate to a hiring manager or client. Your emails are warm, concise, and professional — you lead with the candidate's strongest qualities and why they are a fit for the role.

Your email should:
- Have a clear, specific subject line referencing the candidate name and role
- Open with a brief, enthusiastic introduction of the candidate
- Highlight 2-4 specific strengths or standout qualifications drawn from the resume and analysis context
- Note why this candidate is a strong match for the role
- Close with a clear call to action (schedule a call, review the attached resume, etc.)
- Be written in first person from the recruiter's perspective
- Be 150-250 words in the body — professional but not overly formal

Respond ONLY with a valid JSON object in this exact format (no markdown, no extra text):
{
  "subject": "Email subject line",
  "body": "Full email body text, using \\n for line breaks"
}`;

  const userPrompt = `Generate a candidate presentation email with the following context:

CANDIDATE NAME: ${candidateName}
${role ? `ROLE / JOB DESCRIPTION SNIPPET:\n${role}` : ""}
${analysisContext ? `\nCANDIDATE CONTEXT / ANALYSIS:\n${analysisContext}` : ""}
${resumeText ? `\nRESUME EXCERPT (first 1500 chars):\n${resumeText.substring(0, 1500)}` : ""}

Write a professional recruiter email presenting this candidate.`;

  const url = new URL(
    `${endpoint}openai/deployments/${deploymentName}/chat/completions?api-version=2024-08-01-preview`
  );

  try {
    let response;
    for (let attempt = 1; attempt <= 3; attempt++) {
      response = await new Promise((resolve, reject) => {
        const body = JSON.stringify({
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
          max_tokens: 800,
          temperature: 0.5,
        });
        const httpReq = https.request(
          {
            hostname: url.hostname,
            path: url.pathname + url.search,
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "api-key": apiKey,
              "Content-Length": Buffer.byteLength(body),
            },
          },
          (res) => {
            let data = "";
            res.on("data", (chunk) => (data += chunk));
            res.on("end", () => resolve({ status: res.statusCode, body: data }));
          }
        );
        httpReq.on("error", reject);
        httpReq.write(body);
        httpReq.end();
      });

      if (response.status === 429 && attempt < 3) {
        await new Promise((r) => setTimeout(r, attempt * 2000));
        continue;
      }
      break;
    }

    if (response.status === 429) {
      context.res.status = 429;
      context.res.body = JSON.stringify({
        error: "Azure OpenAI rate limit exceeded. Please wait a moment and try again.",
      });
      return;
    }

    if (response.status !== 200) {
      context.res.status = 500;
      context.res.body = JSON.stringify({
        error: "Azure OpenAI error: " + response.body,
      });
      return;
    }

    const parsed = JSON.parse(response.body);
    const raw = parsed.choices[0]?.message?.content || "";

    let result;
    try {
      result = JSON.parse(raw);
    } catch {
      context.res.status = 500;
      context.res.body = JSON.stringify({
        error: "AI returned unexpected format",
        raw,
      });
      return;
    }

    context.res.status = 200;
    context.res.body = JSON.stringify(result);
  } catch (err) {
    context.log.error("Azure OpenAI error:", err.message);
    context.res.status = 500;
    context.res.body = JSON.stringify({
      error: "Failed to contact Azure OpenAI: " + err.message,
    });
  }
};
