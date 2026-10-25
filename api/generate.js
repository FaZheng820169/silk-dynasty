/**
 * Silk Dynasty — generation endpoint.
 *
 * Accepts a user photograph + dynasty selection and returns a generated
 * portrait. Providers:
 *   - pollinations (free, no key — default; litterbox upload + Pollinations img2img)
 *   - seedream     (ByteDance ARK, multi-image reference — best face preservation)
 *   - qwen-edit    (DashScope qwen-image-edit)
 *   - mock         (returns a dynasty sample — for local testing)
 *
 * Configure via .env (see .env.example). Without a provider key the
 * pollinations provider is used (free but best-effort face preservation).
 */

const fs = require("fs");
const path = require("path");

const PROVIDER = process.env.GEN_PROVIDER || "pollinations";
const ATELIER_EMAIL = process.env.ATELIER_EMAIL || "hello@silkdynasty.studio";

// Dynasty prompt templates — historically grounded, not costume.
const PROMPTS = {
  tang: (desc) =>
    `full-body editorial portrait of ${desc}, wearing an authentic Tang dynasty ` +
    `qixiong ruqun: high-waisted chest-length skirt of saffron silk, a wide ` +
    `celadon gauze daxiushan outer robe, a long flowing pibo shawl draped over ` +
    `the arms, the right lapel crossing over the left. Hair in an elaborate Tang ` +
    `high bun with gold hairpins and a small red huadian mark on the forehead. ` +
    `Standing in a Tang palace courtyard with red pillars and stone steps, warm ` +
    `golden-hour backlight, silk sheen and fine embroidery visible, photorealistic, ` +
    `85mm, museum editorial quality, vertical framing.`,
  song: (desc) =>
    `full-body editorial portrait of ${desc}, wearing an authentic Song dynasty ` +
    `beizi: a long straight-collared white silk jacket over a lotus-pink moxiong ` +
    `inner and a finely pleated baidie skirt, the right lapel over the left. Hair ` +
    `in a simple low bun with a single jade hairpin. Standing in a misty Jiangnan ` +
    `classical garden with bamboo and a moon gate, soft diffused morning light, ` +
    `translucent fabric texture, photorealistic, 85mm, quiet elegant mood, vertical.`,
  ming: (desc) =>
    `full-body editorial portrait of ${desc}, wearing an authentic Ming dynasty ` +
    `liling ao: a stand-collar jacket of indigo silk with gold-woven brocade, ` +
    `over a red horse-face (mamian) skirt with gold floral lan bands, the right ` +
    `lapel over the left. Hair in a neat Ming bun with pearl and filigree ornaments. ` +
    `Standing beside a deep red palace wall with glazed roof tiles, directional side ` +
    `light, metallic thread sheen, photorealistic, 85mm, dignified, vertical.`,
};

function dynastyRef(dynasty) {
  return process.env[`GARMENT_REF_${dynasty.toUpperCase()}`] || "";
}

function ok(res, body) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.status(200).json(body);
}
function fail(res, code, msg) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.status(code).json({ error: msg });
}

/** --- Providers --------------------------------------------------------- */

// Mock: returns a cached dynasty sample as base64 so the full pipeline is
// exercisable without a model key. NOT for production use.
async function mockGenerate({ dynasty }) {
  const file = path.join(__dirname, "..", "assets", "img", `collection-${dynasty}.jpg`);
  const buf = fs.readFileSync(file);
  return {
    status: "mock",
    note: "Demo output — set GEN_PROVIDER=seedream or qwen-edit for real generation.",
    image: `data:image/jpeg;base64,${buf.toString("base64")}`,
  };
}

// Pollinations.ai (free, no key) — image-to-image via a temporary public URL.
// Flow: base64 photo → upload to litterbox.catbox.moe (24h) → Pollinations
// img2img with the dynasty prompt → returns the generated JPEG.
// Face preservation depends on the underlying model; treat as best-effort.
async function pollinationsGenerate({ personImage, dynasty, description }) {
  if (!personImage) throw new Error("personImage required");

  // 1. base64 → Buffer
  const m = personImage.match(/^data:image\/(\w+);base64,(.+)$/);
  if (!m) throw new Error("personImage must be a data URL");
  const ext = m[1] === "png" ? "png" : "jpg";
  const buf = Buffer.from(m[2], "base64");

  // 2. Upload to litterbox (temporary host, 24h expiry)
  const fd = new FormData();
  fd.append("reqtype", "fileupload");
  fd.append("time", "24h");
  fd.append("fileToUpload", new Blob([buf], { type: "image/jpeg" }), `photo.${ext}`);
  const up = await fetch("https://litterbox.catbox.moe/resources/internals/api.php", {
    method: "POST",
    body: fd,
  });
  const photoUrl = (await up.text()).trim();
  if (!up.ok || !/^https?:\/\//.test(photoUrl)) {
    throw new Error("photo upload failed");
  }
  // Litterbox needs a moment to make the file publicly fetchable.
  await new Promise((r) => setTimeout(r, 3000));

  // 3. Pollinations image-to-image (free tier: 1 img / 45s per IP).
  // Retry on 400/402/429/503 with backoff — Vercel's dynamic IPs make the
  // per-IP limit a non-issue in production, but local dev hits it.
  const prompt = PROMPTS[dynasty](description || "the person in the photo") +
    " Keep the face, hair and body shape identical to the reference photo.";

  let genBuf = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    const genUrl = "https://image.pollinations.ai/prompt/" +
      encodeURIComponent(prompt) +
      "?image=" + encodeURIComponent(photoUrl) +
      "&width=720&height=1280&nologo=true&seed=" + (Date.now() + attempt);
    const gen = await fetch(genUrl);
    if (gen.ok) {
      genBuf = Buffer.from(await gen.arrayBuffer());
      break;
    }
    if (gen.status === 400 || gen.status === 402 || gen.status === 429 || gen.status === 503) {
      // Pollinations free tier: 1 img / 45s per IP. Wait the full window
      // so the retry succeeds. On Vercel each invocation uses a fresh IP,
      // so this branch is rarely hit in production.
      await new Promise((r) => setTimeout(r, 47000));
      continue;
    }
    throw new Error(`Pollinations ${gen.status}`);
  }
  if (!genBuf) throw new Error("Pollinations rate limit — try again in a minute");
  return {
    status: "ok",
    image: `data:image/jpeg;base64,${genBuf.toString("base64")}`,
  };
}

// Seedream 5.0 via ByteDance ARK. Multi-image reference keeps the face.
// Docs: https://www.volcengine.com/docs/82379
async function seedreamGenerate({ personImage, dynasty, description }) {
  if (!process.env.ARK_API_KEY || !process.env.ARK_ENDPOINT_ID) {
    throw new Error("ARK_API_KEY and ARK_ENDPOINT_ID are required for the seedream provider.");
  }
  const images = [personImage];
  const ref = dynastyRef(dynasty);
  if (ref) images.push(ref);

  const body = {
    model: process.env.ARK_ENDPOINT_ID,
    prompt: PROMPTS[dynasty](description || "the person in the reference photo"),
    images,
    size: "1440x2560",
  };

  const res = await fetch("https://ark.cn-beijing.volces.com/api/v3/images/generations", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.ARK_API_KEY}`,
    },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || `ARK ${res.status}`);
  return { status: "ok", image: data.data?.[0]?.b64_json ? `data:image/jpeg;base64,${data.data[0].b64_json}` : data.data?.[0]?.url };
}

// DashScope qwen-image-edit — instruction-based edit, good for identity.
async function qwenEditGenerate({ personImage, dynasty, description }) {
  if (!process.env.DASHSCOPE_API_KEY) throw new Error("DASHSCOPE_API_KEY is required.");
  const res = await fetch("https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation", {
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
              { text: PROMPTS[dynasty](description || "this person") + " Keep the face and body exactly as in the reference photo." },
            ],
          },
        ],
      },
      parameters: { size: "1440*2560", n: 1 },
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || `DashScope ${res.status}`);
  // async task
  const taskId = data.output?.task_id;
  if (!taskId) throw new Error("No task id from DashScope");
  return { status: "queued", taskId, provider: "dashscope" };
}

/** --- Handler ----------------------------------------------------------- */

module.exports = async (req, res) => {
  if (req.method !== "POST") return fail(res, 405, "POST only");
  let body;
  try { body = req.body || {}; } catch { return fail(res, 400, "bad JSON"); }

  const { personImage, dynasty, description, plan = "single" } = body;
  if (!dynasty || !PROMPTS[dynasty]) return fail(res, 400, "dynasty must be tang, song or ming");

  try {
    let result;
    switch (PROVIDER) {
      case "pollinations":
        if (!personImage) return fail(res, 400, "personImage required");
        result = await pollinationsGenerate({ personImage, dynasty, description });
        break;
      case "seedream":
        if (!personImage) return fail(res, 400, "personImage required");
        result = await seedreamGenerate({ personImage, dynasty, description });
        break;
      case "qwen-edit":
        if (!personImage) return fail(res, 400, "personImage required");
        result = await qwenEditGenerate({ personImage, dynasty, description });
        break;
      case "mock":
      default:
        result = await mockGenerate({ dynasty });
    }
    ok(res, { provider: PROVIDER, dynasty, plan, ...result });
  } catch (err) {
    fail(res, 500, err.message || "generation failed");
  }
};
