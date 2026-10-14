const $ = (id) => document.getElementById(id);
const cfg = window.CONFIG || {};
const demo = !cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY;
const PLACA_RE = /^[A-Z]{3}[0-9][A-Z0-9][0-9]{2}$/;
const B_PDF = 'contratos';
const B_FOTOS = 'fotos';
const B_DOCS = 'documentos';
const TIPOS_DOC = ['CRLV (documento do carro)', 'Seguro', 'IPVA', 'Licenciamento', 'Contrato de locação',
  'Vistoria', 'Nota fiscal', 'Manutenção', 'Multa', 'Outro'];
const MAX_PDF = 10 * 1024 * 1024; // 10 MB, igual ao limite do bucket
const MAX_FOTOS = 8;              // fotos por carro
const MAX_FOTO_ORIGINAL = 30 * 1024 * 1024; // limite do arquivo escolhido, antes de reduzir
const LADO_MAX = 1280;            // px do maior lado da foto depois de reduzir (~100 KB)
const LADO_MINI = 320;            // miniatura da lista (~15 KB): a lista não baixa a foto inteira
const QUALIDADE_MINI = 0.72;

// ---------- Camada de dados: Supabase, ou localStorage/memória no modo demonstração ----------
const sb = demo ? null : window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);

const lerDemo = () => { try { return JSON.parse(localStorage.getItem('bhl_demo')) || []; } catch { return []; } };
const gravarDemo = (l) => { try { localStorage.setItem('bhl_demo', JSON.stringify(l)); } catch { /* sem armazenamento */ } };
const lerDemoDocs = () => { try { return JSON.parse(localStorage.getItem('bhl_demo_docs')) || []; } catch { return []; } };
const gravarDemoDocs = (l) => { try { localStorage.setItem('bhl_demo_docs', JSON.stringify(l)); } catch { /* sem armazenamento */ } };
const arquivosDemo = new Map(); // modo demonstração: arquivos só ficam na memória, até recarregar a página

const erroAmigavel = (e) => (e?.code === '23505' ? 'Já existe um carro com essa placa.' : e?.message || 'Erro inesperado.');

const dados = {
  async sessao() {
    if (demo) return true;
    const { data } = await sb.auth.getSession();
    return !!data.session;
  },
  async entrar(email, senha) {
    if (demo) return;
    const { error } = await sb.auth.signInWithPassword({ email, password: senha });
    if (error) throw new Error('E-mail ou senha incorretos.');
  },
  async sair() { if (!demo) await sb.auth.signOut(); },
  async listar() {
    if (demo) return lerDemo();
    const { data, error } = await sb.from('carros').select('*').order('modelo');
    if (error) throw error;
    return data;
  },
  async salvar(id, c) {
    if (demo) {
      const l = lerDemo();
      if (l.some((x) => x.placa === c.placa && x.id !== id)) throw { code: '23505' };
      if (id) Object.assign(l.find((x) => x.id === id), c);
      else l.push({ id: crypto.randomUUID(), ...c });
      return gravarDemo(l);
    }
    const q = id ? sb.from('carros').update(c).eq('id', id) : sb.from('carros').insert(c);
    const { error } = await q;
    if (error) throw error;
  },
  async excluir(id) {
    if (demo) { gravarDemoDocs(lerDemoDocs().filter((x) => x.carro_id !== id)); return gravarDemo(lerDemo().filter((x) => x.id !== id)); }
    const { error } = await sb.from('carros').delete().eq('id', id);
    if (error) throw error;
  },
  // ----- documentos do carro -----
  async listarDocumentos() {
    if (demo) return lerDemoDocs();
    const { data, error } = await sb.from('documentos').select('*').order('criado_em');
    if (error) throw error;
    return data;
  },
  async salvarDocumento(id, d) {
    if (demo) {
      const l = lerDemoDocs();
      if (id) Object.assign(l.find((x) => x.id === id), d);
      else l.push({ id: crypto.randomUUID(), criado_em: new Date().toISOString(), ...d });
      return gravarDemoDocs(l);
    }
    const q = id ? sb.from('documentos').update(d).eq('id', id) : sb.from('documentos').insert(d);
    const { error } = await q;
    if (error) throw error;
  },
  async excluirDocumento(id) {
    if (demo) return gravarDemoDocs(lerDemoDocs().filter((x) => x.id !== id));
    const { error } = await sb.from('documentos').delete().eq('id', id);
    if (error) throw error;
  },
  // ----- arquivos (PDF e fotos), em espaços privados do Storage -----
  async enviarArquivo(bucket, arquivo, ext, tipo, caminhoFixo = null) {
    const caminho = caminhoFixo || `${crypto.randomUUID()}.${ext}`;
    if (demo) { arquivosDemo.set(caminho, arquivo); return caminho; }
    const { error } = await sb.storage.from(bucket).upload(caminho, arquivo, { contentType: tipo, upsert: false });
    if (error) {
      if (/bucket not found/i.test(error.message)) throw new Error(`O espaço de arquivos "${bucket}" ainda não existe no Supabase. Rode o SQL de criação (veja o README) e tente de novo.`);
      throw error;
    }
    return caminho;
  },
  async removerArquivos(bucket, caminhos) {
    if (!caminhos.length) return;
    if (demo) { caminhos.forEach((c) => arquivosDemo.delete(c)); return; }
    const { error } = await sb.storage.from(bucket).remove(caminhos);
    if (error) throw error;
  },
  // devolve Map caminho -> URL temporária (1 hora)
  async urlsArquivos(bucket, caminhos) {
    const mapa = new Map();
    if (!caminhos.length) return mapa;
    if (demo) {
      for (const c of caminhos) if (arquivosDemo.has(c)) mapa.set(c, URL.createObjectURL(arquivosDemo.get(c)));
      return mapa;
    }
    const { data, error } = await sb.storage.from(bucket).createSignedUrls(caminhos, 3600);
    if (error) throw error;
    for (const x of data) if (x.signedUrl) mapa.set(x.path, x.signedUrl);
    return mapa;
  },
};

// ---------- Utilidades ----------
const el = (tag, props = {}, ...filhos) => {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...filhos);
  return e;
};

// Datas "YYYY-MM-DD" são tratadas como datas de calendário, sem fuso horário.
const fmtData = (d) => (d ? d.split('-').reverse().join('/') : '—');
const diasAte = (d) => {
  const [y, m, dia] = d.split('-').map(Number);
  const hoje = new Date();
  return Math.round((new Date(y, m - 1, dia) - new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate())) / 86400000);
};
// Em telas estreitas a tabela vira cartões; o rótulo aparece antes do valor (ver style.css).
const rotulo = (td, texto) => { td.setAttribute('data-rotulo', texto); return td; };
function celulaFim(d) {
  const td = el('td', { textContent: fmtData(d) });
  if (!d) return td;
  const n = diasAte(d);
  if (n < 0) td.append(el('span', { className: 'etiqueta vencido', textContent: 'Vencido' }));
  else if (n <= 30) td.append(el('span', { className: 'etiqueta', textContent: n === 0 ? 'Vence hoje' : `Vence em ${n}d` }));
  return td;
}

// A miniatura de "abc.jpg" é "abc_t.jpg", no mesmo espaço; não precisa de coluna no banco.
const caminhoMini = (p) => p.replace(/\.jpg$/, '_t.jpg');
const comMiniaturas = (caminhos) => caminhos.flatMap((p) => [p, caminhoMini(p)]);

// Links temporários ficam guardados nesta aba por 50 min (valem 60): reabrir a lista não gera
// links novos, e o navegador reaproveita as imagens que já baixou. Limpo ao sair.
const CACHE_URLS = 'bhl_urls';
const TTL_URLS = 50 * 60 * 1000;
const lerCacheUrls = () => { try { return JSON.parse(sessionStorage.getItem(CACHE_URLS)) || {}; } catch { return {}; } };
const limparCacheUrls = () => { try { sessionStorage.removeItem(CACHE_URLS); } catch { /* sem armazenamento */ } };
async function urlsComCache(bucket, caminhos, usarCache = !demo) {
  if (!usarCache) return dados.urlsArquivos(bucket, caminhos);
  const agora = Date.now();
  const cache = lerCacheUrls();
  const mapa = new Map();
  const faltam = [];
  for (const p of caminhos) {
    const e = cache[`${bucket}/${p}`];
    if (e && e.ate > agora) mapa.set(p, e.url); else faltam.push(p);
  }
  if (faltam.length) {
    const novos = await dados.urlsArquivos(bucket, faltam);
    for (const [p, u] of novos) { mapa.set(p, u); cache[`${bucket}/${p}`] = { url: u, ate: agora + TTL_URLS }; }
    for (const k of Object.keys(cache)) if (cache[k].ate <= agora) delete cache[k];
    try { sessionStorage.setItem(CACHE_URLS, JSON.stringify(cache)); } catch { /* sem armazenamento */ }
  }
  return mapa;
}

// Mapa foto -> URL da miniatura; fotos antigas, sem miniatura, usam a foto inteira.
async function urlsMiniaturas(fotos) {
  const minis = await urlsComCache(B_FOTOS, fotos.map(caminhoMini));
  const sem = fotos.filter((p) => !minis.get(caminhoMini(p)));
  const inteiras = sem.length ? await urlsComCache(B_FOTOS, sem) : new Map();
  return new Map(fotos.map((p) => [p, minis.get(caminhoMini(p)) || inteiras.get(p)]));
}

// Reduz a foto (celular costuma gerar 3–10 MB) e converte para JPEG, respeitando a rotação.
async function reduzirFoto(arquivo, ladoMax = LADO_MAX, qualidade = 0.82) {
  let bmp;
  try { bmp = await createImageBitmap(arquivo, { imageOrientation: 'from-image' }); }
  catch { throw new Error(`Não consegui ler a imagem "${arquivo.name}". Use JPG, PNG ou WebP.`); }
  const esc = Math.min(1, ladoMax / Math.max(bmp.width, bmp.height));
  const cv = document.createElement('canvas');
  cv.width = Math.max(1, Math.round(bmp.width * esc));
  cv.height = Math.max(1, Math.round(bmp.height * esc));
  cv.getContext('2d').drawImage(bmp, 0, 0, cv.width, cv.height);
  bmp.close?.();
  const blob = await new Promise((ok) => cv.toBlob(ok, 'image/jpeg', qualidade));
  if (!blob) throw new Error(`Não consegui processar a imagem "${arquivo.name}".`);
  return blob;
}

// ---------- Lista ----------
let carros = [];
let editando = null;
let miniaturas = new Map(); // caminho da 1ª foto -> URL temporária
let docs = [];
let docsErro = '';
let abaAtual = 'frota';
const fotosDe = (c) => c.fotos || [];

// Abre a aba antes do await, senão o navegador bloqueia o pop-up.
async function abrirArquivo(bucket, caminho) {
  const aba = window.open('about:blank', '_blank');
  if (!aba) return alert('O navegador bloqueou a nova aba. Permita pop-ups para este site e tente de novo.');
  try {
    const url = (await dados.urlsArquivos(bucket, [caminho])).get(caminho);
    if (!url) throw new Error('Não foi possível abrir o arquivo. No modo demonstração ele só fica disponível até recarregar a página.');
    aba.opener = null;
    aba.location.href = url;
  } catch (e) { aba.close(); alert(erroAmigavel(e)); }
}

const abrirPdf = (caminho) => abrirArquivo(B_PDF, caminho);

function celulaFoto(c) {
  const fotos = fotosDe(c);
  const url = fotos.length && miniaturas.get(fotos[0]);
  if (!url) return el('td', { className: 'foto-celula' }, el('span', { className: 'sem-foto', textContent: fotos.length ? '…' : '—' }));
  const img = el('img', { src: url, alt: `Foto de ${c.modelo} ${c.placa}`, loading: 'lazy' });
  // Foto antiga, sem miniatura: cai para a foto inteira (uma vez só).
  img.onerror = async () => {
    img.onerror = null;
    try { const m = await urlsComCache(B_FOTOS, [fotos[0]]); if (m.get(fotos[0])) img.src = m.get(fotos[0]); } catch { /* fica sem foto */ }
  };
  const b = el('button', { className: 'mini', title: `Ver ${fotos.length} foto(s)` }, img);
  if (fotos.length > 1) b.append(el('span', { className: 'mais', textContent: `+${fotos.length - 1}` }));
  b.onclick = () => abrirGaleria(c);
  return el('td', { className: 'foto-celula' }, b);
}

function desenhar() {
  const termo = $('busca').value.trim().toLowerCase().replace(/[^a-z0-9 ]/g, '');
  const vis = carros.filter((c) => !termo || `${c.placa} ${c.modelo}`.toLowerCase().includes(termo));
  $('resumo').textContent = `${vis.length} de ${carros.length} carro(s)`;
  const corpo = $('lista');
  corpo.replaceChildren();
  if (!vis.length) {
    corpo.append(el('tr', {}, el('td', { colSpan: 8, className: 'vazio', textContent: carros.length ? 'Nenhum carro encontrado.' : 'Nenhum carro cadastrado ainda.' })));
    return;
  }
  for (const c of vis) {
    let contrato;
    if (c.contrato_arquivo) {
      contrato = el('button', { className: 'link', textContent: 'Abrir PDF', title: c.contrato_nome || 'contrato.pdf' });
      contrato.onclick = () => abrirPdf(c.contrato_arquivo);
    } else if (c.contrato_url) { // contratos cadastrados antes como link
      contrato = el('a', { href: c.contrato_url, target: '_blank', rel: 'noopener noreferrer', textContent: 'Abrir link' });
    } else contrato = el('span', { textContent: '—' });
    const editar = el('button', { className: 'link', textContent: 'Editar' });
    editar.onclick = () => abrirForm(c);
    const qtdDocs = docs.filter((d) => d.carro_id === c.id).length;
    const verDocs = el('button', { className: 'link', textContent: qtdDocs ? `Documentos (${qtdDocs})` : 'Documentos' });
    verDocs.onclick = () => irParaDocs(c.id);
    const excluir = el('button', { className: 'perigo', textContent: 'Excluir' });
    excluir.onclick = async () => {
      const aviso = qtdDocs ? `\n\nOs ${qtdDocs} documento(s) deste carro também serão apagados.` : '';
      if (!confirm(`Excluir ${c.modelo} (${c.placa})?${aviso}`)) return;
      const arquivosDocs = docs.filter((d) => d.carro_id === c.id).map((d) => d.arquivo);
      try {
        await dados.excluir(c.id);
        if (arquivosDocs.length) dados.removerArquivos(B_DOCS, arquivosDocs).catch(() => {});
        if (c.contrato_arquivo) dados.removerArquivos(B_PDF, [c.contrato_arquivo]).catch(() => {});
        dados.removerArquivos(B_FOTOS, comMiniaturas(fotosDe(c))).catch(() => {});
        await recarregar();
      } catch (e) { alert(erroAmigavel(e)); }
    };
    corpo.append(el('tr', {},
      celulaFoto(c),
      el('td', { className: 'placa', textContent: c.placa }),
      el('td', { className: 'modelo', textContent: c.modelo }),
      rotulo(el('td', { className: 'num', textContent: c.km.toLocaleString('pt-BR') }), 'Km'),
      rotulo(el('td', { textContent: fmtData(c.contrato_inicio) }), 'Início'),
      rotulo(celulaFim(c.contrato_fim), 'Término'),
      rotulo(el('td', {}, contrato), 'Contrato'),
      el('td', { className: 'acoes-linha' }, verDocs, editar, excluir)));
  }
}

async function recarregar() {
  carros = await dados.listar();
  const primeiras = carros.map((c) => fotosDe(c)[0]).filter(Boolean);
  try { miniaturas = await urlsMiniaturas(primeiras); } catch { miniaturas = new Map(); }
  // Documentos são opcionais aqui: se a tabela ainda não existe, a frota continua funcionando.
  try { docs = await dados.listarDocumentos(); docsErro = ''; }
  catch (e) { docs = []; docsErro = /documentos/i.test(e?.message || '') ? 'A seção de documentos ainda não foi criada no Supabase. Rode o SQL de criação (veja o README) e recarregue a página.' : erroAmigavel(e); }
  desenhar();
  desenharDocs();
}

// ---------- Galeria ----------
let galeria = { urls: [], i: 0 };
function desenharGaleria() {
  const { urls, i } = galeria;
  $('gal-img').src = urls[i];
  $('gal-pos').textContent = `${i + 1} / ${urls.length}`;
  $('gal-ant').disabled = $('gal-prox').disabled = urls.length < 2;
}
async function abrirGaleria(c) {
  const fotos = fotosDe(c);
  try {
    const mapa = await urlsComCache(B_FOTOS, fotos);
    galeria = { urls: fotos.map((f) => mapa.get(f)).filter(Boolean), i: 0 };
  } catch (e) { return alert(erroAmigavel(e)); }
  if (!galeria.urls.length) return alert('Não foi possível carregar as fotos.');
  $('gal-titulo').textContent = `${c.modelo} · ${c.placa}`;
  desenharGaleria();
  $('galeria').showModal();
}
const moverGaleria = (d) => { const n = galeria.urls.length; galeria.i = (galeria.i + d + n) % n; desenharGaleria(); };
$('gal-ant').onclick = () => moverGaleria(-1);
$('gal-prox').onclick = () => moverGaleria(1);
$('gal-fechar').onclick = () => $('galeria').close();
$('galeria').addEventListener('keydown', (ev) => {
  if (ev.key === 'ArrowLeft' && galeria.urls.length > 1) moverGaleria(-1);
  if (ev.key === 'ArrowRight' && galeria.urls.length > 1) moverGaleria(1);
});

// ---------- Formulário ----------
let fotosAtuais = []; // caminhos já salvos que continuam no carro
let fotosNovas = [];  // arquivos escolhidos agora (ainda não enviados)
let urlsAtuais = new Map();
let urlsNovas = [];

function desenharFotosForm() {
  urlsNovas.forEach((u) => URL.revokeObjectURL(u));
  urlsNovas = fotosNovas.map((f) => URL.createObjectURL(f));
  const grade = $('fotos-grade');
  grade.replaceChildren();
  const item = (src, alt, aoRemover) => {
    const x = el('button', { type: 'button', className: 'x', textContent: '×', title: 'Remover foto', ariaLabel: `Remover ${alt}` });
    x.onclick = aoRemover;
    return el('div', { className: 'foto-item' }, el('img', { src, alt }), x);
  };
  fotosAtuais.forEach((p, i) => {
    const it = item(urlsAtuais.get(p) || '', `foto ${i + 1}`, () => { fotosAtuais = fotosAtuais.filter((x) => x !== p); desenharFotosForm(); });
    it.querySelector('img').onerror = async function () {
      this.onerror = null;
      try { const m = await urlsComCache(B_FOTOS, [p]); if (m.get(p)) this.src = m.get(p); } catch { /* fica sem foto */ }
    };
    grade.append(it);
  });
  fotosNovas.forEach((f, i) => {
    const it = item(urlsNovas[i], f.name, () => { fotosNovas.splice(i, 1); desenharFotosForm(); });
    // arquivo que não abre como imagem (ex.: texto renomeado para .jpg) sai da lista na hora
    it.querySelector('img').onerror = () => {
      fotosNovas = fotosNovas.filter((x) => x !== f);
      $('erro-form').textContent = `"${f.name}" não é uma imagem válida e foi removida.`;
      desenharFotosForm();
    };
    grade.append(it);
  });
  const total = fotosAtuais.length + fotosNovas.length;
  $('fotos-contagem').textContent = `${total} de ${MAX_FOTOS} fotos`;
}

$('fotos-botao').onclick = () => $('fotos-input').click();
$('fotos-input').onchange = (ev) => {
  const erro = [];
  for (const f of ev.target.files) {
    if (fotosAtuais.length + fotosNovas.length >= MAX_FOTOS) { erro.push(`Máximo de ${MAX_FOTOS} fotos por carro.`); break; }
    if (!f.type.startsWith('image/')) { erro.push(`"${f.name}" não é uma imagem.`); continue; }
    if (f.size > MAX_FOTO_ORIGINAL) { erro.push(`"${f.name}" é grande demais (máximo 30 MB).`); continue; }
    fotosNovas.push(f);
  }
  ev.target.value = '';
  desenharFotosForm();
  if (erro.length) $('erro-form').textContent = erro.join(' ');
};

async function abrirForm(c = null) {
  editando = c;
  $('titulo-form').textContent = c ? 'Editar carro' : 'Novo carro';
  const f = $('form-carro');
  f.placa.value = c?.placa || '';
  f.modelo.value = c?.modelo || '';
  f.km.value = c?.km ?? '';
  f.contrato_pdf.value = '';
  f.remover_pdf.checked = false;
  const temPdf = !!c?.contrato_arquivo;
  const atual = temPdf ? `Arquivo atual: ${c.contrato_nome || 'contrato.pdf'}. Escolher outro arquivo substitui este.`
    : c?.contrato_url ? `Link antigo: ${c.contrato_url}. Anexar um PDF substitui o link.` : '';
  $('pdf-atual').textContent = atual;
  $('pdf-atual').hidden = !atual;
  $('rotulo-remover').hidden = !temPdf;
  f.contrato_inicio.value = c?.contrato_inicio || '';
  f.contrato_fim.value = c?.contrato_fim || '';
  fotosAtuais = c ? [...fotosDe(c)] : [];
  fotosNovas = [];
  urlsAtuais = new Map();
  $('erro-form').textContent = '';
  desenharFotosForm();
  $('dialogo').showModal();
  f.placa.focus();
  if (fotosAtuais.length) {
    try { urlsAtuais = await urlsMiniaturas(fotosAtuais); desenharFotosForm(); } catch { /* miniaturas são opcionais */ }
  }
}

$('form-carro').onsubmit = async (ev) => {
  ev.preventDefault();
  const f = ev.target;
  const placa = f.placa.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const modelo = f.modelo.value.trim();
  const km = Number(f.km.value);
  const pdf = f.contrato_pdf.files[0] || null;
  const removerPdf = f.remover_pdf.checked;
  const inicio = f.contrato_inicio.value || null;
  const fim = f.contrato_fim.value || null;
  const erro = (m) => { $('erro-form').textContent = m; };
  if (!PLACA_RE.test(placa)) return erro('Placa inválida (ex.: ABC1D23 ou ABC1234).');
  if (!modelo) return erro('Informe o modelo.');
  if (!Number.isInteger(km) || km < 0) return erro('Km deve ser um número inteiro, 0 ou maior.');
  if (pdf) {
    if (!/\.pdf$/i.test(pdf.name)) return erro('O contrato precisa ser um arquivo PDF.');
    if (pdf.size > MAX_PDF) return erro('O PDF é grande demais (máximo 10 MB).');
    const cab = String.fromCharCode(...new Uint8Array(await pdf.slice(0, 5).arrayBuffer()));
    if (cab !== '%PDF-') return erro('Esse arquivo não parece ser um PDF válido.');
  }
  if (inicio && fim && fim < inicio) return erro('O término do contrato não pode ser antes do início.');

  const campos = { placa, modelo, km, contrato_inicio: inicio, contrato_fim: fim };
  const pdfAntigo = editando?.contrato_arquivo || null;
  const fotosAntigas = editando ? fotosDe(editando) : [];
  const enviadas = []; // arquivos subidos agora; apagados se o cadastro falhar
  let pdfNovo = null;
  $('salvar').disabled = true;
  try {
    if (pdf) {
      pdfNovo = await dados.enviarArquivo(B_PDF, pdf, 'pdf', 'application/pdf');
      Object.assign(campos, { contrato_arquivo: pdfNovo, contrato_nome: pdf.name, contrato_url: null });
    } else if (removerPdf) {
      Object.assign(campos, { contrato_arquivo: null, contrato_nome: null });
    }
    for (const [i, arq] of fotosNovas.entries()) {
      $('salvar').textContent = `Enviando foto ${i + 1}/${fotosNovas.length}…`;
      const grande = await reduzirFoto(arq);
      const mini = await reduzirFoto(arq, LADO_MINI, QUALIDADE_MINI);
      const caminho = await dados.enviarArquivo(B_FOTOS, grande, 'jpg', 'image/jpeg');
      enviadas.push(caminho);
      await dados.enviarArquivo(B_FOTOS, mini, 'jpg', 'image/jpeg', caminhoMini(caminho)).catch(() => {});
    }
    campos.fotos = [...fotosAtuais, ...enviadas];
    await dados.salvar(editando?.id, campos);
    if (pdfAntigo && (pdf || removerPdf)) dados.removerArquivos(B_PDF, [pdfAntigo]).catch(() => {});
    dados.removerArquivos(B_FOTOS, comMiniaturas(fotosAntigas.filter((p) => !fotosAtuais.includes(p)))).catch(() => {});
    $('dialogo').close();
    await recarregar();
  } catch (e) {
    if (pdfNovo) dados.removerArquivos(B_PDF, [pdfNovo]).catch(() => {});
    dados.removerArquivos(B_FOTOS, comMiniaturas(enviadas)).catch(() => {});
    erro(erroAmigavel(e));
  } finally { $('salvar').disabled = false; $('salvar').textContent = 'Salvar'; }
};

// ---------- Documentos ----------
const nomeCarro = (c) => (c ? `${c.placa} · ${c.modelo}` : 'Carro removido');

function preencherSelect(sel, opcoes, valor) {
  sel.replaceChildren(...opcoes.map(([v, t]) => el('option', { value: v, textContent: t })));
  if (opcoes.some(([v]) => v === valor)) sel.value = valor;
}

function desenharDocs() {
  const porCarro = [...carros].sort((x, y) => x.placa.localeCompare(y.placa));
  preencherSelect($('filtro-carro'), [['', 'Todos os carros'], ...porCarro.map((c) => [c.id, nomeCarro(c)])], $('filtro-carro').value);
  preencherSelect($('filtro-tipo'), [['', 'Todos os tipos'], ...TIPOS_DOC.map((t) => [t, t])], $('filtro-tipo').value);
  $('erro-docs').textContent = docsErro;
  $('novo-doc').disabled = !carros.length || !!docsErro;
  const fc = $('filtro-carro').value, ft = $('filtro-tipo').value;
  const mapa = new Map(carros.map((c) => [c.id, c]));
  const vis = docs.filter((d) => (!fc || d.carro_id === fc) && (!ft || d.tipo === ft))
    .sort((x, y) => (mapa.get(x.carro_id)?.placa || '').localeCompare(mapa.get(y.carro_id)?.placa || '') || x.tipo.localeCompare(y.tipo));
  $('resumo-docs').textContent = docsErro ? '' : `${vis.length} de ${docs.length} documento(s)`;
  const corpo = $('lista-docs');
  corpo.replaceChildren();
  if (!vis.length) {
    const msg = docsErro ? '' : !carros.length ? 'Cadastre um carro na aba Frota para anexar documentos.' : docs.length ? 'Nenhum documento com esse filtro.' : 'Nenhum documento cadastrado ainda.';
    corpo.append(el('tr', {}, el('td', { colSpan: 5, className: 'vazio', textContent: msg })));
    return;
  }
  for (const d of vis) {
    const c = mapa.get(d.carro_id);
    const abrir = el('button', { className: 'link', textContent: 'Abrir', title: d.nome_arquivo });
    abrir.onclick = () => abrirArquivo(B_DOCS, d.arquivo);
    const editar = el('button', { className: 'link', textContent: 'Editar' });
    editar.onclick = () => abrirFormDoc(d);
    const excluir = el('button', { className: 'perigo', textContent: 'Excluir' });
    excluir.onclick = async () => {
      if (!confirm(`Excluir o documento "${d.tipo}" de ${nomeCarro(c)}?`)) return;
      try {
        await dados.excluirDocumento(d.id);
        dados.removerArquivos(B_DOCS, [d.arquivo]).catch(() => {});
        await recarregar();
      } catch (e) { alert(erroAmigavel(e)); }
    };
    const tipo = el('td', { className: 'doc-nome' }, el('strong', { textContent: d.tipo }));
    if (d.descricao) tipo.append(el('span', { className: 'doc-desc', textContent: d.descricao }));
    corpo.append(el('tr', { className: 'linha-doc' },
      el('td', { className: 'doc-carro' }, el('span', { className: 'placa', textContent: c?.placa || '—' }), el('span', { className: 'doc-desc', textContent: c?.modelo || 'Carro removido' })),
      tipo,
      rotulo(celulaFim(d.validade), 'Validade'),
      rotulo(el('td', {}, abrir), 'Arquivo'),
      el('td', { className: 'acoes-linha' }, editar, excluir)));
  }
}
$('filtro-carro').onchange = desenharDocs;
$('filtro-tipo').onchange = desenharDocs;

function irParaDocs(carroId) {
  mostrarAba('docs');
  $('filtro-carro').value = carroId;
  desenharDocs();
}

let editandoDoc = null;
function abrirFormDoc(d = null) {
  editandoDoc = d;
  $('titulo-doc').textContent = d ? 'Editar documento' : 'Novo documento';
  const f = $('form-doc');
  const porCarro = [...carros].sort((x, y) => x.placa.localeCompare(y.placa));
  preencherSelect($('doc-carro'), porCarro.map((c) => [c.id, nomeCarro(c)]), d?.carro_id || $('filtro-carro').value);
  preencherSelect($('doc-tipo'), TIPOS_DOC.map((t) => [t, t]), d?.tipo);
  f.descricao.value = d?.descricao || '';
  f.validade.value = d?.validade || '';
  f.arquivo.value = '';
  $('doc-atual').textContent = d ? `Arquivo atual: ${d.nome_arquivo}. Escolher outro arquivo substitui este.` : '';
  $('doc-atual').hidden = !d;
  $('erro-doc').textContent = '';
  atualizarDicaDescricao();
  $('dialogo-doc').showModal();
}
function atualizarDicaDescricao() {
  const outro = $('doc-tipo').value === 'Outro';
  $('doc-desc-dica').textContent = outro ? '(obrigatória)' : '(opcional)';
}
$('doc-tipo').onchange = atualizarDicaDescricao;
$('novo-doc').onclick = () => abrirFormDoc();
$('doc-cancelar').onclick = () => $('dialogo-doc').close();

// Valida o arquivo e devolve { blob, ext, mime, nome }. PDF vai como está; foto é reduzida e vira JPEG.
async function prepararDocumento(arq) {
  const ehPdf = /\.pdf$/i.test(arq.name) || arq.type === 'application/pdf';
  if (ehPdf) {
    if (arq.size > MAX_PDF) throw new Error('O PDF é grande demais (máximo 10 MB).');
    const cab = String.fromCharCode(...new Uint8Array(await arq.slice(0, 5).arrayBuffer()));
    if (cab !== '%PDF-') throw new Error('Esse arquivo não parece ser um PDF válido.');
    return { blob: arq, ext: 'pdf', mime: 'application/pdf', nome: arq.name };
  }
  if (arq.type.startsWith('image/')) {
    if (arq.size > MAX_FOTO_ORIGINAL) throw new Error('A foto é grande demais (máximo 30 MB).');
    return { blob: await reduzirFoto(arq, 2200, 0.85), ext: 'jpg', mime: 'image/jpeg', nome: arq.name };
  }
  throw new Error('Use um PDF ou uma foto (JPG, PNG ou WebP).');
}

$('form-doc').onsubmit = async (ev) => {
  ev.preventDefault();
  const f = ev.target;
  const erro = (m) => { $('erro-doc').textContent = m; };
  const carro_id = f.carro_id.value;
  const tipo = f.tipo.value;
  const descricao = f.descricao.value.trim();
  const validade = f.validade.value || null;
  const arq = f.arquivo.files[0] || null;
  if (!carro_id) return erro('Escolha o carro.');
  if (tipo === 'Outro' && !descricao) return erro('Descreva o documento (ex.: Apólice do seguro).');
  if (!editandoDoc && !arq) return erro('Anexe o arquivo do documento (PDF ou foto).');
  const antigo = editandoDoc?.arquivo || null;
  let novo = null;
  $('doc-salvar').disabled = true;
  try {
    const campos = { carro_id, tipo, descricao: descricao || null, validade };
    if (arq) {
      const p = await prepararDocumento(arq);
      novo = await dados.enviarArquivo(B_DOCS, p.blob, p.ext, p.mime);
      Object.assign(campos, { arquivo: novo, nome_arquivo: p.nome });
    }
    await dados.salvarDocumento(editandoDoc?.id, campos);
    if (novo && antigo) dados.removerArquivos(B_DOCS, [antigo]).catch(() => {});
    $('dialogo-doc').close();
    await recarregar();
  } catch (e) {
    if (novo) dados.removerArquivos(B_DOCS, [novo]).catch(() => {});
    erro(erroAmigavel(e));
  } finally { $('doc-salvar').disabled = false; }
};

// ---------- Abas ----------
function mostrarAba(aba) {
  abaAtual = aba;
  $('tela-painel').hidden = aba !== 'frota';
  $('tela-docs').hidden = aba !== 'docs';
  document.querySelectorAll('.aba').forEach((b) => b.classList.toggle('ativa', b.dataset.aba === aba));
  try { history.replaceState(null, '', aba === 'docs' ? '#documentos' : location.pathname + location.search); } catch { /* sem histórico */ }
  if (aba === 'docs') desenharDocs();
}
document.querySelectorAll('.aba').forEach((b) => { b.onclick = () => mostrarAba(b.dataset.aba); });

// ---------- Login e início ----------
async function mostrarTela() {
  const logado = await dados.sessao();
  $('tela-login').hidden = logado;
  $('abas').hidden = !logado;
  $('sair').hidden = !logado || demo;
  if (!logado) { $('tela-painel').hidden = true; $('tela-docs').hidden = true; return; }
  mostrarAba(location.hash === '#documentos' ? 'docs' : 'frota');
  try { await recarregar(); } catch (e) { $('resumo').textContent = erroAmigavel(e); }
}

$('form-login').onsubmit = async (ev) => {
  ev.preventDefault();
  const f = ev.target;
  $('erro-login').textContent = '';
  try { await dados.entrar(f.email.value.trim(), f.senha.value); f.senha.value = ''; await mostrarTela(); }
  catch (e) { $('erro-login').textContent = erroAmigavel(e); }
};

$('novo').onclick = () => abrirForm();
$('cancelar').onclick = () => $('dialogo').close();
$('busca').oninput = desenhar;
$('sair').onclick = async () => { limparCacheUrls(); await dados.sair(); await mostrarTela(); };
$('aviso-demo').hidden = !demo;

mostrarTela();
