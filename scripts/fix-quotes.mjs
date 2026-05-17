#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, '..');
const contentDir = path.join(projectRoot, 'src', 'content');

const seriesList = ['blog', 'extension', 'performance', 'security', 'ux'];

for (const series of seriesList) {
  const seriesDir = path.join(contentDir, series);
  const files = fs.readdirSync(seriesDir).filter(f => f.endsWith('.md'));

  for (const file of files) {
    const filePath = path.join(seriesDir, file);
    let content = fs.readFileSync(filePath, 'utf-8');

    // Replace Chinese quotes with single quotes
    content = content.replace(/"/g, "'");
    content = content.replace(/"/g, "'");

    fs.writeFileSync(filePath, content, 'utf-8');
    console.log(`Fixed: ${series}/${file}`);
  }
}

console.log('All files fixed!');