import { waitingPool, userSocketMap } from "../state/roomState.js"
import {
  getTodayISTDate,
  poolKey,
  removeFromAllPools,
  isInMatchWindow,
  matchUsersForSlot,
  notifyUserIfAlreadyMatched,
} from "../services/matchService.js"

export function registerWaitingHandler(socket, io) {
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
        void matchUsersForSlot(io, slotTime, date)
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
}
