/**
 * HTML Documentation Extractor
 *
 * Extracts documentation content from local SkySpark/Fantom HTML files.
 */

import * as fs from 'fs';
import * as path from 'path';
import { load, CheerioAPI } from 'cheerio';
import { createLogger, sanitizeId } from '../../utils/index.js';
import type { LocalDocItem } from './types.js';
import { getFileType } from './skysparkDocScanner.js';

const logger = createLogger('html-extractor');

/**
 * Parse a type documentation file (e.g., Bool.html, HttpClient.html)
 */
export function extractTypeDoc(
  filePath: string,
  podName: string,
  instanceId: number,
  version?: string
): LocalDocItem | null {
  try {
    const html = fs.readFileSync(filePath, 'utf-8');
    const $ = load(html);
    const basename = path.basename(filePath, '.html');

    // Get type name from h1
    const typeName = $('h1').first().text().trim() || basename;
    const qualifiedName = `${podName}::${typeName}`;

    // Get signature from defc-type-sig
    const signatureEl = $('p.defc-type-sig code');
    const signature = signatureEl.text().trim().replace(/\s+/g, ' ') || undefined;

    // Get description from first paragraph after signature
    const descriptionEl = $('div.defc-main-section p').first();
    const description = descriptionEl.text().trim() || `${typeName} from ${podName}`;

    // Build file URL
    const url = `file://${filePath}`;

    // Extract keywords from type members
    const keywords = extractKeywords($, typeName, podName);

    const item: LocalDocItem = {
      id: sanitizeId(qualifiedName),
      name: typeName,
      qualifiedName,
      type: 'type',
      pod: podName,
      signature,
      description,
      url,
      version,
      instanceId,
      language: 'fantom',
      runtime: 'fantom',
      keywords
    };

    return item;
  } catch (error) {
    logger.warn(`Failed to extract type from ${filePath}: ${error}`);
    return null;
  }
}

/**
 * Extract slots (methods, fields) from a type documentation file
 */
export function extractSlots(
  filePath: string,
  podName: string,
  instanceId: number,
  version?: string
): LocalDocItem[] {
  const items: LocalDocItem[] = [];

  try {
    const html = fs.readFileSync(filePath, 'utf-8');
    const $ = load(html);
    const basename = path.basename(filePath, '.html');

    // Get parent type name
    const parentType = $('h1').first().text().trim() || basename;

    // Extract from summary tables (defc-props)
    $('table.defc-props tr').each((_, row) => {
      const $row = $(row);
      const th = $row.find('th');
      const td = $row.find('td');

      if (th.length && td.length) {
        const slotName = th.text().trim();
        const description = td.find('p').first().text().trim() || td.text().trim();

        if (slotName && !slotName.includes(' ')) {
          const qualifiedName = `${podName}::${parentType}.${slotName}`;

          items.push({
            id: sanitizeId(qualifiedName),
            name: slotName,
            qualifiedName,
            type: 'slot',
            pod: podName,
            parent: parentType,
            description,
            url: `file://${filePath}#${slotName}`,
            version,
            instanceId,
            language: 'fantom',
            runtime: 'fantom',
            keywords: [slotName, parentType, podName]
          });
        }
      }
    });

    return items;
  } catch (error) {
    logger.warn(`Failed to extract slots from ${filePath}: ${error}`);
    return [];
  }
}

/**
 * Parse an Axon function documentation file (e.g., func~abs.html)
 */
export function extractAxonFunction(
  filePath: string,
  podName: string,
  instanceId: number,
  version?: string
): LocalDocItem | null {
  try {
    const html = fs.readFileSync(filePath, 'utf-8');
    const $ = load(html);
    const basename = path.basename(filePath, '.html');

    // Extract function name from filename (func~abs -> abs)
    const funcName = basename.replace('func~', '');
    const qualifiedName = `func:${funcName}`;

    // Get signature from h2 (may include "abs(val)" format)
    const h2 = $('div.defc-main-section h2').first().text().trim();

    // Signature from h2 (e.g., "abs(val)")
    const signature = h2 || undefined;

    // Description from first paragraph in main section
    const description = $('div.defc-main-section p').first().text().trim() ||
      `Axon function: ${funcName}`;

    // Build file URL
    const url = `file://${filePath}`;

    // Extract metadata from meta table
    const metadata: Record<string, string> = {};
    $('div.defc-main-section').each((_, section) => {
      const $section = $(section);
      const heading = $section.prev('h2.defc-main-heading').text().trim();

      if (heading.toLowerCase().includes('meta')) {
        $section.find('table.defc-props tr').each((__, row) => {
          const $row = $(row);
          const key = $row.find('th').text().trim();
          const value = $row.find('td').text().trim();
          if (key && value) {
            metadata[key] = value;
          }
        });
      }
    });

    // Keywords from function name and metadata
    const keywords = [funcName, 'axon', 'function', podName];
    if (metadata.name) keywords.push(metadata.name);

    const item: LocalDocItem = {
      id: sanitizeId(`axon-${funcName}`),
      name: funcName,
      qualifiedName,
      type: 'function',
      pod: podName,
      signature,
      description,
      url,
      version,
      instanceId,
      language: 'axon',
      runtime: 'fantom',
      metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
      keywords
    };

    return item;
  } catch (error) {
    logger.warn(`Failed to extract Axon function from ${filePath}: ${error}`);
    return null;
  }
}

/**
 * Parse a chapter/guide documentation file
 */
export function extractChapter(
  filePath: string,
  podName: string,
  instanceId: number,
  version?: string
): LocalDocItem | null {
  try {
    const html = fs.readFileSync(filePath, 'utf-8');
    const $ = load(html);
    const basename = path.basename(filePath, '.html');

    // Get title from h1 or title element
    const title = $('h1').first().text().trim() ||
      $('title').text().replace(/\s*–.*$/, '').trim() ||
      basename;

    // Get description from first paragraph
    const description = $('div.defc-main-section p').first().text().trim() ||
      $('p').first().text().trim() ||
      `Documentation chapter: ${title}`;

    const qualifiedName = `${podName}::${basename}`;
    const url = `file://${filePath}`;

    const item: LocalDocItem = {
      id: sanitizeId(qualifiedName),
      name: title,
      qualifiedName,
      type: 'chapter',
      pod: podName,
      description: description.substring(0, 500), // Limit description length
      url,
      version,
      instanceId,
      language: 'fantom',
      runtime: 'fantom',
      keywords: [title, basename, podName]
    };

    return item;
  } catch (error) {
    logger.warn(`Failed to extract chapter from ${filePath}: ${error}`);
    return null;
  }
}

/**
 * Parse a documentation file based on its type
 */
export function extractDocFile(
  filePath: string,
  podName: string,
  instanceId: number,
  version?: string,
  isAxonPod: boolean = false
): LocalDocItem[] {
  const items: LocalDocItem[] = [];
  const fileType = getFileType(filePath);

  switch (fileType) {
    case 'type':
      const typeItem = extractTypeDoc(filePath, podName, instanceId, version);
      if (typeItem) {
        items.push(typeItem);
        // Also extract slots for the type
        const slots = extractSlots(filePath, podName, instanceId, version);
        items.push(...slots);
      }
      break;

    case 'function':
      const funcItem = extractAxonFunction(filePath, podName, instanceId, version);
      if (funcItem) {
        items.push(funcItem);
      }
      break;

    case 'chapter':
      // For Axon lib pods, lowercase files might be functions
      if (isAxonPod) {
        const basename = path.basename(filePath, '.html');
        // Check if it looks like a function (lowercase, no special chars)
        if (/^[a-z][a-zA-Z0-9]*$/.test(basename) && basename !== 'index') {
          const funcItem = extractAxonFunction(filePath, podName, instanceId, version);
          if (funcItem) {
            items.push(funcItem);
            break;
          }
        }
      }
      const chapterItem = extractChapter(filePath, podName, instanceId, version);
      if (chapterItem) {
        items.push(chapterItem);
      }
      break;

    case 'index':
      // Skip index files
      break;

    default:
      // Try as chapter
      const defaultItem = extractChapter(filePath, podName, instanceId, version);
      if (defaultItem) {
        items.push(defaultItem);
      }
  }

  return items;
}

/**
 * Extract keywords from a type documentation page
 */
function extractKeywords($: CheerioAPI, typeName: string, podName: string): string[] {
  const keywords: string[] = [typeName, podName];

  // Add slot names as keywords
  $('table.defc-props th a').each((_, el) => {
    const slotName = $(el).text().trim();
    if (slotName && !keywords.includes(slotName)) {
      keywords.push(slotName);
    }
  });

  // Add parent class if present
  const signature = $('p.defc-type-sig code').text();
  const extendsMatch = signature.match(/:\s*(\w+)/);
  if (extendsMatch) {
    keywords.push(extendsMatch[1]);
  }

  // Limit keywords
  return keywords.slice(0, 20);
}
