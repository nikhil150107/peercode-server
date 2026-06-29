import {
  roomFirstPeer,
  roomFirstPeerUserId,
  userSocketMap,
} from "../state/roomState.js"
import {
  loadRoomLiveState,
  patchRoomLiveState,
} from "../services/roomService.js"
import { getIntervieweeUserId } from "../services/roleService.js"
import { emitSessionEnded } from "../services/sessionService.js"

export function registerSessionHandler(socket, io) {
  socket.on("end_session", async ({ roomId, userId }) => {
    if (!roomId) return

    await patchRoomLiveState(roomId, {
      ended: true,
      endedBy: userId ?? null,
    })

    await emitSessionEnded(io, roomId, userId ?? null)
    console.log(`[session] ended via socket in room ${roomId}`, { userId })
  })

  socket.on(
    "swap_roles",
    async ({ roomId, newIntervieweeUserId }) => {
      if (!roomId || !newIntervieweeUserId) return

      const roleState = await loadRoomLiveState(roomId)
      const newInterviewerUserId =
        roleState.intervieweeUserId ?? getIntervieweeUserId(roomId)
      if (!newInterviewerUserId) {
        console.log(`[swap_roles] cannot swap — room ${roomId} missing peers`)
        return
      }

      console.log("[swap_roles] swapping roles only", {
        roomId,
        newInterviewerUserId,
        newIntervieweeUserId,
      })

      await patchRoomLiveState(roomId, {
        interviewerUserId: newInterviewerUserId,
        intervieweeUserId: newIntervieweeUserId,
        forceRoles: true,
      })

      roomFirstPeerUserId[roomId] = newInterviewerUserId
      roomFirstPeer[roomId] =
        userSocketMap[newInterviewerUserId] ?? roomFirstPeer[roomId]

      io.to(roomId).emit("roles_swapped", {
        newInterviewerUserId,
        newIntervieweeUserId,
      })
    },
  )
}
