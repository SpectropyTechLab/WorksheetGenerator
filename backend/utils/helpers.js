const { v4: uuidv4 } = require('uuid');

// Generate unique worksheet ID
function generateWorksheetId() {
  return uuidv4();
}

// Extract file extension
function getFileExtension(filename) {
  return filename.split('.').pop().toLowerCase();
}

// Validate file type
function isValidFileType(filename) {
  const extension = getFileExtension(filename);
  return ['docx', 'pdf'].includes(extension);
}

// Format filename for storage
function formatStoragePath(worksheetId, filename, isInput = true) {
  const extension = getFileExtension(filename);
  const fileName = isInput ? `input.${extension}` : 'manual.docx';
  return `worksheetgenerator/${worksheetId}/${fileName}`;
}

// Get content type based on file extension
function getContentType(extension) {
  const { MIME_TYPES } = require('./constants');
  
  if (extension === 'docx') return MIME_TYPES.DOCX;
  if (extension === 'pdf') return MIME_TYPES.PDF;
  return 'application/octet-stream';
}

// Sleep utility
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = {
  generateWorksheetId,
  getFileExtension,
  isValidFileType,
  formatStoragePath,
  getContentType,
  sleep
};
