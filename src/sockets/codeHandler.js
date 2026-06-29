import { patchRoomLiveState } from "../services/roomService.js"

export function registerCodeHandler(socket, io) {
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
}
