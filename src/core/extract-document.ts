import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as childProcess from 'node:child_process';
import { XMLParser } from 'fast-xml-parser';
import { unzipSync } from 'fflate';
import { defaultImportedDocumentTitle } from './import-document.js';

export type ExtractDocumentStatus = 'ready' | 'needs_dependency' | 'failed';
export type ReadingBasis = 'text' | 'ocr';
export type DocumentExtractor = 'ferrules' | 'mammoth' | 'sheetjs' | 'ooxml-pptx';

export interface InstallInstructions {
  platform: 'macos-arm64' | 'macos-x64';
  steps: string[];
  notes: string[];
}

export interface ExtractDocumentResult {
  doc_type: 'pdf' | 'docx' | 'xlsx' | 'pptx';
  status: ExtractDocumentStatus;
  extractor: DocumentExtractor;
  reading_basis: ReadingBasis;
  raw_text: string;
  confidence: number;
  limits: string[];
  title_hint: string;
  missing_dependency?: 'ferrules';
  install_source_url?: string;
  install_instructions?: InstallInstructions;
  verify_command?: string;
  user_prompt?: string;
}

export function isDocumentParsingDisabled(): boolean {
  const value = process.env.GRANITE_DISABLE_DOCUMENT_PARSING?.trim().toLowerCase();
  return value === '1' || value === 'true';
}

const FERRULES_RELEASES_URL = 'https://github.com/aminediro/ferrules/releases';
const FERRULES_VERIFY_COMMAND = 'ferrules --version';
const PPTX_XML_PARSER = new XMLParser({
  ignoreAttributes: false,
  trimValues: true,
});

export async function extractDocument(filePath: string): Promise<ExtractDocumentResult> {
  const resolvedPath = path.resolve(filePath);
  const extension = path.extname(resolvedPath).toLowerCase();

  switch (extension) {
    case '.pdf':
      return extractPdfWithFerrules(resolvedPath);
    case '.docx':
      return extractDocx(resolvedPath);
    case '.xlsx':
      return extractXlsx(resolvedPath);
    case '.pptx':
      return extractPptx(resolvedPath);
    default:
      throw new Error(`Unsupported document type: "${extension || path.basename(resolvedPath)}". Expected one of: .pdf, .docx, .xlsx, .pptx`);
  }
}

async function extractDocx(filePath: string): Promise<ExtractDocumentResult> {
  const { default: mammoth } = await import('mammoth');
  const result = await mammoth.extractRawText({ path: filePath });
  const rawText = normalizeRawText(result.value);
  const limits = result.messages.map(message => `[${message.type}] ${message.message}`);

  if (!rawText) {
    return failedResult('docx', 'mammoth', defaultImportedDocumentTitle(filePath), [
      ...limits,
      'No extractable text found in the DOCX document.',
    ]);
  }

  return {
    doc_type: 'docx',
    status: 'ready',
    extractor: 'mammoth',
    reading_basis: 'text',
    raw_text: rawText,
    confidence: limits.length > 0 ? 0.85 : 0.95,
    limits,
    title_hint: defaultImportedDocumentTitle(filePath),
  };
}

async function extractXlsx(filePath: string): Promise<ExtractDocumentResult> {
  const { default: XLSX } = await import('xlsx');
  const workbook = XLSX.readFile(filePath, { cellText: true, cellDates: false });
  const sections: string[] = [];

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json<(string | number | boolean | null)[]>(sheet, {
      header: 1,
      raw: false,
      blankrows: false,
      defval: '',
    });
    const textRows = rows
      .map(row => row.map(cell => String(cell ?? '').trim()).filter(Boolean).join('\t'))
      .filter(Boolean);

    if (textRows.length === 0) {
      continue;
    }

    sections.push(`Sheet: ${sheetName}`);
    sections.push(...textRows);
  }

  const rawText = normalizeRawText(sections.join('\n'));
  if (!rawText) {
    return failedResult('xlsx', 'sheetjs', defaultImportedDocumentTitle(filePath), [
      'No extractable cells found in the XLSX workbook.',
    ]);
  }

  return {
    doc_type: 'xlsx',
    status: 'ready',
    extractor: 'sheetjs',
    reading_basis: 'text',
    raw_text: rawText,
    confidence: 0.9,
    limits: [],
    title_hint: defaultImportedDocumentTitle(filePath),
  };
}

async function extractPptx(filePath: string): Promise<ExtractDocumentResult> {
  const archive = unzipSync(new Uint8Array(fs.readFileSync(filePath)));
  const slideNames = Object.keys(archive)
    .filter(name => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
    .sort(comparePptxSlides);

  const sections: string[] = [];
  for (const slideName of slideNames) {
    const xml = Buffer.from(archive[slideName]).toString('utf-8');
    const parsed = PPTX_XML_PARSER.parse(xml) as unknown;
    const textRuns = collectSlideText(parsed);
    if (textRuns.length === 0) {
      continue;
    }

    sections.push(`Slide: ${path.basename(slideName, '.xml')}`);
    sections.push(...textRuns);
  }

  const rawText = normalizeRawText(sections.join('\n'));
  if (!rawText) {
    return failedResult('pptx', 'ooxml-pptx', defaultImportedDocumentTitle(filePath), [
      'No extractable text runs found in the PPTX deck.',
    ]);
  }

  return {
    doc_type: 'pptx',
    status: 'ready',
    extractor: 'ooxml-pptx',
    reading_basis: 'text',
    raw_text: rawText,
    confidence: 0.9,
    limits: [],
    title_hint: defaultImportedDocumentTitle(filePath),
  };
}

async function extractPdfWithFerrules(filePath: string): Promise<ExtractDocumentResult> {
  const titleHint = defaultImportedDocumentTitle(filePath);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'granite-ferrules-'));

  try {
    try {
      childProcess.execFileSync('ferrules', [filePath, '--output-dir', tmpDir], {
        stdio: 'pipe',
        encoding: 'utf-8',
      });
    } catch (error) {
      if (isMissingFerrules(error)) {
        return buildFerrulesMissingDependencyResult(titleHint);
      }

      return failedResult('pdf', 'ferrules', titleHint, [
        error instanceof Error ? error.message : String(error),
      ]);
    }

    const outputFiles = walkFiles(tmpDir);
    const rawText = extractFerrulesRawText(outputFiles);
    if (!rawText) {
      return failedResult('pdf', 'ferrules', titleHint, [
        'Ferrules completed but Granite could not find any extractable text in the output directory.',
      ]);
    }

    return {
      doc_type: 'pdf',
      status: 'ready',
      extractor: 'ferrules',
      reading_basis: detectFerrulesReadingBasis(outputFiles),
      raw_text: normalizeRawText(rawText),
      confidence: 0.9,
      limits: [],
      title_hint: titleHint,
    };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function comparePptxSlides(left: string, right: string): number {
  return extractSlideNumber(left) - extractSlideNumber(right);
}

function extractSlideNumber(slidePath: string): number {
  const match = slidePath.match(/slide(\d+)\.xml$/i);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

function collectSlideText(value: unknown): string[] {
  const lines: string[] = [];

  visitNode(value, (key, nodeValue) => {
    if ((key === 'a:t' || key === 't') && typeof nodeValue === 'string') {
      const normalized = normalizeInlineText(nodeValue);
      if (normalized) {
        lines.push(normalized);
      }
    }
  });

  return dedupeStrings(lines);
}

function visitNode(value: unknown, onStringField: (key: string, value: string) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      visitNode(item, onStringField);
    }
    return;
  }

  if (!value || typeof value !== 'object') {
    return;
  }

  for (const [key, child] of Object.entries(value)) {
    if (typeof child === 'string') {
      onStringField(key, child);
      continue;
    }

    visitNode(child, onStringField);
  }
}

function extractFerrulesRawText(outputFiles: string[]): string {
  const markdownFiles = outputFiles.filter(file => /\.(md|markdown|txt)$/i.test(file));
  for (const markdownFile of markdownFiles) {
    const content = normalizeRawText(fs.readFileSync(markdownFile, 'utf-8'));
    if (content) {
      return content;
    }
  }

  const jsonFiles = outputFiles.filter(file => /\.json$/i.test(file)).sort(preferFerrulesResultsJson);
  for (const jsonFile of jsonFiles) {
    const parsed = safeReadJson(jsonFile);
    if (!parsed) {
      continue;
    }

    const preferredStrings = collectPreferredFerrulesStrings(parsed);
    if (preferredStrings.length > 0) {
      return normalizeRawText(preferredStrings.join('\n\n'));
    }

    const leafStrings = collectLeafStrings(parsed);
    if (leafStrings.length > 0) {
      return normalizeRawText(leafStrings.join('\n'));
    }
  }

  return '';
}

function detectFerrulesReadingBasis(outputFiles: string[]): ReadingBasis {
  const jsonFiles = outputFiles.filter(file => /\.json$/i.test(file));
  for (const jsonFile of jsonFiles) {
    const content = fs.readFileSync(jsonFile, 'utf-8').toLowerCase();
    if (content.includes('"ocr"') || content.includes('ocr_') || content.includes('ocr ')) {
      return 'ocr';
    }
  }

  return 'text';
}

function preferFerrulesResultsJson(left: string, right: string): number {
  const leftScore = left.toLowerCase().includes('result') ? 0 : 1;
  const rightScore = right.toLowerCase().includes('result') ? 0 : 1;
  return leftScore - rightScore || left.localeCompare(right);
}

function safeReadJson(filePath: string): unknown | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

function collectPreferredFerrulesStrings(value: unknown): string[] {
  const preferredKeys = new Set(['markdown', 'md', 'text', 'content', 'raw_text', 'body']);
  const strings: string[] = [];

  visitNode(value, (key, nodeValue) => {
    if (preferredKeys.has(key.toLowerCase())) {
      const normalized = normalizeInlineText(nodeValue);
      if (normalized) {
        strings.push(normalized);
      }
    }
  });

  return dedupeStrings(strings);
}

function collectLeafStrings(value: unknown): string[] {
  const out: string[] = [];

  const walk = (current: unknown): void => {
    if (typeof current === 'string') {
      const normalized = normalizeInlineText(current);
      if (normalized.length >= 2) {
        out.push(normalized);
      }
      return;
    }

    if (Array.isArray(current)) {
      for (const item of current) {
        walk(item);
      }
      return;
    }

    if (!current || typeof current !== 'object') {
      return;
    }

    for (const child of Object.values(current)) {
      walk(child);
    }
  };

  walk(value);
  return dedupeStrings(out);
}

function walkFiles(root: string): string[] {
  const entries = fs.readdirSync(root, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkFiles(fullPath));
      continue;
    }
    files.push(fullPath);
  }

  return files;
}

function failedResult(
  docType: ExtractDocumentResult['doc_type'],
  extractor: DocumentExtractor,
  titleHint: string,
  limits: string[],
): ExtractDocumentResult {
  return {
    doc_type: docType,
    status: 'failed',
    extractor,
    reading_basis: 'text',
    raw_text: '',
    confidence: 0,
    limits,
    title_hint: titleHint,
  };
}

function buildFerrulesMissingDependencyResult(titleHint: string): ExtractDocumentResult {
  return {
    doc_type: 'pdf',
    status: 'needs_dependency',
    extractor: 'ferrules',
    reading_basis: 'text',
    raw_text: '',
    confidence: 0,
    limits: [
      'Ferrules is not installed on this Mac, so Granite cannot read PDF documents in this version.',
    ],
    title_hint: titleHint,
    missing_dependency: 'ferrules',
    install_source_url: FERRULES_RELEASES_URL,
    install_instructions: buildFerrulesInstallInstructions(),
    verify_command: FERRULES_VERIFY_COMMAND,
    user_prompt: 'Ce PDF nécessite Ferrules pour être lu localement sur Mac. Ferrules n\'est pas installé. Veux-tu l\'installer maintenant ?',
  };
}

function buildFerrulesInstallInstructions(): InstallInstructions {
  const platform = process.arch === 'arm64' ? 'macos-arm64' : 'macos-x64';
  const destination = process.arch === 'arm64' ? '/opt/homebrew/bin/ferrules' : '/usr/local/bin/ferrules';

  return {
    platform,
    steps: [
      `Download the latest ferrules binary for ${platform} from ${FERRULES_RELEASES_URL}.`,
      'Make the binary executable: chmod +x ferrules',
      `Move it into your PATH: mv ferrules ${destination}`,
      `Verify the installation: ${FERRULES_VERIFY_COMMAND}`,
    ],
    notes: [
      'Granite does not install Ferrules automatically in v1.',
      'If you already use a different PATH directory, you can move the binary there instead.',
    ],
  };
}

function normalizeRawText(value: string): string {
  return value
    .replace(/\r\n/g, '\n')
    .replace(/\u0000/g, '')
    .trim();
}

function normalizeInlineText(value: string): string {
  return value
    .replace(/\r\n/g, '\n')
    .replace(/\s+/g, ' ')
    .trim();
}

function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];

  for (const value of values) {
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    deduped.push(normalized);
  }

  return deduped;
}

function isMissingFerrules(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === 'object'
    && 'code' in error
    && (error as { code?: unknown }).code === 'ENOENT',
  );
}
