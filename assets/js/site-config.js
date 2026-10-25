/* ============================================================
   Silk Dynasty — site configuration
   Edit these values before deploying. No build step required.
   ============================================================ */
window.SILK_DYNASTY = {
  // Base URL of the generation API. Leave empty to use the same origin.
  apiBase: "",

  // Paddle Payment Links (create at https://vendors.paddle.com/).
  // When empty, the concierge email flow is used instead.
  payLinks: {
    single: "",
    trio: "",
    heirloom: "",
  },

  // Concierge delivery mailbox.
  atelierEmail: "hello@silkdynasty.studio",

  // Free preview uses a public text-to-image endpoint. It produces a generic
  // hanfu portrait (not the user's face) — the paid plan puts the user's
  // actual face on the portrait.
  // Pollinations.ai is free, no key, returns image/jpeg directly.
  previewEndpoint: "https://image.pollinations.ai/prompt/",
};
