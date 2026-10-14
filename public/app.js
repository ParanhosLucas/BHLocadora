const $ = (id) => document.getElementById(id);
const cfg = window.CONFIG || {};
const demo = !cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY;
const PLACA_RE = /^[A-Z]{3}[0-9][A-Z0-9][0-9]{2}$/;
const B_PDF = 'contratos';
const B_FOTOS = 'fotos';
const MAX_PDF = 10 * 1024 * 1024; // 10 MB, igual ao limite do bucket
const MAX_FOTOS = 8;              // fotos por carro
const MAX_FOTO_ORIGINAL = 30 * 1024 * 1024; // limite do arquivo escolhido, antes de reduzir
const LADO_MAX = 1600;            // px do maior lado depois de reduzir

// ---------- Camada de dados: Supabase, ou localStorage/memória no modo demonstração ----------
const sb = demo ? null : window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);

const lerDemo = () => { try { return JSON.parse(localStorage.getItem('bhl_demo')) || []; } catch { return []; } };
const gravarDemo = (l) => { try { localStorage.setItem('bhl_demo', JSON.stringify(l)); } catch { /* sem armazenamento */ } };
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
    if (demo) return gravarDemo(lerDemo().filter((x) => x.id !== id));
    const { error } = await sb.from('carros').delete().eq('id', id);
    if (error) throw error;
  },
  // ----- arquivos (PDF e fotos), em espaços privados do Storage -----
  async enviarArquivo(bucket, arquivo, ext, tipo) {
    const caminho = `${crypto.randomUUID()}.${ext}`;
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

// Reduz a foto (celular costuma gerar 3–10 MB) e converte para JPEG, respeitando a rotação.
async function reduzirFoto(arquivo) {
  let bmp;
  try { bmp = await createImageBitmap(arquivo, { imageOrientation: 'from-image' }); }
  catch { throw new Error(`Não consegui ler a imagem "${arquivo.name}". Use JPG, PNG ou WebP.`); }
  const esc = Math.min(1, LADO_MAX / Math.max(bmp.width, bmp.height));
  const cv = document.createElement('canvas');
  cv.width = Math.max(1, Math.round(bmp.width * esc));
  cv.height = Math.max(1, Math.round(bmp.height * esc));
  cv.getContext('2d').drawImage(bmp, 0, 0, cv.width, cv.height);
  bmp.close?.();
  const blob = await new Promise((ok) => cv.toBlob(ok, 'image/jpeg', 0.82));
  if (!blob) throw new Error(`Não consegui processar a imagem "${arquivo.name}".`);
  return blob;
}

// ---------- Lista ----------
let carros = [];
let editando = null;
let miniaturas = new Map(); // caminho da 1ª foto -> URL temporária
const fotosDe = (c) => c.fotos || [];

// Abre a aba antes do await, senão o navegador bloqueia o pop-up.
async function abrirPdf(caminho) {
  const aba = window.open('about:blank', '_blank');
  if (!aba) return alert('O navegador bloqueou a nova aba. Permita pop-ups para este site e tente de novo.');
  try {
    const url = (await dados.urlsArquivos(B_PDF, [caminho])).get(caminho);
    if (!url) throw new Error('Não foi possível abrir o PDF. No modo demonstração ele só fica disponível até recarregar a página.');
    aba.opener = null;
    aba.location.href = url;
  } catch (e) { aba.close(); alert(erroAmigavel(e)); }
}

function celulaFoto(c) {
  const fotos = fotosDe(c);
  const url = fotos.length && miniaturas.get(fotos[0]);
  if (!url) return el('td', { className: 'foto-celula' }, el('span', { className: 'sem-foto', textContent: fotos.length ? '…' : '—' }));
  const b = el('button', { className: 'mini', title: `Ver ${fotos.length} foto(s)` }, el('img', { src: url, alt: `Foto de ${c.modelo} ${c.placa}` }));
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
    const excluir = el('button', { className: 'perigo', textContent: 'Excluir' });
    excluir.onclick = async () => {
      if (!confirm(`Excluir ${c.modelo} (${c.placa})?`)) return;
      try {
        await dados.excluir(c.id);
        if (c.contrato_arquivo) dados.removerArquivos(B_PDF, [c.contrato_arquivo]).catch(() => {});
        dados.removerArquivos(B_FOTOS, fotosDe(c)).catch(() => {});
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
      el('td', { className: 'acoes-linha' }, editar, excluir)));
  }
}

async function recarregar() {
  carros = await dados.listar();
  const primeiras = carros.map((c) => fotosDe(c)[0]).filter(Boolean);
  try { miniaturas = await dados.urlsArquivos(B_FOTOS, primeiras); } catch { miniaturas = new Map(); }
  desenhar();
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
    const mapa = await dados.urlsArquivos(B_FOTOS, fotos);
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
  fotosAtuais.forEach((p, i) => grade.append(item(urlsAtuais.get(p) || '', `foto ${i + 1}`, () => { fotosAtuais = fotosAtuais.filter((x) => x !== p); desenharFotosForm(); })));
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
    try { urlsAtuais = await dados.urlsArquivos(B_FOTOS, fotosAtuais); desenharFotosForm(); } catch { /* miniaturas são opcionais */ }
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
      enviadas.push(await dados.enviarArquivo(B_FOTOS, await reduzirFoto(arq), 'jpg', 'image/jpeg'));
    }
    campos.fotos = [...fotosAtuais, ...enviadas];
    await dados.salvar(editando?.id, campos);
    if (pdfAntigo && (pdf || removerPdf)) dados.removerArquivos(B_PDF, [pdfAntigo]).catch(() => {});
    dados.removerArquivos(B_FOTOS, fotosAntigas.filter((p) => !fotosAtuais.includes(p))).catch(() => {});
    $('dialogo').close();
    await recarregar();
  } catch (e) {
    if (pdfNovo) dados.removerArquivos(B_PDF, [pdfNovo]).catch(() => {});
    dados.removerArquivos(B_FOTOS, enviadas).catch(() => {});
    erro(erroAmigavel(e));
  } finally { $('salvar').disabled = false; $('salvar').textContent = 'Salvar'; }
};

// ---------- Login e início ----------
async function mostrarTela() {
  const logado = await dados.sessao();
  $('tela-login').hidden = logado;
  $('tela-painel').hidden = !logado;
  $('sair').hidden = !logado || demo;
  if (logado) {
    try { await recarregar(); } catch (e) { $('resumo').textContent = erroAmigavel(e); }
  }
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
$('sair').onclick = async () => { await dados.sair(); await mostrarTela(); };
$('aviso-demo').hidden = !demo;

mostrarTela();
