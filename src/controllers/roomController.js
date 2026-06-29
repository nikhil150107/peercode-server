import { supabase } from "../config/supabase.js"
import {
  loadRoomLiveState,
  patchRoomLiveState,
  toClientRoomState,
} from "../services/roomService.js"
import { emitSessionEnded } from "../services/sessionService.js"

export async function handleGetRoomState(req, res) {
  try {
    const { roomId } = req.params
    const userId = req.query.userId ?? null
    if (!roomId) {
      return res.status(400).json({ ok: false, error: "roomId is required" })
    }
    const state = await loadRoomLiveState(roomId)
    return res.json({
      ok: true,
      state: toClientRoomState(state, userId),
    })
  } catch (err) {
    console.error("[room_state] GET failed:", err)
    return res.status(500).json({ ok: false, error: "Failed to load room state" })
  }
}

export async function handleGetRoomEnded(req, res) {
  try {
    const { roomId } = req.params
    if (!roomId) {
      return res.status(400).json({ ok: false, error: "roomId is required" })
    }
    const state = await loadRoomLiveState(roomId)
    return res.json({ ok: true, ended: Boolean(state.ended) })
  } catch (err) {
    console.error("[room_state] ended check failed:", err)
    return res.status(500).json({ ok: false, error: "Failed to check room status" })
  }
}

export async function handlePutRoomState(req, res) {
  try {
    const { roomId } = req.params
    const { userId, patch } = req.body ?? {}

    if (!roomId) {
      return res.status(400).json({ ok: false, error: "roomId is required" })
    }

    const existing = await loadRoomLiveState(roomId)
    if (existing.ended) {
      return res.status(410).json({ ok: false, error: "Session has ended" })
    }

    const safePatch = { ...(patch ?? {}) }
    delete safePatch.interviewerUserId
    delete safePatch.intervieweeUserId

    const state = await patchRoomLiveState(roomId, safePatch)
    console.log("[room_state] saved", { roomId, userId })
    return res.json({ ok: true, state: toClientRoomState(state) })
  } catch (err) {
    console.error("[room_state] PUT failed:", err)
    return res.status(500).json({ ok: false, error: "Failed to save room state" })
  }
}

export async function handleEndRoomSession(req, res, io) {
  try {
    const { roomId } = req.params
    const { userId } = req.body ?? {}

    if (!roomId) {
      return res.status(400).json({ ok: false, error: "roomId is required" })
    }

    const state = await patchRoomLiveState(roomId, {
      ended: true,
      endedBy: userId ?? null,
    })

    await emitSessionEnded(io, roomId, userId ?? null)
    console.log("[room_state] session ended", { roomId, userId })

    return res.json({ ok: true, state: toClientRoomState(state) })
  } catch (err) {
    console.error("[room_state] end failed:", err)
    return res.status(500).json({ ok: false, error: "Failed to end session" })
  }
}

export async function handleSessionRatingReceived(req, res) {
  try {
    const { peerId, roomId, rating, raterUserId } = req.body ?? {}

    if (!peerId || !roomId || rating == null) {
      return res.status(400).json({
        ok: false,
        error: "peerId, roomId, and rating are required",
      })
    }

    const ratingValue = Math.round(Number(rating))
    if (!Number.isFinite(ratingValue) || ratingValue < 1 || ratingValue > 5) {
      return res.status(400).json({
        ok: false,
        error: "rating must be a number between 1 and 5",
      })
    }

    if (!supabase) {
      return res.status(503).json({
        ok: false,
        error: "Database not configured",
      })
    }

    console.log(
      `[rating] Saving rating_received=${ratingValue} on peer ${peerId} for room ${roomId} (from rater ${raterUserId ?? "unknown"})`,
    )

    const { data: existing, error: fetchError } = await supabase
      .from("sessions")
      .select("id")
      .eq("user_id", peerId)
      .eq("room_id", roomId)
      .maybeSingle()

    if (fetchError) {
      console.error("[rating] Failed to lookup peer session:", fetchError.message)
      return res.status(500).json({ ok: false, error: fetchError.message })
    }

    let savedRow

    if (existing) {
      const { data, error } = await supabase
        .from("sessions")
        .update({
          rating_received: ratingValue,
        })
        .eq("id", existing.id)
        .select("id, user_id, rating_received")
        .single()

      if (error) {
        console.error("[rating] Failed to update peer session:", error.message)
        return res.status(500).json({ ok: false, error: error.message })
      }

      savedRow = data
    } else {
      const { data, error } = await supabase
        .from("sessions")
        .insert({
          user_id: peerId,
          room_id: roomId,
          peer_id: typeof raterUserId === "string" ? raterUserId : null,
          rating_received: ratingValue,
        })
        .select("id, user_id, rating_received")
        .single()

      if (error) {
        console.error("[rating] Failed to insert peer session:", error.message)
        return res.status(500).json({ ok: false, error: error.message })
      }

      savedRow = data
    }

    console.log("[rating] rating_received saved on peer row:", savedRow)
    return res.json({ ok: true, session: savedRow })
  } catch (err) {
    console.error("[rating] error:", err)
    return res.status(500).json({
      ok: false,
      error: err instanceof Error ? err.message : "Internal server error",
    })
  }
}
