// Servidor sem dependências externas: só precisa do Node 18+.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const SENHA = process.env.ADMIN_PASSWORD || 'admin123';
const DATA = path.join(__dirname, 'data');
const PUB = path.join(__dirname, 'public');
const DB_FILE = path.join(DATA, 'db.json');
const DIR_FOTOS = path.join(DATA, 'fotos');
const DIR_CONTRATOS = path.join(DATA, 'contratos');
for (const d of [DATA, DIR_FOTOS, DIR_CONTRATOS]) fs.mkdirSync(d, { recursive: true });

const MAX_BODY = 60 * 1024 * 1024;
const EXT_FOTO = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];
const EXT_CONTRATO = ['.pdf', '.doc', '.docx', '.jpg', '.jpeg', '.png'];
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif', '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

let carros = fs.existsSync(DB_FILE) ? JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) : [];
const salvar = () => {
  fs.writeFileSync(DB_FILE + '.tmp', JSON.stringify(carros, null, 2));
  fs.renameSync(DB_FILE + '.tmp', DB_FILE);
};

const sessoes = new Map(); // token -> expiração
const SESSAO_MS = 12 * 3600 * 1000;
const tokenDe = (req) => /(?:^|;\s*)sessao=([a-f0-9]+)/.exec(req.headers.cookie || '')?.[1];
const autenticado = (req) => {
  const t = tokenDe(req);
  const exp = t && sessoes.get(t);
  if (!exp || exp < Date.now()) { sessoes.delete(t); return false; }
  return true;
};

const json = (res, status, obj, headers = {}) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  res.end(JSON.stringify(obj));
};

function lerCorpo(req) {
  return new Promise((resolve, reject) => {
    let tam = 0; const partes = [];
    req.on('data', (c) => {
      tam += c.length;
      if (tam > MAX_BODY) { reject(Object.assign(new Error('Arquivos grandes demais (máx. 60 MB por envio).'), { status: 413 })); req.destroy(); return; }
      partes.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(partes).toString() || '{}')); }
      catch { reject(Object.assign(new Error('JSON inválido.'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

// Salva um arquivo vindo como data URL (base64) e devolve { arquivo, nome }.
function salvarArquivo(f, dir, extsOk) {
  const ext = path.extname(f?.nome || '').toLowerCase();
  const m = /^data:[^;]*;base64,(.*)$/s.exec(f?.dados || '');
  if (!m || !extsOk.includes(ext)) throw Object.assign(new Error(`Arquivo inválido: ${f?.nome}. Aceitos: ${extsOk.join(', ')}`), { status: 400 });
  const arquivo = crypto.randomUUID() + ext;
  fs.writeFileSync(path.join(dir, arquivo), Buffer.from(m[1], 'base64'));
  return { arquivo, nome: path.basename(f.nome) };
}
const apagar = (dir, arquivo) => { if (arquivo) fs.rm(path.join(dir, path.basename(arquivo)), { force: true }, () => {}); };

function validar(b) {
  const modelo = String(b.modelo || '').trim();
  const placa = String(b.placa || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const ano = parseInt(b.ano, 10);
  const meses = b.meses === '' || b.meses == null ? null : parseInt(b.meses, 10);
  const inicio = b.inicio || null;
  if (!modelo) throw Object.assign(new Error('Informe o modelo.'), { status: 400 });
  if (!/^[A-Z]{3}[0-9][A-Z0-9][0-9]{2}$/.test(placa)) throw Object.assign(new Error('Placa inválida (ex.: ABC1D23 ou ABC1234).'), { status: 400 });
  if (!(ano >= 1950 && ano <= new Date().getFullYear() + 1)) throw Object.assign(new Error('Ano inválido.'), { status: 400 });
  if (meses != null && !(meses >= 1 && meses <= 120)) throw Object.assign(new Error('Tempo de contrato deve ser entre 1 e 120 meses.'), { status: 400 });
  if (inicio && isNaN(Date.parse(inicio))) throw Object.assign(new Error('Data de início inválida.'), { status: 400 });
  return { modelo, placa, ano, meses, inicio, cliente: String(b.cliente || '').trim(), obs: String(b.obs || '').trim() };
}

const publico = (c) => ({ id: c.id, modelo: c.modelo, ano: c.ano, fotos: c.fotos.map((f) => f.arquivo), alugado: !!c.cliente });

async function api(req, res, url) {
  const { pathname } = url;
  const m = req.method;

  if (m === 'GET' && pathname === '/api/carros') return json(res, 200, carros.map(publico));

  if (m === 'POST' && pathname === '/api/login') {
    const b = await lerCorpo(req);
    const a = Buffer.from(String(b.senha || '')), z = Buffer.from(SENHA);
    const ok = a.length === z.length && crypto.timingSafeEqual(a, z);
    if (!ok) return json(res, 401, { erro: 'Senha incorreta.' });
    const t = crypto.randomBytes(24).toString('hex');
    sessoes.set(t, Date.now() + SESSAO_MS);
    return json(res, 200, { ok: true }, { 'Set-Cookie': `sessao=${t}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSAO_MS / 1000}` });
  }
  if (m === 'POST' && pathname === '/api/logout') {
    sessoes.delete(tokenDe(req));
    return json(res, 200, { ok: true }, { 'Set-Cookie': 'sessao=; HttpOnly; Path=/; Max-Age=0' });
  }

  if (!autenticado(req)) return json(res, 401, { erro: 'Não autorizado.' });

  if (m === 'GET' && pathname === '/api/admin/carros') return json(res, 200, carros);

  if (m === 'GET' && pathname.startsWith('/api/admin/contratos/')) {
    const arq = path.basename(pathname);
    const c = carros.find((x) => x.contrato?.arquivo === arq);
    const fp = path.join(DIR_CONTRATOS, arq);
    if (!c || !fs.existsSync(fp)) return json(res, 404, { erro: 'Contrato não encontrado.' });
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(arq)] || 'application/octet-stream',
      'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(c.contrato.nome)}`,
    });
    return fs.createReadStream(fp).pipe(res);
  }

  if (m === 'POST' && pathname === '/api/admin/carros') {
    const b = await lerCorpo(req);
    const dados = validar(b);
    const novo = { id: crypto.randomUUID(), ...dados, fotos: [], contrato: null, criadoEm: new Date().toISOString() };
    for (const f of b.novasFotos || []) novo.fotos.push(salvarArquivo(f, DIR_FOTOS, EXT_FOTO));
    if (b.novoContrato) novo.contrato = salvarArquivo(b.novoContrato, DIR_CONTRATOS, EXT_CONTRATO);
    carros.push(novo); salvar();
    return json(res, 201, novo);
  }

  const mid = /^\/api\/admin\/carros\/([\w-]+)$/.exec(pathname);
  if (mid) {
    const c = carros.find((x) => x.id === mid[1]);
    if (!c) return json(res, 404, { erro: 'Carro não encontrado.' });
    if (m === 'PUT') {
      const b = await lerCorpo(req);
      Object.assign(c, validar(b));
      const manter = new Set(b.manterFotos || []);
      for (const f of c.fotos) if (!manter.has(f.arquivo)) apagar(DIR_FOTOS, f.arquivo);
      c.fotos = c.fotos.filter((f) => manter.has(f.arquivo));
      for (const f of b.novasFotos || []) c.fotos.push(salvarArquivo(f, DIR_FOTOS, EXT_FOTO));
      if (b.novoContrato) { apagar(DIR_CONTRATOS, c.contrato?.arquivo); c.contrato = salvarArquivo(b.novoContrato, DIR_CONTRATOS, EXT_CONTRATO); }
      else if (b.removerContrato) { apagar(DIR_CONTRATOS, c.contrato?.arquivo); c.contrato = null; }
      salvar();
      return json(res, 200, c);
    }
    if (m === 'DELETE') {
      c.fotos.forEach((f) => apagar(DIR_FOTOS, f.arquivo));
      apagar(DIR_CONTRATOS, c.contrato?.arquivo);
      carros = carros.filter((x) => x !== c); salvar();
      return json(res, 200, { ok: true });
    }
  }
  return json(res, 404, { erro: 'Rota não encontrada.' });
}

function estatico(req, res, url) {
  let p = decodeURIComponent(url.pathname);
  let base = PUB;
  if (p.startsWith('/fotos/')) { base = DIR_FOTOS; p = p.slice(6); }
  else if (p === '/') p = '/index.html';
  else if (p === '/admin') p = '/admin.html';
  const fp = path.join(base, path.normalize(p));
  if (!fp.startsWith(base + path.sep) || !fs.existsSync(fp) || !fs.statSync(fp).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Página não encontrada');
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(fp).toLowerCase()] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff' });
  fs.createReadStream(fp).pipe(res);
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname.startsWith('/api/')) await api(req, res, url);
    else estatico(req, res, url);
  } catch (e) {
    if (!res.headersSent) json(res, e.status || 500, { erro: e.status ? e.message : 'Erro interno.' });
    if (!e.status) console.error(e);
  }
}).listen(PORT, () => {
  console.log(`BH Locadora rodando em http://localhost:${PORT}  (painel: /admin)`);
  if (!process.env.ADMIN_PASSWORD) console.log('⚠ Usando senha padrão "admin123". Defina ADMIN_PASSWORD para trocar.');
});
