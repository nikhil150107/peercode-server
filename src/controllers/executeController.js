import { executeOnJudge0 } from "../lib/judge0.js"

export async function handleExecute(req, res) {
  try {
    const { code, language, language_id, languageId, stdin } = req.body ?? {}

    if (!code || typeof code !== "string") {
      return res.status(400).json({
        ok: false,
        error: "code is required",
      })
    }

    const resolvedLanguageId =
      language_id ?? languageId ?? (language ? undefined : null)

    if (resolvedLanguageId == null && !language) {
      return res.status(400).json({
        ok: false,
        error: "language or language_id is required",
      })
    }

    const result = await executeOnJudge0(
      code,
      resolvedLanguageId ?? language,
      stdin ?? "",
    )

    return res.json({
      ok: true,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      compile_output: result.compile_output ?? "",
      message: result.message ?? "",
      status: result.status,
      status_id: result.status_id,
    })
  } catch (err) {
    console.error("[execute] error:", err)
    return res.status(500).json({
      ok: false,
      error: err instanceof Error ? err.message : "Execution failed",
    })
  }
}
