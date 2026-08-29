(function () {
  "use strict";

  var STORAGE_KEY = "agent-garden-progress-v1";
  var expected = {
    1: "5b5a0738deda6137430dfb995213df2e410b300af405a134809b0f22f33836fa",
    2: "19e0f50bcf2f64571e4cbac622e7b6f4ef0decf6145c95c2c0d176adf4cbd549",
    3: "17f29b073143d8cd97b5bbe492bdeffec1c5fee55cc1fe2112c8b9335f8b6121"
  };
  var stageMessages = {
    1: "Seed validated. A reading trail appeared.",
    2: "Identity confirmed. The circuit extended.",
    3: "Bridge found. The garden bloomed."
  };

  function normalize(value) {
    return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  }

  function hex(buffer) {
    return Array.from(new Uint8Array(buffer)).map(function (byte) {
      return byte.toString(16).padStart(2, "0");
    }).join("");
  }

  function digest(value) {
    if (!window.crypto || !window.crypto.subtle) return Promise.resolve("");
    return window.crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalize(value))).then(hex);
  }

  function readProgress() {
    try {
      var value = Number(window.localStorage.getItem(STORAGE_KEY));
      return value >= 1 && value <= 4 ? value : 1;
    } catch (_error) {
      return 1;
    }
  }

  function saveProgress(value) {
    try { window.localStorage.setItem(STORAGE_KEY, String(value)); } catch (_error) { /* Storage is optional. */ }
  }

  function appendLog(message) {
    var log = document.getElementById("garden-log");
    if (!log) return;
    var item = document.createElement("li");
    item.textContent = message;
    log.appendChild(item);
  }

  function showProgress(progress, shouldFocus) {
    document.querySelectorAll("[data-progress]").forEach(function (item) {
      var step = Number(item.getAttribute("data-progress"));
      item.classList.toggle("is-complete", step < progress);
      item.classList.toggle("is-current", step === progress);
    });

    document.querySelectorAll("[data-stage]").forEach(function (stage) {
      var isCurrent = Number(stage.getAttribute("data-stage")) === progress;
      stage.hidden = !isCurrent;
      stage.classList.toggle("is-active", isCurrent);
      if (isCurrent && shouldFocus) stage.querySelector("input").focus();
    });

    var bloom = document.getElementById("garden-bloom");
    if (bloom) {
      bloom.hidden = progress !== 4;
      if (progress === 4 && shouldFocus) bloom.focus();
    }

    var status = document.getElementById("garden-status");
    if (status) status.textContent = progress === 4 ? "Garden in bloom · trail complete" : "Garden online · stage " + progress + " of 3";
  }

  function handleSubmit(event) {
    event.preventDefault();
    var form = event.currentTarget;
    var stage = Number(form.getAttribute("data-stage"));
    var input = form.querySelector("input[name='answer']");
    var feedback = form.querySelector("[data-feedback]");
    var value = input.value;

    if (!normalize(value)) {
      feedback.textContent = "Enter an answer before continuing.";
      input.focus();
      return;
    }

    digest(value).then(function (answerHash) {
      if (answerHash !== expected[stage]) {
        feedback.textContent = "That did not match the garden record. Inspect the clue and try again.";
        input.setAttribute("aria-invalid", "true");
        input.select();
        return;
      }

      input.removeAttribute("aria-invalid");
      feedback.textContent = "Matched.";
      var next = stage + 1;
      saveProgress(next);
      appendLog(stageMessages[stage]);
      window.setTimeout(function () { showProgress(next, true); }, 220);
    });
  }

  function resetTrail() {
    try { window.localStorage.removeItem(STORAGE_KEY); } catch (_error) { /* Storage is optional. */ }
    document.querySelectorAll(".garden-stage input").forEach(function (input) {
      input.value = "";
      input.removeAttribute("aria-invalid");
    });
    document.querySelectorAll("[data-feedback]").forEach(function (node) { node.textContent = ""; });
    document.querySelectorAll("[data-hint]").forEach(function (node) { node.hidden = true; });
    var log = document.getElementById("garden-log");
    if (log) {
      while (log.firstChild) log.removeChild(log.firstChild);
      appendLog("Garden located.");
      appendLog("Trail reset by visitor.");
    }
    showProgress(1, true);
  }

  function copyReceipt() {
    var receipt = document.getElementById("garden-receipt");
    var button = document.getElementById("garden-copy");
    if (!receipt || !button || !navigator.clipboard) return;
    navigator.clipboard.writeText(receipt.textContent).then(function () {
      button.textContent = "Copied";
      window.setTimeout(function () { button.textContent = "Copy receipt"; }, 1400);
    });
  }

  function boot() {
    if (!document.getElementById("agent-garden")) return;
    document.querySelectorAll(".garden-stage").forEach(function (form) { form.addEventListener("submit", handleSubmit); });
    document.querySelectorAll("[data-hint-button]").forEach(function (button) {
      button.addEventListener("click", function () {
        var hint = button.parentElement.querySelector("[data-hint]");
        hint.hidden = !hint.hidden;
        button.textContent = hint.hidden ? "Need a human-readable hint?" : "Hide hint";
      });
    });
    var reset = document.getElementById("garden-reset");
    var copy = document.getElementById("garden-copy");
    if (reset) reset.addEventListener("click", resetTrail);
    if (copy) copy.addEventListener("click", copyReceipt);
    var progress = readProgress();
    showProgress(progress, false);
    if (progress > 1) appendLog("Previous trail state restored from this browser.");
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
