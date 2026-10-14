# BH Locadora

Controle de frota de uma locadora pequena: **placa, modelo, km, datas, PDF do contrato e fotos do carro**.
Site estático (HTML/CSS/JS) + banco de dados e login no [Supabase](https://supabase.com). Tudo no plano gratuito.

## Testar agora (modo demonstração)
```bash
cd public && python3 -m http.server 8000   # abra http://localhost:8000
```
Sem configurar o Supabase, os dados ficam só no navegador (localStorage). Serve apenas para testar.

## Colocar no ar de verdade

### 1. Banco e login (Supabase)
1. Crie um projeto em supabase.com.
2. **SQL Editor → New query**: cole o conteúdo de `supabase/schema.sql` e rode. Ele também cria os espaços privados `contratos` (PDFs de até 10 MB) e `fotos` (até 6 por carro; o site reduz cada foto para JPEG antes de enviar). O arquivo pode ser rodado de novo sem problema.
3. **Authentication → Users → Add user**: crie seu e-mail e senha (marque *Auto Confirm*).
4. **Authentication → Sign In / Providers → Email**: **desative "Allow new users to sign up"**.
   Sem isso, qualquer pessoa que descubra a URL do site poderia criar uma conta e ver a frota.
5. **Project Settings → API**: copie a *Project URL* e a chave *anon public* para `public/config.js`.
   Nunca use a chave `service_role` ali.

### 2. Hospedagem (Cloudflare Pages)
1. Cloudflare → Workers & Pages → Create → Pages → conectar este repositório do GitHub.
2. *Build command*: vazio. *Build output directory*: `public`.
3. Cada `git push` publica de novo.

Alternativa: GitHub Pages, mas a pasta publicada precisa ser a raiz ou `/docs` (ou use um workflow de Actions apontando para `public`).

## Segurança
- Os dados só são lidos/gravados por usuários logados (regra RLS em `schema.sql`).
- Placa e contrato **não** aparecem em nenhuma página pública: o site inteiro exige login.
- PDFs e fotos ficam em espaços **privados** do Supabase: só quem está logado os vê (o site gera links temporários).
- O plano gratuito do Supabase tem 1 GB de armazenamento; confira os limites atuais.
- O plano gratuito do Supabase pausa projetos sem uso por cerca de 1 semana (confira os termos atuais); basta reativar no painel.
