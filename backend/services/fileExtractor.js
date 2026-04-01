const mammoth = require('mammoth');
const pdf = require('pdf-parse');
const JSZip = require('jszip');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const xsltProcessor = require('xslt-processor');
const mathmlToLatex = require('mathml-to-latex');
const { resolvePandocBinary } = require('../utils/resolveBinary');

class FileExtractor {
  /**
   * Extract text from DOCX file
   * @param {Buffer} buffer - DOCX file buffer
   * @returns {Promise<string>}
   */
  static async extractFromDocx(buffer) {
    try {
      const pandocText = await this.extractDocxWithPandoc(buffer);
      let baseText = this.normalizeMathText(this.normalizePandocText(pandocText || ''));
      if (!baseText) {
        const mammothResult = await mammoth.extractRawText({ buffer });
        const equationText = await this.extractDocxEquations(buffer);
        baseText = this.normalizeMathText(
          [mammothResult.value || '', equationText || ''].filter(Boolean).join('\n\n')
        );
      }
      if (!baseText) {
        throw new Error('No text could be extracted from DOCX.');
      }
      return baseText;
    } catch (error) {
      console.error('DOCX extraction error:', error);
      throw new Error(`Failed to extract text from DOCX: ${error.message}`);
    }
  }

  /**
   * Extract text from PDF file
   * @param {Buffer} buffer - PDF file buffer
   * @returns {Promise<string>}
   */
  static async extractFromPdf(buffer) {
    try {
      const pix2texText = await this.extractPdfWithPix2Tex(buffer);
      const data = await pdf(buffer);
      const baseText = this.normalizeMathText(data.text || '');
      if (pix2texText) {
        return `${baseText}\n\n${this.normalizeMathText(pix2texText)}`.trim();
      }
      return baseText;
    } catch (error) {
      console.error('PDF extraction error:', error);
      throw new Error(`Failed to extract text from PDF: ${error.message}`);
    }
  }

  /**
   * Extract text based on file type
   * @param {Buffer} buffer - File buffer
   * @param {string} fileType - File extension (docx or pdf)
   * @returns {Promise<string>}
   */
  static async extractText(buffer, fileType) {
    if (fileType === 'docx') {
      return await this.extractFromDocx(buffer);
    } else if (fileType === 'pdf') {
      return await this.extractFromPdf(buffer);
    } else {
      throw new Error(`Unsupported file type: ${fileType}`);
    }
  }

  /**
   * Extract Word equations (OMML) from DOCX and convert to LaTeX via OMML2MML.
   * @private
   */
  static async extractDocxEquations(buffer) {
    try {
      const zip = await JSZip.loadAsync(buffer);
      const docXmlFile = zip.file('word/document.xml');
      if (!docXmlFile) return '';

      const xml = await docXmlFile.async('text');
      const equationBlocks = [];
      const eqRegex = /<m:oMath[^>]*>[\s\S]*?<\/m:oMath>/g;
      let match;
      while ((match = eqRegex.exec(xml)) !== null) {
        const omml = match[0];
        const latex = await this.convertOmmlToLatex(omml);
        if (latex) {
          equationBlocks.push(`Equation: ${latex}`);
        }
      }

      return equationBlocks.join('\n');
    } catch (error) {
      console.warn('DOCX equation extraction failed:', error.message);
      return '';
    }
  }

  /**
   * Use Pandoc to extract DOCX text with math preserved.
   * @private
   */
  static async extractDocxWithPandoc(buffer) {
    const pandocBin = resolvePandocBinary();
    let tmpDir = '';
    try {
      tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'pandoc-'));
      const docxPath = path.join(tmpDir, 'input.docx');
      await fs.promises.writeFile(docxPath, buffer);

      const output = await new Promise((resolve, reject) => {
        execFile(
          pandocBin,
          ['-f', 'docx', '-t', 'markdown', '--wrap=none', docxPath],
          {
            timeout: 30000,
            env: {
              ...process.env,
              PYTHONUTF8: '1',
              PYTHONIOENCODING: 'utf-8'
            }
          },
          (error, stdout, stderr) => {
            if (error) {
              return reject(new Error(stderr || error.message));
            }
            return resolve(stdout);
          }
        );
      });

      return (output || '').trim();
    } catch (error) {
      console.warn('Pandoc DOCX extraction failed:', error?.message || String(error));
      return '';
    } finally {
      if (tmpDir) {
        await fs.promises.rm(tmpDir, { recursive: true, force: true });
      }
    }
  }

  /**
   * Convert OMML XML to LaTeX using OMML2MML.XSL + MathML conversion.
   * @private
   */
  static async convertOmmlToLatex(ommlXml) {
    try {
      const xslPath = path.join(__dirname, '..', 'assets', 'OMML2MML.XSL');
      if (!fs.existsSync(xslPath)) {
        console.warn('OMML2MML.XSL not found. Skipping DOCX equation conversion.');
        return '';
      }
      const xsl = await this.loadOmmlXslt(xslPath);
      if (!xsl) return '';

      const normalizedOmml = this.ensureOmmlNamespaces(ommlXml);
      const mathml = await this.transformOmmlToMathml(normalizedOmml, xsl, xslPath);
      if (!mathml) return '';

      const latex = this.convertMathmlToLatex(mathml);
      return (latex || '').trim();
    } catch (error) {
      console.warn('OMML -> LaTeX failed:', error?.message || String(error));
      return '';
    }
  }

  /**
   * Convert MathML to LaTeX using mathml-to-latex exports.
   * @private
   */
  static convertMathmlToLatex(mathml) {
    if (!mathml) return '';
    try {
      if (typeof mathmlToLatex === 'function') {
        return mathmlToLatex(mathml);
      }
      if (typeof mathmlToLatex?.convert === 'function') {
        return mathmlToLatex.convert(mathml);
      }
      const MathMLToLaTeX = mathmlToLatex?.MathMLToLaTeX;
      if (typeof MathMLToLaTeX === 'function') {
        if (typeof MathMLToLaTeX.convert === 'function') {
          return MathMLToLaTeX.convert(mathml);
        }
        const converter = new MathMLToLaTeX();
        if (typeof converter.convert === 'function') {
          return converter.convert(mathml);
        }
      }
    } catch (error) {
      console.warn('MathML -> LaTeX failed:', error?.message || String(error));
    }
    return '';
  }

  /**
   * Load and cache OMML2MML XSL.
   * @private
   */
  static async loadOmmlXslt(xslPath) {
    if (this._ommlXsltFailed) return '';
    if (!this._ommlXsltText) {
      this._ommlXsltText = await fs.promises.readFile(xslPath, 'utf8');
      this.warnIfUnsupportedXslt(this._ommlXsltText);
    }
    return this._ommlXsltText;
  }

  /**
   * Ensure OMML has namespace declarations needed for standalone parsing.
   * @private
   */
  static ensureOmmlNamespaces(ommlXml) {
    const hasM = /<m:oMath[^>]*xmlns:m=/.test(ommlXml);
    if (hasM) return ommlXml;
    return ommlXml.replace(
      '<m:oMath',
      '<m:oMath xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math" xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
    );
  }

  /**
   * Transform OMML to MathML using xslt-processor, with Python lxml fallback.
   * @private
   */
  static async transformOmmlToMathml(ommlXml, xslText, xslPath) {
    if (!this._ommlXsltFailed) {
      try {
        const xslt = new xsltProcessor.Xslt();
        return xslt.xsltProcess(
          xsltProcessor.xmlParse(ommlXml),
          xsltProcessor.xmlParse(xslText)
        );
      } catch (error) {
        const message = error?.message || String(error);
        if (!this._ommlXsltWarned) {
          console.warn(`OMML XSLT failed in Node: ${message}. Falling back to Python lxml.`);
          this._ommlXsltWarned = true;
        }
        this._ommlXsltFailed = true;
      }
    }

    const mathml = await this.transformOmmlWithPython(ommlXml, xslPath);
    return mathml;
  }

  /**
   * Python fallback for OMML -> MathML using lxml.
   * @private
   */
  static async transformOmmlWithPython(ommlXml, xslPath) {
    const pythonBin = process.env.OMML_PY || process.env.PIX2TEX_PY || 'python';
    const scriptPath = path.join(__dirname, '..', 'scripts', 'omml2mathml.py');
    if (!fs.existsSync(scriptPath)) {
      console.warn('omml2mathml.py not found. Skipping DOCX equation conversion.');
      return '';
    }

    try {
      const output = await new Promise((resolve, reject) => {
        const child = execFile(
          pythonBin,
          [scriptPath, xslPath],
          {
            timeout: 20000,
            maxBuffer: 2 * 1024 * 1024,
            env: {
              ...process.env,
              PYTHONUTF8: '1',
              PYTHONIOENCODING: 'utf-8'
            }
          },
          (error, stdout, stderr) => {
            if (error) {
              return reject(new Error(stderr || error.message));
            }
            return resolve(stdout);
          }
        );
        child.stdin.write(ommlXml);
        child.stdin.end();
      });
      return (output || '').trim();
    } catch (error) {
      console.warn('Python OMML transform failed:', error?.message || String(error));
      return '';
    }
  }

  /**
   * Warn when XSLT version is not supported by xslt-processor (1.0 only).
   * @private
   */
  static warnIfUnsupportedXslt(xslText) {
    const match = (xslText || '').match(/<xsl:stylesheet[^>]*\bversion\s*=\s*["']([^"']+)["']/i);
    if (!match) return;
    const version = match[1].trim();
    if (version && version !== '1.0') {
      console.warn(
        `OMML2MML.XSL uses XSLT ${version}. xslt-processor supports XSLT 1.0 only. ` +
          'Replace with the official Microsoft OMML2MML.XSL (XSLT 1.0).'
      );
    }
  }

  /**
   * Normalize Unicode math symbols to ASCII-friendly LaTeX-like text.
   * @private
   */
  static normalizeMathText(text) {
    if (!text) return '';
    let output = text;

    output = output
      .replace(/\r\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n');

    output = output
      .split('\n')
      .filter((line) => {
        const trimmed = line.trim();
        if (!trimmed) return true;
        if (/SPECTROPY/i.test(trimmed)) return false;
        if (/Maestro program/i.test(trimmed)) return false;
        if (/^CUQ,\s*JEE\s*MAIN/i.test(trimmed)) return false;
        if (/^JEE\s*MAIN\s+LEVEL/i.test(trimmed)) return false;
        if (/^JEE\s*ADVANCED\s+LEVEL/i.test(trimmed)) return false;
        if (/^\d+$/.test(trimmed)) return false;
        return true;
      })
      .join('\n');

    output = output
      .replace(/²/g, '^2')
      .replace(/³/g, '^3')
      .replace(/¹/g, '^1')
      .replace(/⁰/g, '^0')
      .replace(/₀/g, '_0')
      .replace(/₁/g, '_1')
      .replace(/₂/g, '_2')
      .replace(/₃/g, '_3')
      .replace(/₄/g, '_4')
      .replace(/₅/g, '_5')
      .replace(/₆/g, '_6')
      .replace(/₇/g, '_7')
      .replace(/₈/g, '_8')
      .replace(/₉/g, '_9');

    output = output
      .replace(/\(\s*-\s*1\s*\)\s*\^\s*\+?\s*(\d+)/g, '(-1)^$1')
      .replace(/\^\s*\+?\s*(\d+)/g, '^$1');

    output = output.replace(/\n(?=\d+\s*$)/gm, '');
    output = output.replace(/\n(?=[a-zA-Z])(?<=[a-zA-Z0-9])/, '');
    output = output.replace(/[\u00A0\u2007\u202F]/g, ' ');

    output = this.mapMathAlphanum(output);

    return output;
  }

  /**
   * Normalize Pandoc markdown output to plain text math.
   * @private
   */
  static normalizePandocText(text) {
    if (!text) return '';
    let output = text;

    // Preserve LaTeX math delimiters for downstream rendering.
    output = output.replace(/\\'/g, "'");
    output = output.replace(/\\\$/g, '$');

    return output;
  }

  /**
   * Map Mathematical Alphanumeric Symbols to ASCII.
   * @private
   */
  static mapMathAlphanum(text) {
    const mapChar = (code, offset) => String.fromCodePoint(code - offset);
    let result = '';
    for (const ch of text) {
      const code = ch.codePointAt(0);
      if (code >= 0x1D434 && code <= 0x1D44D) {
        result += mapChar(code, 0x1D434 - 0x41);
        continue;
      }
      if (code >= 0x1D44E && code <= 0x1D467) {
        result += mapChar(code, 0x1D44E - 0x61);
        continue;
      }
      if (code >= 0x1D468 && code <= 0x1D481) {
        result += mapChar(code, 0x1D468 - 0x41);
        continue;
      }
      if (code >= 0x1D482 && code <= 0x1D49B) {
        result += mapChar(code, 0x1D482 - 0x61);
        continue;
      }
      if (code >= 0x1D49C && code <= 0x1D4B5) {
        result += mapChar(code, 0x1D49C - 0x41);
        continue;
      }
      if (code >= 0x1D4B6 && code <= 0x1D4CF) {
        result += mapChar(code, 0x1D4B6 - 0x61);
        continue;
      }
      if (code >= 0x1D4D0 && code <= 0x1D4E9) {
        result += mapChar(code, 0x1D4D0 - 0x41);
        continue;
      }
      if (code >= 0x1D4EA && code <= 0x1D503) {
        result += mapChar(code, 0x1D4EA - 0x61);
        continue;
      }
      if (code >= 0x1D504 && code <= 0x1D51C) {
        result += mapChar(code, 0x1D504 - 0x41);
        continue;
      }
      if (code >= 0x1D51E && code <= 0x1D537) {
        result += mapChar(code, 0x1D51E - 0x61);
        continue;
      }
      if (code >= 0x1D538 && code <= 0x1D551) {
        result += mapChar(code, 0x1D538 - 0x41);
        continue;
      }
      if (code >= 0x1D552 && code <= 0x1D56B) {
        result += mapChar(code, 0x1D552 - 0x61);
        continue;
      }
      if (code >= 0x1D56C && code <= 0x1D585) {
        result += mapChar(code, 0x1D56C - 0x41);
        continue;
      }
      if (code >= 0x1D586 && code <= 0x1D59F) {
        result += mapChar(code, 0x1D586 - 0x61);
        continue;
      }
      if (code >= 0x1D7CE && code <= 0x1D7D7) {
        result += String.fromCodePoint(code - 0x1D7CE + 0x30);
        continue;
      }
      result += ch;
    }
    return result;
  }

  /**
   * Free OCR for PDFs (equations) using pix2tex via Python.
   * Requires PIX2TEX_PY or python available, and pix2tex/pdf2image installed.
   * @private
   */
  static async extractPdfWithPix2Tex(buffer) {
    let tmpDir = '';
    try {
      const pythonBin = process.env.PIX2TEX_PY || 'python';
      const scriptPath = path.join(__dirname, '..', 'scripts', 'pix2tex_ocr.py');
      if (!fs.existsSync(scriptPath)) {
        console.warn('pix2tex script not found. Skipping PDF equation OCR.');
        return '';
      }

      tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'pix2tex-'));
      const pdfPath = path.join(tmpDir, 'input.pdf');
      await fs.promises.writeFile(pdfPath, buffer);

      const output = await new Promise((resolve, reject) => {
        execFile(
          pythonBin,
          [scriptPath, pdfPath],
          {
            timeout: 120000,
            env: {
              ...process.env,
              PYTHONUTF8: '1',
              PYTHONIOENCODING: 'utf-8'
            }
          },
          (error, stdout, stderr) => {
            if (error) {
              return reject(new Error(stderr || error.message));
            }
            return resolve(stdout);
          }
        );
      });

      const lines = (output || '').trim().split(/\r?\n/).filter(Boolean);
      const lastLine = lines.length > 0 ? lines[lines.length - 1] : '{}';
      const parsed = JSON.parse(lastLine || '{}');
      const equations = Array.isArray(parsed.equations) ? parsed.equations : [];
      if (equations.length === 0) return '';
      return equations
        .map((eq) => `Equation:\n$$${eq}$$`)
        .join('\n');
    } catch (error) {
      console.warn('pix2tex OCR failed:', error.message);
      return '';
    } finally {
      if (tmpDir) {
        await fs.promises.rm(tmpDir, { recursive: true, force: true });
      }
    }
  }
}

module.exports = FileExtractor;
