# Writing on this site

Every essay is one plain-text file in `writing/`, ending in `.qmd`. A file is a short
header (between the `---` lines) plus your writing in Markdown. That's the whole system.

## Two ways to write — pick what's comfortable

**1. Visual editor (recommended — feels like Google Docs).**
Open the repo folder in VS Code, open any `.qmd`, and click the **"Visual"** toggle in the
top-right of the editor (install the **Quarto** extension first — VS Code will offer it).
You type formatted text; Quarto saves it as `.qmd` behind the scenes. No Markdown symbols to learn.

**2. Plain Markdown.** Even simpler underneath. You only need:
`# Heading`, `**bold**`, `*italic*`, `[link text](https://url)`, a blank line between
paragraphs, `> quote`, and `- ` for bullets. `---` on its own line makes a section divider.

## Start a new essay (one command)

```bash
./new-post.sh "Your Essay Title"
```

This creates `writing/your-essay-title.qmd` with the header pre-filled and today's date,
and opens it in VS Code. You never hand-write the fiddly header.

## See it as you write

```bash
quarto preview
```

Opens the site locally and **auto-reloads every time you save** — type in the editor,
watch it update in the browser.

## The header fields

- `title` — required.
- `date` — `YYYY-MM-DD`. Controls ordering (newest first).
- `categories` — lowercase tags like `[biosecurity, voice]`. They drive the Archive tag
  cloud and the "Related reading" links between essays.
- `description` — one sentence; used for Google and social-share previews.
- `subtitle` — optional one-liner under the title.
- `canonical-url` — optional; point it at the Substack version if you cross-post.
- `featured: true` (+ `featured-order: 1`) — pins the essay to the Featured rail.

## Working with Claude

Write your draft in the IDE and save. Then just say "render and review the new essay" —
Claude reads the file, builds it, screenshots it, and you iterate together. Same loop we
used for the homepage and About copy.
