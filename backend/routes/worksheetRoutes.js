const express = require('express');
const router = express.Router();
const WorksheetController = require('../controllers/worksheetController');
const FileController = require('../controllers/fileController');
const { upload, handleMulterError } = require('../middleware/upload');
const { requireAuth } = require('../middleware/auth');

// Worksheet routes
router.post('/', requireAuth, upload, handleMulterError, WorksheetController.createWorksheet);
router.get('/:id/status', requireAuth, WorksheetController.getWorksheetStatus);

// File routes
router.get('/:id/docx', requireAuth, FileController.downloadDocx);
router.delete('/:id', requireAuth, FileController.deleteWorksheet);

module.exports = router;
