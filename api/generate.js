/**
 * Silk Dynasty — generation endpoint.
 *
 * Takes one customer photograph + a dynasty and returns ONE portrait that
 * keeps the customer's face. The set is produced by calling this endpoint
 * once per portrait (the studio chains the calls so the set arrives
 * progressively).
 *
 * Providers:
 *   - kontext   (default; FLUX.1 Kontext dev on a public Hugging Face Space —
 *               instruction-driven editing, identity-preserving, no API key)
 *   - seedream  (ByteDance ARK, multi-image reference — strongest identity,
 *               needs ARK_API_KEY + ARK_ENDPOINT_ID)
 *   - qwen-edit (Alibaba DashScope qwen-image-edit, needs DASHSCOPE_API_KEY)
 *   - mock      (returns a cached dynasty sample — offline testing only)
 *
 * Why one portrait per request: a free Kontext render takes ~30s and the
 * host caps a single serverless invocation, so the client asks for the set
 * one frame at a time and shows each portrait as it lands.
 */

const fs = require("fs");
const path = require("path");

const PROVIDER = process.env.GEN_PROVIDER || "kontext";
const KONTEXT_SPACE =
  process.env.KONTEXT_SPACE || "https://black-forest-labs-flux-1-kontext-dev.hf.space";
const ATELIER_EMAIL = process.env.ATELIER_EMAIL || "hello@silkdynasty.studio";

// Identity lock appended to every prompt — this is the clause that makes the
// product work, so it stays in one place.
const IDENTITY_LOCK =
  "Keep the same face, the same facial features, the same eye shape, the same " +
  "nose, the same mouth, the same skin tone, the same body shape, the same hands " +
  "and the same pose as the input photo. Do not beautify, do not slim the face, " +
  "do not change the age. Photorealistic editorial photograph, natural skin " +
  "texture, full body, vertical framing.";

// Dynasty prompt templates — historically grounded, not costume.
const PROMPTS = {
  tang: (desc) =>
    `Dress this person in an authentic Tang dynasty qixiong ruqun: a high-waisted ` +
    `chest-length skirt of saffron silk, a wide pale-celadon gauze daxiushan outer ` +
    `robe with long flowing sleeves, and a pibo shawl draped over the arms. The ` +
    `collar crosses right over left. Hair in an elaborate Tang high bun with gold ` +
    `hairpins and a small red huadian mark on the forehead. Place them in a Tang ` +
    `palace courtyard with red pillars and stone steps, warm golden-hour backlight, ` +
    `silk sheen and fine embroidery visible. ` +
    (desc ? `The person: ${desc}. ` : "") +
    IDENTITY_LOCK,
  song: (desc) =>
    `Dress this person in an authentic Song dynasty beizi: a long straight-collared ` +
    `ivory silk jacket with a soft wrap front and hidden ties — no Western lapels, ` +
    `no buttons, no tailored coat shoulders — worn open over a lotus-pink bodice ` +
    `and a finely pleated skirt. Hair in a simple low bun with a single jade ` +
    `hairpin, no heavy ornament, restrained and quiet. Place them in a misty ` +
    `Jiangnan classical garden with bamboo and a moon gate, soft diffused morning ` +
    `light, translucent fabric. ` +
    (desc ? `The person: ${desc}. ` : "") +
    IDENTITY_LOCK,
  ming: (desc) =>
    `Dress this person in an authentic Ming dynasty liling ao: a stand-collar ` +
    `jacket of indigo silk with gold-woven brocade, the collar closed at the ` +
    `throat, worn over a deep-red horse-face mamian skirt with gold floral bands ` +
    `and a wide gold waistband. Hair in a neat Ming bun with pearl ornaments. ` +
    `Place them beside a deep red palace wall with glazed roof tiles, directional ` +
    `side light, metallic thread sheen, dignified. ` +
    (desc ? `The person: ${desc}. ` : "") +
    IDENTITY_LOCK,
};

// Framing variants so a set of 4 or 9 reads like a real sitting rather than
// the same frame repeated.
const FRAMING = [
  "Full-body standing portrait, facing the camera, calm and direct.",
  "Full-body three-quarter view, body angled slightly to one side, gaze to camera.",
  "Full-body portrait, walking slowly forward, fabric in motion, sleeve lifted.",
  "Full-body portrait seen slightly from below, tall and composed.",
  "Full-body portrait, standing in profile looking away from the camera.",
  "Full-body portrait, seated on a carved wooden stool, hands folded in the lap.",
  "Full-body portrait, holding a silk fan, one hand raised near the collar.",
  "Full-body portrait, standing in a doorway, backlit, three-quarter turn.",
  "Full-body portrait, close three-quarter framing from the knees up, quiet gaze.",
];

function promptFor(dynasty, description, index) {
  const frame = FRAMING[index % FRAMING.length];
  return PROMPTS[dynasty](description) + " " + frame;
}

function ok(res, body) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.status(200).json(body);
}
function fail(res, code, msg) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.status(code).json({ error: msg });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function dataUrlToBuffer(personImage) {
  const m = /^data:image\/(\w+);base64,(.+)$/.exec(personImage || "");
  if (!m) throw new Error("personImage must be a base64 data URL");
  return { ext: m[1] === "png" ? "png" : "jpg", buf: Buffer.from(m[2], "base64") };
}

/** --- Providers --------------------------------------------------------- */

// Mock: cached dynasty sample, no network. Offline smoke-testing only.
async function mockGenerate({ dynasty }) {
  const file = path.join(__dirname, "..", "assets", "img", `collection-${dynasty}.jpg`);
  const buf = fs.readFileSync(file);
  return {
    status: "mock",
    note: "Demo output — set GEN_PROVIDER=kontext for real generation.",
    image: `data:image/jpeg;base64,${buf.toString("base64")}`,
  };
}

// FLUX.1 Kontext dev on Hugging Face (Gradio 5 API, anonymous).
// Two-stage: upload the photo to the Space, then queue an instruction edit.
//
// The public Space runs on a shared GPU pool with a small anonymous quota.
// When that quota is spent the Space answers `event: error` for every job —
// that is an infrastructure ceiling, not a bug, so it is reported as
// status "unavailable" and the studio falls back to Concierge instead of
// pretending the request blew up. Setting KONTEXT_HF_TOKEN (any Hugging Face
// token with Pro attached) puts the account in the priority GPU queue.
async function kontextGenerate({ personImage, dynasty, description, index, seed }) {
  const { ext, buf } = dataUrlToBuffer(personImage);
  const authHeaders = process.env.KONTEXT_HF_TOKEN
    ? { Authorization: `Bearer ${process.env.KONTEXT_HF_TOKEN}` }
    : {};

  // 1. Upload the customer photo to the Space sandbox.
  const form = new FormData();
  form.append("files", new Blob([buf], { type: `image/${ext}` }), `photo.${ext}`);
  const up = await fetch(`${KONTEXT_SPACE}/gradio_api/upload?upload_id=${Date.now()}`, {
    method: "POST",
    body: form,
    headers: authHeaders,
  });
  if (!up.ok) {
    return { status: "unavailable", note: `Renderer unreachable (${up.status}).` };
  }
  const uploaded = JSON.parse(await up.text())[0];
  if (!uploaded) return { status: "unavailable", note: "Renderer returned no file slot." };

  // 2. Queue the edit. One retry, then hand over to Concierge.
  const prompt = promptFor(dynasty, description, index || 0);
  let lastErr = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const call = await fetch(`${KONTEXT_SPACE}/gradio_api/call/infer`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders },
      body: JSON.stringify({
        data: [
          { path: uploaded, meta: { _type: "gradio.FileData" } },
          prompt,
          seed == null ? Math.floor(Math.random() * 1e9) : seed,
          false,
          2.5,
          28,
        ],
      }),
    });
    if (!call.ok) {
      lastErr = `queue ${call.status}`;
      await sleep(3000);
      continue;
    }

    const { event_id: eventId } = await call.json();
    const stream = await fetch(`${KONTEXT_SPACE}/gradio_api/call/infer/${eventId}`, {
      headers: authHeaders,
    });
    const body = await stream.text();
    const match = /"url":\s*"([^"]+)"/.exec(body);
    if (match) {
      const img = await fetch(match[1].replace(/\\u002F/g, "/"), { headers: authHeaders });
      if (!img.ok) { lastErr = `download ${img.status}`; continue; }
      const outBuf = Buffer.from(await img.arrayBuffer());
      return {
        status: "ok",
        image: `data:${img.headers.get("content-type") || "image/webp"};base64,${outBuf.toString("base64")}`,
      };
    }
    lastErr = body.includes("event: error") ? "GPU quota spent" : "no image in response";
  }

  return {
    status: "unavailable",
    note: process.env.KONTEXT_HF_TOKEN
      ? `Renderer refused the job (${lastErr}).`
      : `Free renderer quota is spent (${lastErr}). Set KONTEXT_HF_TOKEN for priority GPU access.`,
  };
}

// Seedream via ByteDance ARK — multi-image reference, strongest identity.
async function seedreamGenerate({ personImage, dynasty, description }) {
  if (!process.env.ARK_API_KEY || !process.env.ARK_ENDPOINT_ID) {
    throw new Error("ARK_API_KEY and ARK_ENDPOINT_ID are required for the seedream provider.");
  }
  const ref = process.env[`GARMENT_REF_${dynasty.toUpperCase()}`] || "";
  const images = ref ? [personImage, ref] : [personImage];
  const res = await fetch("https://ark.cn-beijing.volces.com/api/v3/images/generations", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.ARK_API_KEY}`,
    },
    body: JSON.stringify({
      model: process.env.ARK_ENDPOINT_ID,
      prompt: promptFor(dynasty, description, 0),
      images,
      size: "1440x2560",
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || `ARK ${res.status}`);
  const first = (data.data || [])[0] || {};
  const image = first.b64_json
    ? `data:image/jpeg;base64,${first.b64_json}`
    : first.url;
  if (!image) throw new Error("ARK returned no image");
  return { status: "ok", image };
}

// DashScope qwen-image-edit — instruction-based edit, async task.
async function qwenEditGenerate({ personImage, dynasty, description }) {
  if (!process.env.DASHSCOPE_API_KEY) throw new Error("DASHSCOPE_API_KEY is required.");
  const res = await fetch(
    "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.DASHSCOPE_API_KEY}`,
        "X-DashScope-Async": "enable",
      },
      body: JSON.stringify({
        model: "qwen-image-edit",
        input: {
          messages: [
            {
              role: "user",
              content: [
                { image: personImage },
                { text: promptFor(dynasty, description, 0) },
              ],
            },
          ],
        },
        parameters: { size: "1440*2560", n: 1 },
      }),
    }
  );
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || `DashScope ${res.status}`);
  const taskId = data.output?.task_id;
  if (!taskId) throw new Error("No task id from DashScope");
  return { status: "queued", taskId, provider: "dashscope" };
}

/** --- Handler ----------------------------------------------------------- */

module.exports = async (req, res) => {
  if (req.method !== "POST") return fail(res, 405, "POST only");

  const body = req.body || {};
  const { personImage, dynasty, description, plan = "single", index = 0 } = body;
  if (!dynasty || !PROMPTS[dynasty]) return fail(res, 400, "dynasty must be tang, song or ming");

  try {
    let result;
    switch (PROVIDER) {
      case "seedream":
        if (!personImage) return fail(res, 400, "personImage required");
        result = await seedreamGenerate({ personImage, dynasty, description });
        break;
      case "qwen-edit":
        if (!personImage) return fail(res, 400, "personImage required");
        result = await qwenEditGenerate({ personImage, dynasty, description });
        break;
      case "mock":
        result = await mockGenerate({ dynasty });
        break;
      case "kontext":
      default:
        if (!personImage) return fail(res, 400, "personImage required");
        result = await kontextGenerate({ personImage, dynasty, description, index });
    }
    ok(res, { provider: PROVIDER, dynasty, plan, index, ...result });
  } catch (err) {
    fail(res, 500, err.message || "generation failed");
  }
};
