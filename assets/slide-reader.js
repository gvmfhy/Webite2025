(function () {
  "use strict";
  document.querySelectorAll("[data-slide-reader]").forEach(function (reader) {
    var slides = Array.from(reader.querySelectorAll(".slide-reader__slide"));
    var controls = reader.querySelector(".slide-reader__controls");
    var previous = reader.querySelector("[data-slide-prev]");
    var next = reader.querySelector("[data-slide-next]");
    var count = reader.querySelector("[data-slide-count]");
    var fullscreen = reader.querySelector("[data-slide-fullscreen]");
    if (!slides.length || !controls || !previous || !next || !count) return;
    var current = 0;
    function show(index) {
      current = Math.max(0, Math.min(slides.length - 1, index));
      slides.forEach(function (slide, i) { slide.hidden = i !== current; });
      var focused = document.activeElement;
      previous.disabled = current === 0;
      next.disabled = current === slides.length - 1;
      // Keep keyboard navigation inside the reader when an endpoint disables the focused button.
      if (focused === previous && previous.disabled) next.focus();
      else if (focused === next && next.disabled) previous.focus();
      count.textContent = (current + 1) + " / " + slides.length;
      count.setAttribute("aria-label", "Slide " + (current + 1) + " of " + slides.length);
      // Preload only the next slide, keeping the initial page download small.
      var upcoming = slides[current + 1];
      if (upcoming) upcoming.querySelector("img").loading = "eager";
    }
    previous.addEventListener("click", function () { show(current - 1); });
    next.addEventListener("click", function () { show(current + 1); });
    reader.addEventListener("keydown", function (event) {
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (event.target.closest("details, input, select, textarea")) return;
      if (event.key === "ArrowLeft") { event.preventDefault(); show(current - 1); }
      if (event.key === "ArrowRight") { event.preventDefault(); show(current + 1); }
      if (event.key === "Home") { event.preventDefault(); show(0); }
      if (event.key === "End") { event.preventDefault(); show(slides.length - 1); }
    });
    if (fullscreen && reader.requestFullscreen && document.fullscreenEnabled) {
      fullscreen.hidden = false;
      fullscreen.addEventListener("click", async function () {
        try {
          if (document.fullscreenElement === reader) await document.exitFullscreen();
          else await reader.requestFullscreen();
        } catch (_) { fullscreen.hidden = true; }
      });
      document.addEventListener("fullscreenchange", function () {
        var label = document.fullscreenElement === reader ? "Exit full screen" : "Full screen";
        fullscreen.setAttribute("aria-label", label);
        fullscreen.title = label;
      });
    }
    show(0);
    controls.hidden = false;
  });
})();
