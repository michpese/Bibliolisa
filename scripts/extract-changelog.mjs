import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Escapes special RegExp characters.
 * @param {string} value
 * @returns {string}
 */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Extrahiert den Abschnitt einer Release-Version (mit oder ohne führendem "v") aus CHANGELOG.md.
 * @param {string} markdown
 * @param {string} tag
 * @returns {string}
 */
export function extractChangelogSection(markdown, tag) {
  const normalizedTag = String(tag ?? '').trim().replace(/^[vV]/, '');
  if (!normalizedTag) {
    return '';
  }

  const lines = String(markdown ?? '').replace(/\r\n/g, '\n').split('\n');
  const escapedVersion = escapeRegExp(normalizedTag);
  const startPattern = new RegExp(
    `^##\\s+\\[?[vV]?${escapedVersion}\\]?(?:\\s|$)`,
    'i'
  );

  let collecting = false;
  const collected = [];

  for (const line of lines) {
    if (!collecting) {
      if (startPattern.test(line.trim())) {
        collecting = true;
      }
      continue;
    }

    if (/^##\s+/.test(line.trim())) {
      break;
    }

    collected.push(line);
  }

  if (!collecting) {
    return '';
  }

  while (
    collected.length > 0 &&
    (!collected[0].trim() || /^---+$/.test(collected[0].trim()))
  ) {
    collected.shift();
  }

  while (
    collected.length > 0 &&
    (!collected[collected.length - 1].trim() ||
      /^---+$/.test(collected[collected.length - 1].trim()))
  ) {
    collected.pop();
  }

  return collected.join('\n');
}

const currentFile = path.resolve(fileURLToPath(import.meta.url));
const executedFile = process.argv[1] ? path.resolve(process.argv[1]) : '';

if (currentFile === executedFile) {
  const tagArg = process.argv[2] ?? '';
  const changelogPath = path.resolve(process.argv[3] ?? 'CHANGELOG.md');

  if (!tagArg || !fs.existsSync(changelogPath)) {
    process.exit(0);
  }

  const markdown = fs.readFileSync(changelogPath, 'utf8');
  const section = extractChangelogSection(markdown, tagArg);
  if (section) {
    process.stdout.write(`${section}\n`);
  }
}
