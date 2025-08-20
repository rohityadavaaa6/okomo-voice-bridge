// server.js — Twilio <-> Cloud Run bridge with outbound, TTS greeting, STT listening & reply (ESM)

import express from "express";
import bodyParser from "body-parser";
import { WebSocketServer } from "ws";
import textToSpeech from "@google-cloud/text-to-speech";
import speech from "@google-cloud/speech";

const ttsClient = new textToSpeech.TextToSpeechClient();
const speechClient = new speech.SpeechClient();

/* ===================== ENV / SECRETS ===================== */
const TWILIO_SID   = process.env.TWILIO_ACCOUNT_SID || "";
const TWILIO_TOKEN = process.env.TWILIO_AUTH_TOKEN  || "";
const TWILIO_FROM  = process.env.TWILIO_FROM        || ""; // e.g., +17755490708

const mask = (s) => (s ? s.replace(/^(.{6}).*(.{4})$/, "$1…$2") : "(missing)");
console.log("[boot] TWILIO_ACCOUNT_SID:", mask(TWILIO_SID));
console.log("[boot] TWILIO_FROM:", TWILIO_FROM || "(missing)");

/* ===================== μ-LAW BEEP (warm-up) ===================== */
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
function makeBeepFrames({ secs = 1, freq = 440 }) {
  const sr = 8000, N = sr * secs, CHUNK = 160;
  const ulaw = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    const s = Math.sin((2 * Math.PI * freq * i) / sr) * 0.35;
    ulaw[i] = linear2ulaw((s * 32767) | 0);
  }
  const frames = [];
  for (let i = 0; i < ulaw.length; i += CHUNK) {
    frames.push(Buffer.from(ulaw.slice(i, i + CHUNK)).toString("base64"));
  }
  return frames;
}
const BEEP_FRAMES = makeBeepFrames({ secs: 1, freq: 440 });

/* ===================== TTS (μ-law 8k) ===================== */
async function ttsMuLawFrames(text, { languageCode = "en-IN", sampleRateHertz = 8000 } = {}) {
  const [resp] = await ttsClient.synthesizeSpeech({
    input: { text },
    voice: { languageCode }, // Cloud picks a default voice for the locale
    audioConfig: { audioEncoding: "MULAW", sampleRateHertz }
  });
  const audio = resp.audioContent || new Uint8Array();
  const CHUNK = 160; // 20 ms @ 8k
  const frames = [];
  for (let i = 0; i < audio.length; i += CHUNK) {
    frames.push(Buffer.from(audio.subarray(i, i + CHUNK)).toString("base64"));
  }
  return frames;
}

/* ===================== App + TwiML ===================== */
const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));

app.get("/", (_req, res) => res.status(200).send("ok"));
app.get("/healthz", (_req, res) => res.status(200).send("ok"));

app.post("/voice", (req, res) => {
  const host = req.get("host");
  const wsUrl = `wss://${host}/twilio-ws`;
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>Connecting you to the Okomo three sixty assistant.</Say>
  <Connect>
    <Stream url="${wsUrl}" track="inbound_audio"/>
  </Connect>
</Response>`;
  res.type("text/xml").send(twiml);
});

/* ===================== Outbound call API ===================== */
async function twilioCreateCall({ to, from, voiceUrl }) {
  if (!TWILIO_SID || !TWILIO_TOKEN) throw new Error("Missing Twilio SID/TOKEN");
  const api = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Calls.json`;
  const body = new URLSearchParams({
    To: to,
    From: from || TWILIO_FROM,
    Url: voiceUrl,
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
  if (!r.ok) throw new Error(`Twilio call failed ${r.status} ${await r.text()}`);
  return r.json();
}

app.post("/call", async (req, res) => {
  try {
    const to = (req.body?.to || "").trim();
    const from = (req.body?.from || "").trim();
    if (!/^\+\d{8,15}$/.test(to))  return res.status(400).json({ error: "`to` must be E.164" });
    if (from && !/^\+\d{8,15}$/.test(from)) return res.status(400).json({ error: "`from` must be E.164" });
    const voiceUrl = `https://${req.get("host")}/voice`;
    const call = await twilioCreateCall({ to, from, voiceUrl });
    console.log("[/call] created", call.sid, call.status);
    res.json({ sid: call.sid, status: call.status || "queued" });
  } catch (e) {
    console.error("[/call] error", e);
    res.status(500).json({ error: e.message || String(e) });
  }
});

/* ===================== Diagnostics ===================== */
app.get("/diag", (_req, res) => {
  res.json({
    sid_masked: mask(TWILIO_SID),
    from: TWILIO_FROM || null,
    has_token: Boolean(TWILIO_TOKEN),
  });
});

/* ===================== HTTP start ===================== */
const PORT = Number(process.env.PORT) || 8080;
const server = app.listen(PORT, "0.0.0.0", () => {
  console.log("[boot] HTTP listening on", PORT);
});

/* ===================== Tiny dialog stub ===================== */
function draftReply(utterance) {
  const u = (utterance || "").toLowerCase();
  if (u.includes("hello") || u.includes("hi")) {
    return "Hello! I’m the Okomo three sixty assistant. We create immersive virtual reality wedding experiences. Would you like to book a short in person meeting this week?";
  }
  if (u.includes("meeting") || u.includes("book")) {
    return "Great. I can book a physical meeting with our team. What day works best for you, weekday or weekend?";
  }
  if (u.includes("price") || u.includes("cost") || u.includes("budget")) {
    return "Typical packages start at three lakhs, and we customize for your venue and guest size. We can share a detailed proposal in the meeting.";
  }
  if (u.includes("i will let you know") || u.includes("later")) {
    return "No problem. I’ve noted your interest. I can message you a summary after this call and follow up tomorrow. Is that okay?";
  }
  return "Thanks! Could you please tell me your preferred date and city for the wedding, so I can plan the meeting accordingly?";
}

/* ===================== WebSocket: Twilio Media Stream ===================== */
const wss = new WebSocketServer({ server, path: "/twilio-ws" });

wss.on("connection", (ws) => {
  console.log("[ws] connected");
  let streamSid = null;

  let sttStream = null;
  let speaking  = false;
  let sttClosed = false;
  let mediaCount = 0;

  function startSTTStream() {
    sttClosed = false;
    const request = {
      config: {
        encoding: "MULAW",
        sampleRateHertz: 8000,
        languageCode: "en-IN",
        enableAutomaticPunctuation: true,
        model: "phone_call",
      },
      interimResults: true,
      singleUtterance: true,
    };
    sttStream = speechClient
      .streamingRecognize(request)
      .on("error", (err) => console.error("[stt] error", err))
      .on("data", async (data) => {
        const result = data.results?.[0];
        if (!result) return;

        const transcript = result.alternatives?.[0]?.transcript || "";
        if (result.isFinal) {
          console.log("[stt] final:", transcript);

          const reply = draftReply(transcript);
          speaking = true;

          try {
            const frames = await ttsMuLawFrames(reply, { languageCode: "en-IN" });
            let i = 0;
            const t = setInterval(() => {
              if (ws.readyState !== ws.OPEN) { clearInterval(t); return; }
              if (i >= frames.length) {
                clearInterval(t);
                ws.send(JSON.stringify({ event: "mark", streamSid, mark: { name: `tts-${Date.now()}` } }));
                speaking = false;
                setTimeout(() => { if (ws.readyState === ws.OPEN) startSTTStream(); }, 50);
                return;
              }
              ws.send(JSON.stringify({ event: "media", streamSid, media: { payload: frames[i++] } }));
            }, 20);
          } catch (e) {
            console.error("[tts] error", e);
            speaking = false;
            setTimeout(() => startSTTStream(), 100);
          }

          try { sttStream?.end(); } catch {}
          sttClosed = true;
        } else {
          // console.log("[stt] interim:", transcript);
        }
      })
      .on("end", () => { sttClosed = true; });
  }

  ws.on("message", async (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      if (msg.event === "connected") {
        console.log("[ws] proto:", msg.protocol, "version:", msg.version);
      }

      if (msg.event === "start") {
        streamSid = msg.start?.streamSid;
        console.log("[ws] start", streamSid, "tracks:", msg.start?.tracks);

        // Clear any buffered audio
        ws.send(JSON.stringify({ event: "clear", streamSid }));

        // Beep
        let i = 0;
        const tb = setInterval(() => {
          if (ws.readyState !== ws.OPEN) { clearInterval(tb); return; }
          if (i >= BEEP_FRAMES.length) { clearInterval(tb); return; }
          ws.send(JSON.stringify({ event: "media", streamSid, media: { payload: BEEP_FRAMES[i++] } }));
        }, 20);

        // Greeting (non-blocking)
        (async () => {
          const greet = "Hi, this is the Okomo three sixty assistant. We help plan immersive VR wedding experiences. How can I help today?";
          const gf = await ttsMuLawFrames(greet, { languageCode: "en-IN" });
          let gi = 0;
          const tg = setInterval(() => {
            if (ws.readyState !== ws.OPEN) { clearInterval(tg); return; }
            if (gi >= gf.length) { clearInterval(tg); return; }
            ws.send(JSON.stringify({ event: "media", streamSid, media: { payload: gf[gi++] } }));
          }, 20);
        })().catch(console.error);

        startSTTStream();
      }

      else if (msg.event === "media") {
        mediaCount++;
        if (mediaCount % 50 === 0) console.log("[ws] media frames:", mediaCount);
        if (speaking) return;
        const b = Buffer.from(msg.media?.payload || "", "base64");
        if (b.length && sttStream && !sttClosed) {
          // You can also do: sttStream.write({ audioContent: b });
          sttStream.write(b);
        }
      }

      else if (msg.event === "mark") {
        // ack from Twilio for our 'mark'
      }

      else if (msg.event === "stop") {
        try { sttStream?.end(); } catch {}
        console.log("[ws] stop", streamSid);
      }
    } catch (e) {
      console.error("[ws] parse error", e);
    }
  });

  ws.on("close", () => { try { sttStream?.end(); } catch {}; console.log("[ws] closed"); });
  ws.on("error", (e) => console.error("[ws] error", e));
});








