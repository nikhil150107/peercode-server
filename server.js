import dotenv from "dotenv"
import path from "path"
import { fileURLToPath } from "url"
import express from "express"
import { createServer } from "http"
import { Server } from "socket.io"
import cors from "cors"
import { createClient } from "@supabase/supabase-js"
import { v4 as uuidv4 } from "uuid"
import {
  sendBookingConfirmation,
  sendMatchConfirmation,
  sendNoMatchFound,
} from "./src/lib/email.js"
import { executeOnJudge0 } from "./src/lib/judge0.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(__dirname, ".env") })

const PORT = process.env.PORT || 3001
const allowedOrigins = [
  "https://peercode.live",
  "https://www.peercode.live",
  "http://localhost:5173",
]

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

const supabase =
  SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
    : null

const SCHEDULED_SLOT_TIMES = [
  "10:00 AM",
  "12:00 PM",
  "2:00 PM",
  "4:00 PM",
  "6:00 PM",
  "8:00 PM",
  "10:00 PM",
]

const app = express()
app.use(cors({ origin: allowedOrigins }))
app.use(express.json())

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    waitingPools: Object.keys(waitingPool).length,
    supabaseConfigured: Boolean(supabase),
    resendConfigured: Boolean(process.env.RESEND_API_KEY),
  })
})

async function handleSendBookingEmail(req, res) {
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

app.post("/api/emails/booking-confirmation", handleSendBookingEmail)
app.post("/api/emails/send-booking-email", handleSendBookingEmail)

async function handleFeedback(req, res) {
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

app.post("/api/feedback", handleFeedback)

async function handleExecute(req, res) {
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

app.post("/api/execute", handleExecute)

function defaultRoomLiveState() {
  return {
    question: null,
    codes: {},
    language: "python",
    secondsLeft: 120 * 60,
    timerStarted: false,
    timerStartedAt: null,
    chatMessages: [],
    ended: false,
    endedBy: null,
    interviewerUserId: null,
    intervieweeUserId: null,
  }
}

/** @type {Record<string, ReturnType<typeof defaultRoomLiveState>>} */
const roomLiveCache = {}

const SESSION_DURATION_SECONDS = 120 * 60

function getUserRoleFromState(state, userId) {
  if (!userId) return null
  if (state.interviewerUserId === userId) return "interviewer"
  if (state.intervieweeUserId === userId) return "interviewee"
  return null
}

function toClientRoomState(state, userId = null) {
  let secondsLeft = state.secondsLeft ?? SESSION_DURATION_SECONDS
  if (state.timerStarted && state.timerStartedAt) {
    const elapsed = Math.floor((Date.now() - state.timerStartedAt) / 1000)
    secondsLeft = Math.max(0, SESSION_DURATION_SECONDS - elapsed)
  }

  const clientState = {
    question: state.question,
    codes: state.codes ?? {},
    language: state.language ?? "python",
    secondsLeft,
    timerStarted: Boolean(state.timerStarted),
    timerStartedAt: state.timerStartedAt ?? null,
    chatMessages: state.chatMessages ?? [],
    ended: Boolean(state.ended),
    interviewerUserId: state.interviewerUserId ?? null,
    intervieweeUserId: state.intervieweeUserId ?? null,
  }

  if (userId) {
    clientState.myRole = getUserRoleFromState(state, userId)
  }

  return clientState
}

async function loadRoomLiveState(roomId) {
  if (roomLiveCache[roomId]) {
    return roomLiveCache[roomId]
  }

  const fallback = defaultRoomLiveState()

  if (!supabase) {
    roomLiveCache[roomId] = fallback
    return fallback
  }

  try {
    const { data, error } = await supabase
      .from("room_live_state")
      .select("*")
      .eq("room_id", roomId)
      .maybeSingle()

    if (error || !data) {
      roomLiveCache[roomId] = fallback
      return fallback
    }

    const state = {
      question: data.question ?? null,
      codes: data.codes ?? {},
      language: data.language ?? "python",
      secondsLeft: data.seconds_left ?? 120 * 60,
      timerStarted: Boolean(data.timer_started),
      timerStartedAt: data.timer_started_at
        ? new Date(data.timer_started_at).getTime()
        : null,
      chatMessages: data.chat_messages ?? [],
      ended: Boolean(data.ended_at),
      endedBy: data.ended_by ?? null,
      interviewerUserId: data.interviewer_user_id ?? null,
      intervieweeUserId: data.interviewee_user_id ?? null,
    }

    roomLiveCache[roomId] = state
    return state
  } catch (err) {
    console.error("[room_state] load failed:", err)
    roomLiveCache[roomId] = fallback
    return fallback
  }
}

async function persistRoomLiveState(roomId, state) {
  roomLiveCache[roomId] = state

  if (!supabase) return

  try {
    const row = {
      room_id: roomId,
      question: state.question,
      codes: state.codes ?? {},
      language: state.language ?? "python",
      seconds_left: state.secondsLeft ?? 120 * 60,
      timer_started: Boolean(state.timerStarted),
      timer_started_at: state.timerStartedAt
        ? new Date(state.timerStartedAt).toISOString()
        : null,
      chat_messages: state.chatMessages ?? [],
      ended_at: state.ended ? new Date().toISOString() : null,
      ended_by: state.endedBy ?? null,
      interviewer_user_id: state.interviewerUserId ?? null,
      interviewee_user_id: state.intervieweeUserId ?? null,
      updated_at: new Date().toISOString(),
    }

    const { error } = await supabase.from("room_live_state").upsert(row)
    if (error) {
      console.error("[room_state] persist failed:", error.message)
    }
  } catch (err) {
    console.error("[room_state] persist error:", err)
  }
}

async function patchRoomLiveState(roomId, patch) {
  const state = await loadRoomLiveState(roomId)
  if (patch.question !== undefined) {
    if (state.question && patch.question?.id !== state.question?.id) {
      // Question is locked for the session once set.
      delete patch.question
    } else {
      state.question = patch.question
    }
  }
  if (patch.codes !== undefined) {
    state.codes = { ...(state.codes ?? {}), ...patch.codes }
  }
  if (patch.language !== undefined) state.language = patch.language
  if (patch.secondsLeft !== undefined) state.secondsLeft = patch.secondsLeft
  if (patch.timerStarted !== undefined) state.timerStarted = patch.timerStarted
  if (patch.timerStartedAt !== undefined) {
    state.timerStartedAt = patch.timerStartedAt
  }
  if (state.timerStarted && state.timerStartedAt) {
    const elapsed = Math.floor((Date.now() - state.timerStartedAt) / 1000)
    state.secondsLeft = Math.max(0, SESSION_DURATION_SECONDS - elapsed)
  }
  if (patch.chatMessages !== undefined) {
    state.chatMessages = patch.chatMessages
  }
  if (patch.ended !== undefined) state.ended = patch.ended
  if (patch.endedBy !== undefined) state.endedBy = patch.endedBy
  const forceRoles = Boolean(patch.forceRoles)

  if (patch.interviewerUserId !== undefined) {
    if (
      forceRoles ||
      !state.interviewerUserId ||
      patch.interviewerUserId === state.interviewerUserId
    ) {
      state.interviewerUserId = patch.interviewerUserId
    }
  }
  if (patch.intervieweeUserId !== undefined) {
    if (
      forceRoles ||
      !state.intervieweeUserId ||
      patch.intervieweeUserId === state.intervieweeUserId
    ) {
      state.intervieweeUserId = patch.intervieweeUserId
    }
  }
  await persistRoomLiveState(roomId, state)
  return state
}

function invalidateRoomLiveCache(roomId) {
  delete roomLiveCache[roomId]
}

/** Serialize role assignment per room to prevent simultaneous-join races. */
const roomRoleLocks = new Map()

function withRoomRoleLock(roomId, fn) {
  const previous = roomRoleLocks.get(roomId) ?? Promise.resolve()
  const run = previous
    .catch(() => {})
    .then(fn)
  roomRoleLocks.set(
    roomId,
    run.catch(() => {}),
  )
  return run
}

async function tryClaimRoleSlot(roomId, userId, slot) {
  const column =
    slot === "interviewer" ? "interviewer_user_id" : "interviewee_user_id"
  const field =
    slot === "interviewer" ? "interviewerUserId" : "intervieweeUserId"

  const before = await loadRoomLiveState(roomId)

  if (before.interviewerUserId === userId) return "interviewer"
  if (before.intervieweeUserId === userId) return "interviewee"
  if (before[field]) return null
  if (slot === "interviewee" && before.interviewerUserId === userId) {
    return null
  }

  if (!supabase) {
    if (before[field]) return null
    await patchRoomLiveState(roomId, { [field]: userId })
    invalidateRoomLiveCache(roomId)
    const after = await loadRoomLiveState(roomId)
    return after[field] === userId ? slot : null
  }

  await supabase.from("room_live_state").upsert(
    {
      room_id: roomId,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "room_id", ignoreDuplicates: true },
  )

  const { data, error } = await supabase
    .from("room_live_state")
    .update({
      [column]: userId,
      updated_at: new Date().toISOString(),
    })
    .eq("room_id", roomId)
    .is(column, null)
    .select("interviewer_user_id, interviewee_user_id")
    .maybeSingle()

  if (error) {
    console.error("[roles] claim failed:", error.message)
    if (!before[field]) {
      await patchRoomLiveState(roomId, { [field]: userId })
      invalidateRoomLiveCache(roomId)
      const after = await loadRoomLiveState(roomId)
      if (after[field] === userId) return slot
    }
    return null
  }

  if (!data || data[column] !== userId) {
    invalidateRoomLiveCache(roomId)
    const after = await loadRoomLiveState(roomId)
    if (after[field] === userId) return slot
    return null
  }

  invalidateRoomLiveCache(roomId)
  return slot
}

async function assignOrRestoreRole(roomId, userId, prevPeerCount = 0) {
  let state = await loadRoomLiveState(roomId)

  const existing = getUserRoleFromState(state, userId)
  if (existing) {
    console.log("[role] restored from room_live_state", {
      roomId,
      userId,
      role: existing,
    })
    return {
      role: existing,
      isFirstPeer: existing === "interviewer",
    }
  }

  let targetSlot = null
  if (!state.interviewerUserId && prevPeerCount === 0) {
    targetSlot = "interviewer"
  } else if (!state.intervieweeUserId && prevPeerCount >= 1) {
    targetSlot = "interviewee"
  } else if (!state.interviewerUserId) {
    targetSlot = "interviewer"
  } else if (!state.intervieweeUserId) {
    targetSlot = "interviewee"
  }

  if (targetSlot) {
    const claimed = await tryClaimRoleSlot(roomId, userId, targetSlot)
    if (claimed) {
      return {
        role: claimed,
        isFirstPeer: claimed === "interviewer",
      }
    }

    invalidateRoomLiveCache(roomId)
    state = await loadRoomLiveState(roomId)
    const restoredAfterClaim = getUserRoleFromState(state, userId)
    if (restoredAfterClaim) {
      return {
        role: restoredAfterClaim,
        isFirstPeer: restoredAfterClaim === "interviewer",
      }
    }
  }

  const peers = roomPeers[roomId]
  if (peers) {
    const orderedUserIds = Array.from(peers.keys())
    if (orderedUserIds[0] === userId && !state.interviewerUserId) {
      await patchRoomLiveState(roomId, { interviewerUserId: userId })
      return { role: "interviewer", isFirstPeer: true }
    }
    if (orderedUserIds[1] === userId && !state.intervieweeUserId) {
      await patchRoomLiveState(roomId, { intervieweeUserId: userId })
      return { role: "interviewee", isFirstPeer: false }
    }
  }

  if (state.interviewerUserId && state.intervieweeUserId) {
    console.warn("[roles] both roles assigned but user unknown", {
      roomId,
      userId,
      interviewerUserId: state.interviewerUserId,
      intervieweeUserId: state.intervieweeUserId,
    })
  }

  console.warn("[roles] fallback interviewee assignment", { roomId, userId })
  return { role: "interviewee", isFirstPeer: false }
}

async function handleGetRoomState(req, res) {
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

async function handleGetRoomEnded(req, res) {
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

async function handlePutRoomState(req, res) {
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

async function handleEndRoomSession(req, res) {
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

    io.to(roomId).emit("session_ended", { roomId, from: userId ?? null })
    console.log("[room_state] session ended", { roomId, userId })

    return res.json({ ok: true, state: toClientRoomState(state) })
  } catch (err) {
    console.error("[room_state] end failed:", err)
    return res.status(500).json({ ok: false, error: "Failed to end session" })
  }
}

app.get("/api/room/:roomId/state", handleGetRoomState)
app.get("/api/room/:roomId/ended", handleGetRoomEnded)
app.put("/api/room/:roomId/state", handlePutRoomState)
app.post("/api/room/:roomId/end", handleEndRoomSession)

async function handleSessionRatingReceived(req, res) {
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

app.post("/api/sessions/rating-received", handleSessionRatingReceived)

const httpServer = createServer(app)
const io = new Server(httpServer, {
  cors: {
    origin: allowedOrigins,
    methods: ["GET", "POST"],
  },
})

/** @type {Record<string, Array<{ socketId: string, userId: string, slotTime: string, slotDate: string, userEmail: string, difficultyPreference?: string, topicPreference?: string }>>} */
const waitingPool = {}

/** @type {Record<string, Map<string, string>>} */
const roomPeers = {}

/** @type {Record<string, object>} */
const roomQuestions = {}

/** @type {Record<string, string>} */
const roomFirstPeer = {}

/** @type {Record<string, string>} */
const roomFirstPeerUserId = {}

/** @type {Record<string, Record<string, string>>} */
const roomPeerDifficultyPrefs = {}

/** @type {Record<string, Record<string, string>>} */
const roomPeerTopicPrefs = {}

/** @type {Record<string, string>} */
const roomDifficultyPref = {}

/** @type {Record<string, string>} */
const roomTopicPref = {}

/** @type {Record<string, string>} */
const userSocketMap = {}

/** @type {Set<string>} */
const processedSlotDates = new Set()

/** @type {Record<string, boolean>} */
const roomTimerStarted = {}

const VALID_DIFFICULTY_PREFS = new Set(["Easy", "Medium", "Hard", "Random"])
const VALID_TOPIC_PREFS = new Set([
  "Any",
  "Arrays",
  "Strings",
  "Trees",
  "Graphs",
  "DP",
  "Linked Lists",
])

function getTodayISTDate() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date())
}

function parseSlotHoursMinutes(slotTime) {
  const match = slotTime.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i)
  if (!match) return null

  let hours = parseInt(match[1], 10)
  const minutes = parseInt(match[2], 10)
  const period = match[3].toUpperCase()

  if (period === "PM" && hours !== 12) hours += 12
  if (period === "AM" && hours === 12) hours = 0

  return { hours, minutes }
}

function computeSessionStartMs(slotTime, slotDate) {
  const parsed = parseSlotHoursMinutes(slotTime)
  if (!parsed) return null

  const [year, month, day] = slotDate.split("-").map(Number)
  return Date.UTC(
    year,
    month - 1,
    day,
    parsed.hours - 5,
    parsed.minutes - 30,
    0,
  )
}

const MATCH_BEFORE_MS = 3 * 60 * 1000
const UNMATCHED_CANCEL_AFTER_MS = 3 * 60 * 1000

function isInMatchWindow(slotTime, slotDate) {
  const slotStartMs = computeSessionStartMs(slotTime, slotDate)
  if (slotStartMs == null) return false
  const now = Date.now()
  return (
    now >= slotStartMs - MATCH_BEFORE_MS &&
    now <= slotStartMs + UNMATCHED_CANCEL_AFTER_MS
  )
}

function shouldCancelUnmatched(slotTime, slotDate) {
  const slotStartMs = computeSessionStartMs(slotTime, slotDate)
  if (slotStartMs == null) return false
  return Date.now() >= slotStartMs + UNMATCHED_CANCEL_AFTER_MS
}

function sendFetchQuestionToUser(
  userId,
  roomId,
  difficultyPreference,
  topicPreference,
) {
  const socketId = userSocketMap[userId]
  if (!socketId) {
    console.log(`[fetch_question] no socket mapped for user ${userId}`)
    return false
  }

  const targetSocket = io.sockets.sockets.get(socketId)
  if (!targetSocket) {
    console.log(`[fetch_question] socket ${socketId} not connected for user ${userId}`)
    return false
  }

  console.log(
    `[fetch_question] telling ${userId} (${socketId}) to fetch with difficulty "${difficultyPreference}", topic "${topicPreference}"`,
  )
  targetSocket.emit("fetch_question", {
    roomId,
    difficultyPreference,
    topicPreference,
  })
  return true
}

function getIntervieweeUserId(roomId) {
  const liveState = roomLiveCache[roomId]
  if (liveState?.intervieweeUserId) {
    return liveState.intervieweeUserId
  }

  const peers = roomPeers[roomId]
  const firstUserId = roomFirstPeerUserId[roomId]
  if (!peers || !firstUserId) return null

  for (const userId of peers.keys()) {
    if (userId !== firstUserId) return userId
  }
  return null
}

async function maybeTriggerQuestionFetch(roomId) {
  if (roomQuestions[roomId]) return
  if (!roomPeers[roomId] || roomPeers[roomId].size < 2) return

  const liveState = await loadRoomLiveState(roomId)
  if (liveState.question) {
    roomQuestions[roomId] = liveState.question
    console.log("[question] already exists, skipping fetch")
    return
  }

  const intervieweeUserId =
    liveState.intervieweeUserId ?? getIntervieweeUserId(roomId)
  if (!intervieweeUserId) return

  const pref = roomPeerDifficultyPrefs[roomId]?.[intervieweeUserId]
  const topicPref = roomPeerTopicPrefs[roomId]?.[intervieweeUserId]
  if (!pref || !topicPref) {
    console.log(
      `[fetch_question] waiting for interviewee ${intervieweeUserId} preferences in room ${roomId}`,
    )
    return
  }

  roomDifficultyPref[roomId] = pref
  roomTopicPref[roomId] = topicPref
  sendFetchQuestionToUser(intervieweeUserId, roomId, pref, topicPref)
}

function clearRoomState(roomId) {
  delete roomPeers[roomId]
  delete roomQuestions[roomId]
  delete roomFirstPeer[roomId]
  delete roomFirstPeerUserId[roomId]
  delete roomPeerDifficultyPrefs[roomId]
  delete roomPeerTopicPrefs[roomId]
  delete roomDifficultyPref[roomId]
  delete roomTopicPref[roomId]
  delete roomTimerStarted[roomId]
}

async function emitStartTimerIfReady(roomId) {
  if (!roomPeers[roomId] || roomPeers[roomId].size < 2) return

  const liveState = await loadRoomLiveState(roomId)

  if (liveState.timerStarted && liveState.timerStartedAt) {
    roomTimerStarted[roomId] = true
    const elapsed = Math.floor((Date.now() - liveState.timerStartedAt) / 1000)
    const remaining = Math.max(0, SESSION_DURATION_SECONDS - elapsed)
    io.to(roomId).emit("start_timer", {
      roomId,
      durationSeconds: remaining,
      timerStartedAt: liveState.timerStartedAt,
    })
    console.log(`[timer] restored timer for room ${roomId} (${remaining}s left)`)
    return
  }

  if (roomTimerStarted[roomId]) return

  roomTimerStarted[roomId] = true
  const startedAt = Date.now()
  await patchRoomLiveState(roomId, {
    timerStarted: true,
    timerStartedAt: startedAt,
    secondsLeft: SESSION_DURATION_SECONDS,
  })

  io.to(roomId).emit("start_timer", {
    roomId,
    durationSeconds: SESSION_DURATION_SECONDS,
    timerStartedAt: startedAt,
  })
  console.log(`[timer] start_timer emitted for room ${roomId}`)
}

function poolKey(slotTime, slotDate) {
  return `${slotTime}-${slotDate}`
}

function removeFromAllPools(socketId) {
  for (const key of Object.keys(waitingPool)) {
    const before = waitingPool[key].length
    waitingPool[key] = waitingPool[key].filter((u) => u.socketId !== socketId)
    if (waitingPool[key].length === 0) {
      delete waitingPool[key]
      console.log(`[pool] Removed empty pool: ${key}`)
    } else if (waitingPool[key].length < before) {
      console.log(`[pool] Removed socket ${socketId} from ${key} (${waitingPool[key].length} waiting)`)
    }
  }
}

function removeFromAllRooms(socketId) {
  for (const roomId of Object.keys(roomPeers)) {
    const peers = roomPeers[roomId]
    let disconnectedUserId = null

    for (const [userId, sid] of peers.entries()) {
      if (sid === socketId) {
        disconnectedUserId = userId
        peers.delete(userId)
        console.log(`[room] ${userId} left room ${roomId}`)
      }
    }

    if (disconnectedUserId && peers.size > 0) {
      io.to(roomId).emit("peer_disconnected", { userId: disconnectedUserId })
      console.log(`[room] peer_disconnected emitted in ${roomId}`)
    }

    if (peers.size === 0) {
      clearRoomState(roomId)
    }
  }
}

async function fetchUserEmail(userId) {
  if (!supabase) return null

  try {
    const { data, error } = await supabase.auth.admin.getUserById(userId)
    if (!error && data?.user?.email) {
      return data.user.email
    }
    if (error) {
      console.error(
        `[match] auth.admin.getUserById failed for ${userId}:`,
        error.message,
      )
    }
  } catch (err) {
    console.error(`[match] auth.admin.getUserById error for ${userId}:`, err)
  }

  const { data, error } = await supabase
    .from("profiles")
    .select("email")
    .eq("user_id", userId)
    .maybeSingle()

  if (error) {
    console.error(
      `[match] Failed to fetch profile email for ${userId}:`,
      error.message,
    )
    return null
  }

  return data?.email ?? null
}

async function fetchUserName(userId) {
  if (!supabase) return null

  const { data, error } = await supabase
    .from("profiles")
    .select("username")
    .eq("user_id", userId)
    .maybeSingle()

  if (error) {
    console.error(
      `[match] Failed to fetch profile name for ${userId}:`,
      error.message,
    )
    return null
  }

  return data?.username?.trim() || null
}

async function handleUnmatchedUser(booking, slotTime, slotDate, poolEntry) {
  const { error: cancelError } = await supabase
    .from("slot_bookings")
    .update({ status: "cancelled" })
    .eq("id", booking.id)
    .eq("status", "pending")

  if (cancelError) {
    console.error(
      `[scheduler] Failed to cancel unmatched booking ${booking.id}:`,
      cancelError.message,
    )
    return
  }

  const [authEmail, profileName] = await Promise.all([
    fetchUserEmail(booking.user_id),
    fetchUserName(booking.user_id),
  ])

  const userEmail = authEmail ?? poolEntry?.userEmail ?? null
  const displayName =
    profileName ??
    (userEmail ? userEmail.split("@")[0] : "there")

  if (!userEmail) {
    console.error(
      `[scheduler] Skipping no-match email — no email for user ${booking.user_id}`,
    )
    return
  }

  const result = await sendNoMatchFound(
    userEmail,
    displayName,
    slotTime,
    slotDate,
    { isToday: slotDate === getTodayISTDate() },
  )

  if (!result.ok) {
    console.error(
      `[scheduler] No-match email failed for ${userEmail}:`,
      result.error ?? "unknown error",
    )
  } else {
    console.log(
      `[email] No-match email sent to ${userEmail} for ${slotTime} on ${slotDate}`,
    )
  }
}

function emitMatchToPair(user1, user2, roomId, slotTime) {
  const socket1 = io.sockets.sockets.get(user1.socketId)
  const socket2 = io.sockets.sockets.get(user2.socketId)

  if (socket1) {
    socket1.join(roomId)
    userSocketMap[user1.userId] = user1.socketId
    socket1.emit("match_found", {
      roomId,
      peerId: user2.userId,
      peerEmail: user2.userEmail,
      slotTime,
    })
  }

  if (socket2) {
    socket2.join(roomId)
    userSocketMap[user2.userId] = user2.socketId
    socket2.emit("match_found", {
      roomId,
      peerId: user1.userId,
      peerEmail: user1.userEmail,
      slotTime,
    })
  }

  roomPeers[roomId] = new Map()
  if (socket1) roomPeers[roomId].set(user1.userId, user1.socketId)
  if (socket2) roomPeers[roomId].set(user2.userId, user2.socketId)

  const key = poolKey(slotTime, user1.slotDate)
  if (waitingPool[key]) {
    waitingPool[key] = waitingPool[key].filter(
      (u) => u.userId !== user1.userId && u.userId !== user2.userId,
    )
    if (waitingPool[key].length === 0) delete waitingPool[key]
  }

  console.log(
    `[match] Matched ${user1.userEmail} with ${user2.userEmail} for ${slotTime} on ${user1.slotDate} (room: ${roomId})`,
  )
}

async function notifyUserIfAlreadyMatched(userId, slotTime, slotDate, socket) {
  if (!supabase) return

  const { data: booking, error } = await supabase
    .from("slot_bookings")
    .select("room_id, matched_with, status")
    .eq("user_id", userId)
    .eq("slot_time", slotTime)
    .eq("slot_date", slotDate)
    .eq("status", "matched")
    .maybeSingle()

  if (error) {
    console.error(
      `[match] Failed to check existing match for ${userId}:`,
      error.message,
    )
    return
  }

  if (!booking?.room_id || !booking.matched_with) return

  const peerEmail = await fetchUserEmail(booking.matched_with)
  socket.emit("match_found", {
    roomId: booking.room_id,
    peerId: booking.matched_with,
    peerEmail: peerEmail ?? "your peer",
    slotTime,
  })
  console.log(
    `[match] Re-sent match_found to ${userId} for room ${booking.room_id}`,
  )
}

async function matchUsersForSlot(slotTime, slotDate) {
  if (!supabase) {
    console.warn("[scheduler] Supabase not configured — skipping matchUsersForSlot")
    return
  }

  console.log(`[scheduler] Running matchUsersForSlot(${slotTime}, ${slotDate})`)

  const { data: bookings, error } = await supabase
    .from("slot_bookings")
    .select("id, user_id, slot_time, slot_date")
    .eq("slot_time", slotTime)
    .eq("slot_date", slotDate)
    .eq("status", "pending")
    .order("created_at", { ascending: true })

  if (error) {
    console.error("[scheduler] Failed to fetch bookings:", error.message)
    return
  }

  if (!bookings || bookings.length === 0) {
    console.log(`[scheduler] No pending bookings for ${slotTime} on ${slotDate}`)
    return
  }

  console.log(
    `[scheduler] Found ${bookings.length} pending booking(s) for ${slotTime} on ${slotDate}:`,
    bookings.map((b) => b.user_id),
  )

  const key = poolKey(slotTime, slotDate)
  const matchedUserIds = new Set()

  for (let i = 0; i + 1 < bookings.length; i += 2) {
    const booking1 = bookings[i]
    const booking2 = bookings[i + 1]
    const roomId = uuidv4()

    const { error: update1Error } = await supabase
      .from("slot_bookings")
      .update({
        status: "matched",
        matched_with: booking2.user_id,
        room_id: roomId,
      })
      .eq("id", booking1.id)
      .eq("status", "pending")

    const { error: update2Error } = await supabase
      .from("slot_bookings")
      .update({
        status: "matched",
        matched_with: booking1.user_id,
        room_id: roomId,
      })
      .eq("id", booking2.id)
      .eq("status", "pending")

    if (update1Error || update2Error) {
      console.error("[scheduler] Failed to update bookings:", update1Error?.message, update2Error?.message)
      continue
    }

    matchedUserIds.add(booking1.user_id)
    matchedUserIds.add(booking2.user_id)

    const poolEntry1 = waitingPool[key]?.find((u) => u.userId === booking1.user_id)
    const poolEntry2 = waitingPool[key]?.find((u) => u.userId === booking2.user_id)

    const [authEmail1, authEmail2] = await Promise.all([
      fetchUserEmail(booking1.user_id),
      fetchUserEmail(booking2.user_id),
    ])

    const user1Email = authEmail1 ?? poolEntry1?.userEmail ?? null
    const user2Email = authEmail2 ?? poolEntry2?.userEmail ?? null

    const user1 = {
      userId: booking1.user_id,
      socketId: poolEntry1?.socketId ?? userSocketMap[booking1.user_id],
      userEmail: user1Email,
      slotDate,
    }

    const user2 = {
      userId: booking2.user_id,
      socketId: poolEntry2?.socketId ?? userSocketMap[booking2.user_id],
      userEmail: user2Email,
      slotDate,
    }

    if (user1.socketId || user2.socketId) {
      emitMatchToPair(user1, user2, roomId, slotTime)
    } else {
      console.log(
        `[scheduler] Pair matched in DB (room ${roomId}) but both users offline — emails still sent`,
      )
    }

    const topicPref =
      poolEntry2?.topicPreference ??
      poolEntry1?.topicPreference ??
      "Any"
    const difficultyPref =
      poolEntry2?.difficultyPreference ??
      poolEntry1?.difficultyPreference ??
      "Random"

    if (user1Email && user2Email) {
      console.log(
        `[email] Sending match confirmation — user1=${user1Email} user2=${user2Email} room=${roomId} slot=${slotTime}`,
      )
      const emailResult = await sendMatchConfirmation(
        user1Email,
        user2Email,
        roomId,
        slotTime,
        topicPref,
        difficultyPref,
      )
      console.log("[email] Match confirmation results:", emailResult)

      if (!emailResult.user1?.ok || !emailResult.user2?.ok) {
        console.error("[scheduler] Match confirmation email failed:", emailResult)
      } else {
        console.log(
          `[email] Match confirmation sent to ${user1Email} and ${user2Email}`,
        )
      }
    } else {
      console.error("[scheduler] Skipping match emails — missing addresses", {
        user1Email,
        user2Email,
        booking1: booking1.user_id,
        booking2: booking2.user_id,
      })
    }
  }

  const unmatchedBookings = bookings.filter(
    (booking) => !matchedUserIds.has(booking.user_id),
  )

  if (unmatchedBookings.length > 0) {
    if (shouldCancelUnmatched(slotTime, slotDate)) {
      console.log(
        `[scheduler] ${unmatchedBookings.length} unmatched user(s) for ${slotTime} on ${slotDate} — cancelling after slot window`,
      )

      for (const booking of unmatchedBookings) {
        const poolEntry = waitingPool[key]?.find(
          (u) => u.userId === booking.user_id,
        )
        await handleUnmatchedUser(booking, slotTime, slotDate, poolEntry)
      }

      if (waitingPool[key]) {
        waitingPool[key] = waitingPool[key].filter((u) =>
          matchedUserIds.has(u.userId),
        )
        if (waitingPool[key].length === 0) delete waitingPool[key]
      }
    } else {
      console.log(
        `[scheduler] ${unmatchedBookings.length} user(s) still pending for ${slotTime} on ${slotDate} — waiting for more peers`,
      )
    }
  }
}

function checkScheduledMatching() {
  const now = Date.now()
  const today = getTodayISTDate()

  for (const slotTime of SCHEDULED_SLOT_TIMES) {
    const checkKey = `${slotTime}-${today}`

    const slotStartMs = computeSessionStartMs(slotTime, today)
    if (slotStartMs == null) continue

    const matchAtMs = slotStartMs - MATCH_BEFORE_MS
    if (now >= matchAtMs) {
      if (!processedSlotDates.has(checkKey)) {
        console.log(
          `[scheduler] Match window open for ${slotTime} IST on ${today} (${Math.round((slotStartMs - now) / 60_000)} min before slot)`,
        )
      }
      void matchUsersForSlot(slotTime, today)

      if (now >= slotStartMs + UNMATCHED_CANCEL_AFTER_MS) {
        processedSlotDates.add(checkKey)
      }
    }
  }
}

io.on("connection", (socket) => {
  console.log(`[connect] Client connected: ${socket.id}`)

  socket.on(
    "join_waiting",
    ({
      userId,
      slotTime,
      slotDate,
      userEmail,
      difficultyPreference,
      topicPreference,
    }) => {
    const date = slotDate || getTodayISTDate()
    const key = poolKey(slotTime, date)

    removeFromAllPools(socket.id)
    userSocketMap[userId] = socket.id

    if (!waitingPool[key]) {
      waitingPool[key] = []
    }

    const existing = waitingPool[key].findIndex((u) => u.userId === userId)
    const entry = {
      socketId: socket.id,
      userId,
      slotTime,
      slotDate: date,
      userEmail,
      difficultyPreference,
      topicPreference,
    }

    if (existing >= 0) {
      waitingPool[key][existing] = entry
    } else {
      waitingPool[key].push(entry)
    }

    console.log(
      `[join_waiting] ${userEmail} (${userId}) registered for "${key}" — ${waitingPool[key].length} in pool (scheduled match)`,
    )

    void notifyUserIfAlreadyMatched(userId, slotTime, date, socket)

    if (isInMatchWindow(slotTime, date)) {
      console.log(
        `[join_waiting] Match window active for ${key} — running matchUsersForSlot`,
      )
      void matchUsersForSlot(slotTime, date)
    }
  },
  )

  socket.on("leave_waiting", ({ userId, slotTime, slotDate }) => {
    const date = slotDate || getTodayISTDate()
    const key = poolKey(slotTime, date)
    if (waitingPool[key]) {
      waitingPool[key] = waitingPool[key].filter((u) => u.socketId !== socket.id)
      if (waitingPool[key].length === 0) delete waitingPool[key]
    }
    if (userSocketMap[userId] === socket.id) {
      delete userSocketMap[userId]
    }
    console.log(`[leave_waiting] ${userId} left pool "${key}"`)
  })

  socket.on("join_room", async ({ roomId, userId }) => {
    if (!roomId || !userId) return

    const liveState = await loadRoomLiveState(roomId)
    if (liveState.ended) {
      console.log(`[join_room] room ${roomId} has ended — rejecting ${userId}`)
      socket.emit("session_ended", { roomId })
      return
    }

    const hasStoredQuestion = Boolean(
      roomQuestions[roomId] ?? liveState.question,
    )
    console.log("[join_room] received", {
      roomId,
      socketId: socket.id,
      userId,
      hasStoredQuestion,
      storedQuestionTitle:
        roomQuestions[roomId]?.title ?? liveState.question?.title ?? null,
    })

    if (liveState.question && !roomQuestions[roomId]) {
      roomQuestions[roomId] = liveState.question
    }

    socket.join(roomId)

    let roleInfo
    let prevPeerCount = 0

    await withRoomRoleLock(roomId, async () => {
      if (!roomPeers[roomId]) {
        roomPeers[roomId] = new Map()
      }

      prevPeerCount = roomPeers[roomId].size
      roomPeers[roomId].set(userId, socket.id)
      userSocketMap[userId] = socket.id

      roleInfo = await assignOrRestoreRole(roomId, userId, prevPeerCount)
    })

    const roleState = await loadRoomLiveState(roomId)
    if (roleState.interviewerUserId) {
      roomFirstPeerUserId[roomId] = roleState.interviewerUserId
      roomFirstPeer[roomId] =
        userSocketMap[roleState.interviewerUserId] ?? roomFirstPeer[roomId]
    }

    const peers = Array.from(roomPeers[roomId].keys())
    console.log(
      "[role] Assigning role for room:",
      roomId,
      "isFirstPeer:",
      roleInfo.isFirstPeer,
      "assigned role:",
      roleInfo.role,
      "userId:",
      userId,
      "prevPeerCount:",
      prevPeerCount,
    )
    console.log(`[join_room] ${userId} joined room ${roomId} (${peers.length}/2)`, {
      role: roleInfo.role,
      isFirstPeer: roleInfo.isFirstPeer,
    })

    socket.emit("room_joined", {
      roomId,
      peerCount: peers.length,
      role: roleInfo.role,
      isFirstPeer: roleInfo.isFirstPeer,
    })

    socket.emit("role_assigned", {
      roomId,
      userId,
      role: roleInfo.role,
      isFirstPeer: roleInfo.isFirstPeer,
    })

    socket.emit("room_state_sync", {
      roomId,
      state: toClientRoomState(roleState, userId),
    })

    if (prevPeerCount === 1 && peers.length === 2) {
      io.to(roomId).emit("peer_reconnected", { userId })
      console.log(`[join_room] peer_reconnected in ${roomId}`)
    }

    if (peers.length >= 2) {
      io.to(roomId).emit("room_ready", { roomId, peers })
      console.log(`[join_room] Room ${roomId} ready — both peers connected`)
      emitStartTimerIfReady(roomId)
      maybeTriggerQuestionFetch(roomId)
    }
  })

  socket.on(
    "request_question",
    ({ roomId, userId, difficultyPreference, topicPreference }) => {
    if (!roomId || !userId) return

    const pref = VALID_DIFFICULTY_PREFS.has(difficultyPreference)
      ? difficultyPreference
      : "Random"
    const topic = VALID_TOPIC_PREFS.has(topicPreference) ? topicPreference : "Any"

    if (!roomPeerDifficultyPrefs[roomId]) {
      roomPeerDifficultyPrefs[roomId] = {}
    }
    if (!roomPeerTopicPrefs[roomId]) {
      roomPeerTopicPrefs[roomId] = {}
    }
    roomPeerDifficultyPrefs[roomId][userId] = pref
    roomPeerTopicPrefs[roomId][userId] = topic

    console.log("[request_question] received", {
      roomId,
      socketId: socket.id,
      userId,
      difficultyPreference: pref,
      topicPreference: topic,
      hasStoredQuestion: Boolean(roomQuestions[roomId]),
      peerCount: roomPeers[roomId]?.size ?? 0,
    })

    if (roomQuestions[roomId]) {
      console.log(
        `[request_question] sending stored question to ${socket.id}:`,
        roomQuestions[roomId].title,
      )
      socket.emit("question_selected", {
        question: roomQuestions[roomId],
      })
      return
    }

    const liveState = await loadRoomLiveState(roomId)
    if (liveState.question) {
      roomQuestions[roomId] = liveState.question
      console.log(
        `[request_question] sending persisted question to ${socket.id}:`,
        liveState.question.title,
      )
      socket.emit("question_selected", {
        question: liveState.question,
      })
      return
    }

    console.log(
      `[request_question] no question yet for ${socket.id}, waiting for both peers`,
    )
    maybeTriggerQuestionFetch(roomId)
  },
  )

  socket.on("question_selected", async ({ roomId, question, userId }) => {
    if (!roomId || !question || !userId) return

    const liveState = await loadRoomLiveState(roomId)
    const existingQuestion = roomQuestions[roomId] ?? liveState.question

    if (existingQuestion) {
      roomQuestions[roomId] = existingQuestion
      console.log(
        `[question_selected] room ${roomId} already has "${existingQuestion.title}" — ignoring new question`,
      )
      io.to(roomId).emit("question_selected", {
        question: existingQuestion,
        from: userId,
      })
      return
    }

    console.log("[question_selected] received", {
      roomId,
      socketId: socket.id,
      userId,
      questionTitle: question.title,
    })

    roomQuestions[roomId] = question
    await patchRoomLiveState(roomId, { question })
    console.log(`[question_selected] stored "${question.title}" for room ${roomId}`)

    io.to(roomId).emit("question_selected", {
      question: roomQuestions[roomId],
      from: userId,
    })
    console.log(`[question_selected] broadcast "${question.title}" to room ${roomId}`)
  })

  socket.on("webrtc_offer", ({ roomId, offer, userId }) => {
    console.log(`[webrtc] Offer from ${userId} in room ${roomId}`)
    socket.to(roomId).emit("webrtc_offer", { offer, from: userId })
  })

  socket.on("webrtc_answer", ({ roomId, answer, userId }) => {
    console.log(`[webrtc] Answer from ${userId} in room ${roomId}`)
    socket.to(roomId).emit("webrtc_answer", { answer, from: userId })
  })

  socket.on("webrtc_ice_candidate", ({ roomId, candidate, userId }) => {
    socket.to(roomId).emit("webrtc_ice_candidate", { candidate, from: userId })
  })

  socket.on("code_change", async ({ roomId, code, language, userId }) => {
    if (!roomId || !userId) return

    await patchRoomLiveState(roomId, {
      codes: { [language]: code },
      language,
    })

    socket.to(roomId).emit("code_change", { code, language, from: userId })
  })

  socket.on("code_output", ({ roomId, output, userId, loading }) => {
    if (!roomId || !userId || output === undefined) return

    if (!socket.rooms.has(roomId)) {
      socket.join(roomId)
    }

    const payload = {
      roomId,
      output,
      from: userId,
      loading: Boolean(loading),
    }

    const roomSize = io.sockets.adapter.rooms.get(roomId)?.size ?? 0
    console.log(`[code_output] ${userId} shared output in room ${roomId} (${roomSize} sockets)`)

    socket.to(roomId).emit("code_output", payload)
  })

  socket.on(
    "chat_message",
    async ({ roomId, userId, text, senderName }) => {
      if (!roomId || !userId || !text?.trim()) return

      const state = await loadRoomLiveState(roomId)
      if (state.ended) return

      const message = {
        id: uuidv4(),
        text: text.trim(),
        senderName: senderName?.trim() || "Peer",
        from: userId,
        at: Date.now(),
      }

      const chatMessages = [...(state.chatMessages ?? []), message]
      await patchRoomLiveState(roomId, { chatMessages })

      socket.to(roomId).emit("chat_message", { roomId, message })
      console.log(`[chat] message in room ${roomId} from ${userId}`)
    },
  )

  socket.on("end_session", async ({ roomId, userId }) => {
    if (!roomId) return

    await patchRoomLiveState(roomId, {
      ended: true,
      endedBy: userId ?? null,
    })

    io.to(roomId).emit("session_ended", { roomId, from: userId ?? null })
    console.log(`[session] ended via socket in room ${roomId}`, { userId })
  })

  socket.on(
    "swap_roles",
    async ({ roomId, newIntervieweeUserId }) => {
      if (!roomId || !newIntervieweeUserId) return

      const roleState = await loadRoomLiveState(roomId)
      const newInterviewerUserId =
        roleState.intervieweeUserId ?? getIntervieweeUserId(roomId)
      if (!newInterviewerUserId) {
        console.log(`[swap_roles] cannot swap — room ${roomId} missing peers`)
        return
      }

      console.log("[swap_roles] swapping roles only", {
        roomId,
        newInterviewerUserId,
        newIntervieweeUserId,
      })

      await patchRoomLiveState(roomId, {
        interviewerUserId: newInterviewerUserId,
        intervieweeUserId: newIntervieweeUserId,
        forceRoles: true,
      })

      roomFirstPeerUserId[roomId] = newInterviewerUserId
      roomFirstPeer[roomId] =
        userSocketMap[newInterviewerUserId] ?? roomFirstPeer[roomId]

      io.to(roomId).emit("roles_swapped", {
        newInterviewerUserId,
        newIntervieweeUserId,
      })
    },
  )

  socket.on("disconnect", () => {
    console.log(`[disconnect] Client disconnected: ${socket.id}`)
    for (const [userId, socketId] of Object.entries(userSocketMap)) {
      if (socketId === socket.id) {
        delete userSocketMap[userId]
        console.log(`[disconnect] removed userSocketMap entry for ${userId}`)
      }
    }
    removeFromAllPools(socket.id)
    removeFromAllRooms(socket.id)
  })
})

setInterval(checkScheduledMatching, 60_000)
checkScheduledMatching()

httpServer.listen(PORT, () => {
  console.log(`[server] PeerCode matching server running on http://localhost:${PORT}`)
  console.log(`[server] Socket.io CORS allowed for ${allowedOrigins.join(", ")}`)
  console.log("[email] Resend key loaded:", !!process.env.RESEND_API_KEY)
  console.log(
    "[email] Resend from:",
    process.env.RESEND_FROM_EMAIL || "PeerCode <onboarding@resend.dev>",
  )
  if (!supabase) {
    console.warn(
      "[server] SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY not set — scheduled DB matching disabled",
    )
  } else {
    console.log("[server] Scheduled matching enabled (IST slots:", SCHEDULED_SLOT_TIMES.join(", "), ")")
  }
})
