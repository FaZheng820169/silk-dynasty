/* Silk Dynasty — studio order flow.
   Two ways to sit. Automatic: the photograph is posted to /api/generate and
   one free proof frame is rendered from it, in the browser. Concierge: the
   photograph never leaves the browser and is attached to the email we prepare. */

(function () {
  "use strict";

  var PLANS = {
    single: {
      name: "Single Robe",
      price: 19,
      desc: "One dynasty · 4 portraits at 2K",
      res: "2K",
      print: "Not included"
    },
    trio: {
      name: "Dynasty Trio",
      price: 49,
      desc: "Tang · Song · Ming · 9 portraits at 4K",
      res: "4K",
      print: "Not included"
    },
    heirloom: {
      name: "Heirloom",
      price: 89,
      desc: "Tang · Song · Ming · 9 portraits at 4K + album",
      res: "4K",
      print: "24-page album, shipped"
    }
  };

  var DYNASTY_LABEL = { tang: "Tang", song: "Song", ming: "Ming" };
  var ATELIER_EMAIL = (window.SILK_DYNASTY && window.SILK_DYNASTY.atelierEmail) || "hello@silkdynasty.studio";
  var PREVIEW_ENDPOINT = (window.SILK_DYNASTY && window.SILK_DYNASTY.previewEndpoint) ||
    "https://image.pollinations.ai/prompt/";
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
  var confirmKicker = document.getElementById("confirmKicker");
  var confirmTitleEl = document.getElementById("confirmTitle");
  var confirmLead = document.getElementById("confirmLead");
  var confirmProgress = document.getElementById("confirmProgress");
  var confirmGallery = document.getElementById("confirmGallery");
  var orderRefBox = document.getElementById("orderRefBox");
  var confirmActions = document.getElementById("confirmActions");
  var confirmFoot = document.getElementById("confirmFoot");
  var confirmPanel = confirmBox.querySelector(".confirm-panel");

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

  /* The free preview runs on a public text-to-image endpoint that rate-limits
     per visitor. When it answers 402/429 it returns a branded placeholder
     picture, which a plain <img> would happily show as if it were a portrait.
     So the response is fetched and checked, retried once, and — if the endpoint
     is still busy — replaced with a real atelier portrait and an honest line of
     copy instead of a fake. */
  var PREVIEW_FALLBACK = {
    tang: "assets/img/collection-tang.jpg",
    song: "assets/img/collection-song.jpg",
    ming: "assets/img/collection-ming.jpg",
  };
  var PREVIEW_NOTE_DEFAULT = 'Generic preview only. <a href="#orderForm">Put your face on it →</a>';
  var lastPreviewUrl = null;

  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  function fetchPreviewImage(url) {
    return fetch(url, { mode: "cors", cache: "no-store" }).then(function (r) {
      if (!r.ok) {
        var err = new Error("preview " + r.status);
        err.status = r.status;
        throw err;
      }
      var type = r.headers.get("content-type") || "";
      if (type.indexOf("image/") !== 0) throw new Error("preview did not return an image");
      return r.blob();
    });
  }

  function showPreviewImage(src, alt) {
    previewOut.innerHTML = "";
    var img = document.createElement("img");
    img.alt = alt;
    img.src = src;
    previewOut.appendChild(img);
  }

  function runPreview() {
    var desc = (document.getElementById("previewDesc").value.trim() || "a person").slice(0, 120);
    var prompt = PREVIEW_PROMPTS[previewDynasty].replace("{desc}", desc);
    var dynasty = previewDynasty;
    var label = DYNASTY_LABEL[dynasty] || dynasty;
    // Pollinations.ai: /prompt/{encoded}?width=&height=&nologo=&seed=
    var url = PREVIEW_ENDPOINT + encodeURIComponent(prompt) +
      "?width=720&height=1280&nologo=true&seed=" + Date.now();

    previewBtn.disabled = true;
    previewBtn.textContent = "Composing…";
    previewPh.hidden = true;
    previewNote.hidden = true;
    previewOut.innerHTML = '<div class="preview-wait">Composing a ' + label + " portrait…</div>";

    var release = function () {
      previewBtn.disabled = false;
      previewBtn.textContent = "Generate preview";
    };

    fetchPreviewImage(url)
      .catch(function (err) {
        if (err.status !== 402 && err.status !== 429) throw err;
        return sleep(4000).then(function () { return fetchPreviewImage(url + "&retry=1"); });
      })
      .then(function (blob) {
        if (lastPreviewUrl) URL.revokeObjectURL(lastPreviewUrl);
        lastPreviewUrl = URL.createObjectURL(blob);
        showPreviewImage(lastPreviewUrl, "AI-generated " + label + " hanfu portrait preview");
        previewNote.innerHTML = PREVIEW_NOTE_DEFAULT;
        previewNote.hidden = false;
        track("preview_generate", { dynasty: dynasty, result: "live" });
      })
      .catch(function () {
        showPreviewImage(PREVIEW_FALLBACK[dynasty], "An atelier " + label + " portrait");
        previewNote.innerHTML = "The live preview is at capacity — this is an atelier portrait, " +
          'not a live render. Try again in a minute, or <a href="#orderForm">put your face on it →</a>';
        previewNote.hidden = false;
        track("preview_generate", { dynasty: dynasty, result: "fallback" });
      })
      .then(release, release);
  }

  if (previewBtn) previewBtn.addEventListener("click", runPreview);

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

  // Automatic mode: send the photo to the generation API and return one portrait.
  function autoGenerate(plan, dynasty, index) {
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
          index: index || 0,
          description: document.getElementById("previewDesc").value.trim()
        })
      }).then(function (r) {
        return r.json().then(function (data) {
          if (!r.ok) throw new Error(data && data.error ? data.error : "HTTP " + r.status);
          return data;
        });
      });
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

    if (delivery === "automatic") {
      submitBtn.disabled = true;
      var oldLabel = submitBtn.textContent;
      submitBtn.textContent = "Rendering…";
      startAutomatic(plan, dynasty);
      autoGenerate(plan, dynasty, 0)
        .then(function (result) {
          if (result && result.image && result.status !== "unavailable") {
            finishAutomatic(plan, dynasty, result);
            track("auto_generate", { plan: plan, dynasty: dynasty, status: result.status });
          } else {
            failAutomatic(result && result.note);
            track("auto_generate", { plan: plan, dynasty: dynasty, status: "unavailable" });
          }
        })
        .catch(function (err) {
          // Transport-level failure only — the API reports quirk states as JSON.
          failAutomatic(err && err.message);
          track("auto_generate", { plan: plan, dynasty: dynasty, status: "error" });
        })
        .then(function () {
          submitBtn.disabled = false;
          submitBtn.textContent = oldLabel;
        });
    } else {
      resetConfirm();
      showConfirm();
    }
    track("submit_request", { plan: plan, dynasty: dynasty, delivery: delivery });
  });

  function showConfirm() {
    confirmBox.hidden = false;
    document.body.style.overflow = "hidden";
    confirmClose.focus();
  }

  var PORTRAIT_COUNT = { single: 4, trio: 9, heirloom: 9 };

  function resetConfirm() {
    confirmGallery.innerHTML = "";
    confirmGallery.hidden = true;
    confirmProgress.hidden = true;
    confirmProgress.textContent = "";
    confirmPanel.classList.remove("proof");
    var checkout = confirmActions.querySelector(".js-checkout");
    if (checkout) checkout.remove();
    orderRefBox.hidden = false;
    confirmActions.hidden = false;
    confirmFoot.hidden = false;
    confirmKicker.textContent = "One more step";
    confirmTitleEl.textContent = "Send us the photograph.";
    confirmLead.textContent =
      "Your photo has not left this device. Open the email below — it already contains your order — and attach the photograph there.";
    confirmFoot.textContent =
      "We answer within a few hours, usually much sooner. If anything is unclear about the photograph, we will tell you before you pay.";
    mailLink.textContent = "Open email draft";
    if (currentRef) mailLink.href = buildMailto(currentRef);
  }

  // Automatic mode, state 1: the frame is being rendered.
  function startAutomatic(plan, dynasty) {
    resetConfirm();
    confirmPanel.classList.add("proof");
    confirmKicker.textContent = "Automatic · beta";
    confirmTitleEl.textContent = "Rendering your proof portrait.";
    confirmLead.textContent =
      "One free frame, made from your own face, so you can judge the quality before paying anything.";
    confirmProgress.hidden = false;
    confirmProgress.textContent = "Reading your photograph…";
    confirmGallery.hidden = false;
    confirmGallery.innerHTML = '<div class="cg-skeleton" aria-hidden="true"></div>';
    orderRefBox.hidden = true;
    confirmActions.hidden = true;
    confirmFoot.textContent =
      "Your photo goes to the renderer for this one frame and is not kept on our side. Keep this page open — the frame appears right here when it is ready.";
    showConfirm();
  }

  // Automatic mode, state 2: proof arrived, now ask for the order.
  function finishAutomatic(plan, dynasty, result) {
    var count = PORTRAIT_COUNT[plan] || 4;
    var res = (PLANS[plan] && PLANS[plan].res) || "4K";
    var label = DYNASTY_LABEL[dynasty] || dynasty;

    confirmGallery.innerHTML = "";
    var img = document.createElement("img");
    img.className = "confirm-image";
    img.src = result.image;
    img.alt = "Your proof portrait in " + label + " dynasty dress";
    confirmGallery.appendChild(img);

    if (result.status !== "mock") {
      var save = document.createElement("a");
      save.className = "cg-download";
      save.href = result.image;
      save.download = currentRef + "-" + dynasty + "-proof.jpg";
      save.textContent = "Save this proof";
      confirmGallery.appendChild(save);
    }

    confirmKicker.textContent = result.status === "mock" ? "Demo frame" : "Proof ready";
    confirmTitleEl.textContent = result.status === "mock"
      ? "This is a demo frame, not your photograph."
      : "That is you, in " + label + " silk.";
    confirmLead.textContent = result.status === "mock"
      ? "The automatic renderer is running a demo mode. Choose Concierge and a person will make the set from your photograph."
      : "One frame of " + count + ". The full set — " + count + " portraits at " + res + ", colour-graded — is delivered within 48 hours of payment.";
    confirmProgress.hidden = true;
    orderRefBox.hidden = false;
    confirmActions.hidden = false;
    mailLink.textContent = "Order the full set";
    confirmFoot.textContent =
      "Send the email with your order reference and we reply with a secure payment link. The proof stays yours either way.";

    var payLink = paymentLink(plan);
    if (payLink && result.status !== "mock") {
      var checkout = document.createElement("a");
      checkout.className = "btn js-checkout";
      checkout.href = payLink;
      checkout.target = "_blank";
      checkout.rel = "noopener";
      checkout.textContent = "Pay $" + PLANS[plan].price + " and get the set";
      confirmActions.insertBefore(checkout, mailLink);
      mailLink.textContent = "Ask a question first";
    }
    showConfirm();
  }

  // Automatic mode, state 3: renderer unavailable — fall back to Concierge.
  function failAutomatic(message) {
    resetConfirm();
    confirmKicker.textContent = "Automatic unavailable";
    confirmTitleEl.textContent = "Let a person do this one.";
    confirmLead.textContent =
      "The automatic renderer is busy right now, so nothing was made. Nothing is lost — send the photograph by email and we art-direct the set by hand.";
    confirmFoot.textContent =
      "This is the slower path, not the worse one. Most clients end up preferring it.";
    if (message && window.console) console.info("[Silk Dynasty] automatic unavailable:", message);
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
