class ConceptAuditService {
  static audit(rawText, subject, chapterName) {
    const normalized = this.normalize(rawText);
    const lines = normalized
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);

    const formulas = this.collectFormulas(lines);
    const definitions = this.collectDefinitions(lines);
    const examples = this.collectExamples(lines);
    const diagramIdeas = this.collectDiagramIdeas(lines, subject);
    const topicKeywords = this.collectKeywords(lines, chapterName, subject);

    const allowedConcepts = [
      ...topicKeywords.slice(0, 20),
      ...definitions.slice(0, 8).map((item) => item.label),
      ...formulas.slice(0, 8).map((item) => item.label),
      ...examples.slice(0, 6).map((item) => item.label)
    ].filter(Boolean);

    const bannedConcepts = this.buildBannedConceptHints(allowedConcepts, subject);

    return {
      chapterTitle: String(chapterName || '').trim() || this.inferTitle(lines),
      subject: String(subject || '').trim(),
      allowedConcepts: this.unique(allowedConcepts),
      bannedConcepts,
      formulas,
      definitions,
      examples,
      diagramIdeas,
      questionThemes: this.unique([
        ...topicKeywords.slice(0, 12),
        ...diagramIdeas.slice(0, 6).map((item) => item.title)
      ]),
      sourceExcerpt: normalized.slice(0, 12000)
    };
  }

  static normalize(text) {
    return String(text || '')
      .replace(/\r\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  static inferTitle(lines) {
    return lines.find((line) => line.length > 8 && line.length < 90) || 'Worksheet Topic';
  }

  static collectFormulas(lines) {
    return this.uniqueObjects(
      lines
        .filter((line) => /[=+\-/*^]|\\frac|\\sqrt|\$\$|\$/.test(line))
        .slice(0, 12)
        .map((line, index) => ({
          label: `Formula ${index + 1}`,
          text: line
        }))
    );
  }

  static collectDefinitions(lines) {
    return this.uniqueObjects(
      lines
        .filter((line) => / is | are | means |defined as|refers to/i.test(line))
        .slice(0, 10)
        .map((line, index) => ({
          label: `Definition ${index + 1}`,
          text: line
        }))
    );
  }

  static collectExamples(lines) {
    return this.uniqueObjects(
      lines
        .filter((line) => /example|illustration|consider|suppose|let/i.test(line))
        .slice(0, 10)
        .map((line, index) => ({
          label: `Example ${index + 1}`,
          text: line
        }))
    );
  }

  static collectDiagramIdeas(lines, subject) {
    const keywords = [
      'diagram',
      'figure',
      'graph',
      'table',
      'path',
      'arc',
      'chord',
      'triangle',
      'circle',
      'coordinate',
      'motion',
      'geometry',
      'vector'
    ];

    return this.uniqueObjects(
      lines
        .filter((line) => keywords.some((keyword) => line.toLowerCase().includes(keyword)))
        .slice(0, 8)
        .map((line, index) => ({
          title: `${subject || 'Subject'} diagram ${index + 1}`,
          text: line
        }))
    );
  }

  static collectKeywords(lines, chapterName, subject) {
    const seed = `${chapterName || ''} ${subject || ''}`.toLowerCase();
    const words = `${seed} ${lines.slice(0, 80).join(' ')}`
      .toLowerCase()
      .match(/[a-z][a-z0-9\-]{2,}/g) || [];

    const stopWords = new Set([
      'the', 'and', 'for', 'with', 'from', 'that', 'this', 'into', 'there', 'their', 'then',
      'when', 'where', 'which', 'while', 'have', 'has', 'will', 'shall', 'would', 'about',
      'chapter', 'worksheet', 'question', 'answer', 'solution', 'option', 'subject', 'program'
    ]);

    const counts = new Map();
    for (const word of words) {
      if (stopWords.has(word)) continue;
      counts.set(word, (counts.get(word) || 0) + 1);
    }

    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([word]) => word);
  }

  static buildBannedConceptHints(allowedConcepts, subject) {
    const lowerAllowed = allowedConcepts.map((item) => String(item).toLowerCase());
    const subjectHints = {
      physics: ['modern physics extensions', 'electromagnetism beyond source', 'calculus-based derivations not shown in source'],
      maths: ['theorems not stated in source', 'coordinate transformations not shown in source', 'advanced identities beyond source'],
      chemistry: ['named reactions not in source', 'mechanisms not in source', 'extra periodic trends beyond source'],
      biology: ['extra physiological pathways', 'molecular details not in source', 'taxonomy beyond source']
    };

    const generic = [
      'Any formula not explicitly present or strongly inferable from the source',
      'Any application context that adds a new concept family',
      'Any exam pattern that forces out-of-scope theory'
    ];

    return this.unique([
      ...generic,
      ...(subjectHints[String(subject || '').toLowerCase()] || []),
      ...lowerAllowed.slice(0, 6).map((item) => `Do not move beyond source coverage of "${item}"`)
    ]);
  }

  static unique(values) {
    return [...new Set(values.filter(Boolean))];
  }

  static uniqueObjects(items) {
    const seen = new Set();
    return items.filter((item) => {
      const key = JSON.stringify(item);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
}

module.exports = ConceptAuditService;
