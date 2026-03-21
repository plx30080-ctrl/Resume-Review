const { AzureOpenAI } = require("@azure/openai");

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

  const { jobDescription, positionNotes, resumeText, candidateName, interviewNotes } =
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

  const systemPrompt = `You are an expert resume writer and talent acquisition specialist. Your job is to enhance a candidate's resume to better showcase their fit for a specific role — without fabricating experience, skills, or qualifications they do not have.

Your enhancements should:
- Expand brief or vague bullet points using context from the candidate's actual experience and any interview notes provided
- Strengthen language with strong action verbs and, where plausible from the provided context, quantify accomplishments
- Reorder or reframe content to lead with the most relevant experience for this specific role
- Naturally incorporate keywords and requirements from the job description where the candidate genuinely qualifies
- Use the interview notes to surface accomplishments or context the original resume underrepresents
- Improve the overall presentation, structure, and readability

You must NOT:
- Add experience, roles, skills, certifications, or qualifications the candidate does not have
- Invent numbers or metrics that are not grounded in the provided information
- Change job titles, company names, or dates
- Remove legitimate experience even if not directly relevant

Respond ONLY with a valid JSON object in this exact format (no markdown, no extra text):
{
  "enhancedResume": "The full text of the enhanced resume, formatted cleanly with clear section headers and bullet points using plain text (use dashes for bullets, all-caps for section headers)",
  "summary": "One sentence describing the overall enhancement approach taken",
  "changes": ["Specific change 1", "Specific change 2", "Specific change 3"],
  "keyAlignments": ["How the resume now maps to key requirement 1", "How the resume now maps to key requirement 2"]
}`;

  const userPrompt = `JOB DESCRIPTION:
${jobDescription}

${positionNotes ? `POSITION NOTES / CLIENT CONTEXT:\n${positionNotes}\n\n` : ""}${interviewNotes ? `INTERVIEW NOTES (what was learned about this candidate in the interview — use this context to expand and strengthen the resume):\n${interviewNotes}\n\n` : ""}CANDIDATE NAME: ${candidateName || "Unknown"}

ORIGINAL RESUME:
${resumeText}

Enhance this resume to better showcase the candidate's genuine fit for the role described above. Preserve all factual details while making their qualifications as compelling and relevant as possible.`;

  const client = new AzureOpenAI({ endpoint, apiKey, deployment: deploymentName, apiVersion: "2024-08-01-preview" });

  try {
    let response;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        response = await client.chat.completions.create({
          model: deploymentName,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
          max_tokens: 3000,
          temperature: 0.4,
        });
        break;
      } catch (err) {
        const isRateLimit = err.status === 429;
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
      context.res.body = JSON.stringify({ error: "AI returned unexpected format", raw });
      return;
    }

    context.res.status = 200;
    context.res.body = JSON.stringify(result);
  } catch (err) {
    if (err.status === 429) {
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
