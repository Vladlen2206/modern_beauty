'use strict';

// ───────────── Підключення ─────────────

const cfg = window.MB_CONFIG || {};
const configured = cfg.supabaseUrl && !cfg.supabaseUrl.includes('YOUR-PROJECT') &&
                   cfg.supabaseAnonKey && !cfg.supabaseAnonKey.includes('YOUR-ANON-KEY');
const sb = configured ? (window.MB_SUPABASE || supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey)) : null;

const state = {
  me: null,          // профіль поточного працівника
  staff: [],         // усі працівники
  services: [],
  clients: [],
  visits: [],
  sort: { key: 'last', dir: -1 },
  period: 'month',
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const isAdmin = () => state.me && state.me.role === 'admin';

// ───────────── Утиліти ─────────────

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const money = n => Math.round(Number(n) || 0).toLocaleString('uk-UA') + ' грн';
const dateFmt = d => d ? new Date(d).toLocaleDateString('uk-UA', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '—';
const dayKey = d => { const x = new Date(d); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`; };
const staffName = id => { const s = state.staff.find(p => p.id === id); return s ? (s.full_name || s.email || 'Без імені') : '—'; };
const daysAgo = d => Math.floor((Date.now() - new Date(d)) / 86400000);

// +380XXXXXXXXX з будь-якого запису українського номера.
function normalizePhone(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (d.length === 10 && d.startsWith('0')) d = '38' + d;
  if (d.length === 9) d = '380' + d;
  return d ? '+' + d : '';
}
function prettyPhone(p) {
  const m = /^\+380(\d{2})(\d{3})(\d{2})(\d{2})$/.exec(p || '');
  return m ? `+380 ${m[1]} ${m[2]} ${m[3]} ${m[4]}` : (p || '');
}

function toast(msg, isError = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast' + (isError ? ' error' : '');
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, isError ? 6000 : 2500);
}

function errText(error) {
  const m = (error && (error.message || error.toString())) || 'Невідома помилка';
  if (/Invalid login credentials/i.test(m)) return 'Неправильний email або пароль';
  if (/duplicate key|unique/i.test(m)) return 'Клієнт із таким телефоном уже є в базі';
  if (/row-level security|permission denied/i.test(m)) return 'Немає доступу до цієї дії';
  if (/Failed to fetch|NetworkError/i.test(m)) return 'Немає зв\'язку з сервером';
  return m;
}

async function run(promise) {
  const { data, error } = await promise;
  if (error) throw error;
  return data;
}

// Завантажує всю таблицю частинами по 1000 рядків.
async function fetchAll(table, columns, orderCol) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const page = await run(sb.from(table).select(columns).order(orderCol, { ascending: true }).range(from, from + 999));
    out.push(...page);
    if (page.length < 1000) return out;
  }
}

// ───────────── Вхід ─────────────

function show(view) {
  for (const v of ['login', 'setup', 'app']) $(`#${v}-view`).hidden = v !== view;
}

async function start() {
  if (!configured) return show('setup');
  const { data } = await sb.auth.getSession();
  if (data.session) await enter(data.session.user);
  else show('login');
  sb.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_OUT') { state.me = null; show('login'); }
  });
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const btn = $('button', f);
  $('#login-error').textContent = '';
  btn.disabled = true;
  try {
    const data = await run(sb.auth.signInWithPassword({ email: f.email.value.trim(), password: f.password.value }));
    f.password.value = '';
    await enter(data.user);
  } catch (err) {
    $('#login-error').textContent = errText(err);
  } finally {
    btn.disabled = false;
  }
});

$('#logout').addEventListener('click', () => sb.auth.signOut());

async function enter(user) {
  const { data: me } = await sb.from('profiles').select('*').eq('id', user.id).maybeSingle();
  if (!me || !me.active) {
    await sb.auth.signOut();
    show('login');
    $('#login-error').textContent = 'Доступ вимкнено. Зверніться до адміністратора.';
    return;
  }
  state.me = me;
  $('#who-name').textContent = (me.full_name || me.email) + (isAdmin() ? ' · адміністратор' : '');
  $$('[data-admin]').forEach(el => { el.hidden = !isAdmin(); });
  $('#by-master-panel').hidden = !isAdmin();
  show('app');
  setPeriod('month');
  await reload();
}

// ───────────── Дані ─────────────

async function reload() {
  try {
    const [staff, services, clients, visits] = await Promise.all([
      run(sb.from('profiles').select('*').order('full_name', { ascending: true })),
      run(sb.from('services').select('*').order('name', { ascending: true })),
      fetchAll('clients', '*', 'id'),
      fetchAll('visits', '*', 'visited_at'),
    ]);
    Object.assign(state, { staff, services, clients, visits });
    renderAll();
  } catch (err) {
    toast(errText(err), true);
  }
}

function renderAll() {
  renderClients();
  renderStats();
  if (isAdmin()) { renderStaff(); renderServices(); }
}

// Підсумки по кожному клієнту з видимих візитів.
function clientSummary() {
  const sum = new Map();
  for (const v of state.visits) {
    const s = sum.get(v.client_id) || { count: 0, total: 0, last: null, first: null };
    s.count++;
    s.total += Number(v.price) || 0;
    if (!s.last || v.visited_at > s.last) s.last = v.visited_at;
    if (!s.first || v.visited_at < s.first) s.first = v.visited_at;
    sum.set(v.client_id, s);
  }
  return sum;
}

// ───────────── Вкладки ─────────────

$('#tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-tab]');
  if (!b) return;
  $$('#tabs button').forEach(x => x.classList.toggle('active', x === b));
  $$('.tab').forEach(t => { t.hidden = t.id !== 'tab-' + b.dataset.tab; });
});

// ───────────── Клієнти ─────────────

$('#client-search').addEventListener('input', renderClients);
$('#clients-table thead').addEventListener('click', (e) => {
  const th = e.target.closest('th[data-sort]');
  if (!th) return;
  const key = th.dataset.sort;
  state.sort = { key, dir: state.sort.key === key ? -state.sort.dir : (key === 'full_name' ? 1 : -1) };
  renderClients();
});

function renderClients() {
  const q = $('#client-search').value.trim().toLowerCase();
  const qDigits = q.replace(/\D/g, '');
  const sum = clientSummary();
  let list = state.clients.map(c => ({ ...c, ...(sum.get(c.id) || { count: 0, total: 0, last: null }) }));
  if (q) {
    list = list.filter(c => c.full_name.toLowerCase().includes(q) ||
      (qDigits.length >= 3 && c.phone.replace(/\D/g, '').includes(qDigits)));
  }
  const { key, dir } = state.sort;
  list.sort((a, b) => {
    const x = a[key] ?? '', y = b[key] ?? '';
    if (key === 'full_name') return dir * x.localeCompare(y, 'uk');
    return dir * (x > y ? 1 : x < y ? -1 : 0);
  });

  $('#clients-table tbody').innerHTML = list.map(c => `
    <tr data-id="${c.id}">
      <td><b>${esc(c.full_name)}</b>${c.notes ? `<div class="muted">${esc(c.notes.slice(0, 60))}${c.notes.length > 60 ? '…' : ''}</div>` : ''}</td>
      <td class="nowrap">${esc(prettyPhone(c.phone))}</td>
      <td class="hide-sm">${c.preferred_master ? esc(staffName(c.preferred_master)) : '<span class="muted">—</span>'}</td>
      <td>${c.last ? dateFmt(c.last) : '<span class="muted">—</span>'}</td>
      <td class="num hide-sm">${c.count}</td>
      <td class="num">${money(c.total)}</td>
    </tr>`).join('');
  $('#clients-empty').hidden = list.length > 0;
  $('#clients-empty').textContent = q ? 'Нікого не знайдено.' : 'Клієнтів поки немає.';
}

$('#clients-table tbody').addEventListener('click', (e) => {
  const tr = e.target.closest('tr[data-id]');
  if (tr) openClient(Number(tr.dataset.id));
});

$('#new-client').addEventListener('click', () => openClientForm(null));

// ───────────── Модальне вікно ─────────────

function openModal(html) {
  $('#modal-body').innerHTML = html;
  $('#modal').hidden = false;
  const first = $('#modal-body input, #modal-body textarea, #modal-body select');
  if (first) first.focus();
}
function closeModal() { $('#modal').hidden = true; $('#modal-body').innerHTML = ''; }
$('#modal-close').addEventListener('click', closeModal);
$('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#modal').hidden) closeModal(); });

function masterOptions(selected, { allowEmpty = true, onlyActive = true } = {}) {
  const list = state.staff.filter(s => !onlyActive || s.active || s.id === selected);
  return (allowEmpty ? '<option value="">— не обрано —</option>' : '') +
    list.map(s => `<option value="${s.id}" ${s.id === selected ? 'selected' : ''}>${esc(s.full_name || s.email)}</option>`).join('');
}

// Форма нового клієнта або редагування.
function openClientForm(client) {
  const c = client || { full_name: '', phone: '', birthday: '', notes: '', preferred_master: isAdmin() ? '' : state.me.id };
  openModal(`
    <h2>${client ? 'Редагувати клієнта' : 'Новий клієнт'}</h2>
    <form id="client-form" class="form-grid">
      <label>Ім'я та прізвище<input name="full_name" value="${esc(c.full_name)}" required maxlength="120" /></label>
      <label>Телефон<input name="phone" value="${esc(prettyPhone(c.phone))}" required placeholder="063 100 83 31" inputmode="tel" /></label>
      <label>День народження<input name="birthday" type="date" value="${esc(c.birthday || '')}" /></label>
      <label>Улюблений майстер<select name="preferred_master">${masterOptions(c.preferred_master)}</select></label>
      <label class="wide">Нотатки (алергії, формула фарбування, побажання)<textarea name="notes" maxlength="4000">${esc(c.notes)}</textarea></label>
      <div class="wide" id="dup-notice"></div>
      <div class="form-actions wide">
        <span></span>
        <div class="right">
          <button type="button" class="btn" id="cancel">Скасувати</button>
          <button type="submit" class="btn gold">Зберегти</button>
        </div>
      </div>
    </form>`);

  const form = $('#client-form');
  $('#cancel').addEventListener('click', () => client ? openClient(client.id) : closeModal());

  // Перевірка дубля, поки вводять телефон.
  form.phone.addEventListener('blur', async () => {
    const phone = normalizePhone(form.phone.value);
    $('#dup-notice').innerHTML = '';
    if (phone.length < 13 || (client && phone === client.phone)) return;
    const { data } = await sb.rpc('find_client_by_phone', { p: phone });
    if (data && data.length) showDuplicate(data[0]);
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const row = {
      full_name: form.full_name.value.trim(),
      phone: normalizePhone(form.phone.value),
      birthday: form.birthday.value || null,
      preferred_master: form.preferred_master.value || null,
      notes: form.notes.value.trim(),
    };
    if (row.phone.length < 11) return toast('Перевірте номер телефону', true);
    const btn = $('button[type=submit]', form);
    btn.disabled = true;
    try {
      let id;
      if (client) {
        await run(sb.from('clients').update(row).eq('id', client.id));
        id = client.id;
      } else {
        row.created_by = state.me.id;
        id = (await run(sb.from('clients').insert(row).select('id').single())).id;
      }
      await reload();
      toast('Збережено');
      openClient(id);
    } catch (err) {
      if (/duplicate key|unique/i.test(err.message || '')) {
        const { data } = await sb.rpc('find_client_by_phone', { p: row.phone });
        if (data && data.length) showDuplicate(data[0]);
      }
      toast(errText(err), true);
    } finally {
      btn.disabled = false;
    }
  });
}

function showDuplicate(found) {
  const visible = state.clients.some(c => c.id === found.id);
  $('#dup-notice').innerHTML = `<div class="notice">Клієнт із цим телефоном уже є в базі: <b>${esc(found.full_name)}</b>.
    ${visible ? '<button type="button" class="link" id="dup-open">Відкрити картку</button>'
              : '<button type="button" class="link" id="dup-visit">Додати йому візит</button>'}</div>`;
  const open = $('#dup-open');
  if (open) open.addEventListener('click', () => openClient(found.id));
  const visit = $('#dup-visit');
  if (visit) visit.addEventListener('click', () => openForeignVisit(found));
}

// Візит клієнту, якого майстер ще не бачить (він ходив до інших майстрів).
function openForeignVisit(found) {
  openModal(`<h2>Візит: ${esc(found.full_name)}</h2>
    <p class="muted">Після збереження клієнт з'явиться у вашому списку.</p>
    <div id="visit-slot"></div>`);
  renderVisitForm($('#visit-slot'), found.id, null);
}

// Картка клієнта.
function openClient(id) {
  const c = state.clients.find(x => x.id === id);
  if (!c) { closeModal(); return; }
  const visits = state.visits.filter(v => v.client_id === id).sort((a, b) => b.visited_at.localeCompare(a.visited_at));
  const total = visits.reduce((s, v) => s + (Number(v.price) || 0), 0);
  const avg = visits.length ? total / visits.length : 0;

  openModal(`
    <h2>${esc(c.full_name)}</h2>
    <div class="client-stats">
      <span>📞 <a href="tel:${esc(c.phone)}">${esc(prettyPhone(c.phone))}</a></span>
      ${c.birthday ? `<span>🎂 ${dateFmt(c.birthday)}</span>` : ''}
      <span>Майстер: <b>${c.preferred_master ? esc(staffName(c.preferred_master)) : '—'}</b></span>
      <span>Візитів: <b>${visits.length}</b></span>
      <span>Сума: <b>${money(total)}</b></span>
      <span>Середній чек: <b>${money(avg)}</b></span>
    </div>
    ${c.notes ? `<div class="hint" style="white-space:pre-wrap">${esc(c.notes)}</div>` : ''}
    <div class="section-title">
      <h3>Історія візитів${isAdmin() ? '' : ' (ваші)'}</h3>
      <button class="btn gold small" id="add-visit">+ Візит</button>
    </div>
    <div id="visit-slot"></div>
    ${visits.length ? `<div class="table-wrap"><table class="table">
      <thead><tr><th>Дата</th><th>Послуга</th><th class="hide-sm">Майстер</th><th class="num">Ціна</th><th></th></tr></thead>
      <tbody>${visits.map(v => `<tr>
        <td>${dateFmt(v.visited_at)}</td>
        <td>${esc(v.service_name)}${v.comment ? `<div class="muted">${esc(v.comment)}</div>` : ''}</td>
        <td class="hide-sm">${esc(staffName(v.master_id))}</td>
        <td class="num">${money(v.price)}</td>
        <td class="num"><button class="link" data-edit-visit="${v.id}">змінити</button></td>
      </tr>`).join('')}</tbody></table></div>` : '<p class="muted">Візитів ще не було.</p>'}
    <div class="form-actions">
      ${isAdmin() ? '<button class="btn danger small" id="del-client">Видалити клієнта</button>' : '<span></span>'}
      <div class="right"><button class="btn" id="edit-client">Редагувати</button></div>
    </div>`);

  $('#add-visit').addEventListener('click', () => renderVisitForm($('#visit-slot'), id, null));
  $('#edit-client').addEventListener('click', () => openClientForm(c));
  $$('[data-edit-visit]').forEach(b => b.addEventListener('click', () => {
    const v = state.visits.find(x => x.id === Number(b.dataset.editVisit));
    renderVisitForm($('#visit-slot'), id, v);
    $('#visit-slot').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }));
  const del = $('#del-client');
  if (del) del.addEventListener('click', async () => {
    if (!confirm(`Видалити клієнта «${c.full_name}» і всю історію візитів? Це не можна скасувати.`)) return;
    try {
      await run(sb.from('clients').delete().eq('id', id));
      closeModal();
      await reload();
      toast('Клієнта видалено');
    } catch (err) { toast(errText(err), true); }
  });
}

// Форма візиту (новий або редагування).
function renderVisitForm(slot, clientId, visit) {
  const now = new Date();
  const local = d => { const x = new Date(d); x.setMinutes(x.getMinutes() - x.getTimezoneOffset()); return x.toISOString().slice(0, 16); };
  const client = state.clients.find(c => c.id === clientId);
  const defaultMaster = isAdmin() && client && client.preferred_master ? client.preferred_master : state.me.id;
  const v = visit || { service_id: '', service_name: '', price: '', visited_at: now.toISOString(), comment: '', master_id: defaultMaster };
  const activeServices = state.services.filter(s => s.active || s.id === v.service_id);

  slot.innerHTML = `
    <form class="visit-form form-grid" id="visit-form">
      <label>Послуга<select name="service_id" required>
        <option value="">— оберіть —</option>
        ${activeServices.map(s => `<option value="${s.id}" data-price="${s.price_from}" ${s.id === v.service_id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}
        <option value="other" ${visit && !v.service_id ? 'selected' : ''}>Інше…</option>
      </select></label>
      <label id="other-wrap" ${visit && !v.service_id ? '' : 'hidden'}>Назва послуги<input name="service_name" value="${esc(v.service_name)}" maxlength="120" /></label>
      <label>Ціна, грн<input name="price" type="number" min="0" step="1" value="${esc(v.price)}" required /></label>
      <label>Дата й час<input name="visited_at" type="datetime-local" value="${local(v.visited_at)}" required /></label>
      ${isAdmin() ? `<label>Майстер<select name="master_id" required>${masterOptions(v.master_id, { allowEmpty: false })}</select></label>` : ''}
      <label class="wide">Коментар<input name="comment" value="${esc(v.comment)}" maxlength="500" placeholder="Напр.: відтінок 7.1, оксид 6%" /></label>
      <div class="form-actions wide">
        ${visit ? '<button type="button" class="btn danger small" id="del-visit">Видалити візит</button>' : '<span></span>'}
        <div class="right">
          <button type="button" class="btn" id="visit-cancel">Скасувати</button>
          <button type="submit" class="btn gold">${visit ? 'Зберегти' : 'Додати візит'}</button>
        </div>
      </div>
    </form>`;

  const f = $('#visit-form', slot);
  f.service_id.addEventListener('change', () => {
    const opt = f.service_id.selectedOptions[0];
    $('#other-wrap', f).hidden = f.service_id.value !== 'other';
    if (opt && opt.dataset.price && Number(opt.dataset.price) > 0 && !visit) f.price.value = opt.dataset.price;
  });
  $('#visit-cancel', f).addEventListener('click', () => {
    if (state.clients.some(c => c.id === clientId)) slot.innerHTML = ''; else closeModal();
  });

  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const other = f.service_id.value === 'other';
    const svc = state.services.find(s => s.id === Number(f.service_id.value));
    const row = {
      client_id: clientId,
      service_id: other ? null : svc.id,
      service_name: other ? f.service_name.value.trim() : svc.name,
      price: Number(f.price.value) || 0,
      visited_at: new Date(f.visited_at.value).toISOString(),
      comment: f.comment.value.trim(),
      master_id: isAdmin() ? f.master_id.value : state.me.id,
    };
    if (!row.service_name) return toast('Вкажіть назву послуги', true);
    const btn = $('button[type=submit]', f);
    btn.disabled = true;
    try {
      if (visit) await run(sb.from('visits').update(row).eq('id', visit.id));
      else await run(sb.from('visits').insert(row));
      await reload();
      toast(visit ? 'Візит змінено' : 'Візит додано');
      openClient(clientId);
    } catch (err) {
      toast(errText(err), true);
    } finally {
      btn.disabled = false;
    }
  });

  const del = $('#del-visit', f);
  if (del) del.addEventListener('click', async () => {
    if (!confirm('Видалити цей візит?')) return;
    try {
      await run(sb.from('visits').delete().eq('id', visit.id));
      await reload();
      toast('Візит видалено');
      openClient(clientId);
    } catch (err) { toast(errText(err), true); }
  });
}

// ───────────── Статистика ─────────────

function setPeriod(p) {
  state.period = p;
  const to = new Date(); const from = new Date();
  if (p === 'today') { /* сьогодні */ }
  else if (p === 'month') from.setDate(1);
  else if (p === 'year') { from.setMonth(0, 1); }
  else from.setDate(from.getDate() - (Number(p) - 1));
  $('#from').value = dayKey(from);
  $('#to').value = dayKey(to);
  $$('#period button').forEach(b => b.classList.toggle('active', b.dataset.p === p));
}

$('#period').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-p]');
  if (!b) return;
  setPeriod(b.dataset.p);
  renderStats();
});
for (const id of ['#from', '#to']) {
  $(id).addEventListener('change', () => {
    $$('#period button').forEach(b => b.classList.remove('active'));
    renderStats();
  });
}

function rowsHtml(items, fmt = money) {
  if (!items.length) return '<p class="muted">Немає даних за цей період.</p>';
  const max = Math.max(...items.map(i => i.value), 1);
  return `<div class="rows">${items.map(i => `
    <div class="row-line"><span>${esc(i.label)}${i.sub ? ` <span class="muted">${esc(i.sub)}</span>` : ''}</span><b>${fmt(i.value)}</b>
      <div class="meter"><i style="width:${(i.value / max * 100).toFixed(1)}%"></i></div></div>`).join('')}</div>`;
}

function renderStats() {
  const fromStr = $('#from').value, toStr = $('#to').value;
  if (!fromStr || !toStr) return;
  const inRange = v => { const k = dayKey(v.visited_at); return k >= fromStr && k <= toStr; };
  const period = state.visits.filter(inRange);
  const sum = clientSummary();

  const revenue = period.reduce((s, v) => s + (Number(v.price) || 0), 0);
  const clientIds = new Set(period.map(v => v.client_id));
  const newClients = [...clientIds].filter(id => {
    const first = sum.get(id)?.first;
    return first && dayKey(first) >= fromStr;
  }).length;

  $('#tiles').innerHTML = [
    ['Виручка', money(revenue)],
    ['Візитів', period.length],
    ['Середній чек', money(period.length ? revenue / period.length : 0)],
    ['Клієнтів', clientIds.size],
    ['Нових клієнтів', newClients],
    ['Повернулися', clientIds.size - newClients],
  ].map(([k, v]) => `<div class="tile"><small>${k}</small><strong>${v}</strong></div>`).join('');

  // Виручка по днях / тижнях / місяцях — залежно від довжини періоду.
  const byDay = new Map();
  for (const v of period) { const k = dayKey(v.visited_at); byDay.set(k, (byDay.get(k) || 0) + (Number(v.price) || 0)); }
  const days = [];
  for (let d = new Date(fromStr + 'T00:00'); dayKey(d) <= toStr && days.length < 3700; d.setDate(d.getDate() + 1)) days.push(dayKey(d));
  const unit = days.length > 120 ? 'month' : days.length > 45 ? 'week' : 'day';
  $('#bars-title').textContent = { day: 'Виручка по днях', week: 'Виручка по тижнях', month: 'Виручка по місяцях' }[unit];
  const buckets = [];
  days.forEach((k, i) => {
    const startNew = unit === 'day' || i === 0 ||
      (unit === 'week' && new Date(k + 'T12:00').getDay() === 1) ||
      (unit === 'month' && k.endsWith('-01'));
    if (startNew) buckets.push({ from: k, to: k, value: 0 });
    const b = buckets[buckets.length - 1];
    b.to = k;
    b.value += byDay.get(k) || 0;
  });
  const maxB = Math.max(...buckets.map(b => b.value), 1);
  $('#bars').innerHTML = buckets.map(b => {
    const label = b.from === b.to ? dateFmt(b.from + 'T12:00') : `${dateFmt(b.from + 'T12:00')} – ${dateFmt(b.to + 'T12:00')}`;
    return `<div class="bar" style="height:${(b.value / maxB * 100).toFixed(1)}%" title="${label}: ${money(b.value)}"></div>`;
  }).join('');
  $('#bar-axis').innerHTML = days.length
    ? `<span>${dateFmt(days[0] + 'T12:00')}</span><span>${dateFmt(days[days.length - 1] + 'T12:00')}</span>` : '';

  const group = (keyFn, labelFn) => {
    const m = new Map();
    for (const v of period) {
      const k = keyFn(v);
      const g = m.get(k) || { label: labelFn(v), value: 0, n: 0 };
      g.value += Number(v.price) || 0; g.n++;
      m.set(k, g);
    }
    return [...m.values()].map(g => ({ ...g, sub: `· ${g.n} віз.` })).sort((a, b) => b.value - a.value);
  };

  if (isAdmin()) $('#by-master').innerHTML = rowsHtml(group(v => v.master_id || '-', v => staffName(v.master_id)));
  $('#by-service').innerHTML = rowsHtml(group(v => v.service_name, v => v.service_name));

  const clientName = id => state.clients.find(c => c.id === id)?.full_name || 'Клієнт';
  $('#top-clients').innerHTML = rowsHtml(group(v => v.client_id, v => clientName(v.client_id)).slice(0, 10));

  const lost = state.clients
    .map(c => ({ c, s: sum.get(c.id) }))
    .filter(x => x.s && daysAgo(x.s.last) > 60)
    .sort((a, b) => a.s.last.localeCompare(b.s.last))
    .slice(0, 15);
  $('#lost-clients').innerHTML = lost.length
    ? `<div class="rows">${lost.map(({ c, s }) => `<div class="row-line">
        <span><button class="link" data-open="${c.id}">${esc(c.full_name)}</button> <span class="muted">${esc(prettyPhone(c.phone))}</span></span>
        <span class="muted">${daysAgo(s.last)} дн. тому</span></div>`).join('')}</div>`
    : '<p class="muted">Усі клієнти приходили протягом останніх 60 днів.</p>';
  $$('#lost-clients [data-open]').forEach(b => b.addEventListener('click', () => openClient(Number(b.dataset.open))));
}

// ───────────── Майстри (адміністратор) ─────────────

function renderStaff() {
  $('#staff-table tbody').innerHTML = state.staff.map(s => `
    <tr data-id="${s.id}">
      <td><input name="full_name" value="${esc(s.full_name)}" placeholder="Ім'я" /></td>
      <td class="muted">${esc(s.email)}</td>
      <td><select name="role" ${s.id === state.me.id ? 'disabled' : ''}>
        <option value="master" ${s.role === 'master' ? 'selected' : ''}>Майстер</option>
        <option value="admin" ${s.role === 'admin' ? 'selected' : ''}>Адміністратор</option>
      </select></td>
      <td><label class="inline"><input type="checkbox" name="active" ${s.active ? 'checked' : ''} ${s.id === state.me.id ? 'disabled' : ''} /> має доступ</label></td>
      <td class="num"><button class="btn small" data-save>Зберегти</button></td>
    </tr>`).join('');
}

$('#staff-table tbody').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-save]');
  if (!b) return;
  const tr = b.closest('tr');
  const row = { full_name: $('[name=full_name]', tr).value.trim() };
  if (tr.dataset.id !== state.me.id) {
    row.role = $('[name=role]', tr).value;
    row.active = $('[name=active]', tr).checked;
  }
  try {
    await run(sb.from('profiles').update(row).eq('id', tr.dataset.id));
    await reload();
    toast('Збережено');
  } catch (err) { toast(errText(err), true); }
});

// ───────────── Послуги (адміністратор) ─────────────

function renderServices() {
  $('#services-table tbody').innerHTML = state.services.map(s => `
    <tr data-id="${s.id}">
      <td><input name="name" value="${esc(s.name)}" /></td>
      <td class="num"><input name="price_from" type="number" min="0" step="1" value="${Number(s.price_from)}" style="max-width:120px" /></td>
      <td><input type="checkbox" name="active" ${s.active ? 'checked' : ''} style="width:auto" /></td>
      <td class="num"><button class="btn small" data-save>Зберегти</button></td>
    </tr>`).join('');
}

$('#services-table tbody').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-save]');
  if (!b) return;
  const tr = b.closest('tr');
  const row = {
    name: $('[name=name]', tr).value.trim(),
    price_from: Number($('[name=price_from]', tr).value) || 0,
    active: $('[name=active]', tr).checked,
  };
  try {
    await run(sb.from('services').update(row).eq('id', Number(tr.dataset.id)));
    await reload();
    toast('Збережено');
  } catch (err) { toast(errText(err), true); }
});

$('#service-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    await run(sb.from('services').insert({ name: f.name.value.trim(), price_from: Number(f.price_from.value) || 0 }));
    f.reset();
    await reload();
    toast('Послугу додано');
  } catch (err) { toast(errText(err), true); }
});

start();
