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

  const { mode } = req.body || {};

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

  const url = new URL(
    `${endpoint}openai/deployments/${deploymentName}/chat/completions?api-version=2024-08-01-preview`
  );

  async function callOpenAI(messages, maxTokens, temperature) {
    let response;
    for (let attempt = 1; attempt <= 3; attempt++) {
      response = await new Promise((resolve, reject) => {
        const body = JSON.stringify({ messages, max_tokens: maxTokens, temperature });
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
    return response;
  }

  try {
    if (mode === "generateQuestions") {
      const { resumeText, jobDescription } = req.body;

      if (!resumeText || !jobDescription) {
        context.res.status = 400;
        context.res.body = JSON.stringify({ error: "resumeText and jobDescription are required" });
        return;
      }

      const systemPrompt = `You are an expert talent acquisition specialist and structured interviewer.
Your job is to generate a set of focused, role-specific interview questions for a recruiter conducting a screening interview.

The questions must be grounded in the candidate's actual resume and the specific job description provided. Do not generate generic questions.

Return ONLY a valid JSON object (no markdown, no extra text):
{
  "categories": [
    {
      "category": "Work History",
      "description": "Drilling into specific roles, responsibilities, and transitions",
      "questions": [
        { "id": "wh1", "question": "..." },
        { "id": "wh2", "question": "..." }
      ]
    },
    {
      "category": "Skills Correlation",
      "description": "Matching job description requirements to resume claims",
      "questions": [...]
    },
    {
      "category": "Employment Gaps",
      "description": "Addressing any detected gaps in employment history",
      "questions": [...]
    },
    {
      "category": "General Fit / Motivation",
      "description": "Understanding candidate interest and cultural alignment",
      "questions": [...]
    },
    {
      "category": "Behavioral / Situational",
      "description": "STAR-format questions tied to key role competencies",
      "questions": [...]
    }
  ]
}

Rules:
- Work History: 3-5 questions drilling into the most relevant or recent roles. Reference specific companies, titles, or dates from the resume.
- Skills Correlation: 2-4 questions for each major requirement in the JD that appears in the resume — probe depth of experience. If a required skill is absent from the resume, include a gap question.
- Employment Gaps: Only include this category if there is a detectable gap of 3+ months between roles. If no gaps, return an empty questions array for this category.
- General Fit / Motivation: 2-3 questions about why this role, this company type, career goals.
- Behavioral / Situational: 3-4 STAR-format questions tied to the 3 most important competencies in the job description.
- Each question must be specific, not generic. Reference actual details from the resume or JD.
- Total questions: 12-20 across all categories.`;

      const userPrompt = `JOB DESCRIPTION:
${jobDescription}

CANDIDATE RESUME:
${resumeText}

Generate structured interview questions for this candidate against this role.`;

      const response = await callOpenAI(
        [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        2500,
        0.4
      );

      if (response.status === 429) {
        context.res.status = 429;
        context.res.body = JSON.stringify({ error: "Azure OpenAI rate limit exceeded. Please wait a moment and try again." });
        return;
      }
      if (response.status !== 200) {
        context.res.status = 500;
        context.res.body = JSON.stringify({ error: "Azure OpenAI error: " + response.body });
        return;
      }

      const parsed = JSON.parse(response.body);
      const raw = parsed.choices[0]?.message?.content || "";

      let result;
      try {
        result = JSON.parse(raw);
      } catch {
        context.res.status = 500;
        context.res.body = JSON.stringify({ error: "AI returned unexpected format", raw });
        return;
      }

      if (!Array.isArray(result.categories)) {
        context.res.status = 500;
        context.res.body = JSON.stringify({ error: "AI response missing categories array", raw });
        return;
      }

      context.res.status = 200;
      context.res.body = JSON.stringify(result);

    } else if (mode === "generateFollowUps") {
      const { originalQuestion, recruiterNotes, resumeText, jobDescription } = req.body;

      if (!originalQuestion || !recruiterNotes) {
        context.res.status = 400;
        context.res.body = JSON.stringify({ error: "originalQuestion and recruiterNotes are required" });
        return;
      }

      const systemPrompt = `You are an expert interviewer helping a recruiter generate targeted follow-up questions based on a candidate's response during a screening interview.

The recruiter has taken notes on what the candidate said. Your job is to generate 2-4 specific follow-up questions that:
- Probe deeper into what the candidate revealed in their notes
- Clarify any vague, incomplete, or contradictory statements
- Surface quantifiable evidence if the notes mention accomplishments without metrics
- Expose potential weaknesses or gaps suggested by the response
- Build on positive signals to confirm depth of experience

Return ONLY a valid JSON array of strings (no markdown, no extra text):
["Follow-up question 1", "Follow-up question 2", "Follow-up question 3"]

Rules:
- Questions must be directly derived from the recruiter's notes — do not ask about things the candidate didn't mention.
- If the notes suggest a strong answer, still generate probing follow-ups to verify depth.
- If the notes suggest a weak or vague answer, generate clarifying and challenge questions.
- 2-4 questions total. Quality over quantity.`;

      const userPrompt = `ORIGINAL INTERVIEW QUESTION:
${originalQuestion}

RECRUITER'S NOTES ON CANDIDATE'S RESPONSE:
${recruiterNotes}
${resumeText ? `\nCANDIDATE RESUME (for context):\n${resumeText.substring(0, 1500)}` : ""}
${jobDescription ? `\nJOB DESCRIPTION (for context):\n${jobDescription.substring(0, 800)}` : ""}

Generate targeted follow-up questions based on what the candidate said.`;

      const response = await callOpenAI(
        [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        600,
        0.5
      );

      if (response.status === 429) {
        context.res.status = 429;
        context.res.body = JSON.stringify({ error: "Azure OpenAI rate limit exceeded. Please wait a moment and try again." });
        return;
      }
      if (response.status !== 200) {
        context.res.status = 500;
        context.res.body = JSON.stringify({ error: "Azure OpenAI error: " + response.body });
        return;
      }

      const parsed = JSON.parse(response.body);
      const raw = parsed.choices[0]?.message?.content || "";

      let followUps;
      try {
        followUps = JSON.parse(raw);
        if (!Array.isArray(followUps)) throw new Error("not an array");
      } catch {
        context.res.status = 500;
        context.res.body = JSON.stringify({ error: "AI returned unexpected format", raw });
        return;
      }

      context.res.status = 200;
      context.res.body = JSON.stringify({ followUps });

    } else if (mode === "wrapUp") {
      const { questionsAndNotes, resumeText, jobDescription } = req.body;

      if (!Array.isArray(questionsAndNotes) || questionsAndNotes.length === 0) {
        context.res.status = 400;
        context.res.body = JSON.stringify({ error: "questionsAndNotes must be a non-empty array" });
        return;
      }

      const systemPrompt = `You are a senior talent acquisition specialist. A recruiter has just completed a structured screening interview. You are given all interview questions, organized by category, along with the recruiter's notes for each question.

Your job is to synthesize everything into a professional candidate fit summary.

Return ONLY a valid JSON object (no markdown, no extra text):
{
  "fitAssessment": "2-3 sentence overall assessment of this candidate's fit for the role",
  "keyStrengths": ["strength 1", "strength 2", "strength 3"],
  "keyRisks": ["risk or gap 1", "risk or gap 2"],
  "hiringRecommendation": "ADVANCE",
  "recommendationRationale": "1-2 sentences explaining the recommendation",
  "overallNotes": "Free-form paragraph of detailed recruiter synthesis"
}

Rules:
- Base ALL conclusions on the recruiter's actual notes. Do not invent information.
- If notes are sparse or missing for some questions, acknowledge this in overallNotes.
- hiringRecommendation must be exactly one of: ADVANCE, HOLD, or DECLINE
- keyStrengths: 2-4 items. Only things supported by the notes.
- keyRisks: 1-3 items. Gaps, vague answers, missing evidence, or concerning patterns from the notes.
- Be direct and professional. This is an internal recruiter document, not for the candidate.`;

      const transcript = questionsAndNotes.map((item, i) =>
        `[${item.category}]\nQ${i + 1}: ${item.question}\nNotes: ${item.notes || "(no notes recorded)"}`
      ).join("\n\n");

      const userPrompt = `INTERVIEW TRANSCRIPT:
${transcript}
${resumeText ? `\nCANDIDATE RESUME:\n${resumeText.substring(0, 1500)}` : ""}
${jobDescription ? `\nJOB DESCRIPTION:\n${jobDescription.substring(0, 800)}` : ""}

Generate a candidate fit summary based on this interview.`;

      const response = await callOpenAI(
        [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        1200,
        0.3
      );

      if (response.status === 429) {
        context.res.status = 429;
        context.res.body = JSON.stringify({ error: "Azure OpenAI rate limit exceeded. Please wait a moment and try again." });
        return;
      }
      if (response.status !== 200) {
        context.res.status = 500;
        context.res.body = JSON.stringify({ error: "Azure OpenAI error: " + response.body });
        return;
      }

      const parsed = JSON.parse(response.body);
      const raw = parsed.choices[0]?.message?.content || "";

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

    } else {
      context.res.status = 400;
      context.res.body = JSON.stringify({
        error: "Invalid mode. Expected: generateQuestions, generateFollowUps, or wrapUp",
      });
    }
  } catch (err) {
    context.log.error("Interview function error:", err.message);
    context.res.status = 500;
    context.res.body = JSON.stringify({ error: "Internal error: " + err.message });
  }
};
