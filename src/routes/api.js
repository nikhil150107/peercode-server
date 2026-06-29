import {
  handleSendBookingEmail,
  handleFeedback,
} from "../controllers/emailController.js"
import { handleExecute } from "../controllers/executeController.js"
import {
  handleGetRoomState,
  handleGetRoomEnded,
  handlePutRoomState,
  handleEndRoomSession,
  handleSessionRatingReceived,
} from "../controllers/roomController.js"

export function mountApiRoutes(app, io) {
  app.post("/api/emails/booking-confirmation", handleSendBookingEmail)
  app.post("/api/emails/send-booking-email", handleSendBookingEmail)
  app.post("/api/feedback", handleFeedback)
  app.post("/api/execute", handleExecute)

  app.get("/api/room/:roomId/state", handleGetRoomState)
  app.get("/api/room/:roomId/ended", handleGetRoomEnded)
  app.put("/api/room/:roomId/state", handlePutRoomState)
  app.post("/api/room/:roomId/end", (req, res) =>
    handleEndRoomSession(req, res, io),
  )
  app.post("/api/sessions/rating-received", handleSessionRatingReceived)
}
