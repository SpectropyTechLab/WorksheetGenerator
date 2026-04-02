const express = require('express');
const router = express.Router();
const worksheetRoutes = require('./worksheetRoutes');
const authRoutes = require('./authRoutes');
const userRoutes = require('./userRoutes');

// API routes
router.use('/auth', authRoutes);
router.use('/users', userRoutes);
router.use('/worksheet', worksheetRoutes);

// Health check
router.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// API documentation
router.get('/', (req, res) => {
  res.json({
    message: 'Worksheet Generator API',
    version: '1.0.0',
    endpoints: {
      'POST /api/auth/login': 'Login with username/password',
      'GET /api/users': 'List users (admin)',
      'POST /api/users': 'Create user (admin)',
      'PUT /api/users/:id': 'Update user (admin)',
      'DELETE /api/users/:id': 'Delete user (admin)',
      'POST /api/worksheet': 'Upload worksheet and start processing',
      'GET /api/worksheet/:id/status': 'Get worksheet processing status',
      'GET /api/worksheet/:id/docx': 'Download DOCX (attachment)',
      'DELETE /api/worksheet/:id': 'Delete worksheet and files',
      'GET /api/health': 'Health check'
    }
  });
});

module.exports = router;
