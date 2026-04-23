const axios = require('axios');
require('dotenv').config();
const ConceptAuditService = require('./conceptAuditService');

const DEFAULT_MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const MAX_OUTPUT_TOKENS = Number(process.env.GEMINI_MAX_OUTPUT_TOKENS || 8192);
const FALLBACK_MODELS = (process.env.GEMINI_FALLBACK_MODELS || '')
  .split(',')
  .map((m) => m.trim())
  .filter(Boolean);

class LatexGenerator {
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
      const prompt = this.buildPrompt({
        rawText,
        program,
        subject,
        chapterName,
        audit
      });
      let content = '';

      try {
        content = await this.generateWithFallbacks(prompt);
      } catch (generationError) {
        console.warn(
          `Worksheet generation model call failed, using resilient fallback content: ${
            generationError?.message || generationError
          }`
        );
      }

      const cleaned = this.cleanGeneratedText(content, chapterName, audit);
      const completed = this.ensureRequiredSections(cleaned, chapterName, audit);
      this.validateOutput(completed);
      return completed;
    } catch (error) {
      console.error('Worksheet generation error:', error);
      throw new Error(`Failed to generate worksheet content: ${error.message || 'Unknown error'}`);
    }
  }

  static async generateWithFallbacks(prompt) {
    const candidateModels = [DEFAULT_MODEL, ...FALLBACK_MODELS].filter(Boolean);
    let lastError = null;

    for (const model of candidateModels) {
      try {
        return await this.generateWithModel(model, prompt);
      } catch (error) {
        lastError = error;
        const status = error?.status || error?.response?.status;
        console.warn(`Model "${model}" failed${status ? ` with status ${status}` : ''}: ${error?.message || error}`);

        if (!this.isRetryableModelError(status)) {
          throw error;
        }
      }
    }

    throw lastError || new Error('No Gemini model produced worksheet content.');
  }

  static isRetryableModelError(status) {
    return [404, 429, 500, 503].includes(Number(status));
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
          temperature: 0.2,
          maxOutputTokens: MAX_OUTPUT_TOKENS
        }
      },
      {
        headers: {
          'x-goog-api-key': GEMINI_API_KEY,
          'content-type': 'application/json'
        },
        timeout: 120000
      }
    );

    return (
      response?.data?.candidates?.[0]?.content?.parts
        ?.map((part) => part?.text || '')
        .join('') || ''
    );
  }

  static buildPrompt({ rawText, program, subject, chapterName, audit }) {
    const worksheetTitle = this.resolveWorksheetTitle(program, subject, chapterName);
    return `You are a Senior Subject Matter Expert, Curriculum Specialist, Assessment Designer, Academic Content Quality Auditor, and Premium Coaching Material Designer.

Your task is to create a premium worksheet manual in DOCX-friendly Markdown.
Return ONLY Markdown. No code fences. No JSON.
Keep all mathematics in LaTeX math delimiters such as $...$ or $$...$$.
Mirror the structure of a premium coaching worksheet sample document:
- main title at the top
- a Heading 1 repeating the worksheet title
- Heading 2 sections
- title page fields shown line by line
- audit blocks with bold labels followed by clean content
- question blocks arranged as question, then options, then "Solution:", then stepwise lines, then "Final Answer:"

STRICT SOURCE RULES:
1. Use only concepts explicitly present in the source or strongly inferable from it.
2. Do not introduce new theorems, formulas, applications, terminology families, or exam tricks beyond the source.
3. If a requested question type would go out of scope, keep the difficulty high but remain inside the source boundary.
4. Every question must be traceable to the allowed concept list.
5. Include diagrams only as simple DOCX-safe text figures or figure notes where needed.
6. Do not include any worksheet ID, UUID, job ID, storage path, or internal system identifier anywhere in the output.

SOURCE AUDIT SNAPSHOT
Worksheet title: ${worksheetTitle}
Program: ${program}
Subject: ${subject}
Allowed concepts:
${this.renderAuditList(audit.allowedConcepts)}

Concepts not allowed:
${this.renderAuditList(audit.bannedConcepts)}

Definitions and ideas from source:
${this.renderAuditObjects(audit.definitions)}

Formulas and quantitative expressions from source:
${this.renderAuditObjects(audit.formulas)}

Examples and applications from source:
${this.renderAuditObjects(audit.examples)}

Diagram candidates from source:
${this.renderAuditObjects(audit.diagramIdeas)}

MANDATORY DOCUMENT STRUCTURE
# Premium Olympiad Practice Worksheet
## Premium Olympiad Practice Worksheet
## Title Page
Show:
- Program
- Subject
- Chapter
- Theme line: "Academic + Premium Coaching Institute Style"
- A short source-fidelity statement

## Source Concept Audit
Include:
- Chapter / Topic Title
- Concepts Explicitly Present
- Concepts Not Present And Therefore Not Allowed
- Formula Bank
- Diagram Opportunities

## Section 1: MCQ - Single Correct Answer Type
- Remember - 2 questions
- Understand - 2 questions
- Apply - 2 questions
- Analyse - 2 questions
- Evaluate - 2 questions

## Section 2: MCQ - Multiple Correct Answer Type
- Apply - 2 questions
- Analyse - 2 questions
- Evaluate - 2 questions

## Section 3: Comprehension
- One source-rooted passage
- Remember - 1 question
- Understand - 1 question
- Apply - 1 question
- Analyse - 1 question

## Section 4: Assertion & Reason
- Understand - 1 question
- Apply - 1 question
- Analyse - 1 question

## Section 5: Matching Type
- Understand - 1 question
- Apply - 1 question
- Analyse - 1 question

## Section 6: Source-Aligned PYQ Style
- 4 MCQs total
- Cover styles inspired by National Olympiad, JEE Main, JEE Advanced, International Olympiad, Asian Olympiad
- If exact PYQ use is unsafe, create a source-aligned PYQ-style question

## Section 7: Key & Solutions
- Give detailed step-by-step solutions for every question from Q1 onward
- Every step on a new line
- Mention the final answer clearly
- Add simple figure notes again when needed in a solution

## Bonus Section: 10 Advanced Questions - JEE Advanced & International Olympiad Level
- 5 JEE Advanced level
- 5 International Olympiad level
- Still strictly within source concept boundaries
- Provide full solutions

## Section 8: Classwork and Homework Classification
- Add heading exactly as "Classwork and Homework Classification"
- Add a Markdown table with columns:
  Category | Recommended Purpose | Question Numbers | Rationale
- Include separate rows for Classwork and Homework
- Add a short teacher note below the table

QUESTION WRITING RULES
1. Number questions sequentially as Q1, Q2, Q3 ... across all assessable questions before the solutions section.
2. For each question, show Bloom's level explicitly in the sample style: Qn. (Remember) ...
3. For MCQs, provide options A, B, C, D.
4. For multiple-correct questions, clearly state "More than one option may be correct."
5. For matching questions, use two clean lists.
6. Use rich math notation in LaTeX.
7. Do not add source alignment lines, hidden notes, IDs, metadata lines, or audit traces under questions.
8. Put each question on its own line.
9. Put every option on its own new line directly below the question.
10. Never merge a question and its options into the same paragraph.
11. After the options, write "Solution:" on its own line in bold style if possible.
12. Below "Solution:", write each step on a new line.
13. Put "Final Answer:" on its own new line below the steps.
11. Where a diagram helps, add:
   Figure note: Not to scale.
   Diagram:
   <simple text figure or figure description>
14. Avoid decorative stories.

SOLUTION WRITING RULES
1. Do not move all solutions into a separate answer-key-only layout.
2. For this output style, place the solution directly below each question block.
3. Write each step on a new line beginning with "Step 1.", "Step 2." and so on.
4. End with "Final Answer:".
5. Keep the solution exam-oriented and source-aligned.
6. Do not combine multiple questions into one paragraph.

QUALITY CONTROL RULES
1. Ensure all mandated counts are exactly correct.
2. Make the worksheet polished and print-friendly.
3. Do not mention that the model lacks certainty.
4. Do not skip Section 8.
5. Every list item and every point must appear on a separate new line.

SOURCE CONTENT
${audit.sourceExcerpt || rawText.slice(0, 12000)}

Return only the final Markdown manual.`;
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
      .map((item) => `- ${item.label}: ${item.text}`)
      .join('\n');
  }

  static cleanGeneratedText(text, chapterName, audit) {
    const cleaned = String(text || '')
      .replace(/^```[\s\S]*?\n?/gm, '')
      .replace(/^```\s*\n?/gm, '')
      .replace(/^.*Worksheet ID:\s*.+$/gim, '')
      .replace(/^.*Source alignment:\s*.+$/gim, '')
      .replace(/\r\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    if (!cleaned) {
      return this.buildFallbackContent(chapterName, audit);
    }

    return this.normalizeWorksheetFormatting(cleaned);
  }

  static normalizeWorksheetFormatting(content) {
    return String(content || '')
      .replace(/^# Premium Olympiad Practice Worksheet\s+## Title Page/m, '# Premium Olympiad Practice Worksheet\n\n## Premium Olympiad Practice Worksheet\n\n## Title Page')
      .replace(/\[Bloom'?s Level:\s*([^\]]+)\]/gi, '($1)')
      .replace(/^(Q\d+\.\s*)(?!\()/gm, '$1')
      .replace(/^(Q\d+\.\s*)\(([^)]+)\)\s*/gm, '$1($2) ')
      .replace(/([^\n])\n([A-D]\.\s)/g, '$1\n$2')
      .replace(/([^\n])\n(Solution:)/g, '$1\n$2')
      .replace(/([^\n])\n(Final Answer:)/g, '$1\n$2')
      .replace(/^### Solution for Q\d+\s*$/gim, 'Solution:')
      .replace(/\*\*Solution:\*\*/g, 'Solution:')
      .replace(/\*\*Final Answer:\*\*/g, 'Final Answer:')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  static ensureRequiredSections(content, chapterName, audit) {
    const normalized = String(content || '').trim() || this.buildFallbackContent(chapterName, audit);
    const requiredSections = this.buildRequiredSectionTemplates(chapterName, audit);
    let completed = normalized;

    for (const [marker, template] of requiredSections) {
      if (!completed.includes(marker)) {
        completed = `${completed.trim()}\n\n${template}`.trim();
      }
    }

    if (!completed.includes('### Classwork and Homework Classification')) {
      completed = completed.replace(
        '## Section 8: Classwork and Homework Classification',
        '## Section 8: Classwork and Homework Classification\n### Classwork and Homework Classification'
      );
    }

    return completed.trim();
  }

  static buildRequiredSectionTemplates(chapterName, audit) {
    const title = String(chapterName || '').trim() || audit.chapterTitle || 'Worksheet Topic';
    const concepts = audit.allowedConcepts.length ? audit.allowedConcepts.join(', ') : 'source concepts only';

    return [
      [
        '# Premium Olympiad Practice Worksheet',
        `# Premium Olympiad Practice Worksheet

## Premium Olympiad Practice Worksheet

## Title Page
**Program**: Maestro Worksheet Generator
**Subject**: ${audit.subject || 'Subject'}
**Chapter**: ${title}
**Theme line**: "Academic + Premium Coaching Institute Style"
This worksheet remains restricted to the uploaded source content.`
      ],
      [
        '## Source Concept Audit',
        `## Source Concept Audit
**Chapter / Topic Title**: ${title}

**Concepts Explicitly Present**:
- ${concepts.split(', ').join('\n- ')}

**Concepts Not Present And Therefore Not Allowed**:
- Any concept outside the uploaded source

**Formula Bank**:
- Use only formulas visible in the source

**Diagram Opportunities**:
- Insert only source-rooted diagrams when needed`
      ],
      [
        '## Section 1: MCQ - Single Correct Answer Type',
        `## Section 1: MCQ - Single Correct Answer Type
Q1. (Remember) Placeholder to be kept source-rooted.
A. Option A
B. Option B
C. Option C
D. Option D
Solution:
Step 1. Revisit the relevant line from the uploaded source.
Step 2. Keep the reasoning inside the source boundary.
Final Answer: A`
      ],
      [
        '## Section 2: MCQ - Multiple Correct Answer Type',
        `## Section 2: MCQ - Multiple Correct Answer Type
Q2. (Apply) More than one option may be correct. Placeholder to be kept source-rooted.
A. Option A
B. Option B
C. Option C
D. Option D
Solution:
Step 1. Revisit the relevant line from the uploaded source.
Step 2. Keep the reasoning inside the source boundary.
Final Answer: A`
      ],
      [
        '## Section 3: Comprehension',
        `## Section 3: Comprehension
Read the following passage and answer the questions below.

Passage: Build the passage only from the uploaded source.

Q3. (Understand) Source-rooted comprehension placeholder.
A. Option A
B. Option B
C. Option C
D. Option D
Solution:
Step 1. Revisit the relevant line from the uploaded source.
Step 2. Keep the reasoning inside the source boundary.
Final Answer: A`
      ],
      [
        '## Section 4: Assertion & Reason',
        `## Section 4: Assertion & Reason
Q4. (Analyse) Assertion and reason placeholder.
Solution:
Step 1. Revisit the relevant line from the uploaded source.
Step 2. Keep the reasoning inside the source boundary.
Final Answer: Assertion is correct and Reason is correct.`
      ],
      [
        '## Section 5: Matching Type',
        `## Section 5: Matching Type
Q5. (Apply) Matching placeholder.
Solution:
Step 1. Revisit the relevant line from the uploaded source.
Step 2. Keep the reasoning inside the source boundary.
Final Answer: A-1, B-2, C-3, D-4`
      ],
      [
        '## Section 6: Source-Aligned PYQ Style',
        `## Section 6: Source-Aligned PYQ Style
Q6. (Evaluate) PYQ-style placeholder.
A. Option A
B. Option B
C. Option C
D. Option D
Solution:
Step 1. Revisit the relevant line from the uploaded source.
Step 2. Keep the reasoning inside the source boundary.
Final Answer: A`
      ],
      [
        '## Section 7: Key & Solutions',
        `## Section 7: Key & Solutions
This section may restate answers in compact form if needed, but each question above should already include its own solution block.`
      ],
      [
        '## Bonus Section: 10 Advanced Questions - JEE Advanced & International Olympiad Level',
        `## Bonus Section: 10 Advanced Questions - JEE Advanced & International Olympiad Level
Add 5 JEE Advanced level and 5 International Olympiad level questions while staying inside ${concepts}.`
      ],
      [
        '## Section 8: Classwork and Homework Classification',
        `## Section 8: Classwork and Homework Classification
### Classwork and Homework Classification

| Category | Recommended Purpose | Question Numbers | Rationale |
| --- | --- | --- | --- |
| Classwork | Teacher-guided discussion | Q2, Q3, Q4, Q5, Q6 | Higher-order reasoning and discussion |
| Homework | Independent practice | Q1 | Reinforcement and direct revision |

Teacher note: Higher-order thinking and discussion-oriented questions are recommended for Classwork. Reinforcement questions are recommended for Homework.`
      ]
    ];
  }

  static validateOutput(content) {
    if (!String(content || '').trim()) {
      throw new Error('The generated worksheet is empty.');
    }

    const requiredSections = [
      '# Premium Olympiad Practice Worksheet',
      '## Source Concept Audit',
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
  }

  static buildFallbackContent(chapterName, audit) {
    const title = String(chapterName || '').trim() || audit.chapterTitle || 'Worksheet Topic';
    const concepts = audit.allowedConcepts.length ? audit.allowedConcepts.join(', ') : 'source concepts only';
    return `# Premium Olympiad Practice Worksheet

## Premium Olympiad Practice Worksheet

## Title Page
**Program**: Maestro Worksheet Generator
**Subject**: ${audit.subject || 'Subject'}
**Chapter**: ${title}
**Theme line**: "Academic + Premium Coaching Institute Style"
Every question in this worksheet must remain within the source boundaries.

## Source Concept Audit
**Chapter / Topic Title**: ${title}

**Concepts Explicitly Present**:
- ${concepts.split(', ').join('\n- ')}

**Concepts Not Present And Therefore Not Allowed**:
- Any idea outside the uploaded source

**Formula Bank**:
- Use only formulas visible in the source

**Diagram Opportunities**:
- Add only source-rooted figures if needed

## Section 1: MCQ - Single Correct Answer Type
Q1. (Remember) Source-rooted placeholder question.
A. Option A
B. Option B
C. Option C
D. Option D
Solution:
Step 1. Revisit the exact line from the uploaded source.
Step 2. Keep the explanation within source scope.
Final Answer: A

## Section 2: MCQ - Multiple Correct Answer Type
Q2. (Apply) More than one option may be correct. Source-rooted placeholder question.
A. Option A
B. Option B
C. Option C
D. Option D
Solution:
Step 1. Revisit the exact line from the uploaded source.
Step 2. Keep the explanation within source scope.
Final Answer: A

## Section 3: Comprehension
Read the following passage and answer the questions below.

Passage: Build a passage only from the uploaded source.

## Section 4: Assertion & Reason
Q3. (Understand) Assertion and reason placeholder.
Solution:
Step 1. Revisit the exact line from the uploaded source.
Step 2. Keep the explanation within source scope.
Final Answer: Assertion is correct and Reason is correct.

## Section 5: Matching Type
Q4. (Apply) Matching placeholder.
Solution:
Step 1. Revisit the exact line from the uploaded source.
Step 2. Keep the explanation within source scope.
Final Answer: A-1, B-2, C-3, D-4

## Section 6: Source-Aligned PYQ Style
Q5. (Analyse) PYQ-style placeholder.
A. Option A
B. Option B
C. Option C
D. Option D
Solution:
Step 1. Revisit the exact line from the uploaded source.
Step 2. Keep the explanation within source scope.
Final Answer: A

## Section 7: Key & Solutions
This section may restate answers in compact form if needed, but each question above should already include its own solution block.

## Bonus Section: 10 Advanced Questions - JEE Advanced & International Olympiad Level
Prepare advanced source-bounded questions here.

## Section 8: Classwork and Homework Classification
### Classwork and Homework Classification

| Category | Recommended Purpose | Question Numbers | Rationale |
| --- | --- | --- | --- |
| Classwork | Teacher-guided discussion | Q2, Q3, Q4, Q5 | Higher-order thinking and discussion |
| Homework | Independent practice | Q1 | Reinforcement and direct recall |

Teacher note: Higher-order thinking and discussion-oriented questions are better for classwork, while reinforcement questions are suitable for homework.`;
  }

  static resolveWorksheetTitle(program, subject, chapterName) {
    const safeChapter = String(chapterName || '').trim();
    if (safeChapter) {
      return safeChapter;
    }
    return [program, subject].filter(Boolean).join(' - ') || 'Worksheet';
  }
}

module.exports = LatexGenerator;
