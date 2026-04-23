create extension if not exists pgcrypto;

create table if not exists public.worksheetgenerator (
  id uuid primary key default gen_random_uuid(),
  program varchar(50) not null,
  subject varchar(50) not null,
  chapter_name text not null,
  original_filename varchar(255) not null,
  file_type varchar(10) not null,
  input_storage_path varchar(500),
  output_docx_storage_path varchar(500),
  latex_content text,
  error_message text,
  status varchar(20) default 'extracting',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists idx_worksheetgenerator_status on public.worksheetgenerator(status);
create index if not exists idx_worksheetgenerator_program on public.worksheetgenerator(program);
create index if not exists idx_worksheetgenerator_created_at on public.worksheetgenerator(created_at);
create index if not exists idx_worksheetgenerator_id on public.worksheetgenerator(id);

create table if not exists public.worksheetgeneratorusers (
  id uuid primary key default gen_random_uuid(),
  username text not null unique,
  password text not null,
  role text not null default 'user',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists worksheetgeneratorusers_role_idx
  on public.worksheetgeneratorusers (role);

create index if not exists worksheetgeneratorusers_created_at_idx
  on public.worksheetgeneratorusers (created_at desc);
