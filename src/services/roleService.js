import { supabase } from "../config/supabase.js"
import {
  roomPeers,
  roomFirstPeerUserId,
  roomRoleLocks,
  roomLiveCache,
} from "../state/roomState.js"
import {
  loadRoomLiveState,
  patchRoomLiveState,
  invalidateRoomLiveCache,
  getUserRoleFromState,
} from "./roomService.js"

export function withRoomRoleLock(roomId, fn) {
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

export async function tryClaimRoleSlot(roomId, userId, slot) {
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

export async function assignOrRestoreRole(roomId, userId, prevPeerCount = 0) {
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

export function getIntervieweeUserId(roomId) {
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
