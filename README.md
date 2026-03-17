# Resume Review Tool

AI-powered resume screening tool built on Azure OpenAI. The frontend runs on GitHub Pages; a small Azure Function proxy keeps your API key secure on the server side.

---

## Architecture

```
Your Team (browser)
      │
      ▼
GitHub Pages (index.html)
      │  POST /api/analyze
      ▼
Azure Function App (analyze/index.js)
      │  Azure OpenAI SDK
      ▼
Azure OpenAI (GPT-4o)
```

---

## Step 1: Set Up Azure OpenAI

1. Go to the [Azure Portal](https://portal.azure.com)
2. Create an **Azure OpenAI** resource (or use an existing one)
3. Inside the resource, go to **Azure OpenAI Studio** and deploy a model
   - Recommended: `gpt-4o` — name the deployment `gpt-4o`
4. Note your **Endpoint URL** (e.g. `https://yourresource.openai.azure.com/`) and **API Key** from Keys and Endpoint in the portal

---

## Step 2: Deploy the Azure Function

### Option A: Azure Portal (no CLI required)

1. In the Azure Portal, create a new **Function App**
   - Runtime: **Node.js 18**
   - OS: **Linux**
   - Plan: **Consumption (Serverless)** — free tier covers typical usage
2. Once deployed, open the Function App and go to **Functions > + Create**
   - Select **HTTP trigger**
   - Name it: `analyze`
   - Authorization level: **Function**
3. In the function editor, replace the default `index.js` with the contents of `azure-function/analyze/index.js` from this repo
4. Replace `function.json` with the contents of `azure-function/analyze/function.json`
5. Go to the Function App root > **Configuration > Application Settings** and add these:

| Setting Name | Value |
|---|---|
| `AZURE_OPENAI_ENDPOINT` | Your Azure OpenAI endpoint URL |
| `AZURE_OPENAI_KEY` | Your Azure OpenAI API key |
| `AZURE_OPENAI_DEPLOYMENT` | `gpt-4o` (or your deployment name) |
| `ALLOWED_ORIGIN` | `https://yourusername.github.io` (your GitHub Pages URL) |

6. Go to **Functions > analyze > Function Keys** and copy the **default** key — you will need this later

### Option B: Deploy via VS Code (recommended for developers)

1. Install the [Azure Functions extension](https://marketplace.visualstudio.com/items?itemName=ms-azuretools.vscode-azurefunctions)
2. Open the `azure-function` folder in VS Code
3. Run `npm install` in that folder
4. Click the Azure icon in the sidebar, sign in, and use **Deploy to Function App**
5. Add the Application Settings listed above via the Azure extension or the portal

---

## Step 3: Publish to GitHub Pages

1. Create a new GitHub repository (or use an existing one)
2. Copy `index.html` to the root of your repo
3. Go to the repo **Settings > Pages**
4. Set Source to **Deploy from a branch**, branch `main`, folder `/` (root)
5. Save — GitHub will publish the site at `https://yourusername.github.io/reponame`

---

## Step 4: Configure the App

1. Open your GitHub Pages URL in a browser
2. In the sidebar, find the **Azure Config** section
3. Enter:
   - **Function URL**: `https://yourfunctionapp.azurewebsites.net/api/analyze`
   - **Function Key**: The key you copied in Step 2
4. Click **Save Configuration** — this is stored in the browser (localStorage) so your team only needs to set it once per browser

---

## Using the Tool

### Single Resume Mode
1. Paste the job description in the **Job Description** field
2. Optionally add context in **Position Notes** (client preferences, deal-breakers, etc.)
3. Upload one resume file (`.txt` works best; `.pdf` and `.doc` will attempt text extraction)
4. Click **Analyze**

### Batch Mode
1. Toggle to **Batch** in the Resumes section
2. Upload multiple resume files at once
3. Click **Analyze** — each resume is analyzed individually and sequentially
4. A progress bar shows status as each file completes

### Results
- Each candidate is assigned **Viable**, **Review**, or **Reject**
- A **Fit Score** (0-100) and **Confidence** level are provided
- Click any result card to expand it and see Strengths, Concerns, Follow-up Items, and full AI reasoning
- Use the filter buttons to view only Viable, Review, or Reject candidates

---

## Resume File Tips

For best accuracy, upload resumes as plain `.txt` files. To convert:
- **PDF**: Open in Adobe Reader or browser, select all text, paste into Notepad/TextEdit, save as .txt
- **Word**: File > Save As > Plain Text (.txt)

The tool will attempt to read PDF/DOC files directly, but text extraction quality varies.

---

## Costs

- **Azure Function (Consumption plan)**: First 1 million executions/month are free
- **Azure OpenAI (GPT-4o)**: Charged per token. A typical resume analysis uses roughly 1,500-2,500 tokens total. At current pricing this is fractions of a cent per resume.
- **GitHub Pages**: Free

For a team doing 50-100 resumes/week, expect Azure OpenAI costs under $5/month.

---

## Security Notes

- The Azure Function key acts as a password — only share it with team members who should have access
- The `ALLOWED_ORIGIN` setting restricts which domains can call your function — set this to your GitHub Pages URL in production
- The API key never appears in any frontend code or the GitHub repo
- Configuration is stored in the user's browser localStorage, not sent to any third party
