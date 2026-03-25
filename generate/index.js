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

  const { candidateName, contactInfo, workHistory, education, skills, jobDescription } =
    req.body || {};

  if (!candidateName || !workHistory || workHistory.length === 0) {
    context.res.status = 400;
    context.res.body = JSON.stringify({
      error: "candidateName and at least one workHistory entry are required",
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

  const systemPrompt = `You are an expert resume writer specializing in creating modern, compelling resumes for job seekers. Your goal is to craft a polished, professional resume from the candidate information provided.

Your resume should:
- Open with a strong professional summary (2-3 sentences) that captures the candidate's value proposition
- Present work experience in reverse chronological order with strong action verbs and quantified accomplishments where the provided information supports it
- Use clear, consistent formatting with plain text (all-caps section headers, dash bullets)
- Naturally incorporate keywords from the job description if one is provided
- Sound authentic and specific to this individual — not generic

Format rules:
- Use ALL CAPS for section headers (e.g., PROFESSIONAL SUMMARY, WORK EXPERIENCE)
- Use dashes (- ) for bullet points
- Keep contact info on separate lines at the top
- Do not invent facts — only use what is provided
- Only include sections for data that was actually provided — if education or skills are not provided, omit those sections entirely. Do not add placeholder text or prompts to fill them in.

Respond ONLY with a valid JSON object in this exact format (no markdown, no extra text):
{
  "generatedResume": "The full text of the generated resume in plain text format",
  "summary": "One sentence describing what kind of professional this resume presents"
}`;

  const contactBlock = contactInfo
    ? [
        contactInfo.email,
        contactInfo.phone,
        contactInfo.location,
        contactInfo.linkedin,
      ]
        .filter(Boolean)
        .join(" | ")
    : "";

  const workBlock = workHistory
    .map(
      (w) =>
        `${w.title || ""}${w.company ? " at " + w.company : ""}${w.startDate || w.endDate ? " (" + [w.startDate, w.endDate].filter(Boolean).join(" - ") + ")" : ""}\n${w.responsibilities || ""}`
    )
    .join("\n\n");

  const userPrompt = `Please generate a professional resume for the following candidate.

CANDIDATE NAME: ${candidateName}
${contactBlock ? `CONTACT: ${contactBlock}` : ""}

WORK EXPERIENCE:
${workBlock}

${education ? `EDUCATION:\n${education}` : ""}
${skills ? `SKILLS:\n${skills}` : ""}
${jobDescription ? `\nTARGET JOB DESCRIPTION (tailor the resume to this role):\n${jobDescription}` : ""}

Generate a complete, polished, modern resume for this candidate.`;

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
          max_tokens: 3000,
          temperature: 0.4,
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
