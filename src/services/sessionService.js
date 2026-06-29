import { SESSION_DURATION_SECONDS } from "../config/constants.js"
import {
  roomQuestions,
  roomPeers,
  roomTimerStarted,
} from "../state/roomState.js"
import {
  loadRoomLiveState,
  patchRoomLiveState,
} from "./roomService.js"

export async function buildSessionEndedPayload(roomId, fromUserId = null) {
  const liveState = await loadRoomLiveState(roomId)
  const question = roomQuestions[roomId] ?? liveState.question

  let durationSeconds = 0
  if (liveState.timerStarted && liveState.timerStartedAt) {
    durationSeconds = Math.floor((Date.now() - liveState.timerStartedAt) / 1000)
  } else if (liveState.secondsLeft != null) {
    durationSeconds = Math.max(
      0,
      SESSION_DURATION_SECONDS - liveState.secondsLeft,
    )
  }

  return {
    roomId,
    from: fromUserId ?? null,
    questionTitle: question?.title ?? null,
    questionDifficulty: question?.difficulty ?? null,
    questionTopic: question?.topic ?? null,
    durationSeconds,
    interviewerUserId: liveState.interviewerUserId ?? null,
    intervieweeUserId: liveState.intervieweeUserId ?? null,
  }
}

export async function emitSessionEnded(io, roomId, fromUserId = null) {
  const payload = await buildSessionEndedPayload(roomId, fromUserId)
  io.to(roomId).emit("session_ended", payload)
  console.log("[session] session_ended emitted", payload)
  return payload
}

export async function emitStartTimerIfReady(io, roomId) {
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
