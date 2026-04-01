export type Program = 'Maestro' | 'Pioneer' | 'Catalyst' | 'Future Foundation' | 'Spark';
export type Subject = 'Physics' | 'Maths' | 'Biology' | 'Chemistry';
export type WorksheetStatus = 'extracting' | 'generating' | 'compiling' | 'ready' | 'failed';

export interface WorksheetCreateResponse {
  success: boolean;
  worksheetId: string;
  message: string;
}

export interface WorksheetStatusResponse {
  id: string;
  program: Program;
  subject: Subject;
  status: WorksheetStatus;
  created_at: string;
  updated_at?: string;
  output_pdf_storage_path?: string | null;
  output_docx_storage_path?: string | null;
  pdfUrl?: string | null;
  docxUrl?: string | null;
  error?: string | null;
}
