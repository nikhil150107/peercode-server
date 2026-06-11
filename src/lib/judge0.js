const JUDGE0_HOST =
  process.env.JUDGE0_URL?.replace(/\/$/, "") ?? "https://ce.judge0.com"
const JUDGE0_SUBMISSIONS_URL = `${JUDGE0_HOST}/submissions?base64_encoded=true&wait=true`
const JUDGE0_AUTH_TOKEN = process.env.JUDGE0_AUTH_TOKEN

export const JUDGE0_LANGUAGE_IDS = {
  python: 71,
  javascript: 63,
  java: 62,
  cpp: 54,
}

function decodeBase64Field(value) {
  if (!value) return value
  try {
    return Buffer.from(value, "base64").toString("utf8")
  } catch {
    return value
  }
}

export async function executeOnJudge0(code, language, stdin = "") {
  const languageId =
    typeof language === "number"
      ? language
      : JUDGE0_LANGUAGE_IDS[language?.toLowerCase()]

  if (!languageId) {
    throw new Error(`Unsupported language: ${language}`)
  }

  if (!code || typeof code !== "string") {
    throw new Error("code is required")
  }

  const requestBody = {
    source_code: Buffer.from(code, "utf8").toString("base64"),
    language_id: languageId,
    stdin: Buffer.from(stdin ?? "", "utf8").toString("base64"),
  }

  const headers = { "Content-Type": "application/json" }
  if (JUDGE0_AUTH_TOKEN) {
    headers["X-Auth-Token"] = JUDGE0_AUTH_TOKEN
  }

  console.log("[execute] Judge0 URL:", JUDGE0_SUBMISSIONS_URL)
  console.log("[execute] language_id:", languageId)
  console.log("[execute] code length:", code.length)

  const response = await fetch(JUDGE0_SUBMISSIONS_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(requestBody),
  })

  const responseText = await response.text()

  if (!response.ok) {
    console.error("[execute] Judge0 error:", response.status, responseText)
    throw new Error(
      `Judge0 request failed (${response.status}): ${responseText || response.statusText}`,
    )
  }

  const raw = JSON.parse(responseText)

  return {
    stdout: decodeBase64Field(raw.stdout),
    stderr: decodeBase64Field(raw.stderr),
    compile_output: decodeBase64Field(raw.compile_output),
    message: decodeBase64Field(raw.message),
    status: raw.status?.description ?? "Unknown",
    status_id: raw.status?.id ?? null,
  }
}
