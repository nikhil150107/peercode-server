import { supabase } from "../config/supabase.js"
import { SESSION_DURATION_SECONDS } from "../config/constants.js"
import { roomLiveCache } from "../state/roomState.js"

export function defaultRoomLiveState() {
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

export function getUserRoleFromState(state, userId) {
  if (!userId) return null
  if (state.interviewerUserId === userId) return "interviewer"
  if (state.intervieweeUserId === userId) return "interviewee"
  return null
}

export function toClientRoomState(state, userId = null) {
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

export async function loadRoomLiveState(roomId) {
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

export async function persistRoomLiveState(roomId, state) {
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

export async function patchRoomLiveState(roomId, patch) {
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

export function invalidateRoomLiveCache(roomId) {
  delete roomLiveCache[roomId]
}
