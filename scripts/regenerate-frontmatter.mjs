#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, '..');
const contentDir = path.join(projectRoot, 'src', 'content');

const seriesConfigs = {
  blog: { baseDate: '2024-04-28' },
  extension: { baseDate: '2024-05-16' },
  performance: { baseDate: '2024-05-16' },
  security: { baseDate: '2024-05-16' },
  ux: { baseDate: '2024-05-16' }
};

function extractTitle(content) {
  const lines = content.split('\n');
  // Skip frontmatter if exists
  let startIdx = 0;
  if (content.startsWith('---\n')) {
    const secondDash = content.indexOf('\n---\n', 4);
    if (secondDash !== -1) {
      startIdx = secondDash + 5;
    }
  }

  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('# ')) {
      return line.slice(2).trim();
    }
    if (line.trim() && !line.startsWith('#') && !line.startsWith('```')) {
      // Found non-heading content, return first significant paragraph as description source
      break;
    }
  }

  // Try to find title from existing frontmatter
  const titleMatch = content.match(/^---\n.*?title:\s*["']?(.+?)["']?\n/);
  if (titleMatch) {
    return titleMatch[1].replace(/^["']|["']$/g, '');
  }

  return 'Untitled';
}

function extractDescription(content) {
  const lines = content.split('\n');
  let desc = '';
  let foundTitle = false;
  let startIdx = 0;

  if (content.startsWith('---\n')) {
    const secondDash = content.indexOf('\n---\n', 4);
    if (secondDash !== -1) {
      startIdx = secondDash + 5;
    }
  }

  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('# ')) {
      foundTitle = true;
      continue;
    }
    if (foundTitle && line.trim() && !line.startsWith('#') && !line.startsWith('```')) {
      desc = line.trim();
      if (desc.length > 120) desc = desc.slice(0, 120) + '...';
      break;
    }
  }

  // Try existing frontmatter
  const descMatch = content.match(/^---\n.*?description:\s*["']?(.+?)["']?\n/);
  if (descMatch) {
    return descMatch[1].replace(/^["']|["']$/g, '');
  }

  return desc || '文章内容摘要';
}

function extractOrder(filename) {
  const match = filename.match(/^(\d+)-/);
  return match ? parseInt(match[1], 10) : 1;
}

function processSeries(seriesName) {
  const seriesDir = path.join(contentDir, seriesName);
  const files = fs.readdirSync(seriesDir).filter(f => f.endsWith('.md'));

  for (const file of files) {
    const filePath = path.join(seriesDir, file);
    let content = fs.readFileSync(filePath, 'utf-8');

    const title = extractTitle(content);
    const description = extractDescription(content);
    const order = extractOrder(file);

    const wordCount = content.length;
    const readingTime = Math.ceil(wordCount / 400) + ' min';

    // Remove existing frontmatter
    if (content.startsWith('---\n')) {
      const secondDash = content.indexOf('\n---\n', 4);
      if (secondDash !== -1) {
        content = content.slice(secondDash + 5);
      }
    }

    // Remove first H1 if it matches title
    const lines = content.split('\n');
    if (lines[0].startsWith('# ')) {
      content = lines.slice(1).join('\n');
    }

    const frontmatter = `---
title: ${JSON.stringify(title)}
description: ${JSON.stringify(description)}
publishDate: ${seriesConfigs[seriesName].baseDate}
order: ${order}
readingTime: ${JSON.stringify(readingTime)}
---

`;

    const newContent = frontmatter + content.trim() + '\n';
    fs.writeFileSync(filePath, newContent, 'utf-8');
    console.log(`Regenerated: ${seriesName}/${file}`);
  }
}

for (const seriesName of Object.keys(seriesConfigs)) {
  processSeries(seriesName);
}

console.log('All frontmatter regenerated!');