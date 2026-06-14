#!/usr/bin/env python3
"""Build static interlink index files from essay frontmatter.

Emits two JSON files committed into the repo as static resources:

  related-index.json
      { "<slug>": [ {title, url, date, categories:[...]}, ... ], ... }
      For each essay, its top 3 related essays by number of shared
      categories (tie-break: more shared first, then more recent date).

  link-index.json
      { "/writing/<slug>.html": {title, blurb, date}, ... }
      blurb = description -> subtitle -> first ~160 chars of body text
      (markdown stripped). Used by the gwern-style hover link previews.

WHY THIS DESIGN
---------------
The Vercel build only installs Quarto (see build.sh); it may not have
Python. So this script is NOT wired into a Quarto pre-render hook. Instead
it is run by hand (locally), its two JSON outputs are committed, and
_quarto.yml registers them under `resources:` so Quarto copies them into
_site/. The runtime JS (assets/interlink.js) fetches the committed JSON.
The production build therefore needs only Quarto.

RE-RUN THIS WHENEVER ESSAYS CHANGE
----------------------------------
    python3 scripts/build_indexes.py
This regenerates related-index.json and link-index.json from the current
writing/*.qmd frontmatter and bodies. Commit the refreshed JSON.

Requires: PyYAML (available in the local dev environment).
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

try:
    import yaml
except ImportError:
    sys.stderr.write(
        "ERROR: PyYAML is required to run build_indexes.py.\n"
        "  pip install pyyaml\n"
        "(This script runs only locally; the Vercel build does not need it.)\n"
    )
    sys.exit(1)

ROOT = Path(__file__).resolve().parent.parent
WRITING = ROOT / "writing"

# Essays that are not real essays / should never appear in the indexes.
# index.qmd is a listing page; templates and explicit drafts are excluded.
EXCLUDE_FILENAMES = {"index.qmd", "_template.qmd"}

FRONTMATTER_RE = re.compile(r"^---\s*\n(.*?)\n---\s*\n?", re.DOTALL)

BLURB_MAX = 160


def parse_qmd(path: Path):
    """Return (frontmatter_dict, body_text) for a .qmd file."""
    text = path.read_text(encoding="utf-8")
    m = FRONTMATTER_RE.match(text)
    if not m:
        return {}, text
    raw_fm = m.group(1)
    body = text[m.end():]
    try:
        fm = yaml.safe_load(raw_fm) or {}
    except yaml.YAMLError:
        fm = {}
    if not isinstance(fm, dict):
        fm = {}
    return fm, body


def strip_markdown(body: str) -> str:
    """Crude markdown -> plain text for the blurb fallback.

    Drops fenced code, Quarto/pandoc divs and attributes, blockquotes,
    headings, images, link syntax, and inline emphasis markers. Good enough
    for a ~160-char preview blurb; not a full parser.
    """
    text = body
    # Fenced code blocks (``` ... ``` or ::: divs left intact below)
    text = re.sub(r"```.*?```", " ", text, flags=re.DOTALL)
    # Pandoc/Quarto fenced divs markers: lines of ::: ...
    text = re.sub(r"^:::.*$", " ", text, flags=re.MULTILINE)
    # HTML comments and raw html tags
    text = re.sub(r"<!--.*?-->", " ", text, flags=re.DOTALL)
    text = re.sub(r"<[^>]+>", " ", text)
    # Images ![alt](url)
    text = re.sub(r"!\[[^\]]*\]\([^)]*\)", " ", text)
    # Links [text](url) -> text
    text = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", text)
    # Reference-style and footnote markers
    text = re.sub(r"\[\^[^\]]*\]", " ", text)
    # Headings, blockquote markers, list bullets at line start
    text = re.sub(r"^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+", " ", text, flags=re.MULTILINE)
    # Pandoc span/attribute braces {.class}
    text = re.sub(r"\{[^}]*\}", " ", text)
    # Emphasis / inline code markers
    text = re.sub(r"[*_`~]", "", text)
    # Collapse whitespace
    text = re.sub(r"\s+", " ", text).strip()
    return text


def make_blurb(fm: dict, body: str) -> str:
    desc = fm.get("description")
    if isinstance(desc, str) and desc.strip():
        return desc.strip()
    sub = fm.get("subtitle")
    if isinstance(sub, str) and sub.strip():
        return sub.strip()
    plain = strip_markdown(body)
    if not plain:
        return ""
    if len(plain) <= BLURB_MAX:
        return plain
    # Truncate on a word boundary near BLURB_MAX, add an ellipsis.
    cut = plain[:BLURB_MAX].rsplit(" ", 1)[0].rstrip()
    return (cut or plain[:BLURB_MAX].rstrip()) + "…"


def normalize_categories(fm: dict):
    cats = fm.get("categories")
    if isinstance(cats, str):
        return [cats]
    if isinstance(cats, list):
        return [str(c) for c in cats if c is not None]
    return []


def date_str(fm: dict) -> str:
    d = fm.get("date")
    if d is None:
        return ""
    # PyYAML may parse YYYY-MM-DD into a datetime.date; isoformat() gives back
    # the canonical string. Anything else -> str().
    iso = getattr(d, "isoformat", None)
    return iso() if callable(iso) else str(d)


def collect_essays():
    """Return list of essay dicts sorted newest-first."""
    essays = []
    for path in sorted(WRITING.glob("*.qmd")):
        if path.name in EXCLUDE_FILENAMES:
            continue
        fm, body = parse_qmd(path)
        if fm.get("draft") is True:
            continue
        slug = path.stem
        title = fm.get("title")
        if not isinstance(title, str) or not title.strip():
            title = slug
        essays.append({
            "slug": slug,
            "title": title.strip(),
            "url": f"/writing/{slug}.html",
            "date": date_str(fm),
            "categories": normalize_categories(fm),
            "blurb": make_blurb(fm, body),
        })
    # Newest first; missing dates sort last.
    essays.sort(key=lambda e: (e["date"] or ""), reverse=True)
    return essays


def build_related(essays):
    related = {}
    for a in essays:
        a_cats = set(a["categories"])
        scored = []
        for b in essays:
            if b["slug"] == a["slug"]:
                continue
            shared = len(a_cats & set(b["categories"]))
            if shared == 0:
                continue
            scored.append((shared, b["date"] or "", b))
        # More shared categories first; then more recent date.
        scored.sort(key=lambda t: (t[0], t[1]), reverse=True)
        top = scored[:3]
        if not top:
            continue
        related[a["slug"]] = [
            {
                "title": b["title"],
                "url": b["url"],
                "date": b["date"],
                "categories": b["categories"],
            }
            for _, _, b in top
        ]
    return related


def build_link_index(essays):
    return {
        e["url"]: {
            "title": e["title"],
            "blurb": e["blurb"],
            "date": e["date"],
        }
        for e in essays
    }


def main():
    essays = collect_essays()
    related = build_related(essays)
    link_index = build_link_index(essays)

    (ROOT / "related-index.json").write_text(
        json.dumps(related, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    (ROOT / "link-index.json").write_text(
        json.dumps(link_index, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )

    print(f"Wrote related-index.json  ({len(related)} essays with related reading)")
    print(f"Wrote link-index.json     ({len(link_index)} essays)")


if __name__ == "__main__":
    main()
