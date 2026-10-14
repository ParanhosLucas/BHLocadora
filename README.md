# BH Locadora

Site de locadora de carros com vitrine pública e painel de administração.

## Como rodar
```bash
ADMIN_PASSWORD="sua-senha" node server.js   # precisa de Node 18+; sem npm install
```
- Vitrine pública: http://localhost:3000 (só modelo, ano, fotos e disponibilidade)
- Painel: http://localhost:3000/admin (placa, contrato e cliente só aparecem aqui)
- Sem `ADMIN_PASSWORD`, a senha padrão é `admin123` — troque antes de publicar.

## O que o painel faz
- Cadastra/edita/exclui carros: modelo, placa, ano, várias fotos, tempo de contrato (meses), início, cliente e observações.
- Anexa o contrato (PDF, Word ou imagem) ao carro; abre e substitui pelo próprio site.
- Calcula o fim do contrato e avisa quando faltam 30 dias ou já venceu.

## Onde ficam os dados
Pasta `data/` (ignorada pelo git): `db.json`, `fotos/` e `contratos/`. Faça backup dela.
Contratos só são acessíveis com login; fotos são públicas.
