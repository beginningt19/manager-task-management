alter table public.notebook_entries
  add column if not exists person_label text;

alter table public.notebook_entries
  drop constraint if exists notebook_entries_person_label_check;

alter table public.notebook_entries
  add constraint notebook_entries_person_label_check
  check (person_label is null or char_length(person_label) between 1 and 120);

comment on column public.notebook_entries.person_label is
  'Optional person/category label for user-specific notebook grouping.';
