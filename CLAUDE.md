# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Status

This repository is currently empty — no source files, build config, or dependency manifest exist yet.
Nothing below has been verified against real code.

When the first code lands, re-run `/init` so this file can be regenerated from the actual
codebase. Until then, do not treat any command or architectural claim in this file as ground truth.

## Commands

_Unknown._ No package manifest, build config, or test runner is present. Discover and record the
build / lint / test / single-test commands here once the project is scaffolded.

## Architecture

_Unknown._ Record here only what requires reading multiple files to understand — the module
boundaries, data flow, and cross-cutting decisions that are not obvious from directory listings.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
