import { useState, type ChangeEvent, type FormEvent } from 'react';
import type { Program, Subject, WorksheetCategory } from '../types';

const PROGRAMS: Program[] = ['Maestro', 'Pioneer', 'Catalyst', 'Future Foundation', 'Spark'];
const SUBJECTS: Subject[] = ['Physics', 'Maths', 'Biology', 'Chemistry'];
const CATEGORIES: Array<{ value: WorksheetCategory; label: string }> = [
  { value: 'direct', label: 'Direct Questions' },
  { value: 'similar', label: 'Similar Questions' },
  { value: 'pyq_style', label: 'Previous Year Questions' },
  { value: 'reference', label: 'Reference Questions' }
];

interface UploadFormProps {
  onSubmit: (formData: FormData) => void | Promise<void>;
  isSubmitting: boolean;
}

function UploadForm({ onSubmit, isSubmitting }: UploadFormProps) {
  const [program, setProgram] = useState<Program>('Maestro');
  const [subject, setSubject] = useState<Subject>('Maths');
  const [category, setCategory] = useState<WorksheetCategory>('direct');
  const [chapterName, setChapterName] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const selected = event.target.files?.[0] ?? null;
    setFile(selected);
    setError(null);
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);

    if (!file) {
      setError('Please upload a DOCX or PDF file.');
      return;
    }

    if (!chapterName.trim()) {
      setError('Please enter the chapter name.');
      return;
    }

    const formData = new FormData();
    formData.append('program', program);
    formData.append('subject', subject);
    formData.append('category', category);
    formData.append('chapterName', chapterName.trim());
    formData.append('file', file);

    await onSubmit(formData);
  };

  return (
    <form className="upload-form" onSubmit={handleSubmit}>
      <div className="field-grid">
        <label className="field">
          <span>Program</span>
          <select value={program} onChange={(e) => setProgram(e.target.value as Program)}>
            {PROGRAMS.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          <span>Subject</span>
          <select value={subject} onChange={(e) => setSubject(e.target.value as Subject)}>
            {SUBJECTS.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          <span>Chapter name</span>
          <input
            type="text"
            placeholder="e.g. Laws of Exponents"
            value={chapterName}
            onChange={(e) => setChapterName(e.target.value)}
          />
        </label>

        <label className="field">
          <span>Category</span>
          <select value={category} onChange={(e) => setCategory(e.target.value as WorksheetCategory)}>
            {CATEGORIES.map((value) => (
              <option key={value.value} value={value.value}>
                {value.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <label className="field file-field">
        <span>Upload worksheet</span>
        <input
          type="file"
          accept=".docx,.pdf"
          onChange={handleFileChange}
        />
        <small>Accepted formats: Word DOCX or PDF. Output will always be Word DOCX.</small>
      </label>

      {error && <p className="form-error">{error}</p>}

      <button className="button primary" type="submit" disabled={isSubmitting}>
        {isSubmitting ? 'Uploading...' : 'Submit worksheet'}
      </button>
    </form>
  );
}

export default UploadForm;
