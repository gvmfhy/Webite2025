#!/usr/bin/env bash
# Vercel build script: download Quarto for Linux amd64, render the site to _site/.
# Called from vercel.json buildCommand (which has a 256-char string limit, hence this script).

set -eux

QUARTO_VERSION="1.7.34"
QUARTO_URL="https://github.com/quarto-dev/quarto-cli/releases/download/v${QUARTO_VERSION}/quarto-${QUARTO_VERSION}-linux-amd64.tar.gz"

curl -fsSL "$QUARTO_URL" -o quarto.tar.gz
mkdir -p quarto-bin
tar -xzf quarto.tar.gz -C quarto-bin --strip-components=1

quarto-bin/bin/quarto --version
quarto-bin/bin/quarto render
