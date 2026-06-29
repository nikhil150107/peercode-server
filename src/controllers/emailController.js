import { sendBookingConfirmation } from "../lib/email.js"
import { supabase } from "../config/supabase.js"

export async function handleSendBookingEmail(req, res) {
  try {
    const { userEmail, slotTime, slotDate, slotId } = req.body ?? {}

    if (!userEmail || !slotTime || !slotDate) {
      return res.status(400).json({
        ok: false,
        error: "userEmail, slotTime, and slotDate are required",
      })
    }

    const result = await sendBookingConfirmation(
      userEmail,
      slotTime,
      slotDate,
      slotId,
    )

    if (!result.ok) {
      console.error(
        "[email] booking confirmation failed:",
        result.error ?? "unknown error",
      )
      return res.status(500).json({ ok: false, error: "Failed to send email" })
    }

    return res.json({ ok: true })
  } catch (err) {
    console.error("[email] booking confirmation error:", err)
    return res.status(500).json({
      ok: false,
      error: err instanceof Error ? err.message : "Internal server error",
    })
  }
}

export async function handleFeedback(req, res) {
  try {
    const { message, name, userId } = req.body ?? {}

    if (!message || typeof message !== "string" || !message.trim()) {
      return res.status(400).json({
        ok: false,
        error: "message is required",
      })
    }

    if (!supabase) {
      return res.status(503).json({
        ok: false,
        error: "Database not configured",
      })
    }

    const { error } = await supabase.from("feedback").insert({
      message: message.trim(),
      name: typeof name === "string" && name.trim() ? name.trim() : null,
      user_id: typeof userId === "string" && userId ? userId : null,
    })

    if (error) {
      console.error("[feedback] insert failed:", error.message)
      return res.status(500).json({
        ok: false,
        error: "Failed to save feedback",
      })
    }

    console.log("[feedback] Saved feedback from", userId ?? "anonymous")
    return res.json({ ok: true })
  } catch (err) {
    console.error("[feedback] error:", err)
    return res.status(500).json({
      ok: false,
      error: err instanceof Error ? err.message : "Internal server error",
    })
  }
}
