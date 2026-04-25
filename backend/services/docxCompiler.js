const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { resolvePandocBinary } = require('../utils/resolveBinary');
const PANDOC_API_VERSION = [1, 23, 1];
const REFERENCE_DOC_CANDIDATES = [
  process.env.DOCX_REFERENCE_PATH,
  'C:\\Users\\MY PC\\Downloads\\MAESTRO_PHY_FREE_BODY_DIAGRAM_PREMIUM_WORKSHEET.docx'
].filter(Boolean);

function execFileAsync(command, args, options) {
  return new Promise((resolve, reject) => {
    execFile(command, args, options, (error, stdout, stderr) => {
      if (error) {
        const err = new Error(stderr || stdout || error.message);
        err.cause = error;
        return reject(err);
      }
      return resolve({ stdout, stderr });
    });
  });
}

function sanitizeLatexForPandoc(latexContent) {
  let text = String(latexContent || '');

  // Normalize malformed display math delimiters: "$$ $x ... $" -> "$$ x ... $$"
  text = text.replace(/\$\$\s*\$([\s\S]*?)\$/g, '$$ $1 $$');

  // Fix common escaped/markdown artifacts.
  text = text
    .replace(/\\"/g, '"')
    .replace(/\\\*{2}/g, '**')
    .replace(/\*\*([^*]+)\*\*/g, '\\textbf{$1}')
    // Escape underscores in plain text (Pandoc LaTeX reader is strict).
    .replace(/__/g, '\\_\\_')
    .replace(/(?<!\\)_/g, '\\_');

  // Convert common Unicode symbols to LaTeX-safe forms.
  text = text
    .replace(/\u2264/g, '\\leq ')
    .replace(/\u2265/g, '\\geq ')
    .replace(/\u2260/g, '\\neq ')
    .replace(/\u2248/g, '\\approx ')
    .replace(/\u00B1/g, '\\pm ')
    .replace(/\u00D7/g, '\\times ')
    .replace(/\u00F7/g, '\\div ')
    .replace(/\u03C0/g, '\\pi ')
    .replace(/\u221E/g, '\\infty ')
    .replace(/\u03B1/g, '\\alpha ')
    .replace(/\u03B2/g, '\\beta ')
    .replace(/\u03B3/g, '\\gamma ')
    .replace(/\u03B4/g, '\\delta ')
    .replace(/\u03B8/g, '\\theta ')
    .replace(/\u03BB/g, '\\lambda ')
    .replace(/\u03BC/g, '\\mu ')
    .replace(/\u03C3/g, '\\sigma ')
    .replace(/\u03C6/g, '\\phi ')
    .replace(/\u03C9/g, '\\omega ')
    .replace(/\u0394/g, '\\Delta ')
    .replace(/\u03A9/g, '\\Omega ');

  // Remove stray HTML markers and braces that can break Pandoc's LaTeX reader.
  text = text
    .replace(/^\s*\{=html\}\s*$/gm, '')
    .replace(/^\s*<!--\s*-->\s*$/gm, '')
    // Remove stray leading braces on their own or before list markers.
    .replace(/^\s*}\s*(?=[a-d]\))/gm, '')
    .replace(/^\s*}\s*(?=\d+[\.\)]\s)/gm, '')
    .replace(/^\s*}\s*/gm, '')
    .replace(/\\textbackslash\{\}/g, '\\textbackslash{}');

  return text;
}

function sanitizeMarkdownForPandoc(markdownContent) {
  let text = String(markdownContent || '');

  // Remove common HTML/markdown artifacts.
  text = text
    .replace(/^\s*\{=html\}\s*$/gm, '')
    .replace(/^\s*<!--\s*-->\s*$/gm, '')
    .replace(/^!\[.*?\]\(.*?\)\s*(\{.*?\})?\s*$/gm, '');

  // Prevent accidental emphasis from underscores in plain text.
  // Keep underscores inside math segments intact by leaving $...$ blocks alone.
  text = normalizeMathForPandoc(text);

  const mathRegex = /(\$\$[\s\S]*?\$\$|\$[^$]*?\$|\\\[[\s\S]*?\\\]|\\\([\s\S]*?\\\))/g;
  const mathBlockRegex = /^(\$\$[\s\S]*\$\$|\$[^$]*\$|\\\[[\s\S]*\\\]|\\\([\s\S]*\\\))$/;
  const parts = text.split(mathRegex);
  text = parts
    .map((part) => {
      if (!part) return '';
      if (mathBlockRegex.test(part)) return part;
      return part.replace(/(?<!\\)_/g, '\\_');
    })
    .join('');

  // Ensure labeled sections followed by list items are parsed as real lists.
  text = text
    .replace(/(\*\*[^*\n]+\*\*:\s*)\n(?=[*-]\s)/g, '$1\n\n')
    .replace(/(^[A-Za-z][^\n:]{2,}:\s*)\n(?=[*-]\s)/gm, '$1\n\n');

  text = normalizeQuestionBlocksForDocx(text);

  // Preserve line-by-line structure for title-page fields and question blocks in DOCX output.
  const hardBreakPatterns = [
    /^\*\*Program\*\*:/,
    /^\*\*Subject\*\*:/,
    /^\*\*Chapter\*\*:/,
    /^\*\*Theme line\*\*:/,
    /^Program:/,
    /^Subject:/,
    /^Chapter:/,
    /^Theme line:/,
    /^Source-fidelity statement:/i,
    /^Chapter \/ Topic Title:/i,
    /^## Premium Olympiad Practice Worksheet$/i,
    /^###\s/,
    /^Concepts Explicitly Present:?$/i,
    /^Concepts Not Present And Therefore Not Allowed:?$/i,
    /^Formula Bank:?$/i,
    /^Diagram Opportunities:?$/i,
    /^List I$/i,
    /^List II$/i,
    /^Assertion/i,
    /^Reason:/i,
    /^Passage:/,
    /^Q\d+\./,
    /^[A-D]\.\s/,
    /^Solution:$/,
    /^Step \d+\./,
    /^Final Answer:/,
    /^Figure note:/,
    /^Diagram:/
  ];

  text = structureMarkdownForDocx(text, hardBreakPatterns);

  return text;
}

function structureMarkdownForDocx(text, hardBreakPatterns) {
  const lines = String(text || '').split('\n');
  const output = [];
  let inLineBlock = false;

  const pushBlank = () => {
    if (output[output.length - 1] !== '') {
      output.push('');
    }
  };

  for (const rawLine of lines) {
    const line = rawLine.replace(/[ \t]+$/g, '');
    const trimmed = line.trim();

    if (!trimmed) {
      if (inLineBlock) {
        pushBlank();
        inLineBlock = false;
      }
      pushBlank();
      continue;
    }

    const isMarkdownBlock =
      trimmed.startsWith('#') ||
      trimmed.startsWith('|') ||
      trimmed.startsWith('- ') ||
      trimmed.startsWith('* ') ||
      /^\d+\.\s/.test(trimmed) ||
      trimmed === '---';

    if (isMarkdownBlock) {
      if (inLineBlock) {
        pushBlank();
        inLineBlock = false;
      }
      output.push(line);
      continue;
    }

    if (hardBreakPatterns.some((pattern) => pattern.test(trimmed))) {
      if (!inLineBlock && output.length > 0 && output[output.length - 1] !== '') {
        output.push('');
      }
      output.push(`| ${trimmed}`);
      inLineBlock = true;
      continue;
    }

    if (inLineBlock) {
      pushBlank();
      inLineBlock = false;
    }

    output.push(line);
  }

  if (inLineBlock) {
    pushBlank();
  }

  return output.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function normalizeQuestionBlocksForDocx(text) {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  const output = [];

  for (const rawLine of lines) {
    const line = rawLine.replace(/[ \t]+$/g, '');
    const trimmed = line.trim();

    if (!trimmed) {
      if (output[output.length - 1] !== '') {
        output.push('');
      }
      continue;
    }

    if (/^Q\d+\./.test(trimmed) && output.length > 0 && output[output.length - 1] !== '') {
      output.push('');
    }

    output.push(line);
  }

  return output.join('\n').replace(/\n{3,}/g, '\n\n');
}

function normalizeMathForPandoc(text) {
  return String(text || '')
    .replace(/\$\s+([^$]*?)\s+\$/g, '$$$1$$')
    .replace(/\$([^\n$]+?)\n([^\n$]+?)\$/g, (_, a, b) => `$${`${a} ${b}`.replace(/\s+/g, ' ').trim()}$`)
    .replace(/\$+\s*\$+/g, '')
    .replace(/\$([^\$]*?)\$/g, (_, body) => {
      const normalized = String(body || '').replace(/\s+/g, ' ').trim();
      return normalized ? `$${normalized}$` : '';
    });
}

function buildDocxReferenceMarkdown(content) {
  const source = sanitizeMarkdownForPandoc(content);
  return source;
}

function buildPandocJsonDocument(content) {
  const normalized = String(content || '')
    .replace(/\r\n/g, '\n')
    .replace(/^\s*<div[^>]*>\s*$/gim, '')
    .replace(/^\s*<\/div>\s*$/gim, '')
    .replace(/\u00A0/g, ' ')
    .trim();

  const lines = normalized.split('\n').map((line) => line.replace(/[ \t]+$/g, ''));
  const blocks = [];

  for (let index = 0; index < lines.length;) {
    const line = lines[index];
    const trimmed = line.trim();

    if (!trimmed) {
      index += 1;
      continue;
    }

    const headingMatch = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (headingMatch) {
      blocks.push({
        t: 'Header',
        c: [
          headingMatch[1].length,
          ['', [], []],
          parseInlines(headingMatch[2])
        ]
      });
      index += 1;
      continue;
    }

    if (trimmed.startsWith('|')) {
      const tableLines = [];
      while (index < lines.length && lines[index].trim().startsWith('|')) {
        tableLines.push(lines[index].trim());
        index += 1;
      }
      blocks.push(...convertPipeTableToBlocks(tableLines));
      continue;
    }

    if (/^- /.test(trimmed)) {
      const items = [];
      while (index < lines.length && /^- /.test(lines[index].trim())) {
        items.push(lines[index].trim().replace(/^- /, ''));
        index += 1;
      }

      blocks.push({
        t: 'BulletList',
        c: items.map((item) => [
          {
            t: 'Plain',
            c: parseInlines(item)
          }
        ])
      });
      continue;
    }

    const chunk = [];
    while (index < lines.length) {
      const current = lines[index];
      const currentTrimmed = current.trim();

      if (!currentTrimmed) break;
      if (/^(#{1,6})\s+/.test(currentTrimmed)) break;
      if (currentTrimmed.startsWith('|')) break;
      if (/^- /.test(currentTrimmed) && chunk.length > 0) break;

      chunk.push(currentTrimmed);
      index += 1;
    }

    if (chunk.length === 1) {
      blocks.push({
        t: 'Para',
        c: parseInlines(chunk[0])
      });
      continue;
    }

    blocks.push({
      t: 'LineBlock',
      c: chunk.map((item) => parseInlines(item))
    });
  }

  return {
    'pandoc-api-version': PANDOC_API_VERSION,
    meta: {},
    blocks
  };
}

function convertPipeTableToBlocks(lines) {
  const rows = (lines || [])
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim()));

  if (rows.length === 0) {
    return [];
  }

  const filteredRows = rows.filter((row) => !row.every((cell) => /^:?-+:?$/.test(cell)));
  if (filteredRows.length <= 1) {
    return filteredRows.map((row) => ({
      t: 'Para',
      c: parseInlines(row.join(' | '))
    }));
  }

  const headers = filteredRows[0];
  return filteredRows.slice(1).map((row) => {
    const parts = headers
      .map((header, index) => {
        const value = row[index] || '';
        return `${header}: ${value}`;
      })
      .join(' | ');

    return {
      t: 'Para',
      c: parseInlines(parts)
    };
  });
}

function parseInlines(text) {
  const source = String(text || '');
  if (!source) {
    return [];
  }

  const tokens = [];
  const regex = /(\$[^$\n]+\$)/g;
  let lastIndex = 0;
  let match;

  while ((match = regex.exec(source)) !== null) {
    if (match.index > lastIndex) {
      tokens.push(...textToInlines(source.slice(lastIndex, match.index)));
    }

    const math = match[0].slice(1, -1).trim();
    if (math) {
      tokens.push({
        t: 'Math',
        c: [
          { t: 'InlineMath' },
          math
        ]
      });
    }

    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < source.length) {
    tokens.push(...textToInlines(source.slice(lastIndex)));
  }

  return tokens;
}

function textToInlines(text) {
  return String(text || '')
    .split(/(\s+)/)
    .filter((part) => part.length > 0)
    .map((part) => (/^\s+$/.test(part)
      ? { t: 'Space' }
      : { t: 'Str', c: part }));
}

async function resolveReferenceDocPath() {
  for (const candidate of REFERENCE_DOC_CANDIDATES) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // Try next candidate.
    }
  }

  return null;
}

class DocxCompiler {
  static async compile(latexContent, worksheetId, chapterName) {
    const pandocBin = resolvePandocBinary();
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), `p2m-docx-${worksheetId}-`));
    const jsonPath = path.join(workDir, 'manual.json');
    const markdownPath = path.join(workDir, 'manual.md');
    const inputPath = path.join(workDir, 'manual.tex');
    const outputPath = path.join(workDir, 'manual.docx');

    try {
      try {
        const jsonDocument = buildPandocJsonDocument(latexContent);
        const referenceDoc = await resolveReferenceDocPath();
        const markdownArgs = ['--from=json', '--to=docx'];
        if (referenceDoc) {
          markdownArgs.push(`--reference-doc=${referenceDoc}`);
        }
        markdownArgs.push(jsonPath, '-o', outputPath);
        await fs.writeFile(jsonPath, JSON.stringify(jsonDocument), 'utf8');
        await execFileAsync(
          pandocBin,
          markdownArgs,
          {
            timeout: 120000,
            windowsHide: true
          }
        );
      } catch (jsonError) {
        const markdownText = buildDocxReferenceMarkdown(latexContent);
        const referenceDoc = await resolveReferenceDocPath();
        const markdownArgs = ['--from=markdown+tex_math_dollars+raw_tex+pipe_tables+line_blocks', '--to=docx'];
        if (referenceDoc) {
          markdownArgs.push(`--reference-doc=${referenceDoc}`);
        }
        markdownArgs.push(markdownPath, '-o', outputPath);
        await fs.writeFile(markdownPath, markdownText, 'utf8');
        await execFileAsync(
          pandocBin,
          markdownArgs,
          {
            timeout: 120000,
            windowsHide: true
          }
        );
      }

      const docxBuffer = await fs.readFile(outputPath);
      return docxBuffer;
    } catch (markdownError) {
      try {
        const sanitizedLatex = sanitizeLatexForPandoc(String(latexContent || ''));
        await fs.writeFile(inputPath, sanitizedLatex, 'utf8');
        await execFileAsync(pandocBin, ['--from=latex', '--to=docx', inputPath, '-o', outputPath], {
          timeout: 120000,
          windowsHide: true
        });
      } catch (latexError) {
        throw latexError;
      }
      const docxBuffer = await fs.readFile(outputPath);
      return docxBuffer;
    } finally {
      await fs.rm(workDir, { recursive: true, force: true });
    }
  }
}

module.exports = DocxCompiler;
