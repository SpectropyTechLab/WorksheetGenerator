class QuestionParser {
  static parse(text) {
    const source = String(text || '').replace(/\r\n/g, '\n').trim();
    if (!source) {
      return [];
    }

    const normalized = this.normalizeQuestionText(source)
      .replace(/\n{3,}/g, '\n\n')
      .replace(/[ \t]+\n/g, '\n');

    const matches = [];
    const regex = /(^|\n)\s*(?:Q\s*)?(\d+)[\.\)]\s+/gim;
    let match;
    while ((match = regex.exec(normalized)) !== null) {
      matches.push({ index: match.index + match[1].length, number: match[2] });
    }

    if (matches.length === 0) {
      return [];
    }

    return matches
      .map((entry, index) => {
        const start = entry.index;
        const end = index + 1 < matches.length ? matches[index + 1].index : normalized.length;
        const block = normalized.slice(start, end).trim();
        return this.parseBlock(entry.number, block);
      })
      .filter(Boolean);
  }

  static parseBlock(number, block) {
    const lines = this.normalizeQuestionText(String(block || ''))
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);

    if (lines.length === 0) {
      return null;
    }

    const optionLines = [];
    const promptLines = [];
    let seenOption = false;

    for (const line of lines) {
      if (this.isOptionLine(line)) {
        seenOption = true;
        optionLines.push(line);
        continue;
      }
      if (!seenOption) {
        promptLines.push(line);
      }
    }

    return {
      number: Number(number),
      prompt: promptLines.join(' ').trim(),
      options: optionLines.map((line) => this.normalizeOption(line)),
      source: block
    };
  }

  static isOptionLine(line) {
    return /^\(?[a-dA-D]\)?[\.\): -]+\s*/.test(line) || /^[a-dA-D][\)\.]\s*/.test(line);
  }

  static normalizeOption(line) {
    return String(line || '')
      .replace(/^\(?([a-dA-D])\)?[\.\): -]+\s*/, '($1) ')
      .trim();
  }

  static normalizeQuestionText(text) {
    return String(text || '')
      .replace(/\r\n/g, '\n')
      .replace(/([^\n])\s+(Q\d+[\.\)])\s+/g, '$1\n$2 ')
      .replace(/([^\n])\s+((?:Assertion|Reason|List I|List II):?)/gi, '$1\n$2')
      .replace(/\s+\(?([A-Da-d])\)?[\)\.]\s+/g, '\n$1. ')
      .replace(/\n\(?([A-Da-d])\)?[\)\.]\s*/g, (_, letter) => `\n${letter.toUpperCase()}. `)
      .replace(/\n{3,}/g, '\n\n');
  }
}

module.exports = QuestionParser;
