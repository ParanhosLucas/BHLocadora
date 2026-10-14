const $ = (id) => document.getElementById(id);
const cfg = window.CONFIG || {};
const demo = !cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY;
const PLACA_RE = /^[A-Z]{3}[0-9][A-Z0-9][0-9]{2}$/;
const BUCKET = 'contratos';
const MAX_PDF = 10 * 1024 * 1024; // 10 MB, igual ao limite do bucket

// ---------- Camada de dados: Supabase, ou localStorage no modo demonstração ----------
const sb = demo ? null : window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);

const lerDemo = () => { try { return JSON.parse(localStorage.getItem('bhl_demo')) || []; } catch { return []; } };
const gravarDemo = (l) => { try { localStorage.setItem('bhl_demo', JSON.stringify(l)); } catch { /* sem armazenamento */ } };

const pdfsDemo = new Map(); // modo demonstração: PDFs só ficam na memória, até recarregar a página

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
  async enviarPdf(arquivo) {
    const caminho = `${crypto.randomUUID()}.pdf`;
    if (demo) { pdfsDemo.set(caminho, arquivo); return caminho; }
    const { error } = await sb.storage.from(BUCKET).upload(caminho, arquivo, { contentType: 'application/pdf', upsert: false });
    if (error) throw error;
    return caminho;
  },
  async removerPdf(caminho) {
    if (demo) { pdfsDemo.delete(caminho); return; }
    const { error } = await sb.storage.from(BUCKET).remove([caminho]);
    if (error) throw error;
  },
  async urlPdf(caminho) {
    if (demo) {
      const f = pdfsDemo.get(caminho);
      if (!f) throw new Error('No modo demonstração o PDF só fica disponível até recarregar a página.');
      return URL.createObjectURL(f);
    }
    const { data, error } = await sb.storage.from(BUCKET).createSignedUrl(caminho, 120);
    if (error) throw error;
    return data.signedUrl;
  },
  async excluir(id) {
    if (demo) return gravarDemo(lerDemo().filter((x) => x.id !== id));
    const { error } = await sb.from('carros').delete().eq('id', id);
    if (error) throw error;
  },
};

// ---------- Interface ----------
let carros = [];
let editando = null;

// Datas "YYYY-MM-DD" são tratadas como datas de calendário, sem fuso horário.
const fmtData = (d) => (d ? d.split('-').reverse().join('/') : '—');
const diasAte = (d) => {
  const [y, m, dia] = d.split('-').map(Number);
  const hoje = new Date();
  return Math.round((new Date(y, m - 1, dia) - new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate())) / 86400000);
};
function celulaFim(d) {
  const td = el('td', { textContent: fmtData(d) });
  if (!d) return td;
  const n = diasAte(d);
  if (n < 0) td.append(el('span', { className: 'etiqueta vencido', textContent: 'Vencido' }));
  else if (n <= 30) td.append(el('span', { className: 'etiqueta', textContent: n === 0 ? 'Vence hoje' : `Vence em ${n}d` }));
  return td;
}

const el = (tag, props = {}, ...filhos) => {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...filhos);
  return e;
};

// Abre a aba antes do await, senão o navegador bloqueia o pop-up.
async function abrirPdf(caminho) {
  const aba = window.open('about:blank', '_blank');
  if (!aba) return alert('O navegador bloqueou a nova aba. Permita pop-ups para este site e tente de novo.');
  try {
    const url = await dados.urlPdf(caminho);
    aba.opener = null;
    aba.location.href = url;
  } catch (e) { aba.close(); alert(erroAmigavel(e)); }
}

function desenhar() {
  const termo = $('busca').value.trim().toLowerCase().replace(/[^a-z0-9 ]/g, '');
  const vis = carros.filter((c) => !termo || `${c.placa} ${c.modelo}`.toLowerCase().includes(termo));
  $('resumo').textContent = `${vis.length} de ${carros.length} carro(s)`;
  const corpo = $('lista');
  corpo.replaceChildren();
  if (!vis.length) {
    corpo.append(el('tr', {}, el('td', { colSpan: 7, className: 'vazio', textContent: carros.length ? 'Nenhum carro encontrado.' : 'Nenhum carro cadastrado ainda.' })));
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
        if (c.contrato_arquivo) dados.removerPdf(c.contrato_arquivo).catch(() => {});
        await recarregar();
      } catch (e) { alert(erroAmigavel(e)); }
    };
    corpo.append(el('tr', {},
      el('td', { className: 'placa', textContent: c.placa }),
      el('td', { textContent: c.modelo }),
      el('td', { className: 'num', textContent: c.km.toLocaleString('pt-BR') }),
      el('td', { textContent: fmtData(c.contrato_inicio) }),
      celulaFim(c.contrato_fim),
      el('td', {}, contrato),
      el('td', { className: 'acoes-linha' }, editar, excluir)));
  }
}

async function recarregar() {
  carros = await dados.listar();
  desenhar();
}

function abrirForm(c = null) {
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
  $('erro-form').textContent = '';
  $('dialogo').showModal();
  f.placa.focus();
}

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
  const antigo = editando?.contrato_arquivo || null;
  let novo = null;
  $('salvar').disabled = true;
  try {
    if (pdf) {
      novo = await dados.enviarPdf(pdf);
      Object.assign(campos, { contrato_arquivo: novo, contrato_nome: pdf.name, contrato_url: null });
    } else if (removerPdf) {
      Object.assign(campos, { contrato_arquivo: null, contrato_nome: null });
    }
    await dados.salvar(editando?.id, campos);
    if (antigo && (pdf || removerPdf)) dados.removerPdf(antigo).catch(() => {});
    $('dialogo').close();
    await recarregar();
  } catch (e) {
    if (novo) dados.removerPdf(novo).catch(() => {}); // não deixa PDF órfão se o cadastro falhou
    erro(erroAmigavel(e));
  } finally { $('salvar').disabled = false; }
};

$('novo').onclick = () => abrirForm();
$('cancelar').onclick = () => $('dialogo').close();
$('busca').oninput = desenhar;
$('sair').onclick = async () => { await dados.sair(); await mostrarTela(); };
$('aviso-demo').hidden = !demo;

mostrarTela();
