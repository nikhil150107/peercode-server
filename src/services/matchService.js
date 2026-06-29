import { v4 as uuidv4 } from "uuid"
import { supabase } from "../config/supabase.js"
import {
  SCHEDULED_SLOT_TIMES,
  MATCH_BEFORE_MS,
  UNMATCHED_CANCEL_AFTER_MS,
} from "../config/constants.js"
import {
  waitingPool,
  roomPeers,
  roomQuestions,
  roomFirstPeer,
  roomFirstPeerUserId,
  roomPeerDifficultyPrefs,
  roomPeerTopicPrefs,
  roomDifficultyPref,
  roomTopicPref,
  userSocketMap,
  processedSlotDates,
  roomTimerStarted,
} from "../state/roomState.js"
import {
  sendMatchConfirmation,
  sendNoMatchFound,
} from "../lib/email.js"

export function getTodayISTDate() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date())
}

export function parseSlotHoursMinutes(slotTime) {
  const match = slotTime.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i)
  if (!match) return null

  let hours = parseInt(match[1], 10)
  const minutes = parseInt(match[2], 10)
  const period = match[3].toUpperCase()

  if (period === "PM" && hours !== 12) hours += 12
  if (period === "AM" && hours === 12) hours = 0

  return { hours, minutes }
}

export function computeSessionStartMs(slotTime, slotDate) {
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

export function isInMatchWindow(slotTime, slotDate) {
  const slotStartMs = computeSessionStartMs(slotTime, slotDate)
  if (slotStartMs == null) return false
  const now = Date.now()
  return (
    now >= slotStartMs - MATCH_BEFORE_MS &&
    now <= slotStartMs + UNMATCHED_CANCEL_AFTER_MS
  )
}

export function shouldCancelUnmatched(slotTime, slotDate) {
  const slotStartMs = computeSessionStartMs(slotTime, slotDate)
  if (slotStartMs == null) return false
  return Date.now() >= slotStartMs + UNMATCHED_CANCEL_AFTER_MS
}

export function poolKey(slotTime, slotDate) {
  return `${slotTime}-${slotDate}`
}

export function clearRoomState(roomId) {
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

export function removeFromAllPools(socketId) {
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

export async function fetchUserEmail(userId) {
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

export async function fetchUserName(userId) {
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

export async function handleUnmatchedUser(booking, slotTime, slotDate, poolEntry) {
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

export function emitMatchToPair(io, user1, user2, roomId, slotTime) {
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

export async function notifyUserIfAlreadyMatched(userId, slotTime, slotDate, socket) {
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

export async function matchUsersForSlot(io, slotTime, slotDate) {
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
      emitMatchToPair(io, user1, user2, roomId, slotTime)
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

export function checkScheduledMatching(io) {
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
      void matchUsersForSlot(io, slotTime, today)

      if (now >= slotStartMs + UNMATCHED_CANCEL_AFTER_MS) {
        processedSlotDates.add(checkKey)
      }
    }
  }
}
