import { createServer } from "http"
import { Server } from "socket.io"
import { PORT, allowedOrigins, SCHEDULED_SLOT_TIMES } from "./src/config/constants.js"
import { supabase } from "./src/config/supabase.js"
import { createApp } from "./src/app.js"
import { mountApiRoutes } from "./src/routes/api.js"
import { registerSocketHandlers } from "./src/sockets/index.js"
import { checkScheduledMatching } from "./src/services/matchService.js"

const app = createApp()
const httpServer = createServer(app)
const io = new Server(httpServer, {
  cors: { origin: allowedOrigins, methods: ["GET", "POST"] },
})

mountApiRoutes(app, io)
registerSocketHandlers(io)

setInterval(() => checkScheduledMatching(io), 60_000)
checkScheduledMatching(io)

httpServer.listen(PORT, () => {
  console.log(`[server] PeerCode matching server running on http://localhost:${PORT}`)
  console.log(`[server] Socket.io CORS allowed for ${allowedOrigins.join(", ")}`)
  console.log("[email] Resend key loaded:", !!process.env.RESEND_API_KEY)
  console.log(
    "[email] Resend from:",
    process.env.RESEND_FROM_EMAIL || "PeerCode <onboarding@resend.dev>",
  )
  if (!supabase) {
    console.warn(
      "[server] SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY not set — scheduled DB matching disabled",
    )
  } else {
    console.log("[server] Scheduled matching enabled (IST slots:", SCHEDULED_SLOT_TIMES.join(", "), ")")
  }
})
