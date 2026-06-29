export const PORT = process.env.PORT || 3001

export const allowedOrigins = [
  "https://peercode.live",
  "https://www.peercode.live",
  "http://localhost:5173",
]

export const SCHEDULED_SLOT_TIMES = [
  "10:00 AM",
  "12:00 PM",
  "2:00 PM",
  "4:00 PM",
  "6:00 PM",
  "8:00 PM",
  "10:00 PM",
]

export const SESSION_DURATION_SECONDS = 120 * 60

export const MATCH_BEFORE_MS = 3 * 60 * 1000
export const UNMATCHED_CANCEL_AFTER_MS = 3 * 60 * 1000

export const VALID_DIFFICULTY_PREFS = new Set(["Easy", "Medium", "Hard", "Random"])
export const VALID_TOPIC_PREFS = new Set([
  "Any",
  "Arrays",
  "Strings",
  "Trees",
  "Graphs",
  "DP",
  "Linked Lists",
])
