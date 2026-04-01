-- Single table for worksheet processing
create table if not exists public.worksheets (
  id uuid primary key,
  program text not null,
  subject text not null,
  chapter_name text,
  original_filename text not null,
  file_type text not null,
  input_storage_path text,
  output_pdf_storage_path text,
  output_docx_storage_path text,
  latex_content text,
  error_message text,
  status text not null default 'extracting',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.worksheets
  add column if not exists chapter_name text;

alter table public.worksheets
  add column if not exists output_docx_storage_path text;

alter table public.worksheets
  add column if not exists error_message text;

-- Basic constraints
alter table public.worksheets
  add constraint worksheets_program_check
  check (program in ('maestro','pioneer','catalyst','future foundation','spark'));

alter table public.worksheets
  add constraint worksheets_subject_check
  check (subject in ('physics','maths','biology','chemistry'));

alter table public.worksheets
  add constraint worksheets_file_type_check
  check (file_type in ('docx','pdf'));

alter table public.worksheets
  add constraint worksheets_status_check
  check (status in ('extracting','generating','compiling','ready','failed'));

create index if not exists worksheets_status_idx on public.worksheets (status);
create index if not exists worksheets_created_at_idx on public.worksheets (created_at desc);

-- Users table for login and role management
create table if not exists public.user (
  id uuid primary key default gen_random_uuid(),
  username text not null unique,
  password text not null,
  role text not null default 'user',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists user_role_idx on public.users (role);
create index if not exists user_created_at_idx on public.users (created_at desc);
