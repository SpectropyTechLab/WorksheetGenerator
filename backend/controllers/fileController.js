const supabase = require('../config/database');
const StorageService = require('../services/storageService');
const { WORKSHEET_STATUS } = require('../utils/constants');

const WORKSHEETS_TABLE = process.env.WORKSHEETS_TABLE || 'worksheetgenerator';

class FileController {
  static buildDownloadFilename(worksheet, extension) {
    const subjectMap = {
      physics: 'PHY',
      maths: 'MATH',
      biology: 'BIO',
      chemistry: 'CHEM'
    };

    const slugify = (value, fallback = '') =>
      String(value || fallback)
        .trim()
        .replace(/[^a-zA-Z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .replace(/_+/g, '_')
        .toUpperCase();

    const program = slugify(worksheet.program, 'WORKSHEET');
    const subject = subjectMap[String(worksheet.subject || '').toLowerCase()] || slugify(worksheet.subject, 'SUBJECT');
    const chapter = slugify(worksheet.chapter_name, 'WORKSHEET');

    return `${program}_${subject}_${chapter}_PREMIUM_WORKSHEET.${extension}`;
  }

  static async downloadDocx(req, res) {
    try {
      const { id } = req.params;

      const { data: worksheet, error: worksheetError } = await supabase
        .from(WORKSHEETS_TABLE)
        .select('output_docx_storage_path, original_filename, program, subject, chapter_name')
        .eq('id', id)
        .eq('status', WORKSHEET_STATUS.READY)
        .single();

      if (worksheetError || !worksheet || !worksheet.output_docx_storage_path) {
        return res.status(404).json({ error: 'DOCX not ready or not found' });
      }

      const docxBuffer = await StorageService.downloadFile(
        process.env.OUTPUT_BUCKET,
        worksheet.output_docx_storage_path
      );

      const filename = FileController.buildDownloadFilename(worksheet, 'docx');

      res.setHeader(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      );
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Content-Length', docxBuffer.length);
      return res.send(docxBuffer);
    } catch (error) {
      console.error('DOCX download error:', error);
      return res.status(500).json({
        error: 'Failed to download DOCX',
        details: error.message
      });
    }
  }

  static async deleteWorksheet(req, res) {
    try {
      const { id } = req.params;

      const { data: worksheet, error: fetchError } = await supabase
        .from(WORKSHEETS_TABLE)
        .select('input_storage_path, output_docx_storage_path')
        .eq('id', id)
        .single();

      if (fetchError || !worksheet) {
        return res.status(404).json({ error: 'Worksheet not found' });
      }

      if (worksheet.input_storage_path) {
        await StorageService.deleteFile(process.env.INPUT_BUCKET, worksheet.input_storage_path);
      }

      if (worksheet.output_docx_storage_path) {
        await StorageService.deleteFile(process.env.OUTPUT_BUCKET, worksheet.output_docx_storage_path);
      }

      const { error: deleteError } = await supabase
        .from(WORKSHEETS_TABLE)
        .delete()
        .eq('id', id);

      if (deleteError) {
        throw deleteError;
      }

      return res.json({
        success: true,
        message: 'Worksheet deleted successfully'
      });
    } catch (error) {
      console.error('Delete worksheet error:', error);
      return res.status(500).json({
        error: 'Failed to delete worksheet',
        details: error.message
      });
    }
  }
}

module.exports = FileController;
