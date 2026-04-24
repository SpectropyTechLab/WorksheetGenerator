const supabase = require('../config/database');
const StorageService = require('../services/storageService');
const FileExtractor = require('../services/fileExtractor');
const LatexGenerator = require('../services/latexGenerator');
const DocxCompiler = require('../services/docxCompiler');
const { generateWorksheetId, getFileExtension } = require('../utils/helpers');
const { WORKSHEET_STATUS } = require('../utils/constants');

const WORKSHEETS_TABLE = process.env.WORKSHEETS_TABLE || 'worksheetgenerator';

class WorksheetController {
  static async createWorksheet(req, res) {
    try {
      const missingEnv = [];
      if (!process.env.SUPABASE_URL) missingEnv.push('SUPABASE_URL');
      if (!process.env.SUPABASE_SERVICE_KEY) missingEnv.push('SUPABASE_SERVICE_KEY');
      if (!process.env.INPUT_BUCKET) missingEnv.push('INPUT_BUCKET');
      if (!process.env.OUTPUT_BUCKET) missingEnv.push('OUTPUT_BUCKET');
      if (!process.env.GEMINI_API_KEY) missingEnv.push('GEMINI_API_KEY');

      if (missingEnv.length > 0) {
        return res.status(500).json({
          error: 'Server is not configured. Missing environment variables.',
          missing: missingEnv
        });
      }

      const { program, subject, chapterName } = req.body;
      const file = req.file;

      if (!file) {
        return res.status(400).json({ error: 'No file uploaded' });
      }

      if (!program || !subject) {
        return res.status(400).json({ error: 'Program and subject are required' });
      }

      if (!chapterName || !String(chapterName).trim()) {
        return res.status(400).json({ error: 'Chapter name is required' });
      }

      const fileType = getFileExtension(file.originalname);
      if (!['docx', 'pdf'].includes(fileType)) {
        return res.status(400).json({ error: 'Only DOCX and PDF files are allowed' });
      }

      const normalizedProgram = String(program).trim().toLowerCase();
      const normalizedSubject = String(subject).trim().toLowerCase();
      const normalizedChapter = String(chapterName).trim();
      const worksheetId = generateWorksheetId();

      const inputResult = await StorageService.uploadInputFile(
        worksheetId,
        file.buffer,
        file.originalname
      );

      const { error } = await supabase
        .from(WORKSHEETS_TABLE)
        .insert([
          {
            id: worksheetId,
            program: normalizedProgram,
            subject: normalizedSubject,
            chapter_name: normalizedChapter,
            original_filename: file.originalname,
            file_type: fileType,
            input_storage_path: inputResult.path,
            status: WORKSHEET_STATUS.EXTRACTING
          }
        ]);

      if (error) {
        throw error;
      }

      WorksheetController.processWorksheet(
        worksheetId,
        file.buffer,
        fileType,
        normalizedProgram,
        normalizedSubject,
        normalizedChapter
      ).catch((err) => {
        console.error(`Background processing failed for ${worksheetId}:`, err);
      });

      res.status(201).json({
        success: true,
        worksheetId,
        message: 'Worksheet uploaded successfully. Processing started.'
      });
    } catch (error) {
      console.error('Create worksheet error:', error);
      res.status(500).json({
        error: 'Failed to create worksheet',
        details: error.message
      });
    }
  }

  static async getWorksheetStatus(req, res) {
    try {
      const { id } = req.params;
      const { data, error } = await supabase
        .from(WORKSHEETS_TABLE)
        .select('id, program, subject, chapter_name, status, created_at, updated_at, output_docx_storage_path, error_message')
        .eq('id', id)
        .single();

      if (error || !data) {
        return res.status(404).json({ error: 'Worksheet not found' });
      }

      let docxUrl = null;
      if (data.status === WORKSHEET_STATUS.READY && data.output_docx_storage_path) {
        docxUrl = StorageService.getPublicUrl(process.env.OUTPUT_BUCKET, data.output_docx_storage_path);
      }

      return res.json({
        ...data,
        docxUrl,
        error: data.error_message || null
      });
    } catch (error) {
      console.error('Get status error:', error);
      res.status(500).json({
        error: 'Failed to get worksheet status',
        details: error.message
      });
    }
  }

  static async processWorksheet(id, fileBuffer, fileType, program, subject, chapterName) {
    try {
      await this.updateStatus(id, WORKSHEET_STATUS.EXTRACTING);
      const extractedText = await FileExtractor.extractText(fileBuffer, fileType);

      await this.updateStatus(id, WORKSHEET_STATUS.GENERATING);
      const worksheetContent = await LatexGenerator.generate(
        { rawText: extractedText },
        program,
        subject,
        chapterName
      );

      await this.updateStatus(id, WORKSHEET_STATUS.COMPILING, { latex_content: worksheetContent });
      const docxBuffer = await DocxCompiler.compile(worksheetContent, id, chapterName);
      const docxResult = await StorageService.uploadOutputDocx(id, docxBuffer);

      await this.updateStatus(id, WORKSHEET_STATUS.READY, {
        output_docx_storage_path: docxResult.path,
        error_message: null,
        updated_at: new Date().toISOString()
      });
    } catch (error) {
      console.error(`[${id}] Processing failed:`, error);
      await this.updateStatus(id, WORKSHEET_STATUS.FAILED, {
        error_message: String(error?.message || error).slice(0, 4000),
        updated_at: new Date().toISOString()
      });
    }
  }

  static async updateStatus(id, status, additionalData = {}) {
    const payload = {
      status,
      updated_at: new Date().toISOString(),
      ...additionalData
    };

    const { error } = await supabase
      .from(WORKSHEETS_TABLE)
      .update(payload)
      .eq('id', id);

    if (error) {
      console.error(`Failed to update status for ${id}:`, error);
      throw error;
    }
  }
}

module.exports = WorksheetController;
