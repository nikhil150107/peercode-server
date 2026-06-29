export function registerWebrtcHandler(socket) {
  socket.on("webrtc_offer", ({ roomId, offer, userId }) => {
    console.log(`[webrtc] Offer from ${userId} in room ${roomId}`)
    socket.to(roomId).emit("webrtc_offer", { offer, from: userId })
  })

  socket.on("webrtc_answer", ({ roomId, answer, userId }) => {
    console.log(`[webrtc] Answer from ${userId} in room ${roomId}`)
    socket.to(roomId).emit("webrtc_answer", { answer, from: userId })
  })

  socket.on("webrtc_ice_candidate", ({ roomId, candidate, userId }) => {
    socket.to(roomId).emit("webrtc_ice_candidate", { candidate, from: userId })
  })
}
