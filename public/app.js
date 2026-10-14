const $ = (id) => document.getElementById(id);
const cfg = window.CONFIG || {};
const demo = !cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY;
const PLACA_RE = /^[A-Z]{3}[0-9][A-Z0-9][0-9]{2}$/;

// ---------- Camada de dados: Supabase, ou localStorage no modo demonstração ----------
const sb = demo ? null : window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);

const lerDemo = () => { try { return JSON.parse(localStorage.getItem('bhl_demo')) || []; } catch { return []; } };
const gravarDemo = (l) => { try { localStorage.setItem('bhl_demo', JSON.stringify(l)); } catch { /* sem armazenamento */ } };

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
};

// ---------- Interface ----------
let carros = [];
let editando = null;

const el = (tag, props = {}, ...filhos) => {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...filhos);
  return e;
};

function desenhar() {
  const termo = $('busca').value.trim().toLowerCase().replace(/[^a-z0-9 ]/g, '');
  const vis = carros.filter((c) => !termo || `${c.placa} ${c.modelo}`.toLowerCase().includes(termo));
  $('resumo').textContent = `${vis.length} de ${carros.length} carro(s)`;
  const corpo = $('lista');
  corpo.replaceChildren();
  if (!vis.length) {
    corpo.append(el('tr', {}, el('td', { colSpan: 5, className: 'vazio', textContent: carros.length ? 'Nenhum carro encontrado.' : 'Nenhum carro cadastrado ainda.' })));
    return;
  }
  for (const c of vis) {
    const contrato = c.contrato_url
      ? el('a', { href: c.contrato_url, target: '_blank', rel: 'noopener noreferrer', textContent: 'Abrir' })
      : el('span', { textContent: '—' });
    const editar = el('button', { className: 'link', textContent: 'Editar' });
    editar.onclick = () => abrirForm(c);
    const excluir = el('button', { className: 'perigo', textContent: 'Excluir' });
    excluir.onclick = async () => {
      if (!confirm(`Excluir ${c.modelo} (${c.placa})?`)) return;
      try { await dados.excluir(c.id); await recarregar(); } catch (e) { alert(erroAmigavel(e)); }
    };
    corpo.append(el('tr', {},
      el('td', { className: 'placa', textContent: c.placa }),
      el('td', { textContent: c.modelo }),
      el('td', { className: 'num', textContent: c.km.toLocaleString('pt-BR') }),
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
  f.contrato_url.value = c?.contrato_url || '';
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
  const link = f.contrato_url.value.trim();
  const erro = (m) => { $('erro-form').textContent = m; };
  if (!PLACA_RE.test(placa)) return erro('Placa inválida (ex.: ABC1D23 ou ABC1234).');
  if (!modelo) return erro('Informe o modelo.');
  if (!Number.isInteger(km) || km < 0) return erro('Km deve ser um número inteiro, 0 ou maior.');
  if (link && !/^https?:\/\//i.test(link)) return erro('O link do contrato deve começar com http:// ou https://');
  try {
    await dados.salvar(editando?.id, { placa, modelo, km, contrato_url: link || null });
    $('dialogo').close();
    await recarregar();
  } catch (e) { erro(erroAmigavel(e)); }
};

$('novo').onclick = () => abrirForm();
$('cancelar').onclick = () => $('dialogo').close();
$('busca').oninput = desenhar;
$('sair').onclick = async () => { await dados.sair(); await mostrarTela(); };
$('aviso-demo').hidden = !demo;

mostrarTela();
