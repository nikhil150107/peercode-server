import dotenv from "dotenv"
import path from "path"
import { fileURLToPath } from "url"
import { Resend } from "resend"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.resolve(__dirname, "../../.env") })

let resendClient = null

function getResend() {
  if (!process.env.RESEND_API_KEY) return null
  if (!resendClient) {
    resendClient = new Resend(process.env.RESEND_API_KEY)
  }
  return resendClient
}

function getFromEmail() {
  return process.env.RESEND_FROM_EMAIL || "PeerCode <onboarding@resend.dev>"
}

function getClientUrl() {
  return process.env.CLIENT_URL || "http://localhost:5173"
}

const SLOT_TIME_TO_ID = {
  "10:00 AM": "slot-10am",
  "12:00 PM": "slot-12pm",
  "3:00 PM": "slot-3pm",
  "6:00 PM": "slot-6pm",
  "10:00 PM": "slot-10pm",
}

function formatDateLabel(dateStr) {
  const date = new Date(`${dateStr}T12:00:00`)
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    weekday: "long",
    month: "long",
    day: "numeric",
  }).format(date)
}

function slotIdForTime(slotTime) {
  return SLOT_TIME_TO_ID[slotTime] ?? "slot-6pm"
}

function emailLayout(title, bodyHtml) {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
</head>
<body style="margin:0;padding:0;background:#09090b;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#09090b;padding:32px 16px;">
    <tr>
      <td align="center">
        <table width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#18181b;border:1px solid #27272a;border-radius:16px;overflow:hidden;">
          <tr>
            <td style="padding:28px 32px 8px;">
              <p style="margin:0;font-size:13px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:#34d399;">PeerCode</p>
              <h1 style="margin:12px 0 0;font-size:22px;font-weight:700;color:#fafafa;line-height:1.3;">${title}</h1>
            </td>
          </tr>
          <tr>
            <td style="padding:8px 32px 24px;color:#a1a1aa;font-size:15px;line-height:1.6;">
              ${bodyHtml}
            </td>
          </tr>
          <tr>
            <td style="padding:0 32px 28px;border-top:1px solid #27272a;">
              <p style="margin:20px 0 0;font-size:13px;color:#71717a;text-align:center;">
                Made with ❤️ by Nikhil Jatale
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`
}

function buttonHtml(href, label) {
  return `<p style="margin:24px 0 0;">
    <a href="${href}" style="display:inline-block;background:#10b981;color:#09090b;font-weight:600;font-size:14px;text-decoration:none;padding:12px 24px;border-radius:8px;">
      ${label}
    </a>
  </p>`
}

async function sendEmail(to, subject, html) {
  const resend = getResend()
  if (!resend) {
    console.warn("[email] RESEND_API_KEY not set — skipping email to", to)
    return { ok: false }
  }

  try {
    const { data, error } = await resend.emails.send({
      from: getFromEmail(),
      to,
      subject,
      html,
    })

    if (error) {
      console.error(`[email] Failed to send to ${to}:`, error.message)
      return { ok: false, error }
    }

    console.log(`[email] Sent "${subject}" to ${to} (id: ${data?.id})`)
    return { ok: true, id: data?.id }
  } catch (err) {
    console.error(`[email] Error sending to ${to}:`, err.message)
    return { ok: false, error: err }
  }
}

export async function sendBookingConfirmation(
  userEmail,
  slotTime,
  date,
  slotId,
) {
  const resolvedSlotId = slotId || slotIdForTime(slotTime)
  const dateLabel = formatDateLabel(date)
  const waitingUrl = `${getClientUrl()}/waiting?slot=${resolvedSlotId}&date=${date}`

  const html = emailLayout(
    `Interview booked for ${slotTime}`,
    `<p>Your slot is confirmed for <strong style="color:#fafafa;">${dateLabel}</strong> at <strong style="color:#fafafa;">${slotTime} IST</strong>.</p>
     <p>We'll match you with a peer at that time. Make sure to be online <strong style="color:#fafafa;">5 minutes before</strong> your session starts.</p>
     ${buttonHtml(waitingUrl, "Open waiting room")}`,
  )

  return sendEmail(
    userEmail,
    `Your PeerCode interview is booked for ${slotTime}`,
    html,
  )
}

export async function sendMatchConfirmation(
  user1Email,
  user2Email,
  roomId,
  slotTime,
  topicPref,
  difficultyPref,
) {
  const interviewUrl = `${getClientUrl()}/interview?room=${roomId}`
  const topic = topicPref || "Any"
  const difficulty = difficultyPref || "Random"

  const interviewerHtml = emailLayout(
    "Match found — you're the interviewer",
    `<p>You've been matched with a peer! Your session is ready to start.</p>
     <p><strong style="color:#fafafa;">Session time:</strong> ${slotTime} IST<br />
     <strong style="color:#fafafa;">Topic:</strong> ${topic}<br />
     <strong style="color:#fafafa;">Difficulty:</strong> ${difficulty}</p>
     <p>As the <strong style="color:#fafafa;">interviewer</strong>, you'll see hints to guide your peer. Ask clarifying questions and help them think through the problem — don't give away the answer.</p>
     ${buttonHtml(interviewUrl, "Join room")}`,
  )

  const intervieweeHtml = emailLayout(
    "Match found — good luck!",
    `<p>You've been matched with a peer! Your session is ready to start.</p>
     <p><strong style="color:#fafafa;">Session time:</strong> ${slotTime} IST<br />
     <strong style="color:#fafafa;">Topic:</strong> ${topic}<br />
     <strong style="color:#fafafa;">Difficulty:</strong> ${difficulty}</p>
     <p>As the <strong style="color:#fafafa;">interviewee</strong>, you'll solve the coding challenge in the shared editor. Think out loud, ask questions, and do your best — <strong style="color:#34d399;">good luck!</strong></p>
     ${buttonHtml(interviewUrl, "Join room")}`,
  )

  const subject = "Match found! Your PeerCode interview starts now"

  const [result1, result2] = await Promise.all([
    sendEmail(user1Email, subject, interviewerHtml),
    sendEmail(user2Email, subject, intervieweeHtml),
  ])

  return { user1: result1, user2: result2 }
}

export async function sendNoMatchFound(userEmail, slotTime, slotDate) {
  const dateLabel = formatDateLabel(slotDate)
  const dashboardUrl = `${getClientUrl()}/dashboard`

  const html = emailLayout(
    `No match found for your ${slotTime} slot`,
    `<p>Unfortunately we couldn't find a match for your <strong style="color:#fafafa;">${slotTime}</strong> slot on <strong style="color:#fafafa;">${dateLabel}</strong>.</p>
     <p>Book another slot and we'll try again!</p>
     ${buttonHtml(dashboardUrl, "Book another slot")}`,
  )

  return sendEmail(
    userEmail,
    `No match found for your ${slotTime} slot`,
    html,
  )
}
