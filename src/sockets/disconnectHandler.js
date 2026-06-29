import { roomPeers, userSocketMap } from "../state/roomState.js"
import { removeFromAllPools, clearRoomState } from "../services/matchService.js"

export function removeFromAllRooms(io, socketId) {
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

export function registerDisconnectHandler(socket, io) {
  socket.on("disconnect", () => {
    console.log(`[disconnect] Client disconnected: ${socket.id}`)
    for (const [userId, socketId] of Object.entries(userSocketMap)) {
      if (socketId === socket.id) {
        delete userSocketMap[userId]
        console.log(`[disconnect] removed userSocketMap entry for ${userId}`)
      }
    }
    removeFromAllPools(socket.id)
    removeFromAllRooms(io, socket.id)
  })
}
