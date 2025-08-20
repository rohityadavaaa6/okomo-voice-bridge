// server.js — Outbound-ready WS bridge + diag + from-override (ESM)

import express from "express";
import bodyParser from "body-parser";
import { WebSocketServer } from "ws";

// --- Twilio creds via env (Secret Manager) ---
const TWILIO_SID   = process.env.TWILIO_ACCOUNT_SID || "";
const TWILIO_TOKEN = process.env.TWILIO_AUTH_TOKEN || "";
const DEFAULT_FROM = process.env.TWILIO_FROM || ""; // e.g., +918199969966 (verified) or your Twilio DID

const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));

// ---------- helpers ----------
const isE164 = (n) => typeof n === "string" && /^\+\d{8,15}$/.test(n);
function maskSid(sid) {
  return sid ? `${sid.slice(0,6)}...${sid.slice(-4)}` : null;
}

// TEMP diag to confirm env actually mounted in Cloud Run
app.get("/diag", (_req, res) => {
  res.json({
    sid_masked: maskSid(TWILIO_SID),
    from: DEFAULT_FROM,
    has_token: Boolean(TWILIO_TOKEN),
    ts: new Date().toISOString(),
  });
});

// Health check
app.get("/healthz", (_req, res) => res.status(200).send("ok"));

// Inbound Twilio webhook -> TwiML that starts bidirectional Media Stream
app.post("/voice", (req, res) => {
  const host = req.get("host");
  const wsUrl = `wss://${host}/twilio-ws`;
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>Connecting you to the Okomo three sixty assistant.</Say>
  <Connect><Stream url="${wsUrl}"/></Connect>
</Response>`;
  res.type("text/xml").send(twiml);
});

// ---- OUTBOUND: POST /call { "to": "+91...", "from": "+1..." (optional) } ----
async function twilioCreateCall(to, url, from) {
  const api = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Calls.json`;
  const body = new URLSearchParams({
    To: to,
    From: from,          // must be a Twilio-owned number OR a Verified Caller ID on THIS account
    Url: url,            // TwiML URL Twilio will fetch (our /voice)
    Method: "POST",
  }).toString();

  const r = await fetch(api, {
    method: "POST",
    headers: {
      "Authorization": "Basic " + Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`Twilio call failed ${r.status} ${text}`);
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

app.post("/call", async (req, res) => {
  try {
    const to = (req.body?.to || "").trim();
    const from = (req.body?.from || DEFAULT_FROM || "").trim();
    if (!isE164(to)) return res.status(400).json({ error: "`to` must be E.164 (e.g., +919650669952)" });
    if (!isE164(from)) return res.status(400).json({ error: "`from` must be E.164 and owned/verified on this account" });

    const voiceUrl = `https://${req.get("host")}/voice`;
    const resp = await twilioCreateCall(to, voiceUrl, from);
    res.json({ sid: resp.sid, status: resp.status || "queued", from, to });
  } catch (e) {
    console.error("outbound error:", e?.message || e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Start HTTP server first (Cloud Run binds to PORT)
const PORT = Number(process.env.PORT) || 8080;
const server = app.listen(PORT, "0.0.0.0", () => {
  console.log("Server listening on", PORT);
});

// WebSocket for Twilio Media Streams
const wss = new WebSocketServer({ server, path: "/twilio-ws" });

wss.on("connection", (ws) => {
  console.log("WS connected");
  let streamSid = null;

  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.event === "start") {
        streamSid = msg.start.streamSid;
        console.log("start:", streamSid);
        // Clear Twilio's audio buffer; we'll send audio when AI is wired
        ws.send(JSON.stringify({ event: "clear", streamSid }));
      } else if (msg.event === "media") {
        // inbound μ-law 8k base64; will feed to STT/Vertex next
      } else if (msg.event === "stop") {
        console.log("stop:", streamSid);
      } else if (msg.event) {
        console.log("event:", msg.event);
      }
    } catch (e) {
      console.error("WS parse error:", e);
    }
  });

  ws.on("close", () => console.log("WS closed"));
  ws.on("error", (e) => console.error("WS error:", e));
});

