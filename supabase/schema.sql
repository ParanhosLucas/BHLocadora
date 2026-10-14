-- Rode este script UMA vez no Supabase: SQL Editor > New query > Run.

create table if not exists public.carros (
  id           uuid primary key default gen_random_uuid(),
  placa        text not null unique
               check (placa ~ '^[A-Z]{3}[0-9][A-Z0-9][0-9]{2}$'),
  modelo       text not null check (length(trim(modelo)) > 0),
  km           integer not null check (km >= 0),
  contrato_url text check (contrato_url is null or contrato_url ~* '^https?://'),
  criado_em    timestamptz not null default now()
);

-- Segurança em nível de linha: sem login, ninguém lê nem grava nada.
alter table public.carros enable row level security;

drop policy if exists "somente logados" on public.carros;
create policy "somente logados" on public.carros
  for all to authenticated
  using (true) with check (true);

-- Permissões explícitas: só o papel "authenticated" (usuário logado) acessa a tabela.
-- O papel "anon" (visitante sem login) não recebe nenhuma permissão.
grant usage on schema public to authenticated;
grant select, insert, update, delete on public.carros to authenticated;

-- Datas do contrato (idempotente: pode rodar de novo sem problema).
alter table public.carros
  add column if not exists contrato_inicio date,
  add column if not exists contrato_fim    date;

alter table public.carros drop constraint if exists carros_datas_validas;
alter table public.carros add constraint carros_datas_validas
  check (contrato_inicio is null or contrato_fim is null or contrato_fim >= contrato_inicio);

-- Contrato em PDF: guarda o caminho do arquivo e o nome original.
alter table public.carros
  add column if not exists contrato_arquivo text,
  add column if not exists contrato_nome    text;

-- Espaço de armazenamento PRIVADO só para PDFs de até 10 MB.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('contratos', 'contratos', false, 10485760, array['application/pdf'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Só usuários logados leem, enviam e apagam arquivos desse espaço.
drop policy if exists "contratos: somente logados" on storage.objects;
create policy "contratos: somente logados" on storage.objects
  for all to authenticated
  using (bucket_id = 'contratos')
  with check (bucket_id = 'contratos');

notify pgrst, 'reload schema';

-- Fotos do carro: lista de caminhos dos arquivos (até 8 por carro, controlado pelo site).
alter table public.carros add column if not exists fotos text[] not null default '{}';

-- Espaço de armazenamento PRIVADO para fotos (o site reduz cada foto para JPEG antes de enviar).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('fotos', 'fotos', false, 5242880, array['image/jpeg'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "fotos: somente logados" on storage.objects;
create policy "fotos: somente logados" on storage.objects
  for all to authenticated
  using (bucket_id = 'fotos')
  with check (bucket_id = 'fotos');

notify pgrst, 'reload schema';
