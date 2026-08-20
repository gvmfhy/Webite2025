/* Shared progressive navigation and interaction repairs for the Quarto site. */
(function () {
  "use strict";

  var indexTrigger = null;
  var indexDialog = null;
  var indexClose = null;
  var searchReturnTarget = null;
  var searchWasOpen = false;
  var dialogCloseReason = "normal";

  function addSkipLink() {
    if (document.querySelector(".skip-link")) return;
    var link = document.createElement("a");
    link.className = "skip-link";
    link.href = "#quarto-document-content";
    link.textContent = "Skip to content";
    document.body.insertBefore(link, document.body.firstChild);
  }

  function currentSection() {
    var path = window.location.pathname.replace(/index\.html$/, "");
    if (/\/writing\//.test(path)) return "writing";
    if (/\/about\/?$/.test(path) || /\/about\.html$/.test(path)) return "about";
    if (path === "/" || path === "") return "selected";
    return "";
  }

  function markCurrentIndexLink() {
    var section = currentSection();
    document.querySelectorAll("[data-index-section]").forEach(function (link) {
      if (link.getAttribute("data-index-section") === section) {
        link.setAttribute("aria-current", "page");
      } else {
        link.removeAttribute("aria-current");
      }
    });
  }

  function updateThemeLabels() {
    var isDark = document.body.classList.contains("quarto-dark");
    var hiddenToggle = document.querySelector(".quarto-color-scheme-toggle");
    var visibleToggle = document.querySelector("[data-site-theme]");
    var actionLabel = isDark ? "Switch to light mode" : "Switch to dark mode";

    if (hiddenToggle) {
      hiddenToggle.setAttribute("role", "button");
      hiddenToggle.setAttribute("aria-label", actionLabel);
      hiddenToggle.setAttribute("title", actionLabel);
      hiddenToggle.setAttribute("aria-pressed", isDark ? "true" : "false");
    }

    if (visibleToggle) {
      visibleToggle.textContent = isDark ? "Light mode" : "Dark mode";
      visibleToggle.setAttribute("aria-label", actionLabel);
    }
  }

  function patchThemeToggle() {
    var hiddenToggle = document.querySelector(".quarto-color-scheme-toggle");
    var visibleToggle = document.querySelector("[data-site-theme]");

    if (hiddenToggle) {
      hiddenToggle.addEventListener("keydown", function (event) {
        if (event.key !== " " && event.key !== "Enter") return;
        event.preventDefault();
        hiddenToggle.click();
      });
    }

    if (visibleToggle) {
      visibleToggle.addEventListener("click", function () {
        if (typeof window.quartoToggleColorScheme === "function") {
          window.quartoToggleColorScheme();
        } else if (hiddenToggle) {
          hiddenToggle.click();
        }
      });
    }

    new MutationObserver(updateThemeLabels).observe(document.body, {
      attributes: true,
      attributeFilter: ["class"]
    });
    updateThemeLabels();
  }

  function findSearchTrigger() {
    var root = document.getElementById("quarto-search");
    return root && root.querySelector("button");
  }

  function launchQuartoSearch() {
    window.requestAnimationFrame(function () {
      if (typeof window.quartoOpenSearch === "function") {
        window.quartoOpenSearch();
        return;
      }
      var trigger = findSearchTrigger();
      if (trigger) trigger.click();
    });
  }

  function openSearchFromIndex() {
    searchReturnTarget = indexTrigger;
    dialogCloseReason = "search";
    if (indexDialog && indexDialog.open) {
      indexDialog.close();
    } else {
      launchQuartoSearch();
    }
  }

  function patchSearch() {
    var root = document.getElementById("quarto-search");
    var visibleSearch = document.querySelector("[data-site-search]");

    function updateGeneratedSearch() {
      if (!root) return;
      var trigger = root.querySelector("button");
      var input = root.querySelector("input[type='search']");
      if (trigger) {
        trigger.setAttribute("aria-label", "Search writing");
        trigger.setAttribute("title", "Search writing");
      }
      if (input) input.setAttribute("placeholder", "Search writing");
    }

    if (root) {
      new MutationObserver(updateGeneratedSearch).observe(root, {
        childList: true,
        subtree: true
      });
      updateGeneratedSearch();
    }

    if (visibleSearch) visibleSearch.addEventListener("click", openSearchFromIndex);

    new MutationObserver(function () {
      var isOpen = document.body.classList.contains("aa-Detached");
      if (searchWasOpen && !isOpen && searchReturnTarget) {
        var target = searchReturnTarget;
        searchReturnTarget = null;
        window.requestAnimationFrame(function () { target.focus(); });
      }
      searchWasOpen = isOpen;
    }).observe(document.body, { attributes: true, attributeFilter: ["class"] });

    document.addEventListener("keyup", function (event) {
      if (!indexDialog || !indexDialog.open) return;
      var key = event.key.toLowerCase();
      if (["s", "f", "/"].indexOf(key) === -1 || event.metaKey || event.ctrlKey || event.altKey) return;
      var target = event.target;
      if (target && (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.isContentEditable)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      openSearchFromIndex();
    }, true);
  }

  function initSiteIndex() {
    indexTrigger = document.getElementById("site-index-trigger");
    indexDialog = document.getElementById("site-index-dialog");
    indexClose = indexDialog && indexDialog.querySelector(".site-index__close");

    if (!indexTrigger || !indexDialog || !indexClose || typeof indexDialog.showModal !== "function") return;

    markCurrentIndexLink();

    indexTrigger.addEventListener("click", function () {
      if (indexDialog.open) return;
      dialogCloseReason = "normal";
      indexDialog.showModal();
      indexTrigger.setAttribute("aria-expanded", "true");
      document.body.classList.add("site-index-open");
      var firstLink = indexDialog.querySelector(".site-index__links a");
      window.requestAnimationFrame(function () { (firstLink || indexClose).focus(); });
    });

    indexClose.addEventListener("click", function () {
      dialogCloseReason = "normal";
      indexDialog.close();
    });

    indexDialog.addEventListener("cancel", function () {
      dialogCloseReason = "normal";
    });

    indexDialog.addEventListener("click", function (event) {
      if (event.target !== indexDialog) return;
      dialogCloseReason = "normal";
      indexDialog.close();
    });

    indexDialog.querySelectorAll(".site-index__links a, .site-index__identity, .site-index__foot a").forEach(function (link) {
      link.addEventListener("click", function () {
        if (!indexDialog.open) return;
        dialogCloseReason = "navigation";
        indexDialog.close();
      });
    });

    indexDialog.addEventListener("close", function () {
      indexTrigger.setAttribute("aria-expanded", "false");
      document.body.classList.remove("site-index-open");
      if (dialogCloseReason === "search") {
        launchQuartoSearch();
      } else if (dialogCloseReason === "normal") {
        indexTrigger.focus();
      }
      dialogCloseReason = "normal";
    });

    document.documentElement.classList.add("site-index-ready");
  }

  function addCompactToc() {
    var toc = document.getElementById("TOC");
    var title = document.getElementById("title-block-header");
    if (!toc || !title || document.querySelector(".compact-toc")) return;
    var list = toc.querySelector("ul");
    if (!list) return;

    var details = document.createElement("details");
    details.className = "compact-toc";
    var summary = document.createElement("summary");
    summary.textContent = "On this page";
    details.appendChild(summary);
    var clone = list.cloneNode(true);
    clone.querySelectorAll("[id]").forEach(function (element) { element.removeAttribute("id"); });
    details.appendChild(clone);
    title.after(details);
  }

  function repairFragmentLinks() {
    document.querySelectorAll("a[href^='#']").forEach(function (link) {
      link.removeAttribute("target");
      link.removeAttribute("rel");
    });
  }

  function boot() {
    addSkipLink();
    initSiteIndex();
    patchThemeToggle();
    patchSearch();
    addCompactToc();
    repairFragmentLinks();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
