#!/usr/bin/env bash
# Vercel build script: download Quarto for Linux amd64, render the site to _site/.
# Called from vercel.json buildCommand (which has a 256-char string limit, hence this script).
#
# Quarto is installed to /tmp/ rather than inside the project tree, because
# `quarto render` recursively scans the project for .qmd files — and Quarto's
# own distribution ships template .qmd files (e.g. share/create/extensions/
# shortcode/example.ejs.qmd) that aren't valid Quarto markdown. Extracting
# outside the project keeps render from finding those.

set -eux

QUARTO_VERSION="1.7.34"
QUARTO_URL="https://github.com/quarto-dev/quarto-cli/releases/download/v${QUARTO_VERSION}/quarto-${QUARTO_VERSION}-linux-amd64.tar.gz"
QUARTO_DIR="/tmp/quarto-${QUARTO_VERSION}"

mkdir -p "$QUARTO_DIR"
curl -fsSL "$QUARTO_URL" -o /tmp/quarto.tar.gz
tar -xzf /tmp/quarto.tar.gz -C "$QUARTO_DIR" --strip-components=1

"$QUARTO_DIR/bin/quarto" --version
"$QUARTO_DIR/bin/quarto" render
