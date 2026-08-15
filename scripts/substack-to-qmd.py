#!/usr/bin/env python3
"""
substack-to-qmd.py — Convert a Substack post (HTML) to a Quarto .qmd file.

Generic extraction script for migrating Substack posts onto a canonical
Quarto site. Designed for the Claude-blind migration pipeline: this
script reads HTML on disk, writes .qmd to disk, and prints only meta
stats. Body content never returns through stdout.

Preferred usage (Substack API JSON):
    python3 substack-to-qmd.py \\
        --json /tmp/post.json \\
        --slug example-slug \\
        --canonical https://author.substack.com/p/example-slug \\
        --categories cat1,cat2,cat3 \\
        --output writing/example-slug.qmd \\
        [--image-list /tmp/example-image-urls.txt] \\
        [--image-manifest /tmp/example-images.json] \\
        [--verified-fig-alt "Factual description" ...] \\
        [--image-dir images/writing/example-slug]

Outputs (to stdout, no body content):
    Output path: writing/example-slug.qmd
    Bytes: 12345
    Image URLs: 4
    Title: <extracted from API JSON or JSON-LD>
    Date: <extracted from API JSON or JSON-LD>
    Body word count: 1234
    Fidelity: PASS
"""

import argparse
import difflib
import hashlib
import html
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unicodedata
from datetime import date
from pathlib import Path
from pathlib import PurePosixPath
from urllib.parse import unquote, urlsplit

from bs4 import BeautifulSoup, NavigableString


SLUG_PATTERN = re.compile(r"[a-z0-9]+(?:-[a-z0-9]+)*")


def atomic_write_many(files: list[tuple[Path, str]]) -> None:
    """Stage all files, replace each atomically, and roll back the group on failure."""
    staged = []
    backups = {}
    replaced = []
    try:
        for path, content in files:
            fd, temp_name = tempfile.mkstemp(
                prefix=f".{path.name}.", suffix=".tmp", dir=path.parent
            )
            try:
                with os.fdopen(fd, "w", encoding="utf-8", newline="") as handle:
                    handle.write(content)
                    handle.flush()
                    os.fsync(handle.fileno())
                os.chmod(temp_name, 0o644)
            except Exception:
                try:
                    os.close(fd)
                except OSError:
                    pass
                try:
                    Path(temp_name).unlink()
                except FileNotFoundError:
                    pass
                raise
            staged.append((Path(temp_name), path))

        for _, destination in staged:
            if not destination.exists():
                continue
            backup_fd, backup_name = tempfile.mkstemp(
                prefix=f".{destination.name}.",
                suffix=".backup",
                dir=destination.parent,
            )
            os.close(backup_fd)
            backup_path = Path(backup_name)
            backups[destination] = backup_path
            shutil.copy2(destination, backup_path)

        try:
            for temp_path, destination in staged:
                os.replace(temp_path, destination)
                replaced.append(destination)
        except Exception as replace_error:
            rollback_errors = []
            for destination in reversed(replaced):
                backup = backups.get(destination)
                try:
                    if backup is not None:
                        os.replace(backup, destination)
                    else:
                        destination.unlink(missing_ok=True)
                except OSError as rollback_error:
                    rollback_errors.append(f"{destination}: {rollback_error}")
            if rollback_errors:
                raise RuntimeError(
                    "atomic write failed and rollback was incomplete: "
                    + "; ".join(rollback_errors)
                ) from replace_error
            raise
    finally:
        for temp_path, _ in staged:
            try:
                temp_path.unlink()
            except FileNotFoundError:
                pass
        for backup in backups.values():
            try:
                backup.unlink()
            except FileNotFoundError:
                pass


def prepare_destination_paths(
    source_path: Path,
    raw_destinations: dict[str, str | None],
    force: bool,
) -> dict[str, Path]:
    """Reject collisions/clobbers and prepare every destination directory."""
    source_resolved = source_path.resolve()
    seen = {}
    destinations = {}

    for label, raw_path in raw_destinations.items():
        if not raw_path:
            continue
        path = Path(raw_path).expanduser()
        resolved = path.resolve()
        if resolved == source_resolved:
            raise ValueError(f"{label} path collides with input source: {path}")
        if resolved in seen:
            raise ValueError(
                f"{label} path collides with {seen[resolved]} path: {path}"
            )
        if path.exists():
            if path.is_symlink():
                raise ValueError(f"{label} destination cannot be a symlink: {path}")
            if not path.is_file():
                raise ValueError(f"{label} destination is not a file: {path}")
            if not force:
                raise ValueError(
                    f"{label} destination already exists (use --force): {path}"
                )
        path.parent.mkdir(parents=True, exist_ok=True)
        if not path.parent.is_dir():
            raise ValueError(f"{label} parent is not a directory: {path.parent}")
        seen[resolved] = label
        destinations[label] = path

    return destinations


def extract_jsonld(soup: BeautifulSoup) -> dict:
    """Find Substack's JSON-LD NewsArticle block; return parsed dict (or {})."""
    for script in soup.find_all("script", type="application/ld+json"):
        try:
            data = json.loads(script.string or "")
        except (json.JSONDecodeError, TypeError):
            continue
        if isinstance(data, dict) and data.get("@type") in (
            "NewsArticle",
            "Article",
            "BlogPosting",
        ):
            return data
        if isinstance(data, list):
            for item in data:
                if isinstance(item, dict) and item.get("@type") in (
                    "NewsArticle",
                    "Article",
                    "BlogPosting",
                ):
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


def raw_substack_image_url(img) -> str | None:
    """Return the unscaled S3 source URL for a Substack body image."""
    data_attrs = img.get("data-attrs")
    if data_attrs:
        try:
            src = json.loads(data_attrs).get("src")
            if src and "substack-post-media.s3.amazonaws.com" in src:
                return src.split("?", 1)[0]
        except (json.JSONDecodeError, TypeError):
            pass

    decoded = unquote(img.get("src", ""))
    match = re.search(
        r"https://substack-post-media\.s3\.amazonaws\.com/public/images/[^?\s]+",
        decoded,
    )
    return match.group(0).split("?", 1)[0] if match else None


def clean_caption_html(figcaption) -> str:
    """Keep authored caption markup while removing Substack-only attributes."""
    if figcaption is None:
        return ""
    caption = BeautifulSoup(str(figcaption), "html.parser").find("figcaption")
    for tag in caption.find_all(True):
        if tag.name == "a":
            tag.attrs = {
                key: value
                for key, value in tag.attrs.items()
                if key in {"href", "title"}
            }
        else:
            tag.attrs = {}
    return caption.decode_contents().strip()


def extract_substack_images(body_div, img_dir: str) -> list[dict]:
    """Collect body images, authored captions, source alt text, and local paths."""
    records = []
    seen = set()
    for img in body_div.find_all("img"):
        s3_url = raw_substack_image_url(img)
        if not s3_url or s3_url in seen:
            continue

        size_match = re.search(r"_(\d+)x(\d+)\.(\w+)$", s3_url)
        if size_match:
            width, height = int(size_match.group(1)), int(size_match.group(2))
            if max(width, height) < 400:
                continue

        seen.add(s3_url)
        data_attrs = {}
        try:
            data_attrs = json.loads(img.get("data-attrs") or "{}")
        except (json.JSONDecodeError, TypeError):
            pass

        figure = img.find_parent("figure")
        figcaption = figure.find("figcaption") if figure else None
        caption_html = clean_caption_html(figcaption)
        caption_text = figcaption.get_text(" ", strip=True) if figcaption else ""
        source_alt = html.unescape(
            html.unescape(
                data_attrs.get("alt") or img.get("alt") or img.get("title") or ""
            )
        ).strip()
        source_title = html.unescape(
            html.unescape(data_attrs.get("title") or img.get("title") or "")
        ).strip()
        ext_match = re.search(r"\.([A-Za-z0-9]+)$", urlsplit(s3_url).path)
        extension = (ext_match.group(1) if ext_match else "png").lower()
        local_path = f"/{img_dir}/{len(records) + 1:02d}.{extension}"
        records.append(
            {
                "url": s3_url,
                "local_path": local_path,
                "caption_html": caption_html,
                "caption_text": caption_text,
                "source_alt": source_alt,
                "source_title": source_title,
            }
        )
    return records


def extract_substack_embeds(body_div) -> list[dict]:
    """Collect sanitized iframe embeds so Pandoc cannot replace their contents."""
    records = []
    allowed = {
        "src",
        "title",
        "width",
        "height",
        "allow",
        "allowfullscreen",
        "frameborder",
    }
    for iframe in body_div.find_all("iframe"):
        clean = BeautifulSoup("<iframe></iframe>", "html.parser").iframe
        clean.attrs = {
            key: value for key, value in iframe.attrs.items() if key in allowed
        }
        records.append({"html": str(clean), "src": clean.get("src", "")})
    return records


def remove_substack_chrome(
    body_div,
    preserve_subscription_caption: bool = False,
    exclude_comment_cards: bool = False,
) -> None:
    """Remove UI injected into body_html while retaining authored links/content."""
    subscription_widgets = list(body_div.select(".subscription-widget-wrap-editor"))
    if preserve_subscription_caption and not subscription_widgets:
        raise ValueError("requested subscription caption, but no widget was found")
    for widget in subscription_widgets:
        if preserve_subscription_caption:
            caption = widget.select_one("p.cta-caption")
            if caption is None or not caption.get_text(strip=True):
                raise ValueError("subscription widget has no visible CTA caption")
            widget.replace_with(caption.extract())
        else:
            widget.decompose()

    for node in body_div.select(".subscription-widget, .image-link-expand"):
        node.decompose()

    for paragraph in body_div.select("p.button-wrapper"):
        link = paragraph.find("a", href=True)
        if not link:
            continue
        parsed = urlsplit(link["href"])
        if parsed.path == "/subscribe" or "action=share" in parsed.query:
            paragraph.decompose()

    comments = list(body_div.select("div.comment"))
    if comments and not exclude_comment_cards:
        raise ValueError(
            "embedded Substack comment card found; exclusion requires the explicit "
            "--exclude-comment-cards flag"
        )
    if exclude_comment_cards and not comments:
        raise ValueError(
            "--exclude-comment-cards was supplied, but no comment card was found"
        )
    for comment in comments:
        comment.decompose()


def hydrate_structured_components(body_div) -> None:
    """Restore components whose visible content lives in data-attrs, not body_html."""
    for mention in list(body_div.select("span.mention-wrap")):
        try:
            attrs = json.loads(mention.get("data-attrs") or "{}")
        except (json.JSONDecodeError, TypeError):
            attrs = {}
        name = (attrs.get("name") or "").strip()
        url = (attrs.get("url") or "").strip()
        if not name:
            raise ValueError("Substack mention has no structured name")
        if url:
            replacement = BeautifulSoup(
                f'<a href="{html.escape(url, quote=True)}">{html.escape(name)}</a>',
                "html.parser",
            ).a
        else:
            replacement = NavigableString(name)
        mention.replace_with(replacement)


def simplify_body_html(
    body_div,
    image_records: list[dict],
    embed_records: list[dict],
    preserve_subscription_caption: bool = False,
    exclude_comment_cards: bool = False,
) -> str:
    """Replace Substack layout wrappers with semantic content and image tokens."""
    hydrate_structured_components(body_div)
    remove_substack_chrome(
        body_div,
        preserve_subscription_caption,
        exclude_comment_cards,
    )

    image_index = 0
    for img in list(body_div.find_all("img")):
        if not raw_substack_image_url(img):
            continue
        image_index += 1
        token = f"SUBSTACK_IMAGE_{image_index:04d}"
        replacement = BeautifulSoup(f"<p>{token}</p>", "html.parser").p
        figure = img.find_parent("figure")
        container = img.find_parent("div", class_="captioned-image-container")
        target = container or figure or img
        target.replace_with(replacement)

    if image_index != len(image_records):
        raise ValueError(
            f"image placeholder mismatch: {image_index} body images vs "
            f"{len(image_records)} extracted images"
        )

    embed_index = 0
    for iframe in list(body_div.find_all("iframe")):
        embed_index += 1
        token = f"SUBSTACK_EMBED_{embed_index:04d}"
        replacement = BeautifulSoup(f"<p>{token}</p>", "html.parser").p
        youtube = iframe.find_parent("div", class_="youtube-wrap")
        (youtube or iframe).replace_with(replacement)
    if embed_index != len(embed_records):
        raise ValueError(
            f"embed placeholder mismatch: {embed_index} iframes vs "
            f"{len(embed_records)} extracted embeds"
        )

    for paragraph in body_div.find_all("p"):
        if paragraph.get_text("", strip=True) == "—":
            paragraph.clear()
            paragraph.append(NavigableString("SUBSTACK_LITERAL_EMDASH"))

    for inline in body_div.find_all(("a", "strong", "b", "em", "i", "mark", "s")):
        inline_text = inline.get_text()
        if inline_text[:1].isspace():
            inline.insert_before(NavigableString(" "))
        if inline_text[-1:].isspace():
            inline.insert_after(NavigableString(" "))

    for div in list(body_div.find_all("div")):
        if "pullquote" in div.get("class", []):
            div.attrs = {"class": ["pullquote"]}
        else:
            div.unwrap()
    for span in list(body_div.find_all("span")):
        span.unwrap()

    for tag in body_div.find_all(True):
        if tag.name == "a":
            tag.attrs = {
                key: value
                for key, value in tag.attrs.items()
                if key in {"href", "title"}
            }
        elif tag.name == "iframe":
            tag.attrs = {
                key: value
                for key, value in tag.attrs.items()
                if key
                in {
                    "src",
                    "title",
                    "width",
                    "height",
                    "allow",
                    "allowfullscreen",
                    "frameborder",
                }
            }
        elif tag.name == "ol" and tag.get("start"):
            tag.attrs = {"start": tag["start"]}
        elif tag.name in {"pre", "code"} and tag.get("class"):
            tag.attrs = {"class": tag["class"]}
        elif tag.name == "div" and "pullquote" in tag.get("class", []):
            tag.attrs = {"class": ["pullquote"]}
        else:
            tag.attrs = {}

    return body_div.decode_contents()


def html_to_markdown_via_pandoc(body_html: str) -> str:
    """Pipe semantic body HTML through pandoc. Local binary, no LLM."""
    proc = subprocess.run(
        [
            "pandoc",
            "-f",
            "html",
            "-t",
            "markdown+fenced_divs+raw_html",
            "--markdown-headings=atx",
            "--wrap=preserve",
        ],
        input=body_html,
        capture_output=True,
        text=True,
        check=True,
    )
    return proc.stdout


def markdown_attr_escape(value: str) -> str:
    """Escape text for a quoted Pandoc/Quarto attribute value."""
    return value.replace("\\", "\\\\").replace('"', '\\"').replace("\n", " ")


def image_markdown(record: dict) -> str:
    """Render one deterministic local image block."""
    local_path = record["local_path"]
    if record["caption_html"]:
        alt = html.escape(record["source_alt"], quote=True)
        return (
            '<figure class="substack-figure">\n'
            f'<img class="img-fluid" src="{html.escape(local_path, quote=True)}" '
            f'alt="{alt}">\n'
            f"<figcaption>{record['caption_html']}</figcaption>\n"
            "</figure>"
        )

    fig_alt = record.get("verified_fig_alt") or record["source_alt"] or "FIXME-verify"
    return f'![]({local_path}){{fig-alt="{markdown_attr_escape(fig_alt)}"}}'


def rewrite_image_tokens(md: str, image_records: list[dict]) -> str:
    """Replace deterministic image tokens with local Quarto image blocks."""
    for index, record in enumerate(image_records, 1):
        token = f"SUBSTACK_IMAGE_{index:04d}"
        if md.count(token) != 1:
            raise ValueError(f"expected exactly one {token} placeholder")
        md = md.replace(token, image_markdown(record))
    return md


def rewrite_embed_tokens(md: str, embed_records: list[dict]) -> str:
    """Replace deterministic embed tokens with sanitized raw iframe HTML."""
    for index, record in enumerate(embed_records, 1):
        token = f"SUBSTACK_EMBED_{index:04d}"
        if md.count(token) != 1:
            raise ValueError(f"expected exactly one {token} placeholder")
        responsive_embed = (
            f'<div class="ratio ratio-16x9 substack-embed">\n{record["html"]}\n</div>'
        )
        md = md.replace(token, responsive_embed)
    return md


def pandoc_plain(source: str, source_format: str) -> str:
    """Render semantic plain text for fidelity comparison."""
    proc = subprocess.run(
        ["pandoc", "-f", source_format, "-t", "plain", "--wrap=none"],
        input=source,
        capture_output=True,
        text=True,
        check=True,
    )
    return proc.stdout


def markdown_plain(source: str) -> str:
    """Render Markdown through HTML so text inside raw HTML blocks is included."""
    rendered = subprocess.run(
        [
            "pandoc",
            "-f",
            "markdown+fenced_divs+raw_html",
            "-t",
            "html",
            "--wrap=none",
        ],
        input=source,
        capture_output=True,
        text=True,
        check=True,
    ).stdout
    soup = BeautifulSoup(rendered, "html.parser")
    for figure in list(soup.find_all("figure")):
        figcaption = figure.find("figcaption")
        if figcaption:
            replacement = BeautifulSoup(
                f"<p>{clean_caption_html(figcaption)}</p>", "html.parser"
            ).p
            figure.replace_with(replacement)
        else:
            figure.decompose()
    for node in soup.find_all(("img", "iframe", "script", "style")):
        node.decompose()
    return pandoc_plain(str(soup), "html")


def expected_plain_from_body(
    body_div,
    preserve_subscription_caption: bool = False,
    exclude_comment_cards: bool = False,
) -> str:
    """Extract authored source text after deleting Substack UI and image pixels."""
    soup = BeautifulSoup(str(body_div), "html.parser")
    clean_body = find_body_div(soup) or soup
    hydrate_structured_components(clean_body)
    remove_substack_chrome(
        clean_body,
        preserve_subscription_caption,
        exclude_comment_cards,
    )

    for img in list(clean_body.find_all("img")):
        figure = img.find_parent("figure")
        container = img.find_parent("div", class_="captioned-image-container")
        target = container or figure or img
        figcaption = figure.find("figcaption") if figure else None
        if figcaption:
            replacement = BeautifulSoup(
                f"<p>{clean_caption_html(figcaption)}</p>", "html.parser"
            ).p
            target.replace_with(replacement)
        else:
            target.decompose()

    for iframe in clean_body.find_all("iframe"):
        iframe.decompose()
    return pandoc_plain(clean_body.decode_contents(), "html")


def normalized_plain(text: str) -> str:
    """Normalize Unicode, whitespace, rule lines, and spacing before punctuation."""
    text = unicodedata.normalize("NFC", text)
    text = text.translate(str.maketrans({"“": '"', "”": '"', "‘": "'", "’": "'"}))
    text = re.sub(r"(?m)^\s*[-_*]{3,}\s*$", " ", text)
    text = re.sub(r"(?m)^\s*(?:[-*+]|\d+[.)])\s+", "", text)
    text = re.sub(r"\s+", " ", text).strip()
    return re.sub(r"\s+([,.;:!?])", r"\1", text)


def wrap_first_paragraph_dropcap(md: str) -> str:
    """Wrap the first non-empty content paragraph in ::: {.dropcap} ::: fences."""
    lines = md.split("\n")
    out = []
    in_first = False
    found = False
    for line in lines:
        stripped = line.strip()
        is_nonparagraph = stripped.startswith(
            ("#", ">", "-", "*", "!", "|", "```", ":", "<")
        ) or bool(re.match(r"^\d+[.)]\s", stripped))
        if not found and stripped and not is_nonparagraph:
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


def yaml_quote(value: str) -> str:
    """Return a JSON-style quoted scalar, which is also valid YAML."""
    return json.dumps(value, ensure_ascii=False)


def main() -> int:
    p = argparse.ArgumentParser()
    source = p.add_mutually_exclusive_group(required=True)
    source.add_argument("--json", help="Path to Substack /api/v1/posts/<slug> JSON")
    source.add_argument("--html", help="Path to a full Substack HTML page")
    p.add_argument("--slug", required=True, help="Local slug (filename without .qmd)")
    p.add_argument("--canonical", required=True, help="Canonical URL on Substack")
    p.add_argument("--categories", required=True, help="Comma-separated category list")
    p.add_argument("--output", required=True, help="Output .qmd path")
    p.add_argument(
        "--subtitle", default=None, help="Subtitle override for --html input"
    )
    p.add_argument(
        "--image-list",
        default=None,
        help="Output: file listing extracted image URLs (one per line)",
    )
    p.add_argument(
        "--image-manifest",
        default=None,
        help="Output: JSON image metadata/caption manifest",
    )
    p.add_argument(
        "--image-dir",
        default=None,
        help="Local image dir for path rewriting (default: images/writing/<slug>)",
    )
    p.add_argument(
        "--verified-fig-alt",
        action="append",
        default=[],
        help=(
            "Visually verified factual alt text for each uncaptioned image, in body "
            "order; repeat once per uncaptioned image"
        ),
    )
    p.add_argument(
        "--fidelity-diff",
        default=None,
        help="Write a full plain-text diff here if fidelity verification fails",
    )
    p.add_argument(
        "--preserve-subscription-caption",
        action="store_true",
        help="Keep authored CTA-caption prose while removing the subscription form",
    )
    p.add_argument(
        "--exclude-comment-cards",
        action="store_true",
        help="Explicitly omit embedded Substack comment cards and their attachments",
    )
    p.add_argument(
        "--force", action="store_true", help="Allow replacing an existing output"
    )
    args = p.parse_args()

    if not SLUG_PATTERN.fullmatch(args.slug):
        print("ERROR: slug must be lowercase and hyphenated", file=sys.stderr)
        return 1

    expected_img_dir = f"images/writing/{args.slug}"
    raw_img_dir = args.image_dir or expected_img_dir
    img_path = PurePosixPath(raw_img_dir)
    if (
        raw_img_dir != expected_img_dir
        or img_path.is_absolute()
        or "\\" in raw_img_dir
        or any(part in {"", ".", ".."} for part in img_path.parts)
    ):
        print(
            f"ERROR: image-dir must be exactly {expected_img_dir}",
            file=sys.stderr,
        )
        return 1
    img_dir = str(img_path)

    canonical = urlsplit(args.canonical)
    expected_canonical_path = f"/p/{args.slug}"
    if (
        canonical.scheme != "https"
        or not canonical.netloc.endswith(".substack.com")
        or canonical.path != expected_canonical_path
        or canonical.query
        or canonical.fragment
    ):
        print(
            "ERROR: canonical must be an absolute HTTPS Substack URL whose path "
            f"is exactly {expected_canonical_path}",
            file=sys.stderr,
        )
        return 1

    categories = [item.strip() for item in args.categories.split(",") if item.strip()]
    if not 2 <= len(categories) <= 4 or any(
        not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", item) for item in categories
    ):
        print("ERROR: provide 2–4 lowercase, hyphenated categories", file=sys.stderr)
        return 1

    raw_out_path = Path(args.output).expanduser()
    if raw_out_path.suffix != ".qmd" or raw_out_path.name != f"{args.slug}.qmd":
        print(
            f"ERROR: output filename must be exactly {args.slug}.qmd",
            file=sys.stderr,
        )
        return 1

    source_path = Path(args.json or args.html).expanduser()
    source_label = "JSON" if args.json else "HTML"
    if not source_path.exists() or not source_path.is_file():
        print(f"ERROR: {source_label} file not found: {source_path}", file=sys.stderr)
        return 1

    if args.json:
        try:
            api_post = json.loads(source_path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError) as error:
            print(f"ERROR: could not read API JSON: {error}", file=sys.stderr)
            return 1
        if not isinstance(api_post, dict):
            print("ERROR: API JSON root must be an object", file=sys.stderr)
            return 1
        if api_post.get("slug") != args.slug:
            print(
                f"ERROR: API slug does not match --slug ({api_post.get('slug')!r})",
                file=sys.stderr,
            )
            return 1
        if api_post.get("canonical_url") != args.canonical:
            print(
                "ERROR: API canonical_url does not match --canonical", file=sys.stderr
            )
            return 1

        raw_title = api_post.get("title")
        raw_subtitle = api_post.get("subtitle")
        raw_post_date = api_post.get("post_date")
        body_fragment = api_post.get("body_html")
        if not isinstance(raw_title, str) or not raw_title.strip():
            print("ERROR: API title is missing or blank", file=sys.stderr)
            return 1
        if not isinstance(raw_subtitle, str):
            print("ERROR: API subtitle is missing or not text", file=sys.stderr)
            return 1
        if not isinstance(raw_post_date, str) or len(raw_post_date) < 10:
            print("ERROR: API post_date is missing or malformed", file=sys.stderr)
            return 1
        if not isinstance(body_fragment, str) or not body_fragment.strip():
            print("ERROR: API body_html is missing or blank", file=sys.stderr)
            return 1

        title = raw_title.rstrip()
        subtitle = raw_subtitle.rstrip()
        date_published = raw_post_date[:10]
        try:
            date.fromisoformat(date_published)
        except ValueError:
            print("ERROR: API post_date is not a valid date", file=sys.stderr)
            return 1
        soup = BeautifulSoup(
            f'<div class="body markup">{body_fragment}</div>', "html.parser"
        )
        body_div = soup.select_one("div.body.markup")
    else:
        soup = BeautifulSoup(source_path.read_text(encoding="utf-8"), "html.parser")
        meta = extract_jsonld(soup)
        raw_title = meta.get("headline")
        raw_post_date = meta.get("datePublished")
        if not isinstance(raw_title, str) or not raw_title.strip():
            print("ERROR: HTML metadata title is missing or blank", file=sys.stderr)
            return 1
        if not isinstance(raw_post_date, str) or len(raw_post_date) < 10:
            print("ERROR: HTML metadata datePublished is missing", file=sys.stderr)
            return 1
        title = raw_title.rstrip()
        subtitle = (args.subtitle or "").rstrip()
        date_published = raw_post_date[:10]
        try:
            date.fromisoformat(date_published)
        except ValueError:
            print(
                "ERROR: HTML metadata datePublished is not a valid date",
                file=sys.stderr,
            )
            return 1
        body_div = find_body_div(soup)

    if body_div is None:
        print("ERROR: could not locate article body div", file=sys.stderr)
        return 2

    try:
        destinations = prepare_destination_paths(
            source_path,
            {
                "output": args.output,
                "image-list": args.image_list,
                "image-manifest": args.image_manifest,
                "fidelity-diff": args.fidelity_diff,
            },
            args.force,
        )
    except ValueError as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 1

    out_path = destinations["output"]

    expected_plain = expected_plain_from_body(
        body_div,
        args.preserve_subscription_caption,
        args.exclude_comment_cards,
    )
    image_records = extract_substack_images(body_div, img_dir)
    uncaptioned_images = [
        record for record in image_records if not record["caption_html"]
    ]
    if args.verified_fig_alt:
        if len(args.verified_fig_alt) != len(uncaptioned_images):
            print(
                "ERROR: provide exactly one --verified-fig-alt per uncaptioned "
                f"image ({len(uncaptioned_images)} required)",
                file=sys.stderr,
            )
            return 1
        for record, fig_alt in zip(uncaptioned_images, args.verified_fig_alt):
            clean_fig_alt = fig_alt.strip()
            if not clean_fig_alt or "\n" in clean_fig_alt:
                print(
                    "ERROR: verified fig-alt values must be nonblank, single-line text",
                    file=sys.stderr,
                )
                return 1
            record["verified_fig_alt"] = clean_fig_alt
    embed_records = extract_substack_embeds(body_div)
    semantic_html = simplify_body_html(
        body_div,
        image_records,
        embed_records,
        args.preserve_subscription_caption,
        args.exclude_comment_cards,
    )
    body_md = html_to_markdown_via_pandoc(semantic_html)
    body_md = rewrite_image_tokens(body_md, image_records)
    body_md = rewrite_embed_tokens(body_md, embed_records)
    body_md = body_md.replace("SUBSTACK_LITERAL_EMDASH", "—")
    if (
        "data:image" in body_md
        or "SUBSTACK_IMAGE_" in body_md
        or "SUBSTACK_EMBED_" in body_md
        or "SUBSTACK_LITERAL_" in body_md
    ):
        print("ERROR: unprocessed Substack image chrome remains", file=sys.stderr)
        return 2
    body_md = wrap_first_paragraph_dropcap(body_md.strip())

    actual_plain = markdown_plain(body_md)
    expected_normalized = normalized_plain(expected_plain)
    actual_normalized = normalized_plain(actual_plain)
    if expected_normalized != actual_normalized:
        if "fidelity-diff" in destinations:
            diff = "".join(
                difflib.unified_diff(
                    expected_plain.splitlines(keepends=True),
                    actual_plain.splitlines(keepends=True),
                    fromfile="clean-substack-body",
                    tofile="generated-qmd-body",
                )
            )
            atomic_write_many([(destinations["fidelity-diff"], diff)])
        expected_hash = hashlib.sha256(expected_normalized.encode()).hexdigest()[:12]
        actual_hash = hashlib.sha256(actual_normalized.encode()).hexdigest()[:12]
        print(
            f"ERROR: fidelity mismatch (expected {expected_hash}, actual {actual_hash})",
            file=sys.stderr,
        )
        return 3

    if "fidelity-diff" in destinations and destinations["fidelity-diff"].exists():
        destinations["fidelity-diff"].unlink()

    og_image = (
        image_records[0]["local_path"]
        if image_records
        else "/images/austin-p-morrissey-headshot.jpg"
    )
    categories_yaml = ", ".join(categories)
    frontmatter = (
        f"---\n"
        f"title: {yaml_quote(title)}\n"
        + (f"subtitle: {yaml_quote(subtitle)}\n" if subtitle else "")
        + f"date: {date_published}\n"
        f"categories: [{categories_yaml}]\n"
        f"image: {og_image}\n"
        f"canonical-url: {args.canonical}\n"
        f"---\n\n"
    )

    files_to_write = [(out_path, frontmatter + body_md + "\n")]
    if "image-list" in destinations:
        image_urls = [record["url"] for record in image_records]
        files_to_write.append(
            (
                destinations["image-list"],
                "\n".join(image_urls) + ("\n" if image_urls else ""),
            )
        )
    if "image-manifest" in destinations:
        files_to_write.append(
            (
                destinations["image-manifest"],
                json.dumps(image_records, ensure_ascii=False, indent=2) + "\n",
            )
        )
    atomic_write_many(files_to_write)

    print(f"Output path: {out_path}")
    print(f"Bytes: {out_path.stat().st_size}")
    print(f"Image URLs: {len(image_records)}")
    print(
        f"Authored captions: {sum(bool(item['caption_html']) for item in image_records)}"
    )
    print(
        "Alt text pending visual check: "
        f"{sum(not item['caption_html'] and not item.get('verified_fig_alt') for item in image_records)}"
    )
    print(f"Title: {title}")
    print(f"Date: {date_published}")
    print(f"Body word count: {len(expected_normalized.split())}")
    print("Fidelity: PASS")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (ValueError, subprocess.CalledProcessError) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        sys.exit(2)
