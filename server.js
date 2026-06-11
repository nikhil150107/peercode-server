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
  "3:00 PM",
  "6:00 PM",
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

const SESSION_DURATION_SECONDS = 45 * 60

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

function getCurrentISTSlotTime() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Kolkata",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).formatToParts(new Date())

  const hour = parts.find((p) => p.type === "hour")?.value ?? "0"
  const minute = parts.find((p) => p.type === "minute")?.value ?? "00"
  const dayPeriod =
    parts.find((p) => p.type === "dayPeriod")?.value?.toUpperCase() ?? "AM"

  return `${hour}:${minute} ${dayPeriod}`
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
  const peers = roomPeers[roomId]
  const firstUserId = roomFirstPeerUserId[roomId]
  if (!peers || !firstUserId) return null

  for (const userId of peers.keys()) {
    if (userId !== firstUserId) return userId
  }
  return null
}

function maybeTriggerQuestionFetch(roomId) {
  if (roomQuestions[roomId]) return
  if (!roomPeers[roomId] || roomPeers[roomId].size < 2) return

  const intervieweeUserId = getIntervieweeUserId(roomId)
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

function emitStartTimerIfReady(roomId) {
  if (!roomPeers[roomId] || roomPeers[roomId].size < 2) return
  if (roomTimerStarted[roomId]) return

  roomTimerStarted[roomId] = true
  io.to(roomId).emit("start_timer", {
    roomId,
    durationSeconds: SESSION_DURATION_SECONDS,
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
    .eq("status", "waiting")

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
    .eq("status", "waiting")
    .order("created_at", { ascending: true })

  if (error) {
    console.error("[scheduler] Failed to fetch bookings:", error.message)
    return
  }

  if (!bookings || bookings.length === 0) {
    console.log(`[scheduler] No waiting users for ${slotTime} on ${slotDate}`)
    return
  }

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

    const { error: update2Error } = await supabase
      .from("slot_bookings")
      .update({
        status: "matched",
        matched_with: booking1.user_id,
        room_id: roomId,
      })
      .eq("id", booking2.id)

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

    if (user1.socketId && user2.socketId) {
      emitMatchToPair(user1, user2, roomId, slotTime)
    } else {
      console.log(
        `[scheduler] Pair matched in DB (room ${roomId}) but one or both users offline — emails still sent`,
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
      const emailResult = await sendMatchConfirmation(
        user1Email,
        user2Email,
        roomId,
        slotTime,
        topicPref,
        difficultyPref,
      )

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
    console.log(
      `[scheduler] ${unmatchedBookings.length} unmatched user(s) for ${slotTime} on ${slotDate}`,
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
  }
}

function checkScheduledMatching() {
  const slotTime = getCurrentISTSlotTime()
  const today = getTodayISTDate()

  if (!SCHEDULED_SLOT_TIMES.includes(slotTime)) return

  const checkKey = `${slotTime}-${today}`
  if (processedSlotDates.has(checkKey)) return

  processedSlotDates.add(checkKey)
  console.log(`[scheduler] Slot time reached: ${slotTime} IST on ${today}`)
  void matchUsersForSlot(slotTime, today)
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

  socket.on("join_room", ({ roomId, userId }) => {
    if (!roomId || !userId) return

    const hasStoredQuestion = Boolean(roomQuestions[roomId])
    console.log("[join_room] received", {
      roomId,
      socketId: socket.id,
      userId,
      hasStoredQuestion,
      storedQuestionTitle: roomQuestions[roomId]?.title ?? null,
    })

    socket.join(roomId)

    if (!roomPeers[roomId]) {
      roomPeers[roomId] = new Map()
    }

    const prevPeerCount = roomPeers[roomId].size
    roomPeers[roomId].set(userId, socket.id)
    userSocketMap[userId] = socket.id

    if (!roomFirstPeer[roomId]) {
      roomFirstPeer[roomId] = socket.id
      roomFirstPeerUserId[roomId] = userId
      console.log(`[join_room] ${userId} is first peer in room ${roomId}`)
    }

    const peers = Array.from(roomPeers[roomId].keys())
    const isFirstPeer = roomFirstPeer[roomId] === socket.id
    console.log(`[join_room] ${userId} joined room ${roomId} (${peers.length}/2)`, {
      isFirstPeer,
    })

    socket.emit("room_joined", {
      roomId,
      peerCount: peers.length,
      isFirstPeer,
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

    console.log(
      `[request_question] no question yet for ${socket.id}, waiting for both peers`,
    )
    maybeTriggerQuestionFetch(roomId)
  },
  )

  socket.on("question_selected", ({ roomId, question, userId }) => {
    if (!roomId || !question || !userId) return

    console.log("[question_selected] received", {
      roomId,
      socketId: socket.id,
      userId,
      questionTitle: question.title,
    })

    roomQuestions[roomId] = question
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

  socket.on("code_change", ({ roomId, code, language, userId }) => {
    if (!roomId || !userId) return
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
    "swap_roles",
    ({
      roomId,
      newIntervieweeUserId,
      newIntervieweeDifficulty,
      newIntervieweeTopic,
    }) => {
      if (!roomId || !newIntervieweeUserId) return

      const pref = VALID_DIFFICULTY_PREFS.has(newIntervieweeDifficulty)
        ? newIntervieweeDifficulty
        : "Random"
      const topic = VALID_TOPIC_PREFS.has(newIntervieweeTopic)
        ? newIntervieweeTopic
        : "Any"

      const newInterviewerUserId = getIntervieweeUserId(roomId)
      if (!newInterviewerUserId) {
        console.log(`[swap_roles] cannot swap — room ${roomId} missing peers`)
        return
      }

      console.log("[swap_roles] swapping roles in room", {
        roomId,
        newInterviewerUserId,
        newIntervieweeUserId,
        newIntervieweeDifficulty: pref,
        newIntervieweeTopic: topic,
      })

      roomFirstPeerUserId[roomId] = newInterviewerUserId
      roomFirstPeer[roomId] = userSocketMap[newInterviewerUserId] ?? roomFirstPeer[roomId]

      delete roomQuestions[roomId]

      if (!roomPeerDifficultyPrefs[roomId]) {
        roomPeerDifficultyPrefs[roomId] = {}
      }
      if (!roomPeerTopicPrefs[roomId]) {
        roomPeerTopicPrefs[roomId] = {}
      }
      roomPeerDifficultyPrefs[roomId][newIntervieweeUserId] = pref
      roomPeerTopicPrefs[roomId][newIntervieweeUserId] = topic
      roomDifficultyPref[roomId] = pref
      roomTopicPref[roomId] = topic

      io.to(roomId).emit("roles_swapped", {
        newInterviewerUserId,
        newIntervieweeUserId,
      })

      sendFetchQuestionToUser(newIntervieweeUserId, roomId, pref, topic)
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
