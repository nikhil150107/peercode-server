import { v4 as uuidv4 } from "uuid"
import { loadRoomLiveState, patchRoomLiveState } from "../services/roomService.js"

export function registerChatHandler(socket) {
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
}
