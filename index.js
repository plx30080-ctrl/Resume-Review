const { OpenAIClient, AzureKeyCredential } = require("@azure/openai");

module.exports = async function (context, req) {
  // CORS headers - update ALLOWED_ORIGIN in Azure Function App Settings
  // to match your GitHub Pages URL, e.g. https://yourusername.github.io
  const allowedOrigin = process.env.ALLOWED_ORIGIN || "*";

  context.res = {
    headers: {
      "Access-Control-Allow-Origin": allowedOrigin,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, x-functions-key",
      "Content-Type": "application/json",
    },
  };

  // Handle preflight
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

  const { jobDescription, positionNotes, resumeText, candidateName } =
    req.body || {};

  if (!jobDescription || !resumeText) {
    context.res.status = 400;
    context.res.body = JSON.stringify({
      error: "jobDescription and resumeText are required",
    });
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

  const systemPrompt = `You are an expert talent acquisition specialist and resume screener. Your job is to evaluate resumes against job descriptions with precision, fairness, and a strong bias toward finding the best possible fit for the role.

You will classify each resume into exactly one of three categories:
- VIABLE: The candidate clearly meets the core requirements and is a strong fit. Recommend for immediate consideration.
- REVIEW: The candidate shows potential but has gaps, unclear experience, or items that need follow-up before a recommendation can be made.
- REJECT: The candidate does not meet the minimum requirements for the role. This decision should be based on clear evidence, not speculation.

Always err on the side of opportunity. When in doubt between VIABLE and REVIEW, choose REVIEW. Only REJECT when there is clear, documented misalignment with core requirements.

Respond ONLY with a valid JSON object in this exact format (no markdown, no extra text):
{
  "category": "VIABLE" | "REVIEW" | "REJECT",
  "confidence": "HIGH" | "MEDIUM" | "LOW",
  "summary": "One sentence summary of the candidate and your decision.",
  "strengths": ["strength 1", "strength 2", "strength 3"],
  "concerns": ["concern 1", "concern 2"],
  "followUpItems": ["item to clarify 1", "item to clarify 2"],
  "reasoning": "2-3 sentences explaining the classification decision in detail.",
  "fitScore": 0-100
}

For VIABLE candidates: strengths will be substantial, concerns may be minor or empty, followUpItems may be empty.
For REVIEW candidates: both strengths and concerns should be present, followUpItems should list specific things to verify.
For REJECT candidates: reasoning must clearly explain which core requirements are unmet. Do not fabricate concerns.`;

  const userPrompt = `JOB DESCRIPTION:
${jobDescription}

${positionNotes ? `ADDITIONAL POSITION NOTES / CLIENT CONTEXT:\n${positionNotes}\n` : ""}
CANDIDATE NAME: ${candidateName || "Unknown"}

RESUME:
${resumeText}

Evaluate this candidate against the job description and provide your JSON assessment.`;

  try {
    const client = new OpenAIClient(endpoint, new AzureKeyCredential(apiKey));

    let response;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        response = await client.getChatCompletions(deploymentName, [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ], {
          maxTokens: 1000,
          temperature: 0.2,
        });
        break;
      } catch (err) {
        const isRateLimit = err.statusCode === 429 || err.response?.status === 429;
        if (isRateLimit && attempt < 3) {
          await new Promise(r => setTimeout(r, attempt * 2000));
          continue;
        }
        throw err;
      }
    }

    const raw = response.choices[0]?.message?.content || "";

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
    const isRateLimit = err.statusCode === 429 || err.response?.status === 429;
    if (isRateLimit) {
      context.res.status = 429;
      context.res.body = JSON.stringify({
        error: "Azure OpenAI rate limit exceeded. Please wait a moment and try again.",
      });
    } else {
      context.log.error("Azure OpenAI error:", err.message);
      context.res.status = 500;
      context.res.body = JSON.stringify({
        error: "Failed to contact Azure OpenAI: " + err.message,
      });
    }
  }
};
