import {
  roomQuestions,
  roomPeers,
  roomPeerDifficultyPrefs,
  roomPeerTopicPrefs,
  roomDifficultyPref,
  roomTopicPref,
  userSocketMap,
} from "../state/roomState.js"
import { loadRoomLiveState } from "./roomService.js"
import { getIntervieweeUserId } from "./roleService.js"

export function sendFetchQuestionToUser(
  io,
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

export async function maybeTriggerQuestionFetch(io, roomId) {
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
  sendFetchQuestionToUser(io, intervieweeUserId, roomId, pref, topicPref)
}
