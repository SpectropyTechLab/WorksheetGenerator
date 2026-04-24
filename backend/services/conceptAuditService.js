class ConceptAuditService {
  static NOISE_WORDS = new Set([
    'media', 'png', 'width', 'height', 'frac', 'left', 'right', 'overrightarrow', 'sum',
    'worksheet', 'program', 'subject', 'chapter', 'title', 'page', 'option', 'answer',
    'solution', 'heading', 'bookmark', 'theme', 'audit', 'definition', 'formula', 'example',
    'placeholder', 'rooted', 'assertion', 'reason', 'step', 'match', 'are', 'correct',
    'true', 'item', 'olympiad', 'analyse', 'section', 'apply', 'than', 'source-rooted',
    'times', 'model', 'obj', 'called', 'power', 'mathbf', 'main', 'adv', 'cuq',
    'table', 'symbol', 'name', 'line', 'data', 'ram', 'can', 'text', 'introduction',
    'according', 'note', 'example', 'examples'
  ]);

  static audit(rawText, subject, chapterName) {
    const normalized = this.normalize(rawText);
    const cleanedText = this.strongCleanup(normalized);
    const structuredText = this.buildStructuredSource(cleanedText);
    const lines = this.segment(structuredText)
      .map((line) => line.trim())
      .filter(Boolean);

    const conceptHeadings = this.collectConceptHeadings(lines);
    const formulas = this.collectFormulas(lines);
    const definitions = this.collectDefinitions(lines);
    const examples = this.collectExamples(lines);
    const topicKeywords = this.collectKeywords(lines, chapterName, subject);
    const structuredPoints = this.collectStructuredPoints(lines);

    const allowedConcepts = this.unique([
      ...conceptHeadings.slice(0, 18),
      ...topicKeywords.slice(0, 12),
      ...definitions.slice(0, 8).map((item) => item.label),
      ...structuredPoints.slice(0, 10).map((item) => item.label)
    ]).filter((item) => this.isUsefulConcept(item));

    const sourceRepresentation = this.buildSourceRepresentation({
      chapterName,
      subject,
      conceptHeadings,
      definitions,
      examples,
      formulas,
      structuredPoints
    });

    return {
      chapterTitle: String(chapterName || '').trim() || this.inferTitle(lines),
      subject: String(subject || '').trim(),
      rawText: normalized,
      cleanedText,
      structuredText,
      sourceRepresentation,
      allowedConcepts,
      bannedConcepts: this.buildBannedConceptHints(allowedConcepts, subject),
      formulas,
      definitions,
      examples,
      diagramIdeas: [],
      structuredPoints,
      questionThemes: this.unique([
        ...conceptHeadings.slice(0, 8),
        ...topicKeywords.slice(0, 8),
        ...structuredPoints.slice(0, 6).map((item) => item.label)
      ]),
      sourceExcerpt: structuredText.slice(0, 18000)
    };
  }

  static normalize(text) {
    return String(text || '')
      .replace(/\r\n/g, '\n')
      .replace(/\t/g, ' ')
      .replace(/[â€œâ€]/g, '"')
      .replace(/[â€™â€˜]/g, "'")
      .replace(/\u00a0/g, ' ')
      .replace(/\\overrightarrow/gi, ' ')
      .replace(/\\frac/gi, ' ')
      .replace(/\{[^}\n]*=\s*["“][^"\n]+["”][^}\n]*\}/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  static strongCleanup(text) {
    const rawLines = String(text || '').split('\n');
    const cleanedLines = [];

    for (const rawLine of rawLines) {
      let line = String(rawLine || '')
        .replace(/^#+\s*/, '')
        .replace(/^>+\s*/, '')
        .replace(/^\s*[-=*]{6,}\s*$/g, '')
        .replace(/^\s*[#=_~]{6,}\s*$/g, '')
        .replace(/^\s*[—–-]{6,}\s*$/g, '')
        .replace(/^\s*\+[-+=:| ]+\+\s*$/g, '')
        .replace(/^\s*\|?[\s:+=-]{8,}\|?\s*$/g, '')
        .trim();

      if (!line) continue;

      if (this.isAsciiTableRow(line)) {
        const converted = this.convertAsciiTableRow(line);
        if (converted) {
          cleanedLines.push(converted);
        }
        continue;
      }

      line = line
        .replace(/#+/g, ' ')
        .replace(/[|]{2,}/g, ' | ')
        .replace(/[+]{2,}/g, ' ')
        .replace(/[—–]{3,}/g, ' ')
        .replace(/\s*\|\s*/g, ' - ')
        .replace(/\s{2,}/g, ' ')
        .replace(/^[-•:]+\s*/, '')
        .trim();

      if (this.isNoiseLine(line)) continue;
      cleanedLines.push(line);
    }

    return this.uniqueAdjacent(cleanedLines).join('\n').trim();
  }

  static buildStructuredSource(text) {
    return String(text || '')
      .replace(/(Definition:)/gi, '\n$1')
      .replace(/(Examples?:)/gi, '\n$1')
      .replace(/(Exception:)/gi, '\n$1')
      .replace(/(Note:)/gi, '\n$1')
      .replace(/(Characteristics of [^.:\n]+:)/gi, '\n$1')
      .replace(/(Modern Symbolic Method[^.:\n]*:?)/gi, '\n$1')
      .replace(/(Symbols of [^.:\n]+:)/gi, '\n$1')
      .replace(/(List of [^.:\n]+:)/gi, '\n$1')
      .replace(/(Some elements are named after [^.:\n]+:?)/gi, '\n$1')
      .replace(/(Metals:)/gi, '\n$1')
      .replace(/([ivx]+\))\s+/gi, '\n$1 ')
      .replace(/(\d+\))\s+/g, '\n$1 ')
      .replace(/\.\s+(?=[A-Z][a-z])/g, '.\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  static segment(text) {
    return String(text || '')
      .replace(/(Learning\s+Goal)/gi, '\n$1')
      .replace(/(Working with [^.:\n]+:)/gi, '\n$1')
      .replace(/(Step\s*-?\s*\d+\s*:)/gi, '\n$1')
      .replace(/(CONCEPT CONNECTOR\s*-\s*\d+)/gi, '\n$1')
      .replace(/(SOLUTIONS?)/gi, '\n$1')
      .replace(/(Application of)/gi, '\n$1')
      .split('\n');
  }

  static inferTitle(lines) {
    return lines.find((line) => line.length > 8 && line.length < 90) || 'Worksheet Topic';
  }

  static collectConceptHeadings(lines) {
    return this.unique(
      lines
        .filter((line) =>
          /^[A-Za-z][A-Za-z0-9'(),\-\/\s]{3,120}:?$/.test(line) &&
          !/^step[-\s]?\d+/i.test(line) &&
          !/^solutions?$/i.test(line) &&
          !/^learning\s+goal$/i.test(line) &&
          !/^concept connector/i.test(line)
        )
        .map((line) => line.replace(/:$/, '').trim())
        .filter((line) => !this.NOISE_WORDS.has(line.toLowerCase()))
    );
  }

  static collectFormulas(lines) {
    return this.uniqueObjects(
      lines
        .filter((line) => /[=+\-/*^]|\$\$|\$|\bmelting point\b|\bboiling point\b|\bformulae?\b/i.test(line))
        .filter((line) => line.length >= 6 && line.length <= 240)
        .slice(0, 20)
        .map((line, index) => ({
          label: this.compactLabel(line, `Formula ${index + 1}`),
          text: this.cleanAuditText(line)
        }))
    );
  }

  static collectDefinitions(lines) {
    return this.uniqueObjects(
      lines
        .filter((line) => / is | are | means |defined as|refers to|consists of|called/i.test(line))
        .filter((line) => line.length >= 20 && line.length <= 280)
        .slice(0, 18)
        .map((line, index) => ({
          label: this.compactLabel(line, `Definition ${index + 1}`),
          text: this.cleanAuditText(line)
        }))
    );
  }

  static collectExamples(lines) {
    return this.uniqueObjects(
      lines
        .filter((line) => /example|for example|examples?:/i.test(line))
        .filter((line) => line.length >= 12 && line.length <= 280)
        .slice(0, 14)
        .map((line, index) => ({
          label: this.compactLabel(line, `Example ${index + 1}`),
          text: this.cleanAuditText(line)
        }))
    );
  }

  static collectStructuredPoints(lines) {
    return this.uniqueObjects(
      lines
        .filter((line) => line.length >= 18 && line.length <= 220)
        .filter((line) => !this.isNoiseLine(line))
        .slice(0, 40)
        .map((line, index) => ({
          label: this.compactLabel(line, `Point ${index + 1}`),
          text: this.cleanAuditText(line)
        }))
    );
  }

  static collectKeywords(lines, chapterName, subject) {
    const seed = `${chapterName || ''} ${subject || ''}`.toLowerCase();
    const words = `${seed} ${lines.slice(0, 220).join(' ')}`
      .toLowerCase()
      .match(/[a-z][a-z0-9\-]{2,}/g) || [];

    const stopWords = new Set([
      'the', 'and', 'for', 'with', 'from', 'that', 'this', 'into', 'there', 'their', 'then',
      'when', 'where', 'which', 'while', 'have', 'has', 'will', 'shall', 'would', 'about',
      'chapter', 'worksheet', 'question', 'answer', 'solution', 'option', 'subject', 'program',
      'only', 'along', 'such', 'once', 'same', 'should', 'example', 'first', 'second',
      'always', 'capital', 'small', 'introduced'
    ]);

    const counts = new Map();
    for (const word of words) {
      if (stopWords.has(word) || this.NOISE_WORDS.has(word)) continue;
      counts.set(word, (counts.get(word) || 0) + 1);
    }

    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 24)
      .map(([word]) => word);
  }

  static buildSourceRepresentation({ chapterName, subject, conceptHeadings, definitions, examples, formulas, structuredPoints }) {
    return [
      `Chapter / Topic Title: ${String(chapterName || '').trim() || 'Worksheet Topic'}`,
      `Subject: ${String(subject || '').trim() || 'Subject'}`,
      '',
      'Core headings:',
      this.renderList(conceptHeadings.slice(0, 12)),
      '',
      'Definitions and source statements:',
      this.renderObjects(definitions.slice(0, 8)),
      '',
      'Examples and illustrations:',
      this.renderObjects(examples.slice(0, 6)),
      '',
      'Key source points:',
      this.renderObjects(structuredPoints.slice(0, 16)),
      '',
      'Formula or quantitative statements:',
      this.renderObjects(formulas.slice(0, 6))
    ].join('\n').trim();
  }

  static buildBannedConceptHints(allowedConcepts, subject) {
    const lowerAllowed = allowedConcepts.map((item) => String(item).toLowerCase());
    const subjectHints = {
      physics: ['modern physics extensions', 'electromagnetism beyond source', 'calculus-based derivations not shown in source'],
      maths: ['theorems not stated in source', 'coordinate transformations not shown in source', 'advanced identities beyond source'],
      chemistry: ['named reactions not in source', 'mechanisms not in source', 'extra periodic trends beyond source'],
      biology: ['extra physiological pathways', 'molecular details not in source', 'taxonomy beyond source']
    };

    return this.unique([
      'Any formula not explicitly present or strongly inferable from the source',
      'Any application context that adds a new concept family',
      'Any exam pattern that forces out-of-scope theory',
      ...(subjectHints[String(subject || '').toLowerCase()] || []),
      ...lowerAllowed.slice(0, 6).map((item) => `Do not move beyond source coverage of "${item}"`)
    ]);
  }

  static cleanAuditText(line) {
    return String(line || '')
      .replace(/\$\$[\s\S]*?\$\$/g, ' ')
      .replace(/\$[^$]*\$/g, ' ')
      .replace(/\\[a-zA-Z]+/g, ' ')
      .replace(/[{}]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  static compactLabel(line, fallback) {
    const cleaned = this.cleanAuditText(line).slice(0, 100);
    return cleaned || fallback;
  }

  static isUsefulConcept(value) {
    const text = String(value || '').trim();
    if (!text) return false;
    if (text.length > 80) return false;
    if (this.NOISE_WORDS.has(text.toLowerCase())) return false;
    if (/^\d+[\.\)]/.test(text)) return false;
    if (/example|stock photos|shutterstock/i.test(text)) return false;
    return true;
  }

  static renderList(items) {
    const safeItems = Array.isArray(items) && items.length ? items : ['No clear source items extracted'];
    return safeItems.map((item) => `- ${item}`).join('\n');
  }

  static renderObjects(items) {
    const safeItems = Array.isArray(items) && items.length
      ? items
      : [{ label: 'Not clearly extracted', text: 'Use only the uploaded source text.' }];

    return safeItems
      .map((item) => {
        const label = String(item.label || '').trim();
        const text = String(item.text || '').trim();
        if (!text || label === text) return `- ${label || text}`;
        return `- ${label}: ${text}`;
      })
      .join('\n');
  }

  static isAsciiTableRow(line) {
    return /\|/.test(line) || /^\s*\+[-+=:| ]+\+\s*$/.test(line);
  }

  static convertAsciiTableRow(line) {
    const stripped = String(line || '')
      .replace(/^\s*[+|]\s*/, '')
      .replace(/\s*[+|]\s*$/g, '')
      .trim();

    if (!stripped) return '';
    if (/^[-=:+ ]+$/.test(stripped)) return '';

    const cells = stripped
      .split('|')
      .map((cell) => cell.replace(/[+]/g, ' ').trim())
      .filter(Boolean)
      .map((cell) => cell.replace(/\s{2,}/g, ' '));

    if (cells.length === 0) return '';
    if (cells.length === 1) return cells[0];
    return cells.join(' - ');
  }

  static isNoiseLine(line) {
    const value = String(line || '').trim();
    if (!value) return true;
    if (/^[#=+\-–—_|:;.,\s]+$/.test(value)) return true;
    if (/^(element|latin name|symbol|scientist name|country and laboratory|name of the planet)$/i.test(value)) return true;
    return false;
  }

  static uniqueAdjacent(lines) {
    const output = [];
    for (const line of lines || []) {
      if (output[output.length - 1] !== line) {
        output.push(line);
      }
    }
    return output;
  }

  static unique(values) {
    return [...new Set((values || []).filter(Boolean))];
  }

  static uniqueObjects(items) {
    const seen = new Set();
    return (items || []).filter((item) => {
      const key = JSON.stringify(item);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
}

module.exports = ConceptAuditService;
