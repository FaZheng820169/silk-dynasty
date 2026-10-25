/* Silk Dynasty — shared behaviour: masthead state, scroll progress,
   reveal-on-enter, and a restrained parallax on collection imagery. */

(function () {
  "use strict";

  var reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var masthead = document.getElementById("masthead");
  var pinnedHeader = masthead && masthead.hasAttribute("data-solid");
  var bar = document.getElementById("progressBar");
  var parallaxItems = Array.prototype.slice.call(
    document.querySelectorAll("[data-parallax] img")
  );
  var ticking = false;

  function onScroll() {
    var y = window.scrollY || window.pageYOffset;

    if (masthead && !pinnedHeader) masthead.classList.toggle("is-solid", y > 40);

    if (bar) {
      var max = document.documentElement.scrollHeight - window.innerHeight;
      bar.style.width = (max > 0 ? (y / max) * 100 : 0) + "%";
    }

    if (!reduce && parallaxItems.length) {
      var vh = window.innerHeight;
      parallaxItems.forEach(function (img) {
        var rect = img.parentElement.getBoundingClientRect();
        if (rect.bottom < -80 || rect.top > vh + 80) return;
        // -1 .. 1 as the image travels through the viewport
        var t = (rect.top + rect.height / 2 - vh / 2) / vh;
        img.style.transform = "translate3d(0," + (t * -22).toFixed(2) + "px,0)";
      });
    }

    ticking = false;
  }

  function requestScroll() {
    if (!ticking) {
      ticking = true;
      window.requestAnimationFrame(onScroll);
    }
  }

  window.addEventListener("scroll", requestScroll, { passive: true });
  window.addEventListener("resize", requestScroll);
  onScroll();

  // reveal on enter
  var revealEls = document.querySelectorAll("[data-reveal]");
  if ("IntersectionObserver" in window && !reduce) {
    var io = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            entry.target.classList.add("is-in");
            io.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.18, rootMargin: "0px 0px -8% 0px" }
    );
    revealEls.forEach(function (el) { io.observe(el); });
  } else {
    revealEls.forEach(function (el) { el.classList.add("is-in"); });
  }
})();
