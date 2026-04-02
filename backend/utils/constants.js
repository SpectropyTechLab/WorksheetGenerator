// Programs
const PROGRAMS = {
  MAESTRO: 'maestro',
  PIONEER: 'pioneer',
  CATALYST: 'catalyst',
  FUTURE_FOUNDATION: 'future foundation',
  SPARK: 'spark'
};

// Subjects
const SUBJECTS = {
  PHYSICS: 'physics',
  MATHS: 'maths',
  BIOLOGY: 'biology',
  CHEMISTRY: 'chemistry'
};

// Worksheet Status
const WORKSHEET_STATUS = {
  EXTRACTING: 'extracting',
  GENERATING: 'generating',
  COMPILING: 'compiling',
  READY: 'ready',
  FAILED: 'failed'
};

// Worksheet categories
const WORKSHEET_CATEGORIES = {
  DIRECT: 'direct',
  SIMILAR: 'similar',
  PYQ_STYLE: 'pyq_style',
  REFERENCE: 'reference'
};

// File Types
const FILE_TYPES = {
  DOCX: 'docx',
  PDF: 'pdf'
};

// MIME Types
const MIME_TYPES = {
  DOCX: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  PDF: 'application/pdf'
};

module.exports = {
  PROGRAMS,
  SUBJECTS,
  WORKSHEET_CATEGORIES,
  WORKSHEET_STATUS,
  FILE_TYPES,
  MIME_TYPES
};
