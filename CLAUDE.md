# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A Chinese-language static blog built with Astro 5.x and Tailwind CSS, deployed to GitHub Pages. The blog contains technical articles about Claude Code organized into five themed series.

## Commands

```bash
npm run dev          # Start development server (localhost:4321)
npm run build        # Build static site + run pagefind for search
npm run preview      # Preview built site locally
```

## Architecture

### Content Collections

Five article series defined in `src/content/config.ts`:
- `blog` - Claude Code 源码分析
- `extension` - Claude Code 扩展开发
- `performance` - Claude Code 性能优化
- `security` - Claude Code 安全模型
- `ux` - Claude Code 终端 UX

Each article requires frontmatter: `title`, `description`, `publishDate`, `order`, optional `tags` and `readingTime`.

### Series Metadata

Centralized in `src/utils/series.ts` via `SERIES_CONFIG`. Contains title, description, color, and order for each series. Use `getSeriesMeta(seriesId)` to access.

### Routing

- `/` - Homepage showing series cards and recent articles
- `/[series]/` - Series listing page
- `/[series]/[slug]` - Individual article page

### Key Components

- `Layout.astro` - Base HTML wrapper with Header
- `ArticleLayout.astro` - Article page with SeriesNav sidebar
- `SeriesNav.astro` - Navigation sidebar showing series articles
- `Header.astro` - Site header with theme toggle and navigation

### Styles

Global prose styles in `src/styles/global.css` define typography for article content. Dark mode uses `class` strategy (toggle via ThemeToggle component).

## Deployment

GitHub Pages deployment via `.github/workflows/deploy.yml`. Site URL configured in `astro.config.mjs` (`site` and `base` fields).