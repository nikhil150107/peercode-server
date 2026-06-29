import express from "express"
import cors from "cors"
import { allowedOrigins } from "./config/constants.js"
import { waitingPool } from "./state/roomState.js"
import { supabase } from "./config/supabase.js"

export function createApp() {
  const app = express()
  app.use(cors({ origin: allowedOrigins }))
  app.use(express.json())

  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      waitingPools: Object.keys(waitingPool).length,
      supabaseConfigured: Boolean(supabase),
      resendConfigured: Boolean(process.env.RESEND_API_KEY),
    })
  })

  return app
}
