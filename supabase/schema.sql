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
