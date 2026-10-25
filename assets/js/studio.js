/* Silk Dynasty — studio order flow.
   The photograph never leaves the browser: it is previewed locally and
   the customer attaches it to the email we prepare for them. */

(function () {
  "use strict";

  var PLANS = {
    single: {
      name: "Single Robe",
      price: 19,
      desc: "One dynasty · 4 portraits at 2K",
      print: "Not included"
    },
    trio: {
      name: "Dynasty Trio",
      price: 49,
      desc: "Tang · Song · Ming · 9 portraits at 4K",
      print: "Not included"
    },
    heirloom: {
      name: "Heirloom",
      price: 89,
      desc: "Tang · Song · Ming · 9 portraits at 4K",
      print: "24-page album, shipped"
    }
  };

  var DYNASTY_LABEL = { tang: "Tang", song: "Song", ming: "Ming" };
  var ATELIER_EMAIL = (window.SILK_DYNASTY && window.SILK_DYNASTY.atelierEmail) || "hello@silkdynasty.studio";
  var PREVIEW_ENDPOINT = (window.SILK_DYNASTY && window.SILK_DYNASTY.previewEndpoint) ||
    "https://trae-api-cn.mchost.guru/api/ide/v1/tool_text_to_image";
  var PAY_LINKS = (window.SILK_DYNASTY && window.SILK_DYNASTY.payLinks) || {};
  var API_BASE = (window.SILK_DYNASTY && window.SILK_DYNASTY.apiBase) || "";

  // Dynasty prompts shared with the backend.
  var PREVIEW_PROMPTS = {
    tang: "full-body editorial portrait of {desc} wearing an authentic Tang dynasty qixiong ruqun, high-waisted saffron silk skirt, celadon gauze outer robe, flowing pibo shawl, elaborate Tang high bun with gold hairpins and red huadian, Tang palace courtyard, golden hour, photorealistic 85mm",
    song: "full-body editorial portrait of {desc} wearing an authentic Song dynasty beizi, white silk straight-collared jacket over lotus-pink pleated skirt, simple low bun with jade pin, misty Jiangnan garden with bamboo and moon gate, soft morning light, photorealistic 85mm",
    ming: "full-body editorial portrait of {desc} wearing an authentic Ming dynasty liling ao, indigo silk stand-collar jacket with gold brocade, red horse-face skirt with gold bands, Ming bun with pearl ornaments, red palace wall, directional side light, photorealistic 85mm"
  };

  var form = document.getElementById("orderForm");
  var photoInput = document.getElementById("photoInput");
  var dropzone = document.getElementById("dropzone");
  var preview = document.getElementById("photoPreview");
  var dzEmpty = document.getElementById("dropzoneEmpty");
  var photoStatus = document.getElementById("photoStatus");
  var photoName = null;
  var photoOk = false;
  var photoUrl = null;
  var currentRef = "";

  var summarySet = document.getElementById("summarySet");
  var summaryDesc = document.getElementById("summaryDesc");
  var summaryPrint = document.getElementById("summaryPrint");
  var summaryTotal = document.getElementById("summaryTotal");
  var dynastyHint = document.getElementById("dynastyHint");
  var formError = document.getElementById("formError");

  var confirmBox = document.getElementById("confirm");
  var confirmClose = document.getElementById("confirmClose");
  var orderRefEl = document.getElementById("orderRef");
  var mailLink = document.getElementById("mailLink");
  var copyBtn = document.getElementById("copyBtn");

  function track(event, props) {
    try {
      window.dataLayer = window.dataLayer || [];
      window.dataLayer.push(Object.assign({ event: event }, props || {}));
    } catch (e) { /* measurement is optional */ }
  }

  function planValue() {
    var checked = form.querySelector('input[name="plan"]:checked');
    return checked ? checked.value : "trio";
  }

  function dynastyValue() {
    var checked = form.querySelector('input[name="dynasty"]:checked');
    return checked ? checked.value : "tang";
  }

  /* ---------- plan + summary ---------- */

  function syncPlans() {
    var value = planValue();
    Array.prototype.forEach.call(form.querySelectorAll(".plan"), function (el) {
      var input = el.querySelector("input");
      el.classList.toggle("is-chosen", input.value === value);
    });

    var plan = PLANS[value];
    summarySet.textContent = plan.name;
    summaryDesc.textContent = plan.desc;
    summaryPrint.textContent = plan.print;
    summaryTotal.textContent = "$" + plan.price;

    dynastyHint.textContent =
      value === "single"
        ? "Your set covers one dynasty. Choose the one you want."
        : "Trio and Heirloom include all three dynasties — your choice just sets the running order.";
  }

  form.addEventListener("change", function (e) {
    if (e.target.name === "plan") {
      syncPlans();
      track("select_plan", { plan: e.target.value });
    }
    if (e.target.name === "dynasty") {
      Array.prototype.forEach.call(form.querySelectorAll(".dy"), function (el) {
        el.classList.toggle("is-chosen", el.querySelector("input").checked);
      });
      track("select_dynasty", { dynasty: e.target.value });
    }
  });

  /* ---------- delivery mode ---------- */

  form.addEventListener("change", function (e) {
    if (e.target.name === "delivery") {
      Array.prototype.forEach.call(form.querySelectorAll(".dm"), function (el) {
        el.classList.toggle("is-on", el.querySelector("input").checked);
      });
    }
  });

  /* ---------- free preview (client-side text-to-image) ---------- */

  var previewDynasty = "tang";
  var previewBtn = document.getElementById("previewBtn");
  var previewOut = document.getElementById("previewOut");
  var previewPh = document.getElementById("previewPh");
  var previewNote = document.getElementById("previewNote");

  Array.prototype.forEach.call(document.querySelectorAll(".pdy"), function (btn) {
    btn.addEventListener("click", function () {
      Array.prototype.forEach.call(document.querySelectorAll(".pdy"), function (b) { b.classList.remove("is-on"); });
      btn.classList.add("is-on");
      previewDynasty = btn.getAttribute("data-dy");
    });
  });

  if (previewBtn) {
    previewBtn.addEventListener("click", function () {
      var desc = (document.getElementById("previewDesc").value.trim() || "a person").slice(0, 120);
      var prompt = PREVIEW_PROMPTS[previewDynasty].replace("{desc}", desc);
      // Pollinations.ai: /prompt/{encoded}?width=&height=&nologo=&seed=
      var url = PREVIEW_ENDPOINT + encodeURIComponent(prompt) +
        "?width=720&height=1280&nologo=true&seed=" + Date.now();
      previewPh.hidden = true;
      previewOut.innerHTML =
        '<img alt="AI-generated hanfu portrait preview" src="' + url.replace(/"/g, "&quot;") + '">';
      previewNote.hidden = false;
      track("preview_generate", { dynasty: previewDynasty });
    });
  }

  /* ---------- photograph ---------- */

  function setStatus(text, warn) {
    photoStatus.hidden = false;
    photoStatus.textContent = text;
    photoStatus.classList.toggle("is-warn", !!warn);
  }

  function keepPhoto(file) {
    if (!file) return;
    if (!/^image\/(jpeg|png|webp)$/.test(file.type)) {
      setStatus("That file type is not supported. Please use JPEG, PNG or WebP.", true);
      photoOk = false;
      return;
    }
    if (file.size > 25 * 1024 * 1024) {
      setStatus("That file is over 25 MB. Please send a smaller version.", true);
      photoOk = false;
      return;
    }

    if (photoUrl) URL.revokeObjectURL(photoUrl);
    photoUrl = URL.createObjectURL(file);
    photoName = file.name;

    var probe = new Image();
    probe.onload = function () {
      var longEdge = Math.max(probe.naturalWidth, probe.naturalHeight);
      preview.src = photoUrl;
      preview.hidden = false;
      dzEmpty.hidden = true;
      dropzone.classList.add("has-photo");
      document.getElementById("clearPhoto").hidden = false;

      if (longEdge < 700) {
        photoOk = false;
        setStatus("Too small to work from (" + longEdge + " px). Use a photo at least 1200 px on the long edge.", true);
      } else if (longEdge < 1200) {
        photoOk = true;
        setStatus("Accepted — but " + longEdge + " px is on the low side. A brighter, larger photo gives a better face.", true);
      } else {
        photoOk = true;
        setStatus("Looks usable · " + probe.naturalWidth + " × " + probe.naturalHeight + " px");
      }
      track("photo_selected", { long_edge: longEdge });
    };
    probe.onerror = function () {
      photoOk = false;
      setStatus("That image could not be read. Please try another file.", true);
    };
    probe.src = photoUrl;
  }

  photoInput.addEventListener("change", function (e) {
    keepPhoto(e.target.files && e.target.files[0]);
  });

  ["dragenter", "dragover"].forEach(function (type) {
    dropzone.addEventListener(type, function (e) {
      e.preventDefault();
      dropzone.classList.add("is-dragging");
    });
  });
  ["dragleave", "drop"].forEach(function (type) {
    dropzone.addEventListener(type, function (e) {
      e.preventDefault();
      dropzone.classList.remove("is-dragging");
      if (type === "drop" && e.dataTransfer && e.dataTransfer.files.length) {
        keepPhoto(e.dataTransfer.files[0]);
      }
    });
  });

  document.getElementById("clearPhoto").addEventListener("click", function () {
    if (photoUrl) URL.revokeObjectURL(photoUrl);
    photoUrl = null;
    photoName = null;
    photoOk = false;
    photoInput.value = "";
    preview.hidden = true;
    preview.removeAttribute("src");
    dzEmpty.hidden = false;
    dropzone.classList.remove("has-photo");
    photoStatus.hidden = true;
    this.hidden = true;
  });

  /* ---------- submit ---------- */

  function orderLines(ref) {
    var plan = PLANS[planValue()];
    var lines = [
      "Silk Dynasty — portrait request",
      "Order reference: " + ref,
      "Set: " + plan.name + " ($" + plan.price + ")",
      "Starting dynasty: " + DYNASTY_LABEL[dynastyValue()],
      "Name: " + (document.getElementById("name").value.trim() || "—"),
      "Email: " + document.getElementById("email").value.trim(),
      "Photograph to attach: " + (photoName || "—")
    ];
    var note = document.getElementById("note").value.trim();
    if (note) lines.push("", "Notes: " + note);
    lines.push("", "I have attached my full-body photograph.");
    return lines;
  }

  function buildMailto(ref) {
    var plan = PLANS[planValue()];
    var subject = "Portrait request " + ref + " — " + plan.name;
    return "mailto:" + ATELIER_EMAIL +
      "?subject=" + encodeURIComponent(subject) +
      "&body=" + encodeURIComponent(orderLines(ref).join("\n"));
  }

  function paymentLink(plan) { return PAY_LINKS[plan] || ""; }

  function readPhotoAsDataURL(file) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(r.result); };
      r.onerror = reject;
      r.readAsDataURL(file);
    });
  }

  // Automatic mode: send the photo to the generation API and return a portrait.
  function autoGenerate(plan, dynasty) {
    var file = photoInput.files && photoInput.files[0];
    if (!file) return Promise.reject(new Error("No photograph"));
    return readPhotoAsDataURL(file).then(function (dataUrl) {
      return fetch(API_BASE + "/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          personImage: dataUrl,
          dynasty: dynasty,
          plan: plan,
          description: document.getElementById("previewDesc").value.trim()
        })
      }).then(function (r) { return r.json(); });
    });
  }

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    formError.hidden = true;

    if (!photoOk) {
      formError.hidden = false;
      formError.textContent = "Please add a full-body photograph first — it is the one thing we cannot work without.";
      dropzone.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    var email = document.getElementById("email");
    if (!email.value.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.value.trim())) {
      formError.hidden = false;
      formError.textContent = "Please add an email address we can reply to.";
      email.focus();
      return;
    }
    if (!document.getElementById("consent").checked) {
      formError.hidden = false;
      formError.textContent = "Please confirm how the portraits and your photograph are handled.";
      return;
    }

    var ref = "SD-" + Date.now().toString(36).slice(-5).toUpperCase();
    currentRef = ref;
    orderRefEl.textContent = ref;
    mailLink.href = buildMailto(ref);

    var plan = planValue();
    var dynasty = dynastyValue();
    var delivery = form.querySelector('input[name="delivery"]:checked').value;
    var payLink = paymentLink(plan);

    // If a Paddle link exists, send the customer straight to checkout.
    if (payLink) {
      track("open_checkout", { plan: plan, delivery: delivery });
      window.open(payLink, "_blank", "noopener");
    }

    if (delivery === "automatic") {
      submitBtn.disabled = true;
      var oldLabel = submitBtn.textContent;
      submitBtn.textContent = "Generating…";
      autoGenerate(plan, dynasty).then(function (result) {
        submitBtn.disabled = false;
        submitBtn.textContent = oldLabel;
        if (result && result.image) {
          showConfirmWithImage(result.image, result.status || "ok");
        } else {
          showConfirm();
        }
        track("auto_generate", { plan: plan, dynasty: dynasty, status: result && result.status });
      }).catch(function (err) {
        submitBtn.disabled = false;
        submitBtn.textContent = oldLabel;
        formError.hidden = false;
        formError.textContent = "Automatic generation is not available right now — please choose Concierge and we will deliver by email. (" + (err && err.message) + ")";
      });
    } else {
      showConfirm();
    }
    track("submit_request", { plan: plan, dynasty: dynasty, delivery: delivery });
  });

  function showConfirm() {
    confirmBox.hidden = false;
    document.body.style.overflow = "hidden";
    confirmClose.focus();
  }

  function showConfirmWithImage(dataUrl, status) {
    var panel = confirmBox.querySelector(".confirm-panel");
    var existing = panel.querySelector(".confirm-image");
    if (existing) existing.remove();
    var img = document.createElement("img");
    img.className = "confirm-image";
    img.src = dataUrl;
    img.alt = "Your generated portrait";
    panel.insertBefore(img, panel.querySelector(".order-ref"));
    if (status === "mock") {
      var n = document.createElement("p");
      n.className = "confirm-foot";
      n.style.color = "var(--cinnabar)";
      n.textContent = "Demo image — connect a model key in .env to generate from your photograph.";
      panel.insertBefore(n, panel.querySelector(".order-ref").nextSibling);
    }
    showConfirm();
  }

  confirmClose.addEventListener("click", function () {
    confirmBox.hidden = true;
    document.body.style.overflow = "";
  });
  confirmBox.addEventListener("click", function (e) {
    if (e.target === confirmBox) confirmClose.click();
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && !confirmBox.hidden) confirmClose.click();
  });
  mailLink.addEventListener("click", function () {
    track("open_mail_draft", { plan: planValue() });
  });

  copyBtn.addEventListener("click", function () {
    var text = orderLines(currentRef).join("\n");
    var done = function () {
      copyBtn.textContent = "Copied";
      setTimeout(function () { copyBtn.textContent = "Copy order details"; }, 2200);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, done);
    } else {
      done();
    }
  });

  /* ---------- deep links ---------- */

  (function prefill() {
    var params = new URLSearchParams(window.location.search);
    var plan = params.get("plan");
    var set = params.get("set");

    if (plan && PLANS[plan]) {
      var planInput = form.querySelector('input[name="plan"][value="' + plan + '"]');
      if (planInput) planInput.checked = true;
    }
    if (set && DYNASTY_LABEL[set]) {
      var dyInput = form.querySelector('input[name="dynasty"][value="' + set + '"]');
      if (dyInput) dyInput.checked = true;
    }

    Array.prototype.forEach.call(form.querySelectorAll(".dy"), function (el) {
      el.classList.toggle("is-chosen", el.querySelector("input").checked);
    });
    syncPlans();
  })();
})();
