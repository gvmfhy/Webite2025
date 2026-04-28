#!/usr/bin/env python3
"""
substack-to-qmd.py — Convert a Substack post (HTML) to a Quarto .qmd file.

Generic extraction script for migrating Substack posts onto a canonical
Quarto site. Designed for the Claude-blind migration pipeline: this
script reads HTML on disk, writes .qmd to disk, and prints only meta
stats. Body content never returns through stdout.

Usage:
    python3 substack-to-qmd.py \\
        --html /tmp/post.html \\
        --slug example-slug \\
        --canonical https://author.substack.com/p/example-slug \\
        --categories cat1,cat2,cat3 \\
        --output writing/example-slug.qmd \\
        [--image-list /tmp/example-image-urls.txt] \\
        [--image-dir images/writing/example-slug]

Outputs (to stdout, no body content):
    Output path: writing/example-slug.qmd
    Bytes: 12345
    Image URLs: 4
    Title: <extracted from JSON-LD or <title>>
    Date: <extracted from JSON-LD>
    Body word count: 1234
"""

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

from bs4 import BeautifulSoup, NavigableString


def extract_jsonld(soup: BeautifulSoup) -> dict:
    """Find Substack's JSON-LD NewsArticle block; return parsed dict (or {})."""
    for script in soup.find_all("script", type="application/ld+json"):
        try:
            data = json.loads(script.string or "")
        except (json.JSONDecodeError, TypeError):
            continue
        if isinstance(data, dict) and data.get("@type") in ("NewsArticle", "Article", "BlogPosting"):
            return data
        if isinstance(data, list):
            for item in data:
                if isinstance(item, dict) and item.get("@type") in ("NewsArticle", "Article", "BlogPosting"):
                    return item
    return {}


def find_body_div(soup: BeautifulSoup):
    """Locate the article body div by trying known Substack class selectors."""
    candidates = [
        ("div", {"class_": "body markup"}),
        ("div", {"class_": "available-content"}),
        ("article", {}),
    ]
    for tag, kwargs in candidates:
        # bs4 quirk: class_ filter does substring/exact matching on class list.
        if "class_" in kwargs:
            elem = soup.find(tag, class_=kwargs["class_"])
        else:
            elem = soup.find(tag)
        if elem:
            return elem
    return None


def extract_substack_image_urls(body_div) -> list[str]:
    """
    Find substack-post-media S3 image URLs from <img> tags in the body div.

    Substack <img src> uses CDN URLs (substackcdn.com/image/fetch/...)
    with the underlying S3 URL embedded as a URL-encoded path component.
    We extract the underlying S3 URL because direct S3 fetches bypass the
    CDN's cache-busting tokens (which break under bash variable expansion).

    Substack also exposes the raw S3 URL via <img data-attrs='{"src": "..."}'>
    JSON, which is the most reliable source.
    """
    urls = []
    seen = set()
    for img in body_div.find_all("img"):
        s3_url = None
        # Try data-attrs JSON first (most reliable; has unscaled original)
        data_attrs = img.get("data-attrs")
        if data_attrs:
            try:
                attrs = json.loads(data_attrs)
                src = attrs.get("src")
                if src and "substack-post-media.s3.amazonaws.com" in src:
                    s3_url = src
            except json.JSONDecodeError:
                pass
        # Fall back to extracting from CDN URL in src
        if not s3_url:
            src = img.get("src", "")
            m = re.search(
                r'substack-post-media\.s3\.amazonaws\.com%2Fpublic%2Fimages%2F([0-9a-f-]+)_(\d+x\d+)\.(\w+)',
                src,
            )
            if m:
                uuid, dims, ext = m.groups()
                s3_url = f"https://substack-post-media.s3.amazonaws.com/public/images/{uuid}_{dims}.{ext}"
        if not s3_url or s3_url in seen:
            continue
        # Filter out tiny images (avatars, logos)
        size_match = re.search(r'_(\d+)x(\d+)\.(\w+)$', s3_url)
        if size_match:
            w, h = int(size_match.group(1)), int(size_match.group(2))
            if max(w, h) < 400:
                continue
        seen.add(s3_url)
        urls.append(s3_url)
    return urls


def html_to_markdown_via_pandoc(body_html: str) -> str:
    """Pipe body HTML through pandoc (HTML -> markdown_strict). Local binary, no LLM."""
    proc = subprocess.run(
        ["pandoc", "-f", "html", "-t", "markdown_strict-raw_html", "--wrap=preserve"],
        input=body_html,
        capture_output=True,
        text=True,
        check=True,
    )
    return proc.stdout


def rewrite_image_paths(md: str, url_to_local: dict[str, str]) -> str:
    """
    Replace remote substack image URLs in markdown with local paths.

    Markdown image syntax: ![alt](url)
    """
    def replace(match):
        alt, url = match.group(1), match.group(2)
        # Strip query string
        url = url.split("?")[0]
        # Extract underlying S3 URL if URL is CDN-wrapped
        m = re.search(
            r'substack-post-media\.s3\.amazonaws\.com%2Fpublic%2Fimages%2F([0-9a-f-]+)_(\d+x\d+)\.(\w+)',
            url,
        )
        if m:
            uuid, dims, ext = m.groups()
            url = f"https://substack-post-media.s3.amazonaws.com/public/images/{uuid}_{dims}.{ext}"
        local = url_to_local.get(url)
        if local:
            return f"![{alt}]({local})"
        return match.group(0)
    return re.sub(r'!\[([^\]]*)\]\(([^)]+)\)', replace, md)


def wrap_first_paragraph_dropcap(md: str) -> str:
    """Wrap the first non-empty content paragraph in ::: {.dropcap} ::: fences."""
    lines = md.split("\n")
    out = []
    in_first = False
    found = False
    for line in lines:
        stripped = line.strip()
        if not found and stripped and not stripped.startswith(("#", ">", "-", "*", "!", "|", "```", ":")):
            out.append("::: {.dropcap}")
            out.append(line)
            in_first = True
            found = True
            continue
        if in_first:
            if stripped == "":
                out.append(":::")
                out.append(line)
                in_first = False
                continue
            out.append(line)
            continue
        out.append(line)
    if in_first:
        out.append(":::")
    return "\n".join(out)


def yaml_escape(s: str) -> str:
    """YAML-quote a string with embedded quotes."""
    return s.replace('"', '\\"')


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--html", required=True, help="Path to Substack HTML file")
    p.add_argument("--slug", required=True, help="Local slug (filename without .qmd)")
    p.add_argument("--canonical", required=True, help="Canonical URL on Substack")
    p.add_argument("--categories", required=True, help="Comma-separated category list")
    p.add_argument("--output", required=True, help="Output .qmd path")
    p.add_argument("--image-list", default=None, help="Output: file listing extracted image URLs (one per line)")
    p.add_argument("--image-dir", default=None, help="Local image dir for path rewriting (default: images/writing/<slug>)")
    args = p.parse_args()

    html_path = Path(args.html)
    out_path = Path(args.output)
    img_dir = args.image_dir or f"images/writing/{args.slug}"

    if not html_path.exists():
        print(f"ERROR: HTML file not found: {html_path}", file=sys.stderr)
        return 1

    raw = html_path.read_text(encoding="utf-8")
    soup = BeautifulSoup(raw, "html.parser")

    # 1. Metadata from JSON-LD
    meta = extract_jsonld(soup)
    title = meta.get("headline") or "Untitled"
    date_published = meta.get("datePublished", "")[:10] or "1970-01-01"
    description = (meta.get("description") or "").strip()

    # 2. Find article body
    body_div = find_body_div(soup)
    if body_div is None:
        print("ERROR: could not locate article body div", file=sys.stderr)
        return 2

    # Word count of body for sanity (no body content returned)
    body_word_count = len(body_div.get_text().split())

    # 3. Image URLs from body only (filters out avatars/logos elsewhere on page)
    image_urls = extract_substack_image_urls(body_div)

    # 4. URL → local-path mapping
    url_to_local = {}
    for i, url in enumerate(image_urls, 1):
        ext_match = re.search(r'\.(\w+)$', url)
        ext = ext_match.group(1) if ext_match else "png"
        local_name = f"{i:02d}.{ext}"
        url_to_local[url] = f"/{img_dir}/{local_name}"

    # 5. HTML body → markdown via pandoc
    body_html = str(body_div)
    body_md = html_to_markdown_via_pandoc(body_html)

    # 6. Rewrite image paths
    body_md = rewrite_image_paths(body_md, url_to_local)

    # 6b. Strip Substack chrome image refs (data:image/svg+xml inline icons used
    #     for expand/refresh UI controls — not part of the essay content).
    body_md = re.sub(r'!\[[^\]]*\]\(data:[^)]+\)\s*', '', body_md)

    # 7. Wrap first paragraph in dropcap
    body_md = wrap_first_paragraph_dropcap(body_md.strip())

    # 8. Compose frontmatter
    if image_urls:
        # Predict: photos optimized to .jpg, charts may stay .png — pick first as OG card
        first_local = list(url_to_local.values())[0]
        # Replace .png → .jpg on first image (sips converts photos; charts keep .png)
        og_image = first_local
    else:
        og_image = "/images/austin-p-morrissey-headshot.jpg"
    categories_yaml = ", ".join(args.categories.split(","))
    frontmatter = (
        f"---\n"
        f'title: "{yaml_escape(title)}"\n'
        + (f'description: "{yaml_escape(description)}"\n' if description else "")
        + f"date: {date_published}\n"
        f"categories: [{categories_yaml}]\n"
        f"image: {og_image}\n"
        f"canonical-url: {args.canonical}\n"
        f"---\n\n"
    )

    # 9. Write .qmd
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(frontmatter + body_md + "\n", encoding="utf-8")

    # 10. Optionally write image-url list (for the localize loop)
    if args.image_list:
        Path(args.image_list).write_text("\n".join(image_urls) + ("\n" if image_urls else ""), encoding="utf-8")

    # 11. Print summary stats only — no body content
    print(f"Output path: {out_path}")
    print(f"Bytes: {out_path.stat().st_size}")
    print(f"Image URLs: {len(image_urls)}")
    print(f"Title: {title}")
    print(f"Date: {date_published}")
    print(f"Body word count: {body_word_count}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
