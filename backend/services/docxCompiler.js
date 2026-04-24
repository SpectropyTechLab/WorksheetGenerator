const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { resolvePandocBinary } = require('../utils/resolveBinary');
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

  text = text
    .split('\n')
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;
      if (
        trimmed.startsWith('#') ||
        trimmed.startsWith('|') ||
        trimmed.startsWith('- ') ||
        trimmed.startsWith('* ') ||
        /^\d+\.\s/.test(trimmed) ||
        trimmed === '---'
      ) {
        return line;
      }

      if (hardBreakPatterns.some((pattern) => pattern.test(trimmed))) {
        return `${trimmed}\\`;
      }

      return line;
    })
    .join('\n');

  return text;
}

function normalizeMathForPandoc(text) {
  return String(text || '')
    .replace(/\$\s+([^$]*?)\s+\$/g, '$$$1$$')
    .replace(/\$\s*\n\s*/g, '$')
    .replace(/\s*\n\s*\$/g, '$')
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
    const markdownPath = path.join(workDir, 'manual.md');
    const inputPath = path.join(workDir, 'manual.tex');
    const outputPath = path.join(workDir, 'manual.docx');

    try {
      try {
        const markdownText = buildDocxReferenceMarkdown(latexContent);
        const referenceDoc = await resolveReferenceDocPath();
        const markdownArgs = ['--from=markdown+tex_math_dollars+raw_tex+pipe_tables', '--to=docx'];
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
      } catch (markdownError) {
        const sanitizedLatex = sanitizeLatexForPandoc(String(latexContent || ''));
        await fs.writeFile(inputPath, sanitizedLatex, 'utf8');
        await execFileAsync(pandocBin, ['--from=latex', '--to=docx', inputPath, '-o', outputPath], {
          timeout: 120000,
          windowsHide: true
        });
      }
      const docxBuffer = await fs.readFile(outputPath);
      return docxBuffer;
    } finally {
      await fs.rm(workDir, { recursive: true, force: true });
    }
  }
}

module.exports = DocxCompiler;
