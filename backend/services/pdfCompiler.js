const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { resolvePdflatexBinary } = require('../utils/resolveBinary');

const execFileAsync = promisify(execFile);

class PDFCompiler {
  /**
   * Render manual content to PDF using pdflatex.
   * @param {string} content - Generated manual content
   * @param {string} worksheetId - Worksheet ID
   * @param {string} program - Program name
   * @param {string} subject - Subject name
   * @returns {Promise<Buffer>}
   */
  static async compile(content, worksheetId, program, subject) {
    return await this.renderPdf(content, worksheetId, program, subject);
  }

  /**
   * Render PDF from LaTeX using pdflatex
   * @private
   */
  static async renderPdf(content, worksheetId, program, subject) {
    const headerText = this.buildHeaderText(program, subject);
    const tex = this.buildLatexDocument(content, headerText, worksheetId);
    const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'paper2manual-'));
    const texPath = path.join(tmpDir, 'manual.tex');
    const pdfPath = path.join(tmpDir, 'manual.pdf');
    const logPath = path.join(tmpDir, 'manual.log');
    const miktexDataDir = path.join(tmpDir, 'miktex-data');
    const miktexConfigDir = path.join(tmpDir, 'miktex-config');
    const miktexInstallRoot = process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, 'Programs', 'MiKTeX')
      : '';

    try {
      await fs.promises.writeFile(texPath, tex, 'utf8');
      await fs.promises.mkdir(miktexDataDir, { recursive: true });
      await fs.promises.mkdir(miktexConfigDir, { recursive: true });

      const pdflatexCmd = resolvePdflatexBinary();
      const args = [];
      if (process.platform === 'win32') {
        // MiKTeX can abort non-interactive runs with maintenance/update diagnostics
        // before TeX compilation starts, even when the format build succeeds.
        args.push('--miktex-disable-maintenance', '--miktex-disable-diagnose');
      }
      args.push(
        '-interaction=nonstopmode',
        '-halt-on-error',
        '-file-line-error',
        '-output-directory',
        tmpDir,
        'manual.tex'
      );

      const { stdout, stderr } = await execFileAsync(pdflatexCmd, args, {
        timeout: 120000,
        windowsHide: true,
        maxBuffer: 10 * 1024 * 1024,
        cwd: tmpDir,
        env: {
          ...process.env,
          HOME: tmpDir,
          USERPROFILE: process.env.USERPROFILE || tmpDir,
          MIKTEX_USER_DATA: miktexDataDir,
          MIKTEX_USER_CONFIG: miktexConfigDir,
          MIKTEX_LOG_DIR: tmpDir,
          MIKTEX_TRACE: '',
          MIKTEX_UI: process.env.MIKTEX_UI || 'none',
          MIKTEX_INSTALL: process.env.MIKTEX_INSTALL || '1',
          MIKTEX_NO_UPDATES: process.env.MIKTEX_NO_UPDATES || '1',
          MIKTEX_NO_ETC_FONTS: process.env.MIKTEX_NO_ETC_FONTS || '1',
          TEXMFOUTPUT: tmpDir,
          TEXMFCACHE: path.join(tmpDir, 'texmf-cache'),
          TEXMFVAR: path.join(tmpDir, 'texmf-var'),
          TEXMFCONFIG: path.join(tmpDir, 'texmf-config'),
          TEXMFHOME: process.env.TEXMFHOME || '',
          MIKTEX_USER_INSTALL: miktexInstallRoot
        }
      });

      if (!fs.existsSync(pdfPath)) {
        const details = [stdout, stderr].filter(Boolean).join('\n');
        throw new Error(`pdflatex did not produce a PDF. ${details}`);
      }

      return await fs.promises.readFile(pdfPath);
    } catch (error) {
      const message = error?.message || String(error);
      const stdout = error?.stdout ? String(error.stdout).trim() : '';
      const stderr = error?.stderr ? String(error.stderr).trim() : '';
      let logTail = '';
      try {
        if (fs.existsSync(logPath)) {
          const logContent = await fs.promises.readFile(logPath, 'utf8');
          const lines = logContent.split(/\r?\n/);
          logTail = lines.slice(-40).join('\n').trim();
        }
      } catch {
        // Ignore log read errors.
      }
      const outputDetails = [stdout, stderr].filter(Boolean).join('\n').trim();
      const details = [
        outputDetails ? `\n--- pdflatex output ---\n${outputDetails}` : '',
        logTail ? `\n--- pdflatex log (tail) ---\n${logTail}` : '',
        `\nTemp dir: ${tmpDir}`
      ].join('');
      process.env.LATEX_KEEP_TEMP = 'true';
      throw new Error(`Failed to compile LaTeX to PDF: ${message}${details}`);
    } finally {
      const keepTemp = process.env.LATEX_KEEP_TEMP === 'true';
      if (!keepTemp) {
        try {
          await fs.promises.rm(tmpDir, { recursive: true, force: true });
        } catch (cleanupError) {
          console.warn('Failed to cleanup LaTeX temp dir:', cleanupError?.message || cleanupError);
        }
      }
    }
  }

  /**
   * Build a full LaTeX document with light formatting.
   * @private
   */
  static buildLatexDocument(content, headerText, worksheetId) {
    const safeHeader = this.escapeLatexText(String(headerText || '').trim());
    const title = this.escapeLatexText(`Worksheet Manual ${worksheetId}`);
    const body = this.convertTextToLatex(content);

    return `\\documentclass[11pt]{article}
\\usepackage[utf8]{inputenc}
\\usepackage[T1]{fontenc}
\\usepackage{geometry}
\\usepackage{fancyhdr}
\\usepackage{amsmath,amssymb}
\\usepackage{enumitem}
\\usepackage{newtxtext,newtxmath}
\\geometry{a4paper, margin=1in}
\\pagestyle{fancy}
\\fancyhf{}
\\lhead{}
\\chead{\\small ${safeHeader}}
\\rhead{}
\\cfoot{\\thepage}
\\renewcommand{\\headrulewidth}{0.4pt}
\\renewcommand{\\footrulewidth}{0.4pt}
\\setlength{\\parindent}{0pt}
\\setlength{\\parskip}{4pt}
\\setlist[itemize]{label=\\textbullet,leftmargin=1.2em,topsep=2pt,itemsep=2pt}
\\title{${title}}
\\date{}
\\begin{document}
${body}
\\end{document}
`;
  }

  /**
   * Convert plain text content into LaTeX with simple formatting.
   * Preserves inline/display math where possible.
   * @private
   */
  static convertTextToLatex(content) {
    let text = this.sanitizeSourceText(content);
    // Normalize common malformed math delimiters like "$$ $x ...$" -> "$$ x ... $$"
    // This prevents "Display math should end with $$" errors from mixed delimiters.
    text = text.replace(/\$\$\s*\$([\s\S]*?)\$/g, '$$ $1 $$');
    // Escape unmatched single-dollar delimiters that can break pdflatex.
    text = this.escapeUnbalancedInlineMath(text);
    if (!text) {
      return `\\begin{center}\\Large\\textbf{SPECTROPY-IIT FOUNDATION MENTOR'S MANUAL}\\end{center}\n\nNo content was generated.`;
    }

    const lines = text.split(/\r?\n/);
    const output = [];
    let inList = false;

    for (const raw of lines) {
      const line = raw.trimEnd();
      const trimmed = line.trim();

      if (!trimmed) {
        if (inList) {
          output.push('\\end{itemize}');
          inList = false;
        }
        output.push('');
        continue;
      }

      if (trimmed === "SPECTROPY-IIT FOUNDATION MENTOR'S MANUAL") {
        if (inList) {
          output.push('\\end{itemize}');
          inList = false;
        }
        output.push(`\\begin{center}\\Large\\textbf{${this.escapeLatexText(trimmed)}}\\end{center}`);
        continue;
      }

      if (trimmed.startsWith('Worksheet:')) {
        if (inList) {
          output.push('\\end{itemize}');
          inList = false;
        }
        const value = trimmed.replace(/^Worksheet:\s*/, '');
        output.push(`\\textbf{Worksheet:} ${this.escapeLatexTextPreservingMath(value)}`);
        continue;
      }

      if (trimmed.startsWith('Syllabus Topics Covered:')) {
        if (inList) {
          output.push('\\end{itemize}');
          inList = false;
        }
        const value = trimmed.replace(/^Syllabus Topics Covered:\s*/, '');
        output.push(`\\textbf{Syllabus Topics Covered:} ${this.escapeLatexTextPreservingMath(value)}`);
        continue;
      }

      if (trimmed === 'Answer Key and Detailed Solutions') {
        if (inList) {
          output.push('\\end{itemize}');
          inList = false;
        }
        output.push(`\\vspace{0.5em}\\textbf{${this.escapeLatexText(trimmed)}}`);
        continue;
      }

      if (/^(Q\d+\.|Question\s*\d+[:.]|\d+\.)/i.test(trimmed)) {
        if (inList) {
          output.push('\\end{itemize}');
          inList = false;
        }
        output.push(`\\textbf{${this.escapeLatexTextPreservingMath(trimmed)}}`);
        continue;
      }

      if (/^•\s*-?\s*/.test(trimmed)) {
        if (!inList) {
          output.push('\\begin{itemize}[leftmargin=1.2em]');
          inList = true;
        }
        const item = trimmed.replace(/^•\s*-?\s*/, '');
        output.push(`\\item ${this.escapeLatexTextPreservingMath(item)}`);
        continue;
      }

      if (trimmed.startsWith('- ')) {
        if (!inList) {
          output.push('\\begin{itemize}[leftmargin=1.2em]');
          inList = true;
        }
        const item = trimmed.replace(/^-\\s*/, '');
        output.push(`\\item ${this.escapeLatexTextPreservingMath(item)}`);
        continue;
      }

      if (inList) {
        output.push('\\end{itemize}');
        inList = false;
      }

      output.push(this.escapeLatexTextPreservingMath(trimmed));
    }

    if (inList) {
      output.push('\\end{itemize}');
    }

    return output.join('\n\n');
  }

  /**
   * Normalize raw model output before LaTeX conversion.
   * @private
   */
  static sanitizeSourceText(content) {
    if (!content) return '';
    return String(content)
      .trim()
      // Strip markdown/HTML artifacts.
      .replace(/^\s*\{=html\}\s*$/gm, '')
      .replace(/^\s*<!--\s*-->\s*$/gm, '')
      .replace(/^\s*>\s?/gm, '')
      // Drop markdown images and tables which are not valid LaTeX.
      .replace(/^!\[.*?\]\(.*?\)\s*(\{.*?\})?\s*$/gm, '')
      .replace(/^\s*\|[-\s|:]+\|\s*$/gm, '')
      // Remove stray line-ending backslashes used for markdown line breaks.
      .replace(/\\\s*$/gm, '')
      // Normalize escaped quotes from model output.
      .replace(/\\"/g, '"');
  }

  /**
   * Escape unmatched inline math delimiters to avoid "Missing $" errors.
   * @private
   */
  static escapeUnbalancedInlineMath(text) {
    const lines = String(text || '').split(/\r?\n/);
    const result = lines.map((line) => {
      let count = 0;
      for (let i = 0; i < line.length; i += 1) {
        const ch = line[i];
        if (ch === '\\') {
          i += 1;
          continue;
        }
        if (ch === '$') {
          if (line[i + 1] === '$') {
            i += 1;
            continue;
          }
          count += 1;
        }
      }
      if (count % 2 === 0 || count === 0) return line;

      // Replace the last unescaped single "$" with "\$" to balance the line.
      for (let i = line.length - 1; i >= 0; i -= 1) {
        if (line[i] !== '$') continue;
        const prev = i > 0 ? line[i - 1] : '';
        const next = i + 1 < line.length ? line[i + 1] : '';
        if (prev === '\\' || next === '$') continue;
        return `${line.slice(0, i)}\\$${line.slice(i + 1)}`;
      }
      return line;
    });

    return result.join('\n');
  }

  /**
   * Build a safe header string that won't trigger wrapping/page breaks.
   * @private
   */
  static buildHeaderText(program, subject) {
    const safeProgram = String(program || '').trim();
    const safeSubject = String(subject || '').trim();
    const raw = `SPECTROPY-${safeProgram} program-${safeSubject}`;
    const safe = raw.replace(/\s+/g, ' ').trim();
    return safe.length > 70 ? `${safe.slice(0, 67)}...` : safe;
  }

  /**
   * Escape LaTeX special characters in plain text.
   * @private
   */
  static escapeLatexText(text) {
    const normalized = this.replaceUnicodeTextSymbols(String(text || ''));
    return normalized
      .replace(/\\/g, '\\textbackslash{}')
      .replace(/&/g, '\\&')
      .replace(/%/g, '\\%')
      .replace(/\$/g, '\\$')
      .replace(/#/g, '\\#')
      .replace(/_/g, '\\_')
      .replace(/{/g, '\\{')
      .replace(/}/g, '\\}')
      .replace(/~/g, '\\textasciitilde{}')
      .replace(/\^/g, '\\textasciicircum{}');
  }

  /**
   * Escape text but preserve LaTeX math segments.
   * @private
   */
  static escapeLatexTextPreservingMath(text) {
    const source = String(text || '');
    const mathRegex = /(\$\$[\s\S]*?\$\$|\$[^$]*?\$|\\\[[\s\S]*?\\\]|\\\([\s\S]*?\\\))/g;
    const isMath = /^(\$\$[\s\S]*?\$\$|\$[^$]*?\$|\\\[[\s\S]*?\\\]|\\\([\s\S]*?\\\))$/;
    const parts = source.split(mathRegex);
    const escaped = parts
      .map((part) => {
        if (!part) return '';
        if (isMath.test(part)) return this.replaceUnicodeMathSymbols(part);
        return this.escapeLatexText(part);
      })
      .join('');
    return this.convertMarkdownBold(escaped);
  }

  /**
   * Convert simple markdown bold (**text**) into LaTeX bold.
   * Runs after escaping so LaTeX commands are preserved.
   * @private
   */
  static convertMarkdownBold(text) {
    return String(text || '')
      .replace(/\\\*{2}/g, '**')
      .replace(/\*\*([^*]+)\*\*/g, '\\textbf{$1}');
  }

  /**
   * Replace Unicode math symbols in plain text with ASCII-friendly forms.
   * @private
   */
  static replaceUnicodeTextSymbols(text) {
    return String(text || '')
      .replace(/\u2264/g, '<=') // ≤
      .replace(/\u2265/g, '>=') // ≥
      .replace(/\u2260/g, '!=') // ≠
      .replace(/\u2248/g, '~=') // ≈
      .replace(/\u00B1/g, '+/-') // ±
      .replace(/\u00D7/g, 'x') // ×
      .replace(/\u00F7/g, '/') // ÷
      .replace(/\u03C0/g, 'pi') // π
      .replace(/\u221E/g, 'infinity') // ∞
      // Common Greek letters in plain text -> ASCII names to keep pdflatex happy.
      .replace(/\u03B1/g, 'alpha') // α
      .replace(/\u03B2/g, 'beta') // β
      .replace(/\u03B3/g, 'gamma') // γ
      .replace(/\u03B4/g, 'delta') // δ
      .replace(/\u03B8/g, 'theta') // θ
      .replace(/\u03BB/g, 'lambda') // λ
      .replace(/\u03BC/g, 'mu') // μ
      .replace(/\u03C3/g, 'sigma') // σ
      .replace(/\u03C6/g, 'phi') // φ
      .replace(/\u03C9/g, 'omega') // ω
      .replace(/\u0394/g, 'Delta') // Δ
      .replace(/\u03A9/g, 'Omega'); // Ω
  }

  /**
   * Replace Unicode math symbols inside math segments with LaTeX commands.
   * @private
   */
  static replaceUnicodeMathSymbols(text) {
    return String(text || '')
      .replace(/\u2264/g, '\\leq ')
      .replace(/\u2265/g, '\\geq ')
      .replace(/\u2260/g, '\\neq ')
      .replace(/\u2248/g, '\\approx ')
      .replace(/\u00B1/g, '\\pm ')
      .replace(/\u00D7/g, '\\times ')
      .replace(/\u00F7/g, '\\div ')
      .replace(/\u03C0/g, '\\pi ')
      .replace(/\u221E/g, '\\infty ')
      // Greek letters inside math segments.
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
  }
}

module.exports = PDFCompiler;
