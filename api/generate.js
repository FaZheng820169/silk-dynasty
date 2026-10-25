/**
 * Silk Dynasty — generation endpoint.
 *
 * Takes one customer photograph + a dynasty and returns ONE portrait that
 * keeps the customer's face. The set is produced by calling this endpoint
 * once per portrait (the studio chains the calls so the set arrives
 * progressively).
 *
 * Providers:
 *   - kontext   (default; Hugging Face GRADIO SPACE POOL — FLUX.1 Kontext dev,
 *               then Qwen-Image-Edit, then Qwen-Image-Edit Fast. All three are
 *               instruction editors that keep the subject and change the
 *               clothes. The pool exists because each public Space runs on a
 *               shared GPU quota and can start refusing jobs mid-day; one dead
 *               Space must not take the storefront down.)
 *   - seedream  (ByteDance ARK, multi-image reference — strongest identity,
 *               needs ARK_API_KEY + ARK_ENDPOINT_ID)
 *   - qwen-edit (Alibaba DashScope qwen-image-edit, needs DASHSCOPE_API_KEY)
 *   - mock      (returns a cached dynasty sample — offline testing only)
 *
 * Why one portrait per request: a Kontext or Qwen render takes ~30s and the
 * host caps a single serverless invocation at 60s, so this endpoint makes one
 * frame per call. The studio calls it once for the free proof; the paid set is
 * produced offline from the original photograph.
 */

const fs = require("fs");
const path = require("path");

const PROVIDER = process.env.GEN_PROVIDER || "kontext";
const KONTEXT_SPACE =
  process.env.KONTEXT_SPACE || "https://black-forest-labs-flux-1-kontext-dev.hf.space";

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

function dataUrlToBuffer(personImage) {
  const m = /^data:image\/(jpeg|jpg|png|webp);base64,(.+)$/.exec(personImage || "");
  if (!m) throw new Error("personImage must be a base64 data URL");
  return { ext: m[1] === "jpeg" ? "jpg" : m[1], buf: Buffer.from(m[2], "base64") };
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

// FLUX.1 Kontext dev / Qwen-Image-Edit on Hugging Face (Gradio 5 API).
//
// Every public Space here runs on the shared ZeroGPU pool, which gives each
// visitor a small quota. When that quota is spent the Space answers
// `event: error` for every job — an infrastructure ceiling, not a bug. So each
// renderer is tried in order and the first frame that comes back wins; if all
// of them refuse, the result is status "unavailable" and the studio falls back
// to Concierge instead of pretending the request blew up.
//
// Setting KONTEXT_HF_TOKEN (or HF_TOKEN) puts the account in the signed-in
// queue, which is the only thing that makes this path dependable.

const HF_TOKEN = process.env.KONTEXT_HF_TOKEN || process.env.HF_TOKEN || "";

const RENDERERS = [
  {
    id: "kontext",
    host: KONTEXT_SPACE,
    build: (file, prompt, seed) => [file, prompt, seed, false, 2.5, 28],
  },
  {
    id: "qwen-edit",
    host: process.env.QWEN_EDIT_SPACE || "https://qwen-qwen-image-edit.hf.space",
    build: (file, prompt, seed) => [file, prompt, seed, false, 4, 30, false],
  },
  {
    id: "qwen-edit-fast",
    host: "https://multimodalart-qwen-image-edit-fast.hf.space",
    build: (file, prompt, seed) => [file, prompt, seed, false, 1, 8, false],
  },
];

// One attempt against one Space: upload → queue → stream → download.
async function renderOn(renderer, { buf, ext, prompt, seed }) {
  const headers = HF_TOKEN ? { Authorization: `Bearer ${HF_TOKEN}` } : {};

  const form = new FormData();
  form.append("files", new Blob([buf], { type: `image/${ext}` }), `photo.${ext}`);
  const up = await fetch(`${renderer.host}/gradio_api/upload?upload_id=${Date.now()}`, {
    method: "POST",
    body: form,
    headers,
    signal: AbortSignal.timeout(15000),
  });
  if (!up.ok) return { error: `upload ${up.status}` };
  const uploaded = JSON.parse(await up.text())[0];
  if (!uploaded) return { error: "no file slot" };

  const file = { path: uploaded, meta: { _type: "gradio.FileData" } };
  const call = await fetch(`${renderer.host}/gradio_api/call/infer`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ data: renderer.build(file, prompt, seed) }),
    signal: AbortSignal.timeout(20000),
  });
  if (!call.ok) return { error: `queue ${call.status}` };
  const { event_id: eventId } = await call.json();

  const stream = await fetch(`${renderer.host}/gradio_api/call/infer/${eventId}`, {
    headers,
    signal: AbortSignal.timeout(35000),
  });
  const body = await stream.text();
  const match = /"url":\s*"([^"]+)"/.exec(body);
  if (!match) return { error: body.includes("event: error") ? "space refused (quota)" : "no image" };

  const img = await fetch(match[1].replace(/\\u002F/g, "/"), {
    headers,
    signal: AbortSignal.timeout(20000),
  });
  if (!img.ok) return { error: `download ${img.status}` };
  const outBuf = Buffer.from(await img.arrayBuffer());
  return {
    image: `data:${img.headers.get("content-type") || "image/webp"};base64,${outBuf.toString("base64")}`,
  };
}

async function kontextGenerate({ personImage, dynasty, description, index, seed }) {
  const { ext, buf } = dataUrlToBuffer(personImage);
  const prompt = promptFor(dynasty, description, index || 0);
  const jobSeed = seed == null ? Math.floor(Math.random() * 1e9) : seed;

  const failures = [];
  const started = Date.now();
  for (const renderer of RENDERERS) {
    // Vercel caps this invocation at 60s; leave room for the last download.
    if (Date.now() - started > 48000) break;
    try {
      const out = await renderOn(renderer, { buf, ext, prompt, seed: jobSeed });
      if (out.image) return { status: "ok", renderer: renderer.id, image: out.image };
      failures.push(`${renderer.id}: ${out.error}`);
    } catch (err) {
      failures.push(`${renderer.id}: ${err.name === "TimeoutError" ? "timed out" : err.message}`);
    }
  }

  return {
    status: "unavailable",
    note: HF_TOKEN
      ? `Every renderer refused this job (${failures.join("; ")}).`
      : `The free GPU pool is spent right now (${failures.join("; ")}). Set KONTEXT_HF_TOKEN to use the signed-in queue.`,
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

const MAX_PHOTO_BYTES = 6 * 1024 * 1024;
const MAX_DESCRIPTION = 200;

// The photograph arrives from a browser, so it is checked at the boundary:
// real image type, and small enough that a single request cannot be abused.
function photoProblem(personImage) {
  if (!personImage) return "personImage required";
  if (typeof personImage !== "string") return "personImage must be a base64 data URL";
  const head = /^data:image\/(jpeg|jpg|png|webp);base64,/.exec(personImage);
  if (!head) return "personImage must be a JPEG, PNG or WebP data URL";
  const bytes = (personImage.length - head[0].length) * 0.75;
  if (bytes > MAX_PHOTO_BYTES) return "personImage is larger than 6 MB";
  return null;
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return fail(res, 405, "POST only");

  const body = req.body || {};
  const { personImage, dynasty, plan = "single", index = 0 } = body;
  const description =
    typeof body.description === "string" ? body.description.trim().slice(0, MAX_DESCRIPTION) : "";
  if (!dynasty || !PROMPTS[dynasty]) return fail(res, 400, "dynasty must be tang, song or ming");

  try {
    let result;
    switch (PROVIDER) {
      case "seedream":
      case "qwen-edit":
      case "kontext":
      default: {
        const problem = photoProblem(personImage);
        if (problem) return fail(res, 400, problem);
        result =
          PROVIDER === "seedream"
            ? await seedreamGenerate({ personImage, dynasty, description })
            : PROVIDER === "qwen-edit"
              ? await qwenEditGenerate({ personImage, dynasty, description })
              : await kontextGenerate({ personImage, dynasty, description, index });
        break;
      }
      case "mock":
        result = await mockGenerate({ dynasty });
    }
    ok(res, { provider: PROVIDER, dynasty, plan, index, ...result });
  } catch (err) {
    fail(res, 500, err.message || "generation failed");
  }
};
