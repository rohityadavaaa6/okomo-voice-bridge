// server.js — outbound-ready voice bridge (ESM)

import express from "express";
import bodyParser from "body-parser";
import { WebSocketServer } from "ws";

// ---------- env / secrets ----------
const TWILIO_SID   = process.env.TWILIO_ACCOUNT_SID || "";
const TWILIO_TOKEN = process.env.TWILIO_AUTH_TOKEN  || "";
const TWILIO_FROM  = process.env.TWILIO_FROM        || ""; // your Twilio number or verified caller ID

// Basic sanity logs (masked)
const mask = (s) => (s ? s.replace(/^(.{6}).*(.{4})$/, "$1…$2") : "(missing)");
console.log("[boot] TWILIO_ACCOUNT_SID:", mask(TWILIO_SID));
console.log("[boot] TWILIO_FROM:", TWILIO_FROM || "(missing)");

// ---------- tiny μ-law + beep helpers ----------
const MU_LAW_MAX = 0x1FFF, BIAS = 0x84, QUANT_MASK = 0x0F, SEG_SHIFT = 4;
function linear2ulaw(sample) {
  let pcm = Math.max(-32768, Math.min(32767, sample));
  const sign = (pcm >> 8) & 0x80;
  if (sign !== 0) pcm = -pcm;
  if (pcm > MU_LAW_MAX) pcm = MU_LAW_MAX;
  pcm = pcm + BIAS;
  let seg = 0; for (let v = pcm >> 7; v; v >>= 1) seg++;
  const uval = (seg << SEG_SHIFT) | ((pcm >> (seg + 3)) & QUANT_MASK);
  return ~(uval | sign) & 0xFF;
}
function makeBeepFrames({ secs = 2, freq = 440 }) {
  const sr = 8000, N = sr * secs, CHUNK = 160; // 20ms frames for Twilio
  const ulaw = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    const s = Math.sin((2 * Math.PI * freq * i) / sr) * 0.4; // ~-8 dBFS
    ulaw[i] = linear2ulaw((s * 32767) | 0);
  }
  const frames = [];
  for (let i = 0; i < ulaw.length; i += CHUNK) {
    frames.push(Buffer.from(ulaw.slice(i, i + CHUNK)).toString("base64"));
  }
  return frames;
}
const BEEP_FRAMES = makeBeepFrames({ secs: 2, freq: 440 });

// ---------- app ----------
const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));

// Health
app.get("/healthz", (_req, res) => res.status(200).send("ok"));

// Twilio will fetch this after we create the call.
// It asks Twilio to open a bidirectional Media Stream back to us.
app.post("/voice", (req, res) => {
  const host = req.get("host");
  const wsUrl = `wss://${host}/twilio-ws`;
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>Connecting you to the Okomo three sixty assistant.</Say>
  <Connect>
    <Stream url="${wsUrl}" />
  </Connect>
</Response>`;
  res.type("text/xml").send(twiml);
});

// Create an outbound call via Twilio REST API
async function twilioCreateCall({ to, from, voiceUrl }) {
  if (!TWILIO_SID || !TWILIO_TOKEN) {
    throw new Error("Missing Twilio SID/TOKEN env vars");
  }
  const api = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Calls.json`;

  const body = new URLSearchParams({
    To: to,
    From: from || TWILIO_FROM, // allow override, else default
    Url: voiceUrl,
    Method: "POST"
  }).toString();

  const r = await fetch(api, {
    method: "POST",
    headers: {
      "Authorization": "Basic " + Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body
  });

  if (!r.ok) throw new Error(`Twilio call failed ${r.status} ${await r.text()}`);
  return r.json();
}

// POST /call { "to": "+91xxxxxxxxxx", "from": "+1xxxxxxxxxx" (optional) }
app.post("/call", async (req, res) => {
  try {
    const to = (req.body?.to || "").trim();
    const from = (req.body?.from || "").trim();
    if (!to) return res.status(400).json({ error: "`to` (E.164) is required" });

    const voiceUrl = `https://${req.get("host")}/voice`;

    const result = await twilioCreateCall({ to, from, voiceUrl });
    console.log("[/call] created", result.sid, result.status);
    res.json({ sid: result.sid, status: result.status });
  } catch (e) {
    console.error("[/call] error", e);
    res.status(500).json({ error: e.message });
  }
});

// ---------- Diagnostics ----------
app.get("/diag", (_req, res) => {
  res.json({
    sid_masked: mask(TWILIO_SID),
    from: TWILIO_FROM || null,
    has_token: Boolean(TWILIO_TOKEN)
  });
});

app.get("/diag/twilio", async (_req, res) => {
  try {
    if (!TWILIO_SID || !TWILIO_TOKEN) {
      return res.status(400).json({ error: "Missing Twilio SID/TOKEN env vars" });
    }
    // Verified caller IDs
    const v = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/OutgoingCallerIds.json`,
      { headers: { Authorization: "Basic " + Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString("base64") } }
    ).then(r => r.json());

    // Bought numbers on the account (optional)
    const n = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/IncomingPhoneNumbers.json`,
      { headers: { Authorization: "Basic " + Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString("base64") } }
    ).then(r => r.json());

    res.json({
      sid_masked: mask(TWILIO_SID),
      verified: (v?.outgoing_caller_ids || []).map(x => x.phone_number),
      owned: (n?.incoming_phone_numbers || []).map(x => x.phone_number)
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ---------- start HTTP first ----------
const PORT = Number(process.env.PORT) || 8080;
const server = app.listen(PORT, "0.0.0.0", () => {
  console.log("[boot] HTTP listening on", PORT);
});

// ---------- WebSocket for Twilio Media Streams ----------
const wss = new WebSocketServer({ server, path: "/twilio-ws" });

wss.on("connection", (ws) => {
  console.log("[ws] connected");
  let streamSid = null;

  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      if (msg.event === "start") {
        streamSid = msg.start?.streamSid;
        console.log("[ws] start", streamSid);

        // clear Twilio’s jitter buffer
        ws.send(JSON.stringify({ event: "clear", streamSid }));

        // play a short beep so the caller hears audio after “Connecting…”
        let i = 0;
        const t = setInterval(() => {
          if (ws.readyState !== ws.OPEN) return clearInterval(t);
          if (i >= BEEP_FRAMES.length) return clearInterval(t);
          ws.send(JSON.stringify({
            event: "media",
            streamSid,
            media: { payload: BEEP_FRAMES[i++] }
          }));
        }, 20); // 20ms/frame
      }

      else if (msg.event === "media") {
        // inbound base64 μ-law (8kHz) frames from the caller
        // (feed to STT in the next step)
      }

      else if (msg.event === "stop") {
        console.log("[ws] stop", streamSid);
      }
    } catch (e) {
      console.error("[ws] parse error", e);
    }
  });

  ws.on("close", () => console.log("[ws] closed"));
  ws.on("error", (e) => console.error("[ws] error", e));
});



