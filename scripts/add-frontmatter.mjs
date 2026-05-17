#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, '..');
const contentDir = path.join(projectRoot, 'src', 'content');

const seriesConfigs = {
  blog: { prefix: '源码分析', baseDate: '2024-04-28' },
  extension: { prefix: '扩展开发', baseDate: '2024-05-16' },
  performance: { prefix: '性能优化', baseDate: '2024-05-16' },
  security: { prefix: '安全模型', baseDate: '2024-05-16' },
  ux: { prefix: '终端UX', baseDate: '2024-05-16' }
};

function extractTitle(content) {
  const lines = content.split('\n');
  for (const line of lines) {
    if (line.startsWith('# ')) {
      return line.slice(2).trim();
    }
  }
  return 'Untitled';
}

function extractDescription(content) {
  const lines = content.split('\n');
  let desc = '';
  let foundTitle = false;
  for (const line of lines) {
    if (line.startsWith('# ')) {
      foundTitle = true;
      continue;
    }
    if (foundTitle && line.trim() && !line.startsWith('#') && !line.startsWith('```')) {
      desc = line.trim();
      if (desc.length > 100) desc = desc.slice(0, 100) + '...';
      break;
    }
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
    const content = fs.readFileSync(filePath, 'utf-8');

    // Skip if already has frontmatter
    if (content.startsWith('---\n')) continue;

    const title = extractTitle(content);
    const description = extractDescription(content);
    const order = extractOrder(file);

    // Calculate reading time (approx 200 words per minute for Chinese)
    const wordCount = content.length;
    const readingTime = Math.ceil(wordCount / 400) + ' min';

    const frontmatter = `---
title: ${JSON.stringify(title)}
description: ${JSON.stringify(description)}
publishDate: ${seriesConfigs[seriesName].baseDate}
order: ${order}
readingTime: ${JSON.stringify(readingTime)}
---

`;

    // Remove the first H1 title since it's now in frontmatter
    const newContent = frontmatter + content.replace(/^# .*\n/, '');

    fs.writeFileSync(filePath, newContent, 'utf-8');
    console.log(`Processed: ${seriesName}/${file}`);
  }
}

// Process all series
for (const seriesName of Object.keys(seriesConfigs)) {
  processSeries(seriesName);
}

console.log('Done!');