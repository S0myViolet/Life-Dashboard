-- Link tasks and notes to projects now that public.projects (capture migration) and the
-- Milestone 1 tables live in the same database. Deleting a project keeps its tasks and notes
-- and clears the link.

alter table public.tasks
  add constraint tasks_project_fk foreign key (project_id)
  references public.projects (id) on delete set null;

alter table public.notes
  add constraint notes_project_fk foreign key (project_id)
  references public.projects (id) on delete set null;
