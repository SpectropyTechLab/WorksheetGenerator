const axios = require('axios');
require('dotenv').config();
const { WORKSHEET_CATEGORIES } = require('../utils/constants');

const DEFAULT_MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const MAX_OUTPUT_TOKENS = Number(process.env.GEMINI_MAX_OUTPUT_TOKENS || 8192);
const FALLBACK_MODELS = (process.env.GEMINI_FALLBACK_MODELS || '')
  .split(',')
  .map((m) => m.trim())
  .filter(Boolean);

class LatexGenerator {
  static async generate(input, program, subject, chapterName, category = WORKSHEET_CATEGORIES.DIRECT) {
    try {
      if (!GEMINI_API_KEY) {
        throw new Error('GEMINI_API_KEY is missing. Set it in backend/.env.');
      }

      const rawText = typeof input?.rawText === 'string' ? input.rawText : String(input || '');
      if (!rawText.trim()) {
        throw new Error('No extracted worksheet text found to process.');
      }

      if (category === WORKSHEET_CATEGORIES.DIRECT || category === WORKSHEET_CATEGORIES.SIMILAR) {
        return await this.generateChunked(rawText, program, subject, chapterName, category);
      }

      const prompt = this.buildPrompt({ rawText, program, subject, chapterName, category });
      const content = await this.generateWithFallbacks(prompt);
      const cleaned = this.enforceQuestionCount(this.cleanGeneratedText(content), category);
      this.validateOutput(cleaned, category);
      return cleaned;
    } catch (error) {
      console.error('LaTeX generation error:', error);
      const status = error?.status || error?.response?.status;
      if (status === 429) {
        if (process.env.GEMINI_FALLBACK === 'true') {
          return this.buildFallbackContent(input, program, subject, chapterName, category);
        }
        throw new Error('Gemini quota exceeded. Check your API usage and billing.');
      }
      throw new Error(`Failed to generate LaTeX: ${error.message || 'Unknown error'}`);
    }
  }

  static async generateWithFallbacks(prompt) {
    try {
      return await this.generateWithModel(DEFAULT_MODEL, prompt);
    } catch (error) {
      const status = error?.status || error?.response?.status;
      if (status !== 404 || FALLBACK_MODELS.length === 0) {
        throw error;
      }

      for (const model of FALLBACK_MODELS) {
        try {
          return await this.generateWithModel(model, prompt);
        } catch (fallbackError) {
          console.warn(`Fallback model "${model}" failed: ${fallbackError?.message || fallbackError}`);
        }
      }

      throw error;
    }
  }

  static async generateChunked(rawText, program, subject, chapterName, category) {
    const worksheetTitle = this.resolveWorksheetTitle(program, subject, chapterName);
    const chunks = this.chunkWorksheet(rawText);
    if (chunks.length === 0) {
      throw new Error('No worksheet chunks available for generation.');
    }

    const outputs = [];
    for (let index = 0; index < chunks.length; index += 1) {
      const prompt = this.buildChunkPrompt({
        chunkText: chunks[index],
        chunkIndex: index + 1,
        chunkCount: chunks.length,
        program,
        subject,
        worksheetTitle,
        category
      });
      const chunkOutput = await this.generateWithFallbacks(prompt);
      outputs.push(this.cleanGeneratedText(chunkOutput));
    }

    const merged = this.mergeChunkOutputs(outputs, worksheetTitle, category);
    this.validateOutput(merged, category);
    return merged;
  }

  static async generateWithModel(modelName, prompt) {
    const normalizedModel = modelName.startsWith('models/')
      ? modelName
      : `models/${modelName}`;
    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/${normalizedModel}:generateContent`,
      {
        contents: [
          {
            role: 'user',
            parts: [{ text: prompt }]
          }
        ],
        generationConfig: {
          temperature: 0.3,
          maxOutputTokens: MAX_OUTPUT_TOKENS
        }
      },
      {
        headers: {
          'x-goog-api-key': GEMINI_API_KEY,
          'content-type': 'application/json'
        },
        timeout: 90000
      }
    );

    return (
      response?.data?.candidates?.[0]?.content?.parts
        ?.map((part) => part?.text || '')
        .join('') || ''
    );
  }

  static buildPrompt({ rawText, program, subject, chapterName, category }) {
    const worksheetTitle = this.resolveWorksheetTitle(program, subject, chapterName);
    const categoryLabel = this.getCategoryLabel(category);

    return `You are an educational worksheet expert creating a Word manual.
Return ONLY plain text. No markdown fences.
Use ASCII characters where possible. Preserve LaTeX math delimiters if you use math.

Manual header format:
SPECTROPY-IIT FOUNDATION MENTOR'S MANUAL
Worksheet: ${worksheetTitle}
Category: ${categoryLabel}
Syllabus Topics Covered: <comma-separated topics>
Answer Key and Detailed Solutions

Per-question output format:
1. <question text>
(a) ...
(b) ...
(c) ...
(d) ...
Key: (<correct option letter>) <answer text if available>
Solution:
• ...
• ...
• ...
• ...
• ...

Category behavior:
${this.getCategoryInstructions(category, subject)}

Hard rules:
1. Keep numbering sequential.
2. Every question must have options, a key, and a solution.
3. Solutions must have 4 to 6 short bullet lines, each starting with "• ".
4. Do not leave empty questions.
5. Do not output tables or markdown pipes.
6. Keep the final result suitable for DOCX conversion.

PROGRAM: ${String(program || '').toUpperCase()}
SUBJECT: ${String(subject || '').toUpperCase()}
CHAPTER: ${worksheetTitle}

RAW EXTRACTED TEXT:
${rawText}

Return ONLY the final manual content.`;
  }

  static buildChunkPrompt({ chunkText, chunkIndex, chunkCount, program, subject, worksheetTitle, category }) {
    const categoryLabel = this.getCategoryLabel(category);

    return `You are an educational worksheet expert creating a Word manual.
Return ONLY plain text. No markdown fences.
Use ASCII characters where possible. Preserve LaTeX math delimiters if you use math.

You are working on chunk ${chunkIndex} of ${chunkCount} from the same worksheet.
Generate ONLY the numbered questions for this chunk.
Do not include the document header in this chunk output.
Continue normal question numbering based on the chunk content itself.

Per-question output format:
1. <question text>
(a) ...
(b) ...
(c) ...
(d) ...
Key: (<correct option letter>) <answer text if available>
Solution:
• ...
• ...
• ...
• ...
• ...

Category behavior:
${this.getChunkCategoryInstructions(category)}

Hard rules:
1. Cover all questions that appear in this chunk.
2. Do not skip questions.
3. Do not merge multiple questions into one.
4. Every question must have options, key, and solution.
5. Do not output tables or markdown pipes.

PROGRAM: ${String(program || '').toUpperCase()}
SUBJECT: ${String(subject || '').toUpperCase()}
WORKSHEET: ${worksheetTitle}
CATEGORY: ${categoryLabel}

CHUNK CONTENT:
${chunkText}

Return ONLY the question content for this chunk.`;
  }

  static getCategoryInstructions(category, subject) {
    switch (category) {
      case WORKSHEET_CATEGORIES.SIMILAR:
        return `Read the uploaded worksheet text and identify the original questions.
Generate a similar-question manual based on those source questions.
Create new but conceptually similar questions with similar difficulty and chapter relevance.
Do not copy the original wording directly.
Try to keep the generated question count aligned with the source worksheet.`;
      case WORKSHEET_CATEGORIES.PYQ_STYLE:
        return `Generate exactly 15 previous-year-style multiple-choice questions. Do not generate more than 15 questions.
The style should be inspired by EAPCET, NEET, JEE Main, JEE Advanced, National Olympiad, International Olympiad, Asian Olympiad, and BITSAT.
These are exam-style inspired questions, not verified historical questions.
Keep them chapter-relevant, varied in difficulty, and suitable for competitive exam preparation.`;
      case WORKSHEET_CATEGORIES.REFERENCE:
        return `Generate exactly 15 reference practice multiple-choice questions. Do not generate more than 15 questions.
Base them on the uploaded worksheet topic and these subject-specific reference-book styles:
${this.getReferenceSourcesBySubject(subject)}
Do not make them feel like previous-year exam questions.
Use the worksheet only to infer chapter topics and concept coverage.
Vary the source style across the set instead of repeating the same book for every question.
For each question, include a short reference line such as "Reference: H.C. Verma style", "Reference: Morrison & Boyd style", or "Reference: S.L. Loney style".`;
      case WORKSHEET_CATEGORIES.DIRECT:
      default:
        return `Read the worksheet and preserve the original questions as faithfully as possible.
Keep the original question intent, order, and coverage while adding key and solution.
Try to keep the question count aligned with the uploaded worksheet.`;
    }
  }

  static getChunkCategoryInstructions(category) {
    switch (category) {
      case WORKSHEET_CATEGORIES.SIMILAR:
        return `For each source question in this chunk, create one new but conceptually similar question.
Keep similar difficulty and chapter relevance.
Do not copy the original wording exactly.`;
      case WORKSHEET_CATEGORIES.DIRECT:
      default:
        return `Preserve the original questions in this chunk as faithfully as possible.
Keep the question intent, order, and coverage while adding key and solution.`;
    }
  }

  static validateOutput(content, category) {
    if (!String(content || '').trim()) {
      throw new Error('Gemini returned empty content.');
    }

    const actualCount = this.countQuestions(content);
    if (actualCount === 0) {
      throw new Error('Generated output did not contain recognizable numbered questions.');
    }
    if (category === WORKSHEET_CATEGORIES.PYQ_STYLE || category === WORKSHEET_CATEGORIES.REFERENCE) {
      if (actualCount < 15) {
        throw new Error(`Generated ${actualCount} questions; expected exactly 15.`);
      }
      if (actualCount > 15) {
        throw new Error(`Generated ${actualCount} questions; expected no more than 15.`);
      }
    }
  }

  static enforceQuestionCount(content, category) {
    if (category !== WORKSHEET_CATEGORIES.PYQ_STYLE && category !== WORKSHEET_CATEGORIES.REFERENCE) {
      return content;
    }

    const sections = this.splitHeaderAndBody(content);
    const blocks = this.extractQuestionBlocks(sections.body);
    if (blocks.length <= 15) {
      return content;
    }

    const trimmedBody = blocks
      .slice(0, 15)
      .map((block, index) => this.renumberQuestionBlock(block, index + 1))
      .join('\n\n')
      .trim();

    return [sections.header, trimmedBody].filter(Boolean).join('\n\n').trim();
  }

  static splitHeaderAndBody(content) {
    const source = String(content || '').trim();
    const marker = 'Answer Key and Detailed Solutions';
    const markerIndex = source.indexOf(marker);
    if (markerIndex === -1) {
      return { header: '', body: source };
    }

    const header = source.slice(0, markerIndex + marker.length).trim();
    const body = source.slice(markerIndex + marker.length).trim();
    return { header, body };
  }

  static extractQuestionBlocks(body) {
    const source = String(body || '').trim();
    if (!source) return [];

    const matches = [...source.matchAll(/(^|\n)\s*(?:Q\s*)?\d+[\.\)]\s+/gim)];
    if (matches.length === 0) return [];

    const blocks = [];
    for (let i = 0; i < matches.length; i += 1) {
      const match = matches[i];
      const start = match.index + match[1].length;
      const end = i + 1 < matches.length ? matches[i + 1].index : source.length;
      const block = source.slice(start, end).trim();
      if (block) blocks.push(block);
    }
    return blocks;
  }

  static renumberQuestionBlock(block, number) {
    return String(block || '').replace(/^(?:Q\s*)?\d+[\.\)]\s+/, `${number}. `);
  }

  static chunkWorksheet(rawText) {
    const source = String(rawText || '').replace(/\r\n/g, '\n').trim();
    if (!source) return [];

    const questionMatches = [];
    const regex = /(^|\n)\s*(?:Q\s*)?\d+[\.\)]\s+/gim;
    let match;
    while ((match = regex.exec(source)) !== null) {
      questionMatches.push(match.index + match[1].length);
    }

    if (questionMatches.length < 2) {
      return this.chunkByLength(source, 5500);
    }

    const blocks = [];
    for (let i = 0; i < questionMatches.length; i += 1) {
      const start = questionMatches[i];
      const end = i + 1 < questionMatches.length ? questionMatches[i + 1] : source.length;
      const block = source.slice(start, end).trim();
      if (block) blocks.push(block);
    }

    const chunks = [];
    let current = [];
    let currentLength = 0;
    for (const block of blocks) {
      const blockLength = block.length + 2;
      if (current.length > 0 && (current.length >= 8 || currentLength + blockLength > 6500)) {
        chunks.push(current.join('\n\n'));
        current = [];
        currentLength = 0;
      }
      current.push(block);
      currentLength += blockLength;
    }
    if (current.length > 0) {
      chunks.push(current.join('\n\n'));
    }

    return chunks.length > 0 ? chunks : this.chunkByLength(source, 5500);
  }

  static chunkByLength(text, maxLength) {
    const source = String(text || '').trim();
    if (!source) return [];
    const chunks = [];
    let start = 0;
    while (start < source.length) {
      let end = Math.min(start + maxLength, source.length);
      if (end < source.length) {
        const breakIndex = source.lastIndexOf('\n', end);
        if (breakIndex > start + 1000) {
          end = breakIndex;
        }
      }
      chunks.push(source.slice(start, end).trim());
      start = end;
    }
    return chunks.filter(Boolean);
  }

  static mergeChunkOutputs(outputs, worksheetTitle, category) {
    const body = outputs
      .map((chunk) => this.stripHeader(chunk))
      .filter(Boolean)
      .join('\n\n')
      .trim();

    const topics = 'To be inferred from worksheet';
    return `SPECTROPY-IIT FOUNDATION MENTOR'S MANUAL
Worksheet: ${worksheetTitle}
Category: ${this.getCategoryLabel(category)}
Syllabus Topics Covered: ${topics}
Answer Key and Detailed Solutions

${body}`.trim();
  }

  static stripHeader(text) {
    const lines = String(text || '').split(/\r?\n/);
    const filtered = lines.filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) return true;
      if (trimmed === "SPECTROPY-IIT FOUNDATION MENTOR'S MANUAL") return false;
      if (trimmed.startsWith('Worksheet:')) return false;
      if (trimmed.startsWith('Category:')) return false;
      if (trimmed.startsWith('Syllabus Topics Covered:')) return false;
      if (trimmed === 'Answer Key and Detailed Solutions') return false;
      return true;
    });
    return filtered.join('\n').trim();
  }

  static cleanGeneratedText(text) {
    const cleaned = (text || '')
      .replace(/^```[\s\S]*?\n?/gm, '')
      .replace(/^```\s*\n?/gm, '')
      .replace(/\r\n/g, '\n')
      .trim();
    return this.normalizeSolutionBullets(this.normalizeGeneratedText(this.removeDuplicateLines(cleaned)));
  }

  static normalizeGeneratedText(text) {
    return String(text || '')
      .replace(/^\s*[•●▪◦]\s*-?\s*/gm, '- ')
      .replace(/(^|\n)\s*Solution\s*:\s*\n(?=(?:[•●▪◦]|-)\s*)/g, '$1Solution:\n')
      .replace(/(^|\n)\s*Solution\s*:\s*[•●▪◦]\s*-?\s*/g, '$1Solution:\n- ')
      // Normalize malformed fill-in-the-blank placeholders like "{}_{}_{}_".
      .replace(/(?:\\?\{\}\s*_+\s*){2,}|(?:\\\{\}\\?_+\s*){2,}/g, '_________')
      .replace(/(?:\\\{\}_?){3,}/g, '_________')
      .replace(/(?:\\\{\}\s*_?){3,}/g, '_________')
      .replace(/(?:\\\{\}\\_){2,}/g, '_________')
      .replace(/(?:\{\}_\s*){2,}/g, '_________')
      .replace(/(?:\\\{\}_\s*){2,}/g, '_________')
      .replace(/_{10,}/g, '_________');
  }

  static removeDuplicateLines(text) {
    const lines = (text || '').split(/\r?\n/);
    const output = [];
    let last = '';
    for (const line of lines) {
      const normalized = line.trim().replace(/\s+/g, ' ');
      if (normalized && normalized === last) continue;
      output.push(line);
      last = normalized;
    }
    return output.join('\n').trim();
  }

  static normalizeSolutionBullets(text) {
    return String(text || '')
      .replace(/^\s*(?:\u2022|\u25cf|\u25aa|\u25e6)\s*-?\s*/gm, '• ')
      .replace(/^\s*-\s+/gm, '• ')
      .replace(/(^|\n)\s*Solution\s*:\s*\n(?=(?:(?:\u2022|\u25cf|\u25aa|\u25e6|•)|-)\s*)/g, '$1Solution:\n')
      .replace(/(^|\n)\s*Solution\s*:\s*(?:\u2022|\u25cf|\u25aa|\u25e6|•)\s*-?\s*/g, '$1Solution:\n• ');
  }

  static buildFallbackContent(input, program, subject, chapterName, category) {
    const rawText = typeof input?.rawText === 'string' ? input.rawText : String(input || '');
    const title = this.resolveWorksheetTitle(program, subject, chapterName);
    const categoryLabel = this.getCategoryLabel(category);
    const source = rawText.slice(0, 4000);

    return `SPECTROPY-IIT FOUNDATION MENTOR'S MANUAL
Worksheet: ${title}
Category: ${categoryLabel}
Syllabus Topics Covered: ${subject}
Answer Key and Detailed Solutions

1. ${source}
(a) Option A
(b) Option B
(c) Option C
(d) Option D
Key: (a)
Solution:
• Review the source worksheet for this concept.
• Confirm the topic and chapter context.
• Cross-check the options against the question stem.
• Use the chapter method shown in class.
• Finalize the best-supported answer.`;
  }

  static getCategoryLabel(category) {
    switch (category) {
      case WORKSHEET_CATEGORIES.SIMILAR:
        return 'Similar Questions';
      case WORKSHEET_CATEGORIES.PYQ_STYLE:
        return 'Previous Year Style Questions';
      case WORKSHEET_CATEGORIES.REFERENCE:
        return 'Reference Questions';
      case WORKSHEET_CATEGORIES.DIRECT:
      default:
        return 'Direct Questions';
    }
  }

  static getReferenceSourcesBySubject(subject) {
    switch (String(subject || '').trim().toLowerCase()) {
      case 'physics':
        return 'Physics: H.C. Verma, Halliday/Resnick/Walker, Irodov, Krotov, Griffiths, Beiser.';
      case 'chemistry':
        return 'Chemistry: P. Bahadur, N. Avasthi, Atkins, O.P. Tandon, Morrison & Boyd, M.S. Chauhan, Peter Sykes, J.D. Lee, NCERT.';
      case 'biology':
        return 'Biology: NCERT and standard authored books. Each question should include reference information such as "Reference: NCERT style" or "Reference: Standard Authored Book style".';
      case 'maths':
      case 'mathematics':
        return 'Mathematics: S.L. Loney, Hall & Knight, I.A. Maron, Tata McGraw Hill, Cengage, Arihant, Prasolov, A. Das Gupta, NCERT.';
      default:
        return 'Reference books should match the current subject and chapter.';
    }
  }

  static countQuestions(text) {
    if (!text) return 0;
    const matches = text.match(/(^|\n)\s*(?:Q\s*)?(\d+)[\.\)]\s+/gi);
    return matches ? matches.length : 0;
  }

  static resolveWorksheetTitle(program, subject, chapterName) {
    const safeChapter = String(chapterName || '').trim();
    if (safeChapter) {
      return safeChapter.toUpperCase();
    }
    const safeProgram = String(program || '').trim();
    const safeSubject = String(subject || '').trim();
    const fallback = [safeProgram, safeSubject].filter(Boolean).join(' - ');
    return fallback || 'WORKSHEET';
  }
}

module.exports = LatexGenerator;
