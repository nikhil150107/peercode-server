import { VALID_DIFFICULTY_PREFS, VALID_TOPIC_PREFS } from "../config/constants.js"
import {
  roomPeers,
  roomQuestions,
  roomFirstPeer,
  roomFirstPeerUserId,
  roomPeerDifficultyPrefs,
  roomPeerTopicPrefs,
  userSocketMap,
} from "../state/roomState.js"
import {
  loadRoomLiveState,
  patchRoomLiveState,
  toClientRoomState,
} from "../services/roomService.js"
import {
  withRoomRoleLock,
  assignOrRestoreRole,
} from "../services/roleService.js"
import {
  buildSessionEndedPayload,
  emitStartTimerIfReady,
} from "../services/sessionService.js"
import { maybeTriggerQuestionFetch } from "../services/questionService.js"

export function registerRoomHandler(socket, io) {
  socket.on("join_room", async ({ roomId, userId }) => {
    if (!roomId || !userId) return

    const liveState = await loadRoomLiveState(roomId)
    if (liveState.ended) {
      console.log(`[join_room] room ${roomId} has ended — sending ${userId} to feedback`)
      const payload = await buildSessionEndedPayload(roomId, liveState.endedBy)
      socket.emit("session_ended", payload)
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
      emitStartTimerIfReady(io, roomId)
      maybeTriggerQuestionFetch(io, roomId)
    }
  })

  socket.on(
    "request_question",
    async ({ roomId, userId, difficultyPreference, topicPreference }) => {
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
      void maybeTriggerQuestionFetch(io, roomId)
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
}
