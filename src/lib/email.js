import dotenv from "dotenv"
import path from "path"
import { fileURLToPath } from "url"
import { Resend } from "resend"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.resolve(__dirname, "../../.env") })

const BRAND_GREEN = "#10b981"
const BRAND_DARK = "#09090b"
const SURFACE = "#18181b"
const BORDER = "#27272a"
const TEXT = "#fafafa"
const TEXT_MUTED = "#a1a1aa"
const TEXT_SUBTLE = "#71717a"

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

function emailLayout({ title, preheader, bodyHtml, cta }) {
  const ctaBlock = cta
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:28px 0 0;">
        <tr>
          <td style="border-radius:10px;background:${BRAND_GREEN};">
            <a href="${cta.href}" style="display:inline-block;padding:14px 28px;font-size:15px;font-weight:600;color:${BRAND_DARK};text-decoration:none;">
              ${cta.label}
            </a>
          </td>
        </tr>
      </table>`
    : ""

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="color-scheme" content="dark light" />
  <meta name="supported-color-schemes" content="dark light" />
  <title>${title}</title>
  <!--[if mso]><style>body,table,td{font-family:Arial,sans-serif!important;}</style><![endif]-->
  <style>
    @media only screen and (max-width: 620px) {
      .container { width: 100% !important; }
      .content { padding: 24px 20px !important; }
      .hero-title { font-size: 22px !important; line-height: 1.35 !important; }
    }
  </style>
</head>
<body style="margin:0;padding:0;background:${BRAND_DARK};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;-webkit-font-smoothing:antialiased;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${preheader ?? title}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BRAND_DARK};padding:32px 12px;">
    <tr>
      <td align="center">
        <table role="presentation" class="container" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:${SURFACE};border:1px solid ${BORDER};border-radius:16px;overflow:hidden;">
          <tr>
            <td style="padding:24px 32px 0;background:linear-gradient(180deg,rgba(16,185,129,0.12) 0%,rgba(16,185,129,0) 100%);">
              <p style="margin:0;font-size:12px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:${BRAND_GREEN};">PeerCode</p>
            </td>
          </tr>
          <tr>
            <td class="content hero-title" style="padding:12px 32px 0;font-size:26px;font-weight:700;line-height:1.3;color:${TEXT};">
              ${title}
            </td>
          </tr>
          <tr>
            <td class="content" style="padding:16px 32px 28px;font-size:16px;line-height:1.65;color:${TEXT_MUTED};">
              ${bodyHtml}
              ${ctaBlock}
            </td>
          </tr>
          <tr>
            <td style="padding:20px 32px 28px;border-top:1px solid ${BORDER};background:${BRAND_DARK};">
              <p style="margin:0;font-size:13px;line-height:1.5;color:${TEXT_SUBTLE};text-align:center;">
                PeerCode — practice DSA interviews with real peers.<br />
                <a href="${getClientUrl()}" style="color:${BRAND_GREEN};text-decoration:none;">peercode.live</a>
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

function infoCard(label, value) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:20px 0 0;background:${BRAND_DARK};border:1px solid ${BORDER};border-radius:12px;">
    <tr>
      <td style="padding:16px 18px;">
        <p style="margin:0 0 4px;font-size:12px;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;color:${TEXT_SUBTLE};">${label}</p>
        <p style="margin:0;font-size:17px;font-weight:600;line-height:1.4;color:${TEXT};">${value}</p>
      </td>
    </tr>
  </table>`
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
  _slotId,
) {
  const dateLabel = formatDateLabel(date)
  const dateAndTime = `${dateLabel} at ${slotTime} IST`

  const html = emailLayout({
    title: "Your slot is booked",
    preheader: `PeerCode session booked for ${dateAndTime}`,
    bodyHtml: `<p style="margin:0 0 12px;">You're all set for your next mock interview session.</p>
      ${infoCard("Session time", dateAndTime)}
      <p style="margin:20px 0 0;">We'll email you as soon as a peer is matched. Join from the dashboard when it's time.</p>`,
  })

  return sendEmail(userEmail, "Slot Booked — PeerCode", html)
}

export async function sendMatchConfirmation(
  user1Email,
  user2Email,
  roomId,
  slotTime,
  _topicPref,
  _difficultyPref,
) {
  console.log(
    `[email] sendMatchConfirmation called — user1=${user1Email} user2=${user2Email} room=${roomId}`,
  )
  const interviewUrl = `${getClientUrl()}/interview?room=${roomId}`
  const subject = "Peer Matched — PeerCode"

  const html = emailLayout({
    title: "You've been matched!",
    preheader: `Join your PeerCode interview room for ${slotTime} IST`,
    bodyHtml: `<p style="margin:0 0 12px;">Great news — a peer is ready for your session at <strong style="color:${TEXT};">${slotTime} IST</strong>.</p>
      ${infoCard("Interview room", roomId)}
      <p style="margin:20px 0 0;">Open the room a few minutes early to test your camera and mic. One of you will interview while the other codes, then you'll swap roles mid-session.</p>
      <p style="margin:16px 0 0;font-size:13px;line-height:1.5;color:${TEXT_SUBTLE};word-break:break-all;">Direct link: ${interviewUrl}</p>`,
    cta: { href: interviewUrl, label: "Join interview room" },
  })

  const [result1, result2] = await Promise.all([
    sendEmail(user1Email, subject, html),
    sendEmail(user2Email, subject, html),
  ])

  return { user1: result1, user2: result2 }
}

export async function sendNoMatchFound(
  userEmail,
  userName,
  slotTime,
  slotDate,
  { isToday = true } = {},
) {
  const shareUrl = getClientUrl()
  const whenLabel = isToday ? "today" : `on ${formatDateLabel(slotDate)}`
  const greetingName = userName?.trim() || "there"

  const html = emailLayout({
    title: "No peer match this time",
    preheader: `We couldn't find a peer for your ${slotTime} session`,
    bodyHtml: `<p style="margin:0 0 12px;">Hey <strong style="color:${TEXT};">${greetingName}</strong>,</p>
      <p style="margin:0 0 12px;">We weren't able to find a peer for your session at <strong style="color:${TEXT};">${slotTime}</strong> ${whenLabel}.</p>
      ${infoCard("What you can do", "Book the next slot or invite friends to join PeerCode")}
      <p style="margin:20px 0 0;">The more engineers on PeerCode, the faster matching gets for everyone. Share the link with classmates and interview prep groups:</p>
      <p style="margin:12px 0 0;"><a href="${shareUrl}" style="color:${BRAND_GREEN};font-weight:600;text-decoration:none;">${shareUrl}</a></p>
      <p style="margin:20px 0 0;">We'll see you at the next slot. Keep grinding!</p>`,
    cta: { href: shareUrl, label: "Share PeerCode" },
  })

  return sendEmail(
    userEmail,
    "We couldn't find a peer this time — PeerCode",
    html,
  )
}

export { slotIdForTime, formatDateLabel }
