const $ = (id) => document.getElementById(id);
const cfg = window.CONFIG || {};
const demo = !cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY;
const PLACA_RE = /^[A-Z]{3}[0-9][A-Z0-9][0-9]{2}$/;
const B_PDF = 'contratos';
const B_FOTOS = 'fotos';
const B_DOCS = 'documentos';
// Só o CRLV pode ser escolhido para documentos novos. Documentos antigos de outros tipos (Seguro, Fotos,
// Vídeo...) continuam na lista e podem ser editados; o vídeo continua sendo enviado pelo cadastro do carro.
const TIPOS_DOC = ['CRLV (documento do carro)'];
const TIPO_FOTOS = 'Fotos'; // várias fotos (até MAX_FOTOS) num único documento, só imagens
const GOOGLE_ID = cfg.GOOGLE_CLIENT_ID || '';
const usaDrive = !!GOOGLE_ID; // sem o ID do Google, o envio direto fica desligado
const TIPO_VIDEO = 'Vídeo'; // guarda só o link/ID (Drive, YouTube...); o arquivo fica fora do Supabase
const MAX_PDF = 10 * 1024 * 1024; // 10 MB, igual ao limite do bucket
const MAX_FOTOS = 10;             // fotos por carro
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
  // Baixa o arquivo para dentro do app (como Blob), usando o login: serve para entregar ao navegador como arquivo a salvar.
  async obterArquivo(bucket, caminho) {
    if (demo) return arquivosDemo.get(caminho) || null;
    const { data, error } = await sb.storage.from(bucket).download(caminho);
    if (error) throw error;
    return data;
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

const TIPOS_POR_EXTENSAO = { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png' };
async function baixarArquivo(bucket, caminho, nome) {
  try {
    const bruto = await dados.obterArquivo(bucket, caminho);
    if (!bruto) throw new Error('Não foi possível baixar o arquivo. No modo demonstração ele só fica disponível até recarregar a página.');
    // o tipo certo faz o navegador tratar como arquivo (o Safari do iPhone abre na tela quando o tipo vem vazio ou genérico)
    const tipo = TIPOS_POR_EXTENSAO[nome.split('.').pop().toLowerCase()] || bruto.type || 'application/octet-stream';
    const url = URL.createObjectURL(new Blob([bruto], { type: tipo }));
    const a = el('a', { href: url, download: nome, rel: 'noopener' });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (e) { alert(erroAmigavel(e)); }
}
// Nome do arquivo baixado: o original, com a extensão do que foi guardado (foto vira .jpg ao enviar).
const nomeDownload = (d) => `${(d.nome_arquivo || 'documento').replace(/\.[^./\\]+$/, '')}.${(d.arquivo || '').split('.').pop() || 'pdf'}`;

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

// Vídeos enviados pelo cadastro do carro: vivem na Frota, fora da aba Documentos.
const videosDoCarro = (c) => docs.filter((d) => d.carro_id === c.id && d.tipo === TIPO_VIDEO && d.link);

function desenhar() {
  const termo = $('busca').value.trim().toLowerCase().replace(/[^a-z0-9 ]/g, '');
  const vis = carros.filter((c) => !termo || `${c.placa} ${c.modelo} ${c.locatario || ''}`.toLowerCase().replace(/[^a-z0-9 ]/g, '').includes(termo));
  $('resumo').textContent = `${vis.length} de ${carros.length} carro(s)`;
  const corpo = $('lista');
  corpo.replaceChildren();
  if (!vis.length) {
    corpo.append(el('tr', {}, el('td', { colSpan: 10, className: 'vazio', textContent: carros.length ? 'Nenhum carro encontrado.' : 'Nenhum carro cadastrado ainda.' })));
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
    const videos = videosDoCarro(c);
    const celulaVideo = el('td', {});
    if (!videos.length) celulaVideo.append('—');
    videos.forEach((v, i) => celulaVideo.append(el('a', { href: v.link, target: '_blank', rel: 'noopener noreferrer', textContent: videos.length > 1 ? `Assistir ${i + 1}` : 'Assistir' })));
    const excluir = el('button', { className: 'perigo', textContent: 'Excluir' });
    excluir.onclick = async () => {
      const videosDrive = videos.filter((d) => d.drive_id);
      // documentos antigos ainda presos ao carro (antes do SQL que os torna independentes) sumiriam junto com ele
      const presos = docs.filter((d) => d.carro_id === c.id && d.tipo !== TIPO_VIDEO).length;
      const aviso = (videosDrive.length ? `\n\n${videosDrive.length} vídeo(s) também serão apagados do seu Google Drive.` : '')
        + (presos ? `\n\n${presos} documento(s) antigo(s) ligado(s) a este carro também serão apagados.` : '');
      if (!confirm(`Excluir ${c.modelo} (${c.placa})?${aviso}`)) return;
      const arquivosDocs = docs.filter((d) => d.carro_id === c.id).flatMap(arquivosDoDoc);
      try {
        for (const v of videosDrive) if (!(await apagarVideoDoDrive(v.drive_id))) return; // 1º: a janela do Google abre direto do clique
        await dados.excluir(c.id);
        if (arquivosDocs.length) dados.removerArquivos(B_DOCS, arquivosDocs).catch(() => {});
        if (c.contrato_arquivo) dados.removerArquivos(B_PDF, [c.contrato_arquivo]).catch(() => {});
        dados.removerArquivos(B_FOTOS, comMiniaturas(fotosDe(c))).catch(() => {});
        await recarregar();
      } catch (e) { alert(erroAmigavel(e)); }
    };
    corpo.append(el('tr', {},
      celulaFoto(c),
      el('td', { className: `locatario${c.locatario ? '' : ' sem-loc'}`, textContent: c.locatario || '—' }),
      el('td', { className: 'modelo', textContent: c.modelo }),
      el('td', { className: 'placa', textContent: c.placa }),
      rotulo(el('td', { className: 'num', textContent: c.km.toLocaleString('pt-BR') }), 'Km'),
      rotulo(el('td', { textContent: fmtData(c.contrato_inicio) }), 'Início'),
      rotulo(celulaFim(c.contrato_fim), 'Término'),
      rotulo(el('td', {}, contrato), 'Contrato'),
      rotulo(celulaVideo, 'Vídeo'),
      el('td', { className: 'acoes-linha' }, editar, excluir)));
  }
}

async function recarregar() {
  carros = await dados.listar();
  const primeiras = carros.map((c) => fotosDe(c)[0]).filter(Boolean);
  try { miniaturas = await urlsMiniaturas(primeiras); } catch { miniaturas = new Map(); }
  // Documentos são opcionais aqui: se a tabela ainda não existe, a frota continua funcionando.
  try {
    docs = await dados.listarDocumentos(); docsErro = '';
    docs.forEach((d) => { if (d.tipo === 'Vídeo (link)') d.tipo = TIPO_VIDEO; }); // nome antigo do tipo
  }
  catch (e) { docs = []; docsErro = /documentos/i.test(e?.message || '') ? 'A seção de documentos ainda não foi criada no Supabase. Rode o SQL de criação (veja o README) e recarregue a página.' : erroAmigavel(e); }
  desenhar();
  desenharDocs();
  desenharLembrete();
}

// ---------- Galeria ----------
let galeria = { urls: [], i: 0 };
function desenharGaleria() {
  const { urls, i } = galeria;
  $('gal-img').src = urls[i];
  $('gal-pos').textContent = `${i + 1} / ${urls.length}`;
  $('gal-ant').disabled = $('gal-prox').disabled = urls.length < 2;
}
// Abre a galeria com fotos de qualquer espaço do Storage (fotos do carro ou fotos de um documento).
async function abrirGaleriaDe(titulo, fotos, bucket) {
  try {
    const mapa = await urlsComCache(bucket, fotos);
    galeria = { urls: fotos.map((f) => mapa.get(f)).filter(Boolean), i: 0 };
  } catch (e) { return alert(erroAmigavel(e)); }
  if (!galeria.urls.length) return alert('Não foi possível carregar as fotos.');
  $('gal-titulo').textContent = titulo;
  desenharGaleria();
  $('galeria').showModal();
}
const abrirGaleria = (c) => abrirGaleriaDe(`${c.modelo} · ${c.placa}`, fotosDe(c), B_FOTOS);
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

// Lista os vídeos do carro dentro do formulário, com Assistir e Apagar.
function desenharVideosDoCarro(c) {
  const caixa = $('videos-existentes');
  const videos = c ? videosDoCarro(c) : [];
  caixa.replaceChildren();
  caixa.hidden = !videos.length;
  if (!videos.length) return;
  caixa.append(el('span', { className: 'rotulo', textContent: `Vídeos deste carro (${videos.length}) — enviar outro adiciona mais um` }));
  videos.forEach((v, i) => {
    const ver = el('a', { href: v.link, target: '_blank', rel: 'noopener noreferrer', textContent: 'Assistir' });
    const apagar = el('button', { type: 'button', className: 'perigo', textContent: v.drive_id ? 'Apagar do Drive' : 'Remover' });
    apagar.onclick = async () => {
      const msg = v.drive_id ? `Apagar o vídeo ${i + 1} do seu Google Drive e do site?\n\nIsso não pode ser desfeito.` : `Remover o link do vídeo ${i + 1} do site?`;
      if (!confirm(msg)) return;
      try {
        if (v.drive_id && !(await apagarVideoDoDrive(v.drive_id))) return;
        await dados.excluirDocumento(v.id);
        await recarregar();
        desenharVideosDoCarro(c);
      } catch (e) { $('erro-form').textContent = erroAmigavel(e); }
    };
    caixa.append(el('div', { className: 'video-item' }, el('span', { textContent: `Vídeo ${i + 1}` }), ver, apagar));
  });
}

async function abrirForm(c = null) {
  editando = c;
  $('titulo-form').textContent = c ? 'Editar carro' : 'Novo carro';
  const f = $('form-carro');
  f.locatario.value = c?.locatario || '';
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
  f.video.value = '';
  $('carro-video-progresso').hidden = true;
  $('bloco-video-carro').hidden = !usaDrive;
  desenharVideosDoCarro(c);
  atualizarEstadoGoogle();
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
  const locatario = f.locatario.value.trim() || null;
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
  const video = usaDrive ? f.video.files[0] || null : null;
  if (video) {
    if (!video.type.startsWith('video/')) return erro('O arquivo escolhido não é um vídeo.');
    if (!driveConectado()) return erro('Toque em "Conectar ao Google Drive" antes de enviar o vídeo.');
  }

  const campos = { locatario, placa, modelo, km, contrato_inicio: inicio, contrato_fim: fim };
  const pdfAntigo = editando?.contrato_arquivo || null;
  const fotosAntigas = editando ? fotosDe(editando) : [];
  const enviadas = []; // arquivos subidos agora; apagados se o cadastro falhar
  let pdfNovo = null;
  let driveNovo = null;
  let carroSalvo = false;
  const idCarro = editando?.id || crypto.randomUUID(); // o id nasce aqui para o vídeo já apontar para o carro
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
    if (video) {
      const barra = $('carro-video-progresso');
      barra.hidden = false; barra.value = 0;
      driveNovo = await enviarVideoDrive(video, `${placa} - Vídeo - ${video.name}`, (pct) => {
        barra.value = pct;
        $('salvar').textContent = pct < 100 ? `Enviando vídeo… ${pct}%` : 'Finalizando…';
      });
    }
    await dados.salvar(editando?.id, editando ? campos : { id: idCarro, ...campos });
    carroSalvo = true;
    if (driveNovo) {
      try {
        await dados.salvarDocumento(null, { carro_id: idCarro, tipo: TIPO_VIDEO, descricao: null, validade: null, arquivo: null, nome_arquivo: null,
          link: `https://drive.google.com/file/d/${driveNovo}/view`, drive_id: driveNovo });
      } catch (e) {
        apagarNoDrive(driveNovo).catch(() => {}); // não deixa o vídeo solto no Drive
        throw new Error(`O carro foi salvo, mas o vídeo não foi registrado (${erroAmigavel(e)}). Envie o vídeo de novo pela aba Documentos.`);
      }
    }
    if (pdfAntigo && (pdf || removerPdf)) dados.removerArquivos(B_PDF, [pdfAntigo]).catch(() => {});
    dados.removerArquivos(B_FOTOS, comMiniaturas(fotosAntigas.filter((p) => !fotosAtuais.includes(p)))).catch(() => {});
    $('dialogo').close();
    await recarregar();
  } catch (e) {
    if (!carroSalvo) { // o carro NÃO foi salvo: desfaz os envios. Se foi, os arquivos já pertencem a ele.
      if (pdfNovo) dados.removerArquivos(B_PDF, [pdfNovo]).catch(() => {});
      dados.removerArquivos(B_FOTOS, comMiniaturas(enviadas)).catch(() => {});
      if (driveNovo && driveConectado()) apagarNoDrive(driveNovo).catch(() => {});
    }
    if (carroSalvo) { // o carro existe: fecha o formulário (salvar de novo daria "placa duplicada") e avisa
      $('dialogo').close();
      await recarregar().catch(() => {});
      alert(erroAmigavel(e));
    } else erro(erroAmigavel(e));
  } finally { $('salvar').disabled = false; $('salvar').textContent = 'Salvar'; $('carro-video-progresso').hidden = true; }
};

// ---------- Google Drive (opcional) ----------
// O vídeo sobe do celular direto para o Drive de quem está logado, numa pasta do site. O escopo
// "drive.file" só enxerga/apaga arquivos criados por este site, nunca o resto do Drive.
const ESCOPO_DRIVE = 'https://www.googleapis.com/auth/drive.file';
const PASTA_DRIVE = 'BH Locadora Vídeos';
const API_DRIVE = 'https://www.googleapis.com/drive/v3/files';
let tokenDrive = null; // só na memória; vale ~1 hora
const driveConectado = () => !!tokenDrive && tokenDrive.ate > Date.now() + 30000;
const authDrive = () => ({ Authorization: `Bearer ${tokenDrive.valor}` });

function carregarGoogle() {
  if (!usaDrive || document.getElementById('gsi')) return;
  const s = el('script', { id: 'gsi', src: 'https://accounts.google.com/gsi/client', async: true });
  s.onload = atualizarEstadoGoogle;
  document.head.append(s);
}

// Precisa ser chamada direto de um clique, senão o navegador bloqueia a janela do Google.
function conectarDrive() {
  return new Promise((ok, falha) => {
    if (driveConectado()) return ok();
    if (!window.google?.accounts?.oauth2) return falha(new Error('O login do Google ainda não carregou. Aguarde alguns segundos e tente de novo.'));
    google.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_ID,
      scope: ESCOPO_DRIVE,
      callback: (r) => {
        if (r.error) return falha(new Error(r.error === 'access_denied' ? 'Você não autorizou o acesso ao Drive.' : `Erro do Google: ${r.error}`));
        tokenDrive = { valor: r.access_token, ate: Date.now() + (Number(r.expires_in) || 3000) * 1000 };
        atualizarEstadoGoogle();
        ok();
      },
      error_callback: (e) => falha(new Error(e?.type === 'popup_closed' ? 'A janela do Google foi fechada antes de terminar.' : 'Não consegui abrir a janela do Google. Permita pop-ups para este site.')),
    }).requestAccessToken();
  });
}

function atualizarEstadoGoogle() {
  const ok = driveConectado();
  document.querySelectorAll('.google-estado').forEach((e) => {
    e.textContent = ok ? 'Google Drive: conectado ✓' : 'Google Drive: não conectado. A conexão vale por cerca de 1 hora.';
    e.classList.toggle('ok', ok);
  });
  document.querySelectorAll('.google-conectar').forEach((b) => { b.hidden = ok; });
}
document.querySelectorAll('.google-conectar').forEach((b) => {
  b.onclick = async () => {
    const msg = b.closest('form').querySelector('.erro');
    msg.textContent = '';
    try { await conectarDrive(); } catch (e) { msg.textContent = erroAmigavel(e); }
  };
});

async function erroDrive(r) {
  if (r.status === 401) { tokenDrive = null; atualizarEstadoGoogle(); return new Error('A conexão com o Google expirou. Toque em "Conectar ao Google Drive" e tente de novo.'); }
  let msg = '';
  try { msg = (await r.json())?.error?.message || ''; } catch { /* sem corpo */ }
  return new Error(`Google Drive recusou (${r.status}). ${msg}`.trim());
}

async function pastaDrive() {
  let id = null;
  try { id = localStorage.getItem('bhl_pasta_drive'); } catch { /* sem armazenamento */ }
  if (id) {
    const r = await fetch(`${API_DRIVE}/${encodeURIComponent(id)}?fields=id,trashed`, { headers: authDrive() });
    if (r.ok && !(await r.json()).trashed) return id;
  }
  const q = encodeURIComponent(`name='${PASTA_DRIVE}' and mimeType='application/vnd.google-apps.folder' and trashed=false`);
  const busca = await fetch(`${API_DRIVE}?q=${q}&fields=files(id)`, { headers: authDrive() });
  if (!busca.ok) throw await erroDrive(busca);
  id = (await busca.json()).files?.[0]?.id;
  if (!id) {
    const r = await fetch(`${API_DRIVE}?fields=id`, { method: 'POST', headers: { ...authDrive(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: PASTA_DRIVE, mimeType: 'application/vnd.google-apps.folder' }) });
    if (!r.ok) throw await erroDrive(r);
    id = (await r.json()).id;
  }
  try { localStorage.setItem('bhl_pasta_drive', id); } catch { /* sem armazenamento */ }
  return id;
}

// Envio em duas etapas: abre uma sessão no Google e manda o arquivo por ela, com barra de progresso.
async function enviarVideoDrive(arq, nome, aoProgredir) {
  if (!driveConectado()) throw new Error('Toque em "Conectar ao Google Drive" antes de enviar o vídeo.');
  const tipo = arq.type || 'video/mp4';
  const pasta = await pastaDrive();
  const ini = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id', {
    method: 'POST',
    headers: { ...authDrive(), 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': tipo, 'X-Upload-Content-Length': String(arq.size) },
    body: JSON.stringify({ name: nome, parents: [pasta] }),
  });
  if (!ini.ok) throw await erroDrive(ini);
  const sessao = ini.headers.get('Location');
  if (!sessao) throw new Error('O Google não devolveu o endereço de envio. Tente de novo.');
  return new Promise((ok, falha) => {
    const x = new XMLHttpRequest();
    x.open('PUT', sessao);
    x.setRequestHeader('Content-Type', tipo);
    x.upload.onprogress = (e) => { if (e.lengthComputable) aoProgredir(Math.round((e.loaded / e.total) * 100)); };
    x.onload = () => {
      if (x.status < 200 || x.status > 299) return falha(new Error(`Falha no envio do vídeo (${x.status}). Tente de novo.`));
      try { ok(JSON.parse(x.responseText).id); } catch { falha(new Error('Resposta inesperada do Google. Confira o Drive e tente de novo.')); }
    };
    x.onerror = () => falha(new Error('A conexão caiu durante o envio. Tente de novo, de preferência no Wi-Fi.'));
    x.send(arq);
  });
}

// Apaga o arquivo no Drive. Devolve false se o Google não achou o arquivo NESTA conta: ele pode já ter
// sido apagado, ou ter sido enviado por outra conta Google (o site só enxerga o que a conta conectada criou).
async function apagarNoDrive(id) {
  await conectarDrive();
  const r = await fetch(`${API_DRIVE}/${encodeURIComponent(id)}`, { method: 'DELETE', headers: authDrive() });
  if (r.ok) return true;
  if (r.status === 404) return false;
  throw await erroDrive(r);
}
// true = pode seguir e remover o registro do site; false = o usuário desistiu
async function apagarVideoDoDrive(id) {
  if (await apagarNoDrive(id)) return true;
  return confirm('O Google não encontrou este vídeo na conta conectada.\n\nEle pode já ter sido apagado, ou foi enviado por OUTRA conta Google (nesse caso, cancele, conecte com a conta certa e tente de novo).\n\nRemover só o registro do site, mesmo assim?');
}

// ---------- Documentos ----------
const nomeCarro = (c) => (c ? `${c.modelo} · ${c.placa}` : 'Carro removido');
const porModelo = (x, y) => x.modelo.localeCompare(y.modelo) || x.placa.localeCompare(y.placa);

function preencherSelect(sel, opcoes, valor) {
  sel.replaceChildren(...opcoes.map(([v, t]) => el('option', { value: v, textContent: t })));
  if (opcoes.some(([v]) => v === valor)) sel.value = valor;
}

// Vídeos (links) de carros cujo contrato já terminou: o site não apaga nada no Drive, só avisa.
function videosParaApagar() {
  const mapa = new Map(carros.map((c) => [c.id, c]));
  return docs.filter((d) => d.link && d.tipo === TIPO_VIDEO)
    .map((d) => ({ d, c: mapa.get(d.carro_id) }))
    .filter(({ c }) => c?.contrato_fim && diasAte(c.contrato_fim) < 0)
    .sort((x, y) => x.c.contrato_fim.localeCompare(y.c.contrato_fim));
}
function desenharLembrete() {
  const lista = docsErro ? [] : videosParaApagar();
  const aba = document.querySelector('.aba[data-aba=frota]');
  aba.replaceChildren('Frota', ...(lista.length ? [el('span', { className: 'contagem', textContent: String(lista.length), title: 'Vídeos para apagar' })] : []));
  const caixa = $('lembrete-videos');
  caixa.hidden = !lista.length;
  caixa.replaceChildren();
  if (!lista.length) return;
  caixa.append(
    el('strong', { textContent: `Vídeos para apagar (${lista.length})` }),
    el('p', { textContent: 'O contrato destes carros já terminou. Vídeos enviados pelo site podem ser apagados do Drive com um toque; nos de link, apague onde estiverem hospedados e clique em "Já apaguei".' }));
  for (const { d, c } of lista) {
    const dias = -diasAte(c.contrato_fim);
    const ver = el('a', { href: d.link, target: '_blank', rel: 'noopener noreferrer', textContent: 'Abrir vídeo' });
    const noDrive = !!d.drive_id;
    const feito = el('button', { type: 'button', className: 'sec', textContent: noDrive ? 'Apagar do Drive' : 'Já apaguei' });
    feito.onclick = async () => {
      const msg = noDrive ? `Apagar o vídeo de ${nomeCarro(c)} do seu Google Drive e do site?\n\nIsso não pode ser desfeito.`
        : `Confirma que o vídeo de ${nomeCarro(c)} já foi apagado de onde estava hospedado?\n\nO link será removido do site.`;
      if (!confirm(msg)) return;
      try {
        if (noDrive && !(await apagarVideoDoDrive(d.drive_id))) return;
        await dados.excluirDocumento(d.id);
        await recarregar();
      } catch (e) { alert(erroAmigavel(e)); }
    };
    caixa.append(el('div', { className: 'lembrete-item' },
      el('span', {}, el('b', { textContent: nomeCarro(c) }), ` · encerrado há ${dias} dia${dias === 1 ? '' : 's'}`),
      el('span', { className: 'lembrete-acoes' }, ver, feito)));
  }
}

// Cada documento guarda o próprio modelo e a placa. Só documentos antigos, que ainda apontam para um carro
// da Frota, usam o cadastro dele (o SQL de independência os converte).
const carroDoDoc = (d, mapa) => (d.placa ? { modelo: d.modelo || '', placa: d.placa } : mapa.get(d.carro_id) || null);
// A aba mostra tudo, menos os vídeos que pertencem a carros da Frota.
const docsDaAba = () => docs.filter((d) => !(d.carro_id && d.tipo === TIPO_VIDEO));
const fotosDoc = (d) => d.fotos || [];
const arquivosDoDoc = (d) => [d.arquivo, ...fotosDoc(d)].filter(Boolean);
// tipos fixos + tipos antigos que ainda existam nos dados (ex.: "Outro", que foi retirado do formulário)
const tiposDoFiltro = () => [...new Set([...TIPOS_DOC, ...docsDaAba().map((d) => d.tipo)])].filter((t) => t !== TIPO_VIDEO); // vídeo não é opção de filtro

function desenharDocs() {
  const lista = docsDaAba();
  const mapa = new Map(carros.map((c) => [c.id, c]));
  const carrosDosDocs = [...new Map(lista.map((d) => carroDoDoc(d, mapa)).filter(Boolean).map((c) => [c.placa, c])).values()].sort(porModelo);
  preencherSelect($('filtro-carro'), [['', 'Todos os carros'], ...carrosDosDocs.map((c) => [`placa:${c.placa}`, nomeCarro(c)])], $('filtro-carro').value);
  preencherSelect($('filtro-tipo'), [['', 'Todos os tipos'], ...tiposDoFiltro().map((t) => [t, t])], $('filtro-tipo').value);
  $('erro-docs').textContent = docsErro;
  $('novo-doc').disabled = !!docsErro;
  const fc = $('filtro-carro').value, ft = $('filtro-tipo').value;
  const termo = $('busca-doc').value.trim().toLowerCase();
  const doCarro = (d) => !fc || carroDoDoc(d, mapa)?.placa === fc.slice(6);
  const vis = lista.filter((d) => {
    const c = carroDoDoc(d, mapa);
    return doCarro(d) && (!ft || d.tipo === ft)
      && (!termo || `${c?.modelo || ''} ${c?.placa || ''} ${d.tipo}`.toLowerCase().includes(termo));
  }).sort((x, y) => {
    const cx = carroDoDoc(x, mapa), cy = carroDoDoc(y, mapa);
    return (cx && cy ? porModelo(cx, cy) : 0) || x.tipo.localeCompare(y.tipo);
  });
  $('resumo-docs').textContent = docsErro ? '' : `${vis.length} de ${lista.length} documento(s)`;
  const corpo = $('lista-docs');
  corpo.replaceChildren();
  if (!vis.length) {
    const msg = docsErro ? '' : lista.length ? 'Nenhum documento com esse filtro.' : 'Nenhum documento cadastrado ainda.';
    corpo.append(el('tr', {}, el('td', { colSpan: 5, className: 'vazio', textContent: msg })));
    return;
  }
  for (const d of vis) {
    const c = carroDoDoc(d, mapa);
    const abrir = []; // botões da coluna CRLV
    if (d.tipo === TIPO_FOTOS) {
      const ver = el('button', { className: 'link', textContent: `Ver fotos (${fotosDoc(d).length})` });
      ver.onclick = () => abrirGaleriaDe(nomeCarro(c), fotosDoc(d), B_DOCS);
      abrir.push(ver);
    } else if (d.link) abrir.push(el('a', { href: d.link, target: '_blank', rel: 'noopener noreferrer', textContent: 'Assistir' }));
    else if (d.arquivo) {
      const exibir = el('button', { className: 'link', textContent: 'Exibir', title: d.nome_arquivo || '' });
      exibir.onclick = () => abrirArquivo(B_DOCS, d.arquivo);
      const baixar = el('button', { className: 'link', textContent: 'Baixar' });
      baixar.onclick = () => baixarArquivo(B_DOCS, d.arquivo, nomeDownload(d));
      abrir.push(exibir, baixar);
    }
    const editar = el('button', { className: 'link', textContent: 'Editar' });
    editar.onclick = () => abrirFormDoc(d);
    const excluir = el('button', { className: 'perigo', textContent: 'Excluir' });
    excluir.onclick = async () => {
      const aviso = d.drive_id ? '\n\nO vídeo também será apagado do seu Google Drive.' : '';
      if (!confirm(`Excluir o documento "${d.tipo}" de ${nomeCarro(c)}?${aviso}`)) return;
      try {
        if (d.drive_id && !(await apagarVideoDoDrive(d.drive_id))) return;
        await dados.excluirDocumento(d.id);
        dados.removerArquivos(B_DOCS, arquivosDoDoc(d)).catch(() => {});
        await recarregar();
      } catch (e) { alert(erroAmigavel(e)); }
    };
    const tipo = el('td', { className: 'doc-nome' }, el('strong', { textContent: d.tipo }));
    if (d.descricao) tipo.append(el('span', { className: 'doc-desc', textContent: d.descricao })); // documentos antigos
    corpo.append(el('tr', { className: 'linha-doc' },
      el('td', { className: 'doc-carro', textContent: c?.modelo || '—' }),
      el('td', { className: 'doc-placa', textContent: c?.placa || '—' }),
      tipo,
      rotulo(el('td', { className: 'doc-acoes-arquivo' }, ...abrir), d.tipo === TIPO_VIDEO ? 'Vídeo' : d.tipo === TIPO_FOTOS ? 'Fotos' : TIPOS_DOC.includes(d.tipo) ? 'CRLV' : 'Arquivo'),
      el('td', { className: 'acoes-linha' }, editar, excluir)));
  }
}
$('filtro-carro').onchange = desenharDocs;
$('filtro-tipo').onchange = desenharDocs;
$('busca-doc').oninput = desenharDocs;

// ----- fotos de um documento do tipo "Fotos" -----
let editandoDoc = null;
let fotosDocAtuais = []; // caminhos já salvos que continuam
let fotosDocNovas = [];  // arquivos escolhidos agora
let urlsDocAtuais = new Map();
let urlsDocNovas = [];

function desenharFotosDoc() {
  urlsDocNovas.forEach((u) => URL.revokeObjectURL(u));
  urlsDocNovas = fotosDocNovas.map((f) => URL.createObjectURL(f));
  const grade = $('doc-fotos-grade');
  grade.replaceChildren();
  const item = (src, alt, aoRemover) => {
    const x = el('button', { type: 'button', className: 'x', textContent: '×', title: 'Remover foto', ariaLabel: `Remover ${alt}` });
    x.onclick = aoRemover;
    return el('div', { className: 'foto-item' }, el('img', { src, alt }), x);
  };
  fotosDocAtuais.forEach((p, i) => grade.append(item(urlsDocAtuais.get(p) || '', `foto ${i + 1}`, () => { fotosDocAtuais = fotosDocAtuais.filter((x) => x !== p); desenharFotosDoc(); })));
  fotosDocNovas.forEach((f, i) => {
    const it = item(urlsDocNovas[i], f.name, () => { fotosDocNovas.splice(i, 1); desenharFotosDoc(); });
    it.querySelector('img').onerror = () => { // arquivo que não abre como imagem sai da lista
      fotosDocNovas = fotosDocNovas.filter((x) => x !== f);
      $('erro-doc').textContent = `"${f.name}" não é uma imagem válida e foi removida.`;
      desenharFotosDoc();
    };
    grade.append(it);
  });
  $('doc-fotos-contagem').textContent = `${fotosDocAtuais.length + fotosDocNovas.length} de ${MAX_FOTOS} fotos`;
}
$('doc-fotos-botao').onclick = () => $('doc-fotos-input').click();
$('doc-fotos-input').onchange = (ev) => {
  const erro = [];
  for (const f of ev.target.files) {
    if (fotosDocAtuais.length + fotosDocNovas.length >= MAX_FOTOS) { erro.push(`Máximo de ${MAX_FOTOS} fotos por documento.`); break; }
    if (!f.type.startsWith('image/')) { erro.push(`"${f.name}" não é uma imagem.`); continue; }
    if (f.size > MAX_FOTO_ORIGINAL) { erro.push(`"${f.name}" é grande demais (máximo 30 MB).`); continue; }
    fotosDocNovas.push(f);
  }
  ev.target.value = '';
  desenharFotosDoc();
  if (erro.length) $('erro-doc').textContent = erro.join(' ');
};

async function abrirFormDoc(d = null) {
  editandoDoc = d;
  $('titulo-doc').textContent = d ? 'Editar documento' : 'Novo documento';
  const f = $('form-doc');
  // Modelo e placa são sempre digitados. Ao editar, ou ao abrir com um carro filtrado, já vêm preenchidos.
  const filtro = $('filtro-carro').value;
  const mapa = new Map(carros.map((c) => [c.id, c]));
  const origem = d ? carroDoDoc(d, mapa)
    : filtro ? docsDaAba().map((x) => carroDoDoc(x, mapa)).find((c) => c?.placa === filtro.slice(6)) : null;
  f.modelo_doc.value = origem?.modelo || '';
  f.placa_doc.value = origem?.placa || '';
  // documento antigo com um tipo que saiu da lista (ex.: "Outro") continua editável sem perder o tipo
  const tipos = d && !TIPOS_DOC.includes(d.tipo) ? [...TIPOS_DOC, d.tipo] : TIPOS_DOC;
  preencherSelect($('doc-tipo'), tipos.map((t) => [t, t]), d?.tipo);
  f.arquivo.value = '';
  f.link.value = d?.link || ''; // o campo fica oculto quando o envio para o Drive está ligado; o valor é mantido
  f.video.value = '';
  fotosDocAtuais = d ? [...fotosDoc(d)] : [];
  fotosDocNovas = [];
  urlsDocAtuais = new Map();
  $('video-progresso').hidden = true;
  $('doc-atual').textContent = d?.arquivo ? `Arquivo atual: ${d.nome_arquivo}. Escolher outro arquivo substitui este.` : '';
  $('erro-doc').textContent = '';
  atualizarFormDoc();
  desenharFotosDoc();
  $('dialogo-doc').showModal();
  if (fotosDocAtuais.length) {
    try { urlsDocAtuais = await urlsComCache(B_DOCS, fotosDocAtuais); desenharFotosDoc(); } catch { /* miniaturas são opcionais */ }
  }
}
// Cada tipo mostra só o que usa: PDF/foto, várias fotos, ou vídeo (envio para o Drive).
function atualizarFormDoc() {
  const tipo = $('doc-tipo').value;
  const video = tipo === TIPO_VIDEO;
  const fotos = tipo === TIPO_FOTOS;
  $('rotulo-arquivo').hidden = video || fotos;
  $('bloco-fotos-doc').hidden = !fotos;
  $('bloco-video').hidden = !(video && usaDrive);
  $('rotulo-link').hidden = !(video && !usaDrive); // o link só aparece se o envio direto estiver desligado
  atualizarEstadoGoogle();
  $('doc-atual').hidden = video || fotos || !$('doc-atual').textContent;
}
$('doc-tipo').onchange = atualizarFormDoc;
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
  let carro_id = null;
  let modeloDoc = f.modelo_doc.value.trim();
  let placaDoc = f.placa_doc.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const tipo = f.tipo.value;
  const ehVideo = tipo === TIPO_VIDEO;
  const ehFotos = tipo === TIPO_FOTOS;
  const link = f.link.value.trim();
  const arq = ehVideo || ehFotos ? null : f.arquivo.files[0] || null;
  const video = ehVideo && usaDrive ? f.video.files[0] || null : null;
  if (!modeloDoc) return erro('Informe o modelo do carro.');
  if (!PLACA_RE.test(placaDoc)) return erro('Placa inválida (ex.: ABC1D23 ou ABC1234).');
  if (ehFotos) {
    if (!fotosDocAtuais.length && !fotosDocNovas.length) return erro('Escolha pelo menos uma foto.');
  } else if (ehVideo && video) {
    if (!video.type.startsWith('video/')) return erro('O arquivo escolhido não é um vídeo.');
    if (!driveConectado()) return erro('Toque em "Conectar ao Google Drive" antes de enviar o vídeo.');
  } else if (ehVideo) {
    if (!link) return erro(usaDrive ? 'Escolha o vídeo do celular para enviar.' : 'Cole o link do vídeo (ex.: do Google Drive).');
    if (!/^https?:\/\//i.test(link)) return erro('O link deve começar com http:// ou https://');
  } else if (!arq && !editandoDoc?.arquivo) return erro('Anexe o arquivo do documento (PDF ou foto).');
  const antigo = editandoDoc?.arquivo || null;
  const antigoDrive = editandoDoc?.drive_id || null;
  const fotosAntigas = editandoDoc ? fotosDoc(editandoDoc) : [];
  const enviadas = []; // fotos subidas agora; apagadas se o salvamento falhar
  let novo = null;
  let driveNovo = null;
  $('doc-salvar').disabled = true;
  try {
    // "descricao" e "locatario" não são mais preenchidos aqui: ficam de fora para não apagar os de documentos antigos
    const campos = { carro_id, modelo: modeloDoc, placa: placaDoc, tipo, link: ehVideo ? link : null, drive_id: null, fotos: [] };
    if (ehVideo && video) {
      const carro = carros.find((c) => c.id === carro_id);
      const barra = $('video-progresso');
      barra.hidden = false; barra.value = 0;
      driveNovo = await enviarVideoDrive(video, `${carro?.placa || placaDoc || 'carro'} - ${tipo} - ${video.name}`, (pct) => {
        barra.value = pct;
        $('doc-salvar').textContent = pct < 100 ? `Enviando vídeo… ${pct}%` : 'Finalizando…';
      });
      Object.assign(campos, { link: `https://drive.google.com/file/d/${driveNovo}/view`, drive_id: driveNovo });
    } else if (ehVideo && editandoDoc?.drive_id && link === editandoDoc.link) {
      campos.drive_id = editandoDoc.drive_id; // editou só os dados: o vídeo continua o mesmo no Drive
    }
    if (ehFotos) {
      for (const [i, foto] of fotosDocNovas.entries()) {
        $('doc-salvar').textContent = `Enviando foto ${i + 1}/${fotosDocNovas.length}…`;
        enviadas.push(await dados.enviarArquivo(B_DOCS, await reduzirFoto(foto, 1600, 0.82), 'jpg', 'image/jpeg'));
      }
      Object.assign(campos, { fotos: [...fotosDocAtuais, ...enviadas], arquivo: null, nome_arquivo: null, link: null });
    } else if (ehVideo) {
      Object.assign(campos, { arquivo: null, nome_arquivo: null });
    } else if (arq) {
      const p = await prepararDocumento(arq);
      novo = await dados.enviarArquivo(B_DOCS, p.blob, p.ext, p.mime);
      Object.assign(campos, { arquivo: novo, nome_arquivo: p.nome });
    }
    await dados.salvarDocumento(editandoDoc?.id, campos);
    // apaga o que deixou de ser usado: fotos removidas e arquivo substituído ou trocado de formato
    const manter = new Set(campos.fotos);
    const sobras = fotosAntigas.filter((p) => !manter.has(p));
    if (antigo && (novo || ehVideo || ehFotos)) sobras.push(antigo);
    if (sobras.length) dados.removerArquivos(B_DOCS, sobras).catch(() => {});
    if (antigoDrive && antigoDrive !== campos.drive_id && driveConectado()) apagarNoDrive(antigoDrive).catch(() => {});
    $('dialogo-doc').close();
    await recarregar();
  } catch (e) {
    const soltos = [novo, ...enviadas].filter(Boolean);
    if (soltos.length) dados.removerArquivos(B_DOCS, soltos).catch(() => {});
    if (driveNovo && driveConectado()) apagarNoDrive(driveNovo).catch(() => {}); // não deixa vídeo solto no Drive
    erro(erroAmigavel(e));
  } finally { $('doc-salvar').disabled = false; $('doc-salvar').textContent = 'Salvar'; $('video-progresso').hidden = true; }
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
carregarGoogle();

mostrarTela();
