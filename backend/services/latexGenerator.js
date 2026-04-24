const axios = require('axios');
require('dotenv').config();
const ConceptAuditService = require('./conceptAuditService');
const QuestionParser = require('./questionParser');

const DEFAULT_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const MAX_OUTPUT_TOKENS = Number(process.env.GEMINI_MAX_OUTPUT_TOKENS || 8192);
const FRONT_MATTER_MAX_TOKENS = Math.min(MAX_OUTPUT_TOKENS, 2200);
const QUESTION_SECTION_MAX_TOKENS = Math.min(MAX_OUTPUT_TOKENS, 3200);
const SOLUTION_BATCH_MAX_TOKENS = Math.min(MAX_OUTPUT_TOKENS, 3600);
const INPUT_TOKEN_BUDGET_PER_MINUTE = Number(process.env.GEMINI_INPUT_TOKEN_BUDGET_PER_MINUTE || 25000);
const INPUT_TOKEN_WINDOW_MS = 60 * 1000;
const RETRY_DELAY_MS = Number(process.env.GEMINI_RETRY_DELAY_MS || 30000);
const QUESTION_MODE = process.env.WORKSHEET_QUESTION_MODE || 'model';

const MAIN_QUESTION_COUNT = 30;
const BONUS_QUESTION_COUNT = 10;
const TOTAL_QUESTION_COUNT = MAIN_QUESTION_COUNT + BONUS_QUESTION_COUNT;
const QUESTION_SECTION_CONFIGS = [
  {
    heading: '## Section 1: MCQ - Single Correct Answer Type',
    range: [1, 10],
    sectionType: 'single',
    typeRules: 'Every question must have options A, B, C, D. Single correct only.',
    slots: [
      { range: [1, 2], bloom: 'Remember', count: 2 },
      { range: [3, 4], bloom: 'Understand', count: 2 },
      { range: [5, 6], bloom: 'Apply', count: 2 },
      { range: [7, 8], bloom: 'Analyse', count: 2 },
      { range: [9, 10], bloom: 'Evaluate', count: 2 }
    ]
  },
  {
    heading: '## Section 2: MCQ - Multiple Correct Answer Type',
    range: [11, 16],
    sectionType: 'multiple',
    typeRules: 'Every question must clearly say: More than one option may be correct. Use options A, B, C, D.',
    slots: [
      { range: [11, 12], bloom: 'Apply', count: 2 },
      { range: [13, 14], bloom: 'Analyse', count: 2 },
      { range: [15, 16], bloom: 'Evaluate', count: 2 }
    ]
  },
  {
    heading: '## Section 3: Comprehension',
    range: [17, 20],
    sectionType: 'comprehension',
    typeRules: 'Include the passage first, then Q17 to Q20 with options A, B, C, D.',
    slots: [
      { range: [17, 17], bloom: 'Remember', count: 1 },
      { range: [18, 18], bloom: 'Understand', count: 1 },
      { range: [19, 19], bloom: 'Apply', count: 1 },
      { range: [20, 20], bloom: 'Analyse', count: 1 }
    ]
  },
  {
    heading: '## Section 4: Assertion & Reason',
    range: [21, 23],
    sectionType: 'assertion',
    typeRules: 'Use standard assertion-reason format with answer options.',
    slots: [
      { range: [21, 21], bloom: 'Understand', count: 1 },
      { range: [22, 22], bloom: 'Apply', count: 1 },
      { range: [23, 23], bloom: 'Analyse', count: 1 }
    ]
  },
  {
    heading: '## Section 5: Matching Type',
    range: [24, 26],
    sectionType: 'matching',
    typeRules: 'Use two clean lists for each question.',
    slots: [
      { range: [24, 24], bloom: 'Understand', count: 1 },
      { range: [25, 25], bloom: 'Apply', count: 1 },
      { range: [26, 26], bloom: 'Analyse', count: 1 }
    ]
  },
  {
    heading: '## Section 6: Source-Aligned PYQ Style',
    range: [27, 30],
    sectionType: 'pyq',
    typeRules: 'Every question must have options A, B, C, D.',
    slots: [
      { range: [27, 27], bloom: 'Apply', count: 1, style: 'National Olympiad / JEE Main style' },
      { range: [28, 28], bloom: 'Analyse', count: 1, style: 'JEE Advanced style' },
      { range: [29, 29], bloom: 'Evaluate', count: 1, style: 'International Olympiad style' },
      { range: [30, 30], bloom: 'Analyse', count: 1, style: 'Asian Olympiad style' }
    ]
  },
  {
    heading: '## Bonus Section: 10 Advanced Questions - JEE Advanced & International Olympiad Level',
    range: [31, 40],
    sectionType: 'bonus',
    typeRules: 'Questions must be advanced, analytical, source-bounded, and include options A, B, C, D where applicable.',
    slots: [
      { range: [31, 35], bloom: 'JEE Advanced', count: 5 },
      { range: [36, 40], bloom: 'International Olympiad', count: 5 }
    ]
  }
];

class LatexGenerator {
  static rateLimitWindowStartedAt = 0;

  static rateLimitTokensUsed = 0;

  static async generate(input, program, subject, chapterName) {
    try {
      if (!GEMINI_API_KEY) {
        throw new Error('GEMINI_API_KEY is missing. Set it in backend/.env.');
      }

      const rawText = typeof input?.rawText === 'string' ? input.rawText : String(input || '');
      if (!rawText.trim()) {
        throw new Error('No extracted worksheet text found to process.');
      }

      const audit = ConceptAuditService.audit(rawText, subject, chapterName);
      const context = {
        rawText,
        program,
        subject,
        chapterName,
        audit
      };

      const frontMatter = await this.generateFrontMatter(context);
      const questions = await this.generateQuestions(context);
      const solutions = await this.generateSolutions(context, questions);
      const classification = this.buildClassificationSection(questions);

      const document = this.cleanGeneratedText(
        [frontMatter, questions, solutions, classification].filter(Boolean).join('\n\n'),
        chapterName,
        audit
      );

      return document;
    } catch (error) {
      console.error('Worksheet generation error:', error);
      throw new Error(`Failed to generate worksheet content: ${error.message || 'Unknown error'}`);
    }
  }

  static async generateFrontMatter(context) {
    return this.ensureFrontMatter('', context.audit, context.program, context.subject, context.chapterName);
  }

  static async generateQuestions(context) {
    if (QUESTION_MODE === 'local') {
      return this.normalizeWorksheetFormatting(QUESTION_SECTION_CONFIGS
        .map((config) => this.buildFallbackQuestionSubsection(config, context.audit, config.range))
        .join('\n\n'));
    }

    const sections = [];
    for (const config of QUESTION_SECTION_CONFIGS) {
      sections.push(await this.generateQuestionSection(context, config));
    }
    return this.normalizeWorksheetFormatting(sections.join('\n\n'));
  }

  static async generateSolutions(context, questions) {
    const parsedQuestions = QuestionParser.parse(this.normalizeWorksheetFormatting(questions));
    const sections = ['## Section 7: Key & Solutions', this.buildLocalSolutions(context.audit, parsedQuestions)];
    return this.ensureSolutionSection(this.normalizeWorksheetFormatting(sections.join('\n\n')));
  }

  static async generateQuestionSection(context, config) {
    const sectionParts = [config.heading];

    if (config.sectionType === 'comprehension') {
      sectionParts.push(await this.generateComprehensionPassage(context, config));
    }

    for (const slot of config.slots || []) {
      sectionParts.push(await this.generateQuestionSlot(context, config, slot));
    }

    const sectionContent = sectionParts.filter(Boolean).join('\n\n').trim();
    return sectionContent;
  }

  static async generateComprehensionPassage(context, config) {
    const [start, end] = config.range;
    const prompt = `You are writing the comprehension passage for a premium Olympiad worksheet.

Return ONLY Markdown lines for the passage that will be placed under:
${config.heading}

Rules:
- Start exactly with: Passage:
- Write one compact academic passage of 120 to 180 words.
- The passage must support Q${start} to Q${end}.
- Use only the uploaded source material.
- Preserve mathematical expressions exactly and wrap them in inline math delimiters like $...$.
- Do NOT write questions.
- Do NOT write options.
- Do NOT write solutions.

Source context:
${this.buildSharedContext(context)}
`;

    const content = await this.safeGenerate(prompt, 900);
    const normalized = String(content || '').trim();
    if (/^Passage:/im.test(normalized)) {
      return normalized;
    }

    const concept = this.pickConceptForQuestion(context.audit, start);
    return `Passage: The source discussion explains ${this.toSentence(concept, 120)} through direct conceptual statements only. Read the passage carefully and answer Q${start} to Q${end} without using any idea beyond the uploaded material.`;
  }

  static async generateQuestionSlot(context, config, slot) {
    const [start, end] = slot.range;
    const expectedNumbers = this.rangeToArray(start, end);
    const batchSize = expectedNumbers.length;
    const prompt = this.buildQuestionSlotPrompt(context, config, slot);

    try {
      const content = await this.generateWithFallbacks(prompt, QUESTION_SECTION_MAX_TOKENS);
      return String(content || '').trim();
    } catch (error) {
      if (batchSize <= 1) {
        throw error;
      }

      const midpoint = Math.floor((start + end) / 2);
      const firstHalf = await this.generateQuestionSlot(context, config, { ...slot, range: [start, midpoint], count: midpoint - start + 1 });
      const secondHalf = await this.generateQuestionSlot(context, config, { ...slot, range: [midpoint + 1, end], count: end - midpoint });
      return `${firstHalf}\n\n${secondHalf}`.trim();
    }
  }

  static buildQuestionSlotPrompt(context, config, slot) {
    const [start, end] = slot.range;
    const numberingLine = start === end
      ? `Return only Q${start}.`
      : `Return only Q${start} to Q${end}.`;

    return `You are creating a tightly controlled worksheet slot for a premium Olympiad worksheet.

Section:
${config.heading}

${numberingLine}

Slot blueprint:
- Bloom level: ${slot.bloom}
- Expected question count: ${slot.count}
- Section type: ${config.sectionType}
${slot.style ? `- Exam style focus: ${slot.style}` : ''}

Formatting rules:
- Every question must start exactly like: Qn. (${slot.bloom}) ...
- Use the exact Bloom label ${slot.bloom} for every question in this slot.
- ${config.typeRules}
- Preserve every mathematical expression exactly.
- Wrap mathematical expressions in inline math delimiters like $...$ so they can be converted into Word equations later.
- Do NOT include the section heading.
- Do NOT include any passage heading unless the question explicitly depends on the already-generated passage.
- Do NOT write solutions.
- Do NOT write final answers.
- Do NOT use placeholder text such as "Placeholder question", "Option A", "Option B", or generic dummy wording.
- Questions must be genuinely different from one another and strictly source-rooted.

Additional section-specific rules:
${this.buildSlotSpecificRules(config, slot)}

Source context:
${this.buildSharedContext(context)}
`;
  }

  static buildSlotSpecificRules(config, slot) {
    const rules = [];

    if (config.sectionType === 'single') {
      rules.push('Exactly one option must be correct.');
    }
    if (config.sectionType === 'multiple') {
      rules.push('Include the sentence "More than one option may be correct." in each question line.');
      rules.push('Design the options so the answer requires identifying more than one correct statement.');
    }
    if (config.sectionType === 'assertion') {
      rules.push('Use Assertion and Reason lines followed by the four standard assertion-reason options.');
    }
    if (config.sectionType === 'matching') {
      rules.push('Each question must include List I and List II.');
      rules.push('Each list must contain four clean entries.');
    }
    if (config.sectionType === 'comprehension') {
      rules.push('Each question must explicitly depend on the already-written passage.');
    }
    if (config.sectionType === 'pyq') {
      rules.push('Write the question in source-aligned PYQ style without claiming it is an actual previous-year question.');
    }
    if (config.sectionType === 'bonus') {
      rules.push('Make the question multi-step, analytical, and harder than the base sections while staying within source scope.');
    }

    if (/Remember/i.test(slot.bloom)) {
      rules.push('Focus on recall, identification, definition recognition, or direct source facts.');
    } else if (/Understand/i.test(slot.bloom)) {
      rules.push('Focus on interpretation, classification, comparison, or explanation within the source.');
    } else if (/Apply/i.test(slot.bloom)) {
      rules.push('Focus on direct source-based application without adding new theory.');
    } else if (/Analyse/i.test(slot.bloom)) {
      rules.push('Focus on comparison, separation of cases, inference, or reasoning through source statements.');
    } else if (/Evaluate/i.test(slot.bloom)) {
      rules.push('Focus on best judgment, strongest conclusion, or choosing the most defensible source-aligned statement.');
    }

    return rules.map((item) => `- ${item}`).join('\n');
  }

  static async generateSolutionBatch(context, questions, range) {
    const [start, end] = range;
    const prompt = `You are creating solutions for a premium Olympiad worksheet.

Return ONLY Markdown solution blocks for Q${start} to Q${end}.

Formatting rules:
- Start each block with: ### Solution for Qn
- Write every step on a new line beginning with Step 1., Step 2., and so on.
- End each block with Final Answer:
- Do NOT repeat the full question statement.
- Do NOT repeat the answer options unless absolutely necessary.
- Do NOT use placeholder wording.
- Do NOT skip any question in this range.

Relevant questions:
${this.extractQuestionRange(questions, start, end)}

Source context:
${this.buildSharedContext(context)}
`;

    try {
      const content = await this.generateWithFallbacks(prompt, SOLUTION_BATCH_MAX_TOKENS);
      return this.ensureSolutionBatch(content, start, end);
    } catch (error) {
      const batchSize = end - start + 1;
      if (batchSize <= 2) {
        return this.buildFallbackSolutionRange(context.audit, [start, end]);
      }

      const midpoint = Math.floor((start + end) / 2);
      const firstHalf = await this.generateSolutionBatch(context, questions, [start, midpoint]);
      const secondHalf = await this.generateSolutionBatch(context, questions, [midpoint + 1, end]);
      return `${firstHalf}\n\n${secondHalf}`.trim();
    }
  }

  static async safeGenerate(prompt, maxOutputTokens) {
    try {
      const content = await this.generateWithFallbacks(prompt, maxOutputTokens);
      return String(content || '').trim();
    } catch (generationError) {
      console.warn(
        `Worksheet generation model call failed, using resilient fallback content: ${
          generationError?.message || generationError
        }`
      );
      return '';
    }
  }

  static async generateWithFallbacks(prompt, maxOutputTokens = MAX_OUTPUT_TOKENS) {
    const candidateModels = [DEFAULT_MODEL];
    let lastError = null;

    for (const model of candidateModels) {
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
          return await this.generateWithModel(model, prompt, maxOutputTokens);
        } catch (error) {
          lastError = error;
          const status = error?.status || error?.response?.status;
          const reason = this.extractModelErrorMessage(error);
          console.warn(`Model "${model}" failed${status ? ` with status ${status}` : ''}: ${reason}`);

          if (!this.isRetryableModelError(status) || attempt === 2) {
            throw error;
          }

          if (Number(status) === 429) {
            await this.delay(RETRY_DELAY_MS);
          } else {
            await this.delay(5000);
          }
        }
      }
    }

    throw lastError || new Error('No Gemini model produced worksheet content.');
  }

  static isRetryableModelError(status) {
    return [404, 429, 500, 503, 529].includes(Number(status));
  }

  static async generateWithModel(modelName, prompt, maxOutputTokens) {
    await this.reserveInputTokenBudget(prompt);

    let response;
    try {
      const normalizedModel = modelName.startsWith('models/')
        ? modelName
        : `models/${modelName}`;

      response = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/${normalizedModel}:generateContent`,
        {
          contents: [
            {
              role: 'user',
              parts: [{ text: prompt }]
            }
          ],
          generationConfig: {
            temperature: 0.2,
            maxOutputTokens: maxOutputTokens || MAX_OUTPUT_TOKENS
          }
        },
        {
          headers: {
            'x-goog-api-key': GEMINI_API_KEY,
            'content-type': 'application/json'
          },
          timeout: 180000
        }
      );
    } catch (error) {
      const status = error?.response?.status;
      const details = this.extractModelErrorMessage(error);
      const requestId = error?.response?.headers?.['request-id'];
      const enrichedError = new Error(
        requestId
          ? `${details} (request-id: ${requestId})`
          : details
      );
      enrichedError.status = status;
      enrichedError.response = error?.response;
      throw enrichedError;
    }

    return (
      response?.data?.candidates?.[0]?.content?.parts
        ?.map((part) => part?.text || '')
        .join('') || ''
    );
  }

  static extractModelErrorMessage(error) {
    const bodyMessage =
      error?.response?.data?.error?.message ||
      error?.response?.data?.message ||
      error?.response?.data?.error ||
      error?.message ||
      'Unknown model error';

    return String(bodyMessage).replace(/\s+/g, ' ').trim();
  }

  static async reserveInputTokenBudget(prompt) {
    const estimatedTokens = this.estimateInputTokens(prompt);
    const now = Date.now();

    if (!this.rateLimitWindowStartedAt || now - this.rateLimitWindowStartedAt >= INPUT_TOKEN_WINDOW_MS) {
      this.rateLimitWindowStartedAt = now;
      this.rateLimitTokensUsed = 0;
    }

    if (this.rateLimitTokensUsed + estimatedTokens > INPUT_TOKEN_BUDGET_PER_MINUTE) {
      const waitMs = Math.max(0, INPUT_TOKEN_WINDOW_MS - (now - this.rateLimitWindowStartedAt)) + 1000;
      await this.delay(waitMs);
      this.rateLimitWindowStartedAt = Date.now();
      this.rateLimitTokensUsed = 0;
    }

    this.rateLimitTokensUsed += estimatedTokens;
  }

  static estimateInputTokens(prompt) {
    return Math.max(1, Math.ceil(String(prompt || '').length / 4));
  }

  static delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  static buildSubsectionConfig(config, range) {
    const [start, end] = range;
    return {
      ...config,
      heading: config.heading,
      range,
      instructions: [
        `This subsection must contain only Q${start} to Q${end}.`,
        `Keep the original section type and difficulty progression from ${config.heading}.`,
        ...(config.instructions || [])
      ]
    };
  }

  static buildFallbackQuestionSubsection(config, audit, range) {
    const [start, end] = range;
    const concepts = (audit.allowedConcepts || []).filter(Boolean);
    const formulas = (audit.formulas || []).map((item) => item.text).filter(Boolean);
    const definitionTexts = (audit.definitions || []).map((item) => item.text).filter(Boolean);
    const examples = (audit.examples || []).map((item) => item.text).filter(Boolean);
    const sourceSnippets = [...definitionTexts, ...formulas, ...examples].filter(Boolean);
    const blocks = [config.heading];
    const slotMap = this.buildBloomByQuestionMap(config);

    if (/Comprehension/i.test(config.heading)) {
      const passageTopic = this.pickConceptForQuestion(audit, start);
      const passage = this.pickSourceSnippet(sourceSnippets, start, `The source discussion explains ${passageTopic} using direct conceptual statements only.`);
      blocks.push(`Passage: ${this.toSentence(passage, 320)}`);
      blocks.push('');
    }

    for (let q = start; q <= end; q += 1) {
      const concept = this.pickConceptForQuestion(audit, q);
      const supportLine = this.pickSourceSnippet(
        sourceSnippets,
        q,
        `The source discussion of ${concept} within ${audit.chapterTitle || 'the chapter'}`
      );
      const bloom = slotMap.get(q) || 'Apply';
      if (/Assertion & Reason/i.test(config.heading)) {
        blocks.push(`Q${q}. [${bloom}]`);
        blocks.push(`Assertion: ${this.toSentence(supportLine, 160)}.`);
        blocks.push(`Reason: This follows directly from the same source treatment of ${concept} and does not require any out-of-scope idea.`);
        blocks.push('A. Both Assertion and Reason are true and Reason is the correct explanation of Assertion.');
        blocks.push('B. Both Assertion and Reason are true but Reason is not the correct explanation of Assertion.');
        blocks.push('C. Assertion is true but Reason is false.');
        blocks.push('D. Assertion is false but Reason is true.');
      } else if (/Matching Type/i.test(config.heading)) {
        blocks.push(`Q${q}. [${bloom}] Match the following based on the source treatment of ${concept}.`);
        blocks.push('List I');
        blocks.push(`A. ${this.shortLabel(concepts, q, concept)}`);
        blocks.push(`B. ${this.shortLabel(concepts, q + 1, 'Source idea 2')}`);
        blocks.push(`C. ${this.shortLabel(concepts, q + 2, 'Source idea 3')}`);
        blocks.push(`D. ${this.shortLabel(concepts, q + 3, 'Source idea 4')}`);
        blocks.push('List II');
        blocks.push(`1. ${this.shortLabel(definitionTexts, q, 'Source statement 1')}`);
        blocks.push(`2. ${this.shortLabel(definitionTexts, q + 1, 'Source statement 2')}`);
        blocks.push(`3. ${this.shortLabel(definitionTexts, q + 2, 'Source statement 3')}`);
        blocks.push(`4. ${this.shortLabel(definitionTexts, q + 3, 'Source statement 4')}`);
      } else if (/Multiple Correct/i.test(config.heading)) {
        blocks.push(`Q${q}. [${bloom}] Which of the following statements are correct according to the source discussion of ${concept}?`);
        blocks.push(`I. ${this.toSentence(supportLine, 120)}`);
        blocks.push(`II. ${concept} is treated in the source using an entirely unrelated concept family.`);
        blocks.push(`III. The source keeps ${concept} within the chapter scope and does not add outside theory.`);
        blocks.push(`IV. The source states that ${concept} has no connection to the chapter.`);
        blocks.push('A. I and III only');
        blocks.push('B. I and II only');
        blocks.push('C. II and IV only');
        blocks.push('D. I, III and IV only');
      } else {
        const correctLetter = this.getCorrectLetter(q);
        const options = this.placeCorrectOption(
          correctLetter,
          this.toSentence(supportLine, 130),
          [
            `${concept} is explained using ideas that are not present in the uploaded source.`,
            `${concept} is unrelated to the chapter discussion according to the source.`,
            `${concept} is replaced in the source by a different concept family altogether.`
          ]
        );
        blocks.push(`Q${q}. [${bloom}] Which statement best matches the source treatment of ${concept}?`);
        options.forEach((option) => blocks.push(`${option.letter}. ${option.text}`));
      }
      blocks.push('');
    }

    return blocks.join('\n').trim();
  }

  static buildFallbackSolutionRange(audit, range) {
    const [start, end] = range;
    const concepts = (audit.allowedConcepts || []).filter(Boolean);
    const lines = [];

    for (let q = start; q <= end; q += 1) {
      const concept = concepts[(q - start) % Math.max(concepts.length, 1)] || audit.chapterTitle || 'the source concept';
      lines.push(`### Solution for Q${q}`);
      lines.push(`Step 1. Identify the exact source statement or formula linked to ${concept}.`);
      lines.push('Step 2. Eliminate any option that introduces an idea not present in the uploaded material.');
      lines.push(`Step 3. Select the option that stays fully aligned with the chapter discussion of ${concept}.`);
      lines.push('Final Answer: The correct option is the one that matches the uploaded source exactly.');
      lines.push('');
    }

    return lines.join('\n').trim();
  }

  static buildLocalSolutions(audit, parsedQuestions) {
    const questionMap = new Map((parsedQuestions || []).map((item) => [Number(item.number), item]));
    const lines = [];

    for (let q = 1; q <= TOTAL_QUESTION_COUNT; q += 1) {
      const question = questionMap.get(q);
      const concept = this.pickConceptForQuestion(audit, q);
      const answer = this.resolveAnswerFromQuestion(q, question);
      const promptSummary = this.summarizeQuestionPrompt(question?.prompt, concept);
      const distractors = this.collectDistractorNotes(question, answer);
      lines.push(`### Solution for Q${q}`);
      lines.push('Solution:');
      lines.push(`- The question is centered on ${promptSummary}.`);
      lines.push(`- From the uploaded source, the key idea to track here is ${this.toSentence(concept, 90)}.`);
      if (question?.options?.length) {
        lines.push(`- The option that matches the source most directly is ${answer.letter}. ${answer.text}.`);
      }
      if (distractors.length > 0) {
        distractors.forEach((note) => lines.push(`- ${note}`));
      } else {
        lines.push('- Any option that introduces extra theory, reverses the source statement, or goes beyond the given concept scope must be rejected.');
      }
      if (answer?.text) {
        lines.push(`- Therefore, the source-supported conclusion is ${answer.text}.`);
      }
      lines.push('');
      lines.push(`Final Answer: ${answer?.letter || 'A'} ${answer?.text || 'The source-aligned option'}`);
      lines.push('');
    }

    return lines.join('\n').trim();
  }

  static pickConceptForQuestion(audit, questionNumber) {
    const concepts = (audit.allowedConcepts || []).filter(Boolean);
    if (concepts.length === 0) {
      return audit.chapterTitle || 'the chapter concept';
    }
    return concepts[(questionNumber - 1) % concepts.length];
  }

  static shortLabel(values, index, fallback) {
    const list = Array.isArray(values) ? values.filter(Boolean) : [];
    const value = list.length ? list[index % list.length] : fallback;
    return this.toSentence(value || fallback);
  }

  static toSentence(value, limit = 140) {
    const safe = String(value || '')
      .replace(/\s+/g, ' ')
      .replace(/[^\S\r\n]+/g, ' ')
      .trim();
    if (!safe) return 'Refer to the uploaded source';
    return safe.length > limit ? `${safe.slice(0, Math.max(limit - 3, 20)).trim()}...` : safe;
  }

  static getBloomSequence(config) {
    return this.rangeToArray(config.range[0], config.range[1]).map((number) => this.buildBloomByQuestionMap(config).get(number) || 'Apply');
  }

  static pickSourceSnippet(snippets, index, fallback) {
    const list = Array.isArray(snippets) ? snippets.filter(Boolean) : [];
    if (list.length === 0) return fallback;
    return list[index % list.length];
  }

  static getCorrectLetter(questionNumber) {
    return ['A', 'B', 'C', 'D'][(questionNumber - 1) % 4];
  }

  static placeCorrectOption(correctLetter, correctOption, distractors) {
    const letters = ['A', 'B', 'C', 'D'];
    const wrongs = [...distractors];
    return letters.map((letter) => ({
      letter,
      text: letter === correctLetter ? correctOption : wrongs.shift()
    }));
  }

  static resolveAnswerFromQuestion(questionNumber, question) {
    if (!question?.options?.length) {
      return { letter: this.getCorrectLetter(questionNumber), text: 'The source-aligned option' };
    }

    if (question.options.some((item) => /I and III only/i.test(item))) {
      return { letter: 'A', text: 'I and III only' };
    }

    const targetLetter = this.getCorrectLetter(questionNumber);
    const option = question.options.find((item) => item.startsWith(`(${targetLetter})`)) || question.options[0];
    const text = String(option || '').replace(/^\([A-D]\)\s*/, '').trim();
    return { letter: targetLetter, text };
  }

  static summarizeQuestionPrompt(prompt, fallbackConcept) {
    const safePrompt = this.toSentence(
      String(prompt || '')
        .replace(/\[[^\]]+\]/g, '')
        .replace(/^Assertion:\s*/i, '')
        .replace(/^Reason:\s*/i, ''),
      160
    );
    return safePrompt || `the source treatment of ${fallbackConcept}`;
  }

  static collectDistractorNotes(question, answer) {
    const options = Array.isArray(question?.options) ? question.options : [];
    return options
      .map((option) => {
        const match = String(option).match(/^\(([A-D])\)\s*(.*)$/);
        if (!match) return null;
        const [, letter, text] = match;
        if (letter === answer.letter) return null;
        return `Option ${letter} is not selected because ${this.buildRejectionReason(text)}.`;
      })
      .filter(Boolean)
      .slice(0, 2);
  }

  static buildRejectionReason(optionText) {
    const text = String(optionText || '').trim();
    if (!text) {
      return 'it does not provide a clear source-supported statement';
    }

    if (/\bnot\b|\bnever\b|\bincorrect\b|\bfalse\b|\bunrelated\b|\boutside\b/i.test(text)) {
      return 'it either contradicts the source statement or pushes the idea outside the allowed scope';
    }

    if (/\bI and III only\b|\bI and II only\b|\bII and IV only\b|\bI, III and IV only\b/i.test(text)) {
      return 'that combination does not match the set of source-consistent statements';
    }

    return 'it is weaker than the option that aligns most directly with the uploaded source';
  }

  static buildSharedContext({ rawText, program, subject, chapterName, audit }) {
    return [
      `Worksheet title: ${this.resolveWorksheetTitle(program, subject, chapterName)}`,
      `Program: ${program}`,
      `Subject: ${subject}`,
      '',
      'Clean source representation:',
      audit.sourceRepresentation || 'No structured source representation available.',
      '',
      'Allowed concepts:',
      this.renderAuditList((audit.allowedConcepts || []).slice(0, 8)),
      '',
      'Concepts not allowed:',
      this.renderAuditList((audit.bannedConcepts || []).slice(0, 5)),
      '',
      'Definitions and ideas from source:',
      this.renderAuditObjects((audit.definitions || []).slice(0, 4)),
      '',
      'Formulas and quantitative expressions from source:',
      this.renderAuditObjects((audit.formulas || []).slice(0, 4)),
      '',
      'Examples and applications from source:',
      this.renderAuditObjects((audit.examples || []).slice(0, 3)),
      '',
      'CLEANED SOURCE CONTENT',
      audit.sourceExcerpt || audit.cleanedText || rawText.slice(0, 3500)
    ].join('\n');
  }

  static renderAuditList(items) {
    const safeItems = Array.isArray(items) && items.length > 0 ? items : ['No explicit items extracted'];
    return safeItems.map((item) => `- ${item}`).join('\n');
  }

  static renderAuditObjects(items) {
    const safeItems = Array.isArray(items) && items.length > 0
      ? items
      : [{ label: 'Not clearly extracted', text: 'Use only the source text.' }];

    return safeItems
      .map((item) => {
        const label = String(item.label || '').trim();
        const text = String(item.text || '').trim();
        if (!text) {
          return `- ${label}`;
        }
        if (/^formula \d+$/i.test(label) || /^example \d+$/i.test(label) || label === text) {
          return `- ${text}`;
        }
        return `- ${label}: ${text}`;
      })
      .join('\n');
  }

  static cleanGeneratedText(text, chapterName, audit) {
    const cleaned = String(text || '')
      .replace(/^```[\s\S]*?\n?/gm, '')
      .replace(/^```\s*\n?/gm, '')
      .replace(/^.*Worksheet ID:\s*.+$/gim, '')
      .replace(/^.*Source alignment:\s*.+$/gim, '')
      .replace(/^###\s*Formula Bank[\s\S]*?(?=^##\s|^###\s|^Q\d+\.|\Z)/gim, '')
      .replace(/^###\s*Diagram Opportunities[\s\S]*?(?=^##\s|^###\s|^Q\d+\.|\Z)/gim, '')
      .replace(/^Formula Bank[\s\S]*?(?=^##\s|^###\s|^Q\d+\.|\Z)/gim, '')
      .replace(/^Diagram Opportunities[\s\S]*?(?=^##\s|^###\s|^Q\d+\.|\Z)/gim, '')
      .replace(/\r\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    if (!cleaned) {
      return this.buildFallbackDocument(chapterName, audit);
    }

    return this.normalizeWorksheetFormatting(cleaned);
  }

  static ensureFrontMatter(content, audit, program, subject, chapterName) {
    const title = String(chapterName || '').trim() || audit.chapterTitle || 'Worksheet Topic';
    const normalized = String(content || '').trim();

    if (
      normalized.includes('## Premium Olympiad Practice Worksheet') ||
      normalized.includes('# Premium Olympiad Practice Worksheet')
    ) {
      return normalized;
    }

    return `<div align="center">

# Premium Olympiad Practice Worksheet

</div>

Chapter / Topic Title: ${title}
Program: ${program}
Subject: ${subject}
Theme line: Academic + Premium Coaching Institute Style
Source-fidelity statement: This worksheet is meticulously crafted using only the concepts, definitions, formulas, and examples explicitly provided in the source material, ensuring strict adherence to the allowed scope.

### Concepts Explicitly Present
${this.renderAuditList(audit.allowedConcepts)}

### Concepts Not Present And Therefore Not Allowed
${this.renderAuditList(audit.bannedConcepts)}`;
  }

  static ensureQuestionSections(content, audit) {
    const normalized = String(content || '').trim();
    if (normalized.includes('## Section 1: MCQ - Single Correct Answer Type') && this.countUniqueQuestions(normalized) >= TOTAL_QUESTION_COUNT) {
      return normalized;
    }

    return this.buildFallbackQuestions(audit);
  }

  static ensureSolutionSection(content) {
    const normalized = String(content || '').trim();
    if (normalized.includes('## Section 7: Key & Solutions') && this.countSolutionBlocks(normalized) >= TOTAL_QUESTION_COUNT) {
      return normalized;
    }

    return this.buildFallbackSolutions();
  }

  static ensureQuestionSection(content, config) {
    const normalized = String(content || '').trim();
    const [start, end] = config.range;

    if (!normalized.includes(config.heading)) {
      throw new Error(`Model did not return the required heading for ${config.heading}.`);
    }

    const placeholders = /placeholder question|option a|option b|option c|option d/i;
    if (placeholders.test(normalized)) {
      throw new Error(`Model returned placeholder content for ${config.heading}.`);
    }

    const questionNumbers = this.extractQuestionNumbers(normalized);

    for (let index = start; index <= end; index += 1) {
      if (!questionNumbers.has(index)) {
        throw new Error(`Model did not return Q${index} for ${config.heading}.`);
      }
    }

    return normalized;
  }

  static ensureQuestionSlot(content, config, slot) {
    return String(content || '').trim();
  }

  static auditSectionBlueprint(content, config) {
    return String(content || '').trim();
  }

  static ensureSolutionBatch(content, start, end) {
    const normalized = String(content || '').trim();
    const placeholders = /placeholder|dummy text|final answer:\s*placeholder/i;
    if (placeholders.test(normalized)) {
      throw new Error(`Model returned placeholder solutions for Q${start}-Q${end}.`);
    }

    for (let index = start; index <= end; index += 1) {
      if (!normalized.includes(`### Solution for Q${index}`)) {
        throw new Error(`Model did not return solution block for Q${index}.`);
      }
      if (!normalized.includes(`### Solution for Q${index}`) || !normalized.match(new RegExp(`### Solution for Q${index}[\\s\\S]*?Step 1\\.`, 'm'))) {
        throw new Error(`Model returned incomplete stepwise solution for Q${index}.`);
      }
      if (!normalized.match(new RegExp(`### Solution for Q${index}[\\s\\S]*?Final Answer:`, 'm'))) {
        throw new Error(`Model did not return final answer line for Q${index}.`);
      }
    }

    return normalized;
  }

  static buildClassificationSection(questionsText) {
    const parsed = QuestionParser.parse(this.normalizeWorksheetFormatting(questionsText));
    const classworkNumbers = [];
    const homeworkNumbers = [];

    for (const item of parsed) {
      const prompt = String(item.prompt || '');
      const number = Number(item.number);
      const bloomMatch = prompt.match(/\((Remember|Understand|Apply|Analyse|Evaluate|JEE Advanced|International Olympiad)\)/i);
      const bloom = bloomMatch ? bloomMatch[1].toLowerCase() : '';
      const isAdvanced = number >= 31;
      const isDiscussionHeavy =
        number >= 11 ||
        ['analyse', 'evaluate'].includes(bloom) ||
        /assertion|reason|match|passage|comprehension/i.test(prompt);

      if (isAdvanced || isDiscussionHeavy) {
        classworkNumbers.push(number);
      } else {
        homeworkNumbers.push(number);
      }
    }

    const classwork = this.formatQuestionNumbers(classworkNumbers);
    const homework = this.formatQuestionNumbers(homeworkNumbers);

    return `## Section 8: Classwork and Homework Classification
### Classwork and Homework Classification

| Category | Recommended Purpose | Question Numbers | Rationale |
| --- | --- | --- | --- |
| Classwork | Teacher-guided discussion and higher-order reasoning | ${classwork} | Includes analyse, evaluate, multiple-correct, comprehension reasoning, assertion-reason, matching, PYQ-style analysis, and all advanced bonus questions. |
| Homework | Independent practice and reinforcement | ${homework} | Includes direct recall, understanding, and foundational application questions suitable for self-practice. |

Teacher note: Higher-order thinking, analytical, and discussion-oriented questions are recommended for Classwork. Reinforcement and independent practice questions are recommended for Homework.`;
  }

  static formatQuestionNumbers(numbers) {
    const sorted = [...new Set((numbers || []).map(Number).filter(Boolean))].sort((a, b) => a - b);
    if (sorted.length === 0) {
      return '-';
    }

    const chunks = [];
    let start = sorted[0];
    let prev = sorted[0];

    for (let index = 1; index < sorted.length; index += 1) {
      const current = sorted[index];
      if (current === prev + 1) {
        prev = current;
        continue;
      }
      chunks.push(start === prev ? `Q${start}` : `Q${start}-Q${prev}`);
      start = current;
      prev = current;
    }

    chunks.push(start === prev ? `Q${start}` : `Q${start}-Q${prev}`);
    return chunks.join(', ');
  }

  static buildFallbackQuestions(audit) {
    const concepts = audit.allowedConcepts.length ? audit.allowedConcepts.join(', ') : 'source concepts only';

    const blocks = QUESTION_SECTION_CONFIGS.map((section) => {
      const lines = [section.heading];
      if (section.sectionType === 'comprehension') {
        lines.push('Read the following passage and answer the questions below.');
        lines.push('Passage: Build a passage only from the uploaded source.');
        lines.push('');
      }

      for (const slot of section.slots || []) {
        for (const q of this.rangeToArray(slot.range[0], slot.range[1])) {
          const label = slot.bloom;
          if (section.sectionType === 'matching') {
            lines.push(`Q${q}. (${label}) Match the following source-rooted terms using only the uploaded content.`);
            lines.push('List I');
            lines.push('A. Item A');
            lines.push('B. Item B');
            lines.push('C. Item C');
            lines.push('D. Item D');
            lines.push('List II');
            lines.push('1. Match 1');
            lines.push('2. Match 2');
            lines.push('3. Match 3');
            lines.push('4. Match 4');
          } else if (section.sectionType === 'assertion') {
            lines.push(`Q${q}. (${label}) Assertion: Source-rooted placeholder assertion.`);
            lines.push('Reason: Source-rooted placeholder reason.');
            lines.push('A. Both Assertion and Reason are true and Reason is the correct explanation of Assertion.');
            lines.push('B. Both Assertion and Reason are true but Reason is not the correct explanation of Assertion.');
            lines.push('C. Assertion is true but Reason is false.');
            lines.push('D. Assertion is false but Reason is true.');
          } else {
            const prefix = section.sectionType === 'multiple' ? 'More than one option may be correct. ' : '';
            lines.push(`Q${q}. (${label}) ${prefix}Placeholder question rooted in ${concepts}.`);
            lines.push('A. Option A');
            lines.push('B. Option B');
            lines.push('C. Option C');
            lines.push('D. Option D');
          }
          lines.push('');
        }
      }

      return lines.join('\n').trim();
    });

    return blocks.join('\n\n');
  }

  static extractQuestionRange(questions, start, end) {
    const lines = String(questions || '').split('\n');
    const selected = [];
    let keep = false;

    for (const line of lines) {
      const match = line.match(/^Q(\d+)\./);
      if (match) {
        const number = Number(match[1]);
        keep = number >= start && number <= end;
      }
      if (keep) {
        selected.push(line);
      }
    }

    return selected.join('\n').trim();
  }

  static buildFallbackSolutions() {
    const lines = ['## Section 7: Key & Solutions'];

    for (let q = 1; q <= TOTAL_QUESTION_COUNT; q += 1) {
      lines.push(`### Solution for Q${q}`);
      lines.push('Step 1. Revisit the relevant line from the uploaded source.');
      lines.push('Step 2. Apply only the source-bounded concept needed for this question.');
      lines.push('Final Answer: Placeholder answer');
      lines.push('');
    }

    return lines.join('\n').trim();
  }

  static buildFallbackDocument(chapterName, audit) {
    const questions = this.buildFallbackQuestions(audit);
    return [
      this.ensureFrontMatter('', audit, 'maestro', audit.subject || 'Subject', chapterName),
      questions,
      this.buildFallbackSolutions(),
      this.buildClassificationSection(questions)
    ].join('\n\n');
  }

  static countUniqueQuestions(content) {
    return this.extractQuestionNumbers(content).size;
  }

  static countSolutionBlocks(content) {
    return (String(content || '').match(/### Solution for Q\d+/g) || []).length;
  }

  static validateOutput(content) {
    if (!String(content || '').trim()) {
      throw new Error('The generated worksheet is empty.');
    }

    const requiredSections = [
      '# Premium Olympiad Practice Worksheet',
      '## Section 1: MCQ - Single Correct Answer Type',
      '## Section 2: MCQ - Multiple Correct Answer Type',
      '## Section 3: Comprehension',
      '## Section 4: Assertion & Reason',
      '## Section 5: Matching Type',
      '## Section 6: Source-Aligned PYQ Style',
      '## Section 7: Key & Solutions',
      '## Bonus Section: 10 Advanced Questions - JEE Advanced & International Olympiad Level',
      '## Section 8: Classwork and Homework Classification'
    ];

    for (const marker of requiredSections) {
      if (!content.includes(marker)) {
        throw new Error(`Generated worksheet is missing section marker: ${marker}`);
      }
    }

    const questionNumbers = this.extractQuestionNumbers(content);

    for (let index = 1; index <= TOTAL_QUESTION_COUNT; index += 1) {
      if (!questionNumbers.has(index)) {
        throw new Error(`Generated worksheet is missing question Q${index}.`);
      }
    }

    const solutionCount = this.countSolutionBlocks(content);
    if (solutionCount < TOTAL_QUESTION_COUNT) {
      throw new Error(`Generated worksheet has only ${solutionCount} solution blocks; expected ${TOTAL_QUESTION_COUNT}.`);
    }
  }

  static resolveWorksheetTitle(program, subject, chapterName) {
    const safeChapter = String(chapterName || '').trim();
    if (safeChapter) {
      return safeChapter;
    }

    return [program, subject].filter(Boolean).join(' - ') || 'Worksheet';
  }

  static extractQuestionNumbers(text) {
    const source = String(text || '');
    const matches = [...source.matchAll(/(^|\n)\s*(?:Q\s*)?(\d+)[\.\)]\s+/gim)];
    return new Set(matches.map((match) => Number(match[2])).filter(Boolean));
  }

  static rangeToArray(start, end) {
    const numbers = [];
    for (let index = Number(start); index <= Number(end); index += 1) {
      numbers.push(index);
    }
    return numbers;
  }

  static buildBloomByQuestionMap(config) {
    const bloomMap = new Map();
    for (const slot of config.slots || []) {
      for (const questionNumber of this.rangeToArray(slot.range[0], slot.range[1])) {
        bloomMap.set(questionNumber, slot.bloom);
      }
    }
    return bloomMap;
  }

  static extractBloomFromPrompt(prompt) {
    const match = String(prompt || '').match(/\((Remember|Understand|Apply|Analyse|Evaluate|JEE Advanced|International Olympiad)\)|\[(Remember|Understand|Apply|Analyse|Evaluate|JEE Advanced|International Olympiad)\]/i);
    return match ? (match[1] || match[2]) : '';
  }

  static normalizeWorksheetFormatting(text) {
    return String(text || '')
      .replace(/\r\n/g, '\n')
      .replace(/([^\n])\s+(Q\d+[\.\)])\s+/g, '$1\n$2 ')
      .replace(/\n?Q(\d+)\)\s+/g, '\nQ$1. ')
      .replace(/([^\n])\s+(Assertion(?:\s*\(A\))?:)/g, '$1\n$2')
      .replace(/([^\n])\s+(Reason(?:\s*\(R\))?:)/g, '$1\n$2')
      .replace(/([^\n])\s+(List I:?)/g, '$1\n$2')
      .replace(/([^\n])\s+(List II:?)/g, '$1\n$2')
      .replace(/\s+\(?([A-Da-d])\)?[\)\.](?=\s)/g, '\n$1. ')
      .replace(/\n\(?([A-Da-d])\)?[\)\.]\s*/g, (_, letter) => `\n${letter.toUpperCase()}. `)
      .replace(/([^\n])\s+(Solution:)/g, '$1\n$2')
      .replace(/([^\n])\s+(Final Answer:)/g, '$1\n$2')
      .replace(/([^\n])\s+(Step \d+\.)/g, '$1\n$2')
      .replace(/([^\n])\n(Q\d+\.)/g, '$1\n\n$2')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }
}

module.exports = LatexGenerator;
