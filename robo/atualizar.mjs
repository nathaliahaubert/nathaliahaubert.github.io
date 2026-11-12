// Robô do link na bio. Roda no GitHub (de 3 em 3 horas) e:
// 1) pega o último vídeo do YouTube (sem Shorts)
// 2) pega os últimos posts do Instagram pelo Behold (API oficial, dentro das regras)
// 3) lê a planilha de cupons e produtos, se ela estiver publicada
// 4) cria os links curtos (ex.: /creamy) que contam clique e mandam pra loja
// Se alguma parte falhar, ele mantém o que já estava e segue.

import fs from 'node:fs/promises';

const SITE = new URL('../site/', import.meta.url);
const ler = (p) => fs.readFile(new URL(p, SITE), 'utf8');
const gravar = (p, s) => fs.writeFile(new URL(p, SITE), s);
const lerJSON = async (p, padrao) => { try { return JSON.parse(await ler(p)); } catch { return padrao; } };
const urlOk = (u) => /^https?:\/\//i.test(String(u || '').trim());
const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const esc = (s) => String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const xml = (s) => String(s || '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');

async function baixar(url) {
  const r = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 (link-na-bio)', 'accept-language': 'pt-BR,pt;q=0.9' } });
  if (!r.ok) throw new Error(r.status + ' em ' + url.split('?')[0]);
  return r.text();
}

const html = await ler('index.html');
const CFG = JSON.parse(html.match(/<script id="config" type="application\/json">([\s\S]*?)<\/script>/)[1]);
const feed = await lerJSON('data/feed.json', {});

// 1) YouTube
try {
  let canal = CFG.youtubeCanalId;
  if (!canal) {
    const pagina = await baixar('https://www.youtube.com/@' + CFG.youtube);
    canal = (pagina.match(/"externalId":"(UC[\w-]{22})"/) || pagina.match(/youtube\.com\/channel\/(UC[\w-]{22})/) || [])[1];
  }
  if (!canal) throw new Error('não achei o canal');
  const rss = await baixar('https://www.youtube.com/feeds/videos.xml?channel_id=' + canal);
  const videos = rss.split('<entry>').slice(1);
  const v = videos.find((e) => !/\/shorts\//.test(e)) || videos[0];
  if (v) {
    const pega = (re) => xml((v.match(re) || [])[1]);
    feed.youtube = { id: pega(/<yt:videoId>([^<]+)/), titulo: pega(/<title>([^<]*)/), data: pega(/<published>([^<]+)/) };
    console.log('YouTube ok:', feed.youtube.titulo);
  }
} catch (e) { console.log('YouTube ficou como estava:', e.message); }

// 2) Instagram (Behold)
if (urlOk(process.env.BEHOLD_FEED_URL)) {
  try {
    const j = JSON.parse(await baixar(process.env.BEHOLD_FEED_URL));
    const posts = Array.isArray(j) ? j : (j.posts || []);
    feed.instagram = posts.slice(0, 6).map((p) => ({
      link: p.permalink,
      img: (p.sizes && (p.sizes.medium || p.sizes.small || p.sizes.large) || {}).mediaUrl || p.thumbnailUrl || p.mediaUrl,
      legenda: String(p.prunedCaption || p.caption || '').slice(0, 120)
    })).filter((p) => urlOk(p.link) && urlOk(p.img));
    if (j.followersCount) feed.instagramSeguidores = j.followersCount;
    console.log('Instagram ok:', feed.instagram.length, 'posts');
  } catch (e) { console.log('Instagram ficou como estava:', e.message); }
}

feed.atualizado = new Date().toISOString().slice(0, 10); // um registro por dia mantém o robô ativo
await gravar('data/feed.json', JSON.stringify(feed, null, 2) + '\n');

// 3) Planilha
function lerCSV(t) {
  const linhas = []; let linha = [], campo = '', aspas = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (aspas) { if (c === '"') { if (t[i + 1] === '"') { campo += '"'; i++; } else aspas = false; } else campo += c; }
    else if (c === '"') aspas = true;
    else if (c === ',') { linha.push(campo); campo = ''; }
    else if (c === '\n') { linha.push(campo); linhas.push(linha); linha = []; campo = ''; }
    else if (c !== '\r') campo += c;
  }
  if (campo || linha.length) { linha.push(campo); linhas.push(linha); }
  return linhas;
}
if (urlOk(CFG.planilhaCsv)) {
  try {
    const linhas = lerCSV(await baixar(CFG.planilhaCsv));
    const cab = (linhas.shift() || []).map(norm);
    const col = (r, ...nomes) => { for (const n of nomes) { const i = cab.indexOf(n); if (i > -1 && r[i]) return r[i].trim(); } return ''; };
    const out = { cupons: [], produtos: [] };
    for (const r of linhas) {
      const tipo = norm(col(r, 'tipo'));
      if (!tipo) continue;
      const item = { secao: col(r, 'secao'), marca: col(r, 'marca'), nome: col(r, 'nome'), cupom: col(r, 'cupom'), link: col(r, 'link'), foto: col(r, 'foto'), linkCurto: col(r, 'link curto', 'link_curto') };
      (tipo.startsWith('cupom') ? out.cupons : out.produtos).push(item);
    }
    // fotos que vêm por link são baixadas pro site, assim não somem se a loja mudar o endereço
    await fs.mkdir(new URL('img/produtos/', SITE), { recursive: true });
    for (const p of out.produtos) {
      if (!urlOk(p.foto)) continue;
      const nome = (norm(p.marca + '-' + p.nome).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'produto').slice(0, 60);
      try {
        const r = await fetch(p.foto, { headers: { 'user-agent': 'Mozilla/5.0 (link-na-bio)' } });
        const tipo = r.headers.get('content-type') || '';
        if (!r.ok || !tipo.startsWith('image/')) throw new Error(r.status + ' ' + tipo);
        const ext = tipo.includes('png') ? 'png' : tipo.includes('webp') ? 'webp' : 'jpg';
        await fs.writeFile(new URL('img/produtos/' + nome + '.' + ext, SITE), Buffer.from(await r.arrayBuffer()));
        p.foto = 'img/produtos/' + nome + '.' + ext;
      } catch (e) { console.log('Foto de', p.nome, 'não baixou, fica o link:', e.message); }
    }
    if (out.cupons.length || out.produtos.length) {
      await gravar('data/conteudo.json', JSON.stringify(out, null, 2) + '\n');
      console.log('Planilha ok:', out.cupons.length, 'cupons e', out.produtos.length, 'produtos');
    }
  } catch (e) { console.log('Planilha ficou como estava:', e.message); }
}

// 4) Links curtos
const RESERVADOS = new Set(['img', 'data', 'fontes', 'robo', 'index', 'assets', 'fonts', '404']);
const slug = (s) => norm(s).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const conteudo = await lerJSON('data/conteudo.json', { cupons: [], produtos: [] });
const itens = [...(conteudo.cupons || []), ...(conteudo.produtos || [])]
  .map((i) => ({ ...i, s: slug(i.linkCurto) }))
  .filter((i) => i.s && !RESERVADOS.has(i.s) && urlOk(i.link));
const unicos = [...new Map(itens.map((i) => [i.s, i])).values()];
const antigos = await lerJSON('data/links-curtos.json', []);
for (const s of antigos) if (!unicos.some((i) => i.s === s)) await fs.rm(new URL(s + '/', SITE), { recursive: true, force: true });
for (const i of unicos) {
  const destino = esc(i.link.trim());
  const contador = CFG.umamiId ? '<script defer src="https://cloud.umami.is/script.js" data-website-id="' + esc(CFG.umamiId) + '" data-auto-track="false"></script>' : '';
  const pagina = '<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>Indo para ' + esc(i.marca || i.nome) + '</title>' + contador +
    '<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#F4EEE6;color:#2B1D16;font:16px system-ui,sans-serif}a{color:#8C4321}</style></head><body>' +
    '<p>Indo para a loja. Se não abrir, <a href="' + destino + '">toque aqui</a>.</p>' +
    '<script>(function(){var d=' + JSON.stringify(i.link.trim()) + ',foi=false;function ir(){if(!foi){foi=true;location.replace(d)}}' +
    'window.addEventListener("load",function(){try{umami.track("link-curto",{slug:' + JSON.stringify(i.s) + '})}catch(e){}setTimeout(ir,350)});setTimeout(ir,1500)})()</script></body></html>\n';
  await fs.mkdir(new URL(i.s + '/', SITE), { recursive: true });
  await gravar(i.s + '/index.html', pagina);
}
await gravar('data/links-curtos.json', JSON.stringify(unicos.map((i) => i.s)) + '\n');
console.log('Links curtos:', unicos.map((i) => '/' + i.s).join(' ') || 'nenhum');
