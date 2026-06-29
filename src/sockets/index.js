import { registerWaitingHandler } from "./waitingHandler.js"
import { registerRoomHandler } from "./roomHandler.js"
import { registerWebrtcHandler } from "./webrtcHandler.js"
import { registerCodeHandler } from "./codeHandler.js"
import { registerChatHandler } from "./chatHandler.js"
import { registerSessionHandler } from "./sessionHandler.js"
import { registerDisconnectHandler } from "./disconnectHandler.js"

export function registerSocketHandlers(io) {
  io.on("connection", (socket) => {
    console.log(`[connect] Client connected: ${socket.id}`)

    registerWaitingHandler(socket, io)
    registerRoomHandler(socket, io)
    registerWebrtcHandler(socket)
    registerCodeHandler(socket, io)
    registerChatHandler(socket)
    registerSessionHandler(socket, io)
    registerDisconnectHandler(socket, io)
  })
}
