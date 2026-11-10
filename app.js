const $ = selector => document.querySelector(selector);
let current = null, followToken = 0, local = false, timers = [], shownMenu = '', shownState = '', sessionIds = new Set();
const STATES = { working:'Working…', asking:'Needs your OK', idle:'Waiting for you', ended:'Ended' };

// The QR code brings a one-time pairing code (#pair=…) and, for the app's fixed page, the computer's phone link
// (#mac=…). Both are taken out of the address at once.
const fromQr = new URLSearchParams(location.hash.slice(1));
if (location.hash) history.replaceState(null, '', location.pathname + location.search);
const pairCode = /^[\w-]{10,}$/.test(fromQr.get('pair') || '') ? fromQr.get('pair') : '';

// Where the computer is. Opened from the computer, or from its phone link: this page's own address. Opened from the
// app's fixed page (POCKET_APP_URL on the computer): the computer's current phone link, kept on this phone. The QR
// code brings it, and after a restart the computer sends the new one in a notification (sw.js keeps it). There the
// device's key is kept on the phone too, and sent in a header instead of a cookie.
const SAVED = 'pocket-agent', KEY = 'pocket-agent-key'; // SAVED is shared with sw.js
const kept = async () => { try { return await (await (await caches.open(SAVED)).match('mac'))?.text() || ''; } catch { return ''; } };
if (/^https:\/\//.test(fromQr.get('mac') || '')) await (await caches.open(SAVED)).put('mac', new Response(new URL(fromQr.get('mac')).origin));
const onFixedPage = Boolean(await kept());
// sw.js needs the key too, to tell the computer a notification arrived; it can't read localStorage.
const keepKey = key => caches.open(SAVED).then(cache => key ? cache.put('key', new Response(key)) : cache.delete('key')).catch(() => {});
if (onFixedPage) keepKey(localStorage.getItem(KEY));
const OFFLINE = 'Can\'t reach your computer. It may be asleep or offline. If this lasts, scan the QR code on the computer again.';

async function api(url, options = {}) {
  const key = onFixedPage && localStorage.getItem(KEY);
  const res = await fetch((onFixedPage ? await kept() : '') + url, { ...options, headers:{ 'Content-Type':'application/json', ...(key ? { Authorization:`Bearer ${key}` } : {}) } })
    .catch(error => { throw Object.assign(new Error(onFixedPage ? OFFLINE : 'Can\'t reach Pocket Agent.'), { offline:error.name !== 'TimeoutError' }); });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !url.startsWith('/api/login')) { stopApp(); show('login'); }
  if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status}).`), { status:res.status });
  return { ...data, httpStatus:res.status };
}
const post = (url, payload = {}) => api(url, { method:'POST', body:JSON.stringify(payload) });
const showError = message => { $('#error').textContent = message || ''; };
const formError = (form, message) => { form.querySelector('.error').textContent = message || ''; };
const folderName = cwd => cwd.split(/[\\/]/).filter(Boolean).pop() || cwd;
const ago = date => { const m = Math.floor((Date.now() - Date.parse(date)) / 60000); return m < 1 ? 'now' : m < 60 ? `${m}m ago` : m < 1440 ? `${Math.floor(m / 60)}h ago` : `${Math.floor(m / 1440)}d ago`; };
function make(tag, props, children = []) { const node = Object.assign(document.createElement(tag), props); node.append(...children); return node; }

function show(screen) {
  for (const name of ['setup', 'login', 'scan', 'waiting', 'app']) $(`#${name}-screen`).hidden = name !== screen;
  $('#sign-out').hidden = screen !== 'app';
}

async function boot() {
  const status = await api('/api/auth/status');
  local = status.local;
  if (!status.passwordSet) {
    if (local) return show('setup');
    $('#login-note').textContent = 'Open Pocket Agent on your computer first and set a password there.';
    return show('login');
  }
  if (status.device === 'approved') return startApp();
  if (status.device === 'pending') return waitForApproval();
  show('login');
}

function waitForApproval() {
  show('waiting');
  const timer = setInterval(async () => {
    const { device } = await api('/api/auth/status').catch(() => ({}));
    if (device === 'approved') { clearInterval(timer); startApp(); }
    if (device === 'none') { clearInterval(timer); $('#login-note').textContent = 'This device was not approved. Sign in again to ask once more.'; show('login'); }
  }, 3000);
}

function startApp() {
  show('app');
  // Opened from a notification (?session=… or ?ask=…): go straight to that session or question.
  const opened = location.search;
  if (opened) history.replaceState(null, '', location.pathname);
  loadSessions().then(() => { if (opened) openFromUrl(opened); }).catch(error => showError(error.message));
  loadAsks().catch(() => {});
  timers.push(setInterval(() => { if (!document.hidden) loadAsks().catch(() => {}); }, 3000));
  loadDevices().catch(() => {});
  loadNotify().catch(() => {});
  loadChats().catch(() => {});
  timers.push(setInterval(() => { if (!document.hidden) loadSessions().catch(() => {}); }, 5000));
  timers.push(setInterval(() => { if (!document.hidden && $('#chats-card').open) loadChats().catch(() => {}); }, 30000));
  // On the computer: the QR code (pairing codes last 10 minutes) and new devices to approve.
  if (local) {
    loadConnect().catch(() => {});
    loadTests().catch(() => {});
    timers.push(setInterval(() => loadConnect().catch(() => {}), 5 * 60000), setInterval(() => { loadDevices().catch(() => {}); loadTests().catch(() => {}); }, 3000));
  }
}
function stopApp() { timers.forEach(clearInterval); timers = []; followToken++; current = null; }

async function loadConnect() {
  const { url, state, qr } = await api('/api/connect');
  $('#connect').hidden = false;
  $('#qr').innerHTML = qr; // SVG made by the server's QR library from the tunnel address
  $('#qr').hidden = !qr;
  $('#phone-link').textContent = url || ({ starting:'Starting the phone link…', missing:'cloudflared is not installed, so phones cannot connect yet.' }[state] || 'The phone link is not available.');
  if (!url && state === 'starting') setTimeout(() => loadConnect().catch(() => {}), 2000);
}

// Notifications: a service worker shows them even when the app is closed. It needs https (the phone link) or localhost.
const pushSupported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window && window.isSecureContext;
const worker = pushSupported ? navigator.serviceWorker.register('sw.js').catch(() => null) : Promise.resolve(null);
if (pushSupported) navigator.serviceWorker.addEventListener('message', event => { if (event.data?.type === 'open') openFromUrl(event.data.url); });
const keyBytes = base64url => Uint8Array.from(atob(base64url.replace(/-/g, '+').replace(/_/g, '/')), char => char.charCodeAt(0));

async function loadNotify() {
  const text = $('#notify-text'), button = $('#notify-button');
  const set = (message, label = '') => { text.textContent = message; button.textContent = label; button.hidden = !label; };
  // They are for the phone: the computer is where you already are (and some browsers, like Brave, block them anyway).
  if (local) return set('They go to your phone: turn them on in Pocket Agent on the phone. Check them with "Test your phone" above.');
  if (!pushSupported || !await worker) return set(/iPhone|iPad/.test(navigator.userAgent) ? 'On iPhone, add Pocket Agent to the Home Screen first (Share, then Add to Home Screen), and open it from there.' : 'This browser can\'t show notifications.');
  if (Notification.permission === 'denied') return set('Notifications are blocked for this site. Allow them in the browser\'s site settings.');
  const subscription = await (await worker).pushManager.getSubscription();
  const { subscribed } = subscription ? await api(`/api/push?endpoint=${encodeURIComponent(subscription.endpoint)}`) : { subscribed:false };
  // Android holds back Chrome's notifications while the phone sleeps (they show when it wakes), unless Chrome's
  // battery use is Unrestricted. Tested on Android 16: instant with it, only after waking without it.
  const android = /Android/.test(navigator.userAgent) ? ' On Android, set Chrome\'s battery use to Unrestricted (Settings > Apps > Chrome > Battery), or they only show when you wake the phone.' : '';
  if (subscribed) set(`On for this device. It buzzes when Claude needs you while you are away from the computer: lid closed, screen locked, or 1 minute without using it.${android}`, 'Turn off');
  else set('Get a notification when any Claude on your computer needs your OK or is done, while you are away from it.', 'Turn on');
  button.onclick = async () => {
    button.disabled = true;
    try {
      if (subscribed) {
        await post('/api/push/unsubscribe', { endpoint:subscription.endpoint });
        await subscription.unsubscribe();
      } else {
        if (await Notification.requestPermission() !== 'granted') return loadNotify();
        const { publicKey } = await api('/api/push');
        const fresh = subscription || await (await worker).pushManager.subscribe({ userVisibleOnly:true, applicationServerKey:keyBytes(publicKey) });
        await post('/api/push/subscribe', { subscription:fresh.toJSON() });
      }
      showError('');
    } catch (error) { showError(`Notifications: ${error.message}`); }
    finally { button.disabled = false; loadNotify().catch(() => {}); }
  };
}

// On the computer: pretend questions to the phone (see startTest in index.js), and how each one went.
const clock = date => new Date(date).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit', second:'2-digit' });
async function loadTests() {
  const { tests } = await api('/api/test');
  $('#test-card').hidden = false;
  $('#tests').replaceChildren(...tests.map(t => make('p', { className:'muted', textContent:
    !t.sentAt ? `Sends at ${clock(t.at)}`
    : `Sent at ${clock(t.sentAt)} to ${t.devices} device(s). ${reached(t)} ${!t.answeredAt ? 'Waiting for your answer on the phone…'
      : t.answer ? `You answered "${t.answer}" ${seconds(t.sentAt, t.answeredAt)} s later.` : 'Not answered on the phone.'}` })));
}
const seconds = (from, to) => Math.round((Date.parse(to) - Date.parse(from)) / 1000);
function reached(t) {
  if (!t.receipt) return t.devices ? 'Not on the phone yet.' : 'No phone has notifications on.';
  return t.receipt.shown ? `It reached the phone ${seconds(t.sentAt, t.receipt.at)} s later and showed.`
    : `It reached the phone ${seconds(t.sentAt, t.receipt.at)} s later, but the phone blocked it: ${t.receipt.permission === 'denied'
      ? 'notifications are off for Pocket Agent there (Settings > Apps > Pocket Agent > Notifications, and Chrome\'s site settings).'
      : `it said "${t.receipt.error || 'not shown'}".`}`;
}
$('#test-button').addEventListener('click', () => post('/api/test', { delay:Number($('#test-delay').value) }).then(loadTests, error => showError(error.message)));

// Session ids live only while the app runs, so a notification from before a restart just opens the app.
async function openFromUrl(url) {
  const query = new URL(url, location.href).searchParams;
  if (sessionIds.has(query.get('session'))) openSession(query.get('session'));
  if (query.get('ask')) {
    await loadAsks().catch(() => {});
    const ask = document.querySelector(`.ask[data-id="${CSS.escape(query.get('ask'))}"]`);
    if (ask) { ask.scrollIntoView({ block:'center', behavior:'smooth' }); ask.classList.add('flash'); }
    else showError('That question was already answered, or Claude stopped waiting for it.');
  }
}

// Claude's permission questions from every session on the computer (sent by its hooks): what it wants to do, and
// Allow / Deny. Redrawn only when the list changes, so a tap is never lost to a redraw.
let shownAsks = '';
async function loadAsks() {
  const { asks } = await api('/api/asks');
  const key = asks.map(ask => ask.id).join(',');
  if (key === shownAsks) return;
  shownAsks = key;
  $('#asks').hidden = !asks.length;
  $('#asks-title').textContent = asks.length > 1 ? `Claude needs you (${asks.length})` : asks[0]?.kind === 'question' ? 'Claude has a question' : 'Claude needs your OK';
  $('#ask-list').replaceChildren(...asks.map(ask => {
    if (ask.kind === 'question') return questionNode(ask);
    const node = make('div', { className:'ask' }, [
      make('p', { className:'muted', textContent:`${ask.folder} · ${ago(ask.createdAt)}` }),
      make('p', { className:'ask-action', textContent:ask.action }),
      ask.detail ? make('pre', { className:'mono', textContent:ask.detail }) : '',
      make('div', { className:'ask-buttons' }, [
        make('button', { className:'primary', textContent:'Allow', onclick:() => answer(ask, 'allow', node) }),
        ask.canAlways ? make('button', { textContent:'Always allow', title:'Allow, and let Claude do this again without asking', onclick:() => answer(ask, 'always', node) }) : '',
        make('button', { className:'deny', textContent:'Deny', onclick:() => answer(ask, 'deny', node) }),
      ]),
    ]);
    node.dataset.id = ask.id;
    return node;
  }));
}
async function answer(ask, decision, node) {
  await send(node, ask, { decision }, decision === 'deny' ? 'Denied. Claude was told no.' : 'Allowed. Claude carries on.');
}
// Sends an answer, then replaces the buttons with what happened; the list refreshes a moment later.
async function send(node, ask, payload, doneText) {
  node.querySelectorAll('button, input').forEach(control => { control.disabled = true; });
  let text = doneText;
  try { await post(`/api/asks/${ask.id}`, payload); } catch (error) { text = error.message; }
  node.querySelectorAll('.ask-buttons, .ask-question').forEach(part => part.remove());
  node.append(make('p', { className:'ask-done', textContent:text }));
  setTimeout(() => { shownAsks = ''; loadAsks().catch(() => {}); }, 2500);
}

// Claude's multiple-choice questions (one to four). One question with one answer: a tap on an option sends it.
// Otherwise the choices are collected and sent together. "Other…" takes the person's own words.
function questionNode(ask) {
  const chosen = ask.questions.map(() => new Set()), own = ask.questions.map(() => '');
  const answerOf = i => [...chosen[i], own[i].trim()].filter(Boolean).join(', ');
  const quick = ask.questions.length === 1 && !ask.questions[0].multiSelect;
  const sendAll = () => send(node, ask, { answers:Object.fromEntries(ask.questions.map((q, i) => [q.question, answerOf(i)])) }, 'Sent. Claude carries on with your answer.');
  const sendButton = make('button', { className:'primary', textContent:'Send answer', disabled:true, hidden:quick, onclick:sendAll });
  const refresh = () => { sendButton.disabled = ask.questions.some((q, i) => !answerOf(i)); };
  const node = make('div', { className:'ask' }, [
    make('p', { className:'muted', textContent:`${ask.folder} · ${ago(ask.createdAt)}` }),
    ...ask.questions.map((q, i) => {
      const buttons = q.options.map(option => make('button', { className:'option', onclick:() => {
        if (quick) { chosen[i] = new Set([option.label]); return sendAll(); }
        if (q.multiSelect) chosen[i].has(option.label) ? chosen[i].delete(option.label) : chosen[i].add(option.label);
        else { chosen[i] = new Set([option.label]); own[i] = ''; ownInput.value = ''; }
        buttons.forEach(b => b.classList.toggle('selected', chosen[i].has(b.dataset.label)));
        refresh();
      } }, [make('span', { textContent:option.label }), option.description && option.description !== option.label ? make('small', { textContent:option.description }) : '']));
      buttons.forEach((b, n) => { b.dataset.label = q.options[n].label; });
      const ownInput = make('input', { type:'text', maxLength:2000, placeholder:'Your own answer', hidden:true, oninput:() => {
        own[i] = ownInput.value;
        if (!q.multiSelect && own[i].trim()) { chosen[i].clear(); buttons.forEach(b => b.classList.remove('selected')); }
        sendButton.hidden = false; refresh();
      } });
      return make('div', { className:'ask-question' }, [
        q.header ? make('p', { className:'muted', textContent:`${q.header}${q.multiSelect ? ' · choose any' : ''}` }) : '',
        make('p', { className:'ask-action', textContent:q.question }),
        make('div', { className:'options' }, [...buttons, make('button', { className:'option', onclick:() => { ownInput.hidden = false; ownInput.focus(); } }, [make('span', { textContent:'Other…' })])]),
        ownInput,
      ]);
    }),
    make('div', { className:'ask-buttons' }, [
      sendButton,
      make('button', { textContent:'Answer on the computer', title:'Removes it from the phone; Claude still asks on the computer', onclick:() => send(node, ask, { release:true }, 'OK. Answer it on the computer.') }),
    ]),
  ]);
  node.dataset.id = ask.id;
  return node;
}

async function loadDevices() {
  const { devices, canApprove } = await api('/api/devices');
  const pending = devices.filter(d => d.status === 'pending');
  $('#approvals').hidden = !(canApprove && pending.length);
  $('#approvals').replaceChildren(...pending.map(d => make('div', { className:'device pending' }, [
    make('div', {}, [make('strong', { textContent:'A new device wants to sign in' }), make('p', { className:'muted', textContent:`${d.name} · ${d.lastIp} · ${ago(d.createdAt)}` })]),
    make('div', {}, [
      make('button', { className:'primary small', textContent:'Approve', onclick:() => post(`/api/devices/${d.id}/approve`).then(loadDevices) }),
      ' ',
      make('button', { className:'small', textContent:'Deny', onclick:() => post(`/api/devices/${d.id}/remove`).then(loadDevices) }),
    ]),
  ])));
  $('#devices').replaceChildren(...devices.map(d => make('div', { className:'device' }, [
    make('div', {}, [make('strong', { textContent:d.name }), make('p', { className:'muted', textContent:`${d.current ? 'This device · ' : ''}${d.status === 'pending' ? 'Waiting for approval · ' : ''}${d.local ? 'this computer' : d.lastIp} · seen ${ago(d.lastSeenAt)}` })]),
    d.current ? '' : make('button', { className:'small', textContent:'Remove', onclick:() => post(`/api/devices/${d.id}/remove`).then(loadDevices) }),
  ])));
}

// Saved chats: Continue starts Claude with --resume in the chat's folder; a chat already open here just opens.
async function loadChats() {
  const { chats } = await api('/api/chats');
  $('#chats').replaceChildren(...(chats.length ? chats.map(chat => make('div', { className:'device' }, [
    make('div', { style:'flex:1 1 200px; min-width:0' }, [
      make('strong', { className:'chat-title', textContent:chat.title }),
      make('p', { className:'muted', textContent:`${folderName(chat.cwd)} · ${ago(chat.updatedAt)}${chat.open === 'elsewhere' ? ' · open in another window' : ''}` }),
    ]),
    chat.open === 'here' ? make('button', { className:'small', textContent:'Open', onclick:() => openSession(chat.sessionId) })
      : make('button', { className:'small primary', textContent:'Continue', disabled:chat.open === 'elsewhere', title:chat.open === 'elsewhere' ? 'Close it in the other window on the computer first' : '', onclick:event => resumeChat(chat.id, event.target) }),
  ])) : [make('p', { className:'muted', textContent:'No saved chats yet.' })]));
}
async function resumeChat(id, button) {
  button.disabled = true;
  try {
    const { session } = await post(`/api/chats/${id}/resume`);
    showError('');
    await loadSessions();
    openSession(session.id);
    $('#session').scrollIntoView({ block:'start', behavior:'smooth' });
    loadChats().catch(() => {});
  } catch (error) { showError(error.message); button.disabled = false; }
}

async function loadSessions() {
  const { sessions } = await api('/api/sessions');
  sessionIds = new Set(sessions.map(s => s.id));
  $('#sessions').replaceChildren(...sessions.map(s => make('button', { className:[s.id === current ? 'active' : '', s.state === 'asking' ? 'asking' : ''].join(' '), textContent:`${folderName(s.cwd)} · ${STATES[s.state] || s.state}`, onclick:() => openSession(s.id) })));
}

function openSession(id) {
  current = id; shownMenu = ''; shownState = '';
  follow(id);
  $('#session').hidden = false;
  fitColumns();
  loadSessions().catch(error => showError(error.message));
}

// Live screen by long polling: each request is answered as soon as the screen changes (or "same" after 25 seconds),
// then the next one goes out. A newer follow() (another session, or coming back to the app) ends the older loop.
async function follow(id) {
  const token = ++followToken;
  let version = -1;
  while (token === followToken) {
    try {
      const data = await api(`/api/sessions/${id}/screen?since=${version}`, { signal:AbortSignal.timeout(35000) });
      if (token !== followToken) return;
      if (!data.same) render(data);
      version = data.version;
    } catch (error) {
      if (token !== followToken || /not found/i.test(error.message)) return;
      await new Promise(resolve => setTimeout(resolve, 2000)); // offline or asleep: try again shortly
    }
  }
}
// A phone that was locked may have dropped the waiting request without telling the page, so ask again straight away.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  if (current) follow(current);
  if (!$('#app-screen').hidden) loadAsks().catch(() => {});
});

// Asks Claude to draw as many columns as fit this screen, so a phone needs no sideways scrolling.
function fitColumns() {
  if (!current) return;
  const screen = $('#screen'), probe = make('span', { className:'mono', textContent:'M'.repeat(50) });
  probe.style.cssText = 'position:absolute; visibility:hidden; white-space:pre';
  document.body.append(probe);
  const charWidth = probe.getBoundingClientRect().width / 50;
  probe.remove();
  const style = getComputedStyle(screen);
  const cols = Math.floor((screen.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)) / charWidth);
  if (cols > 0) post(`/api/sessions/${current}/resize`, { cols }).catch(() => {});
}
let resizeTimer;
window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(fitColumns, 300); });

function render(session) {
  const screen = $('#screen');
  const atBottom = screen.scrollHeight - screen.scrollTop - screen.clientHeight < 40;
  screen.textContent = session.screen || 'Starting Claude…';
  if (atBottom) screen.scrollTop = screen.scrollHeight;
  $('#state-chip').textContent = STATES[session.state] || session.state;
  $('#state-chip').className = `chip ${session.state}`;
  $('#status').textContent = folderName(session.cwd);
  $('#status').title = session.cwd;
  $('#stop-button').hidden = $('#end-button').hidden = session.exited;
  renderQuestion(session.menu);
  if (session.state !== shownState) {
    shownState = session.state;
    loadSessions().catch(() => {});
    if (session.state === 'ended') loadChats().catch(() => {});
  }
}

// Claude's question as big buttons. Redrawn only when the question changes, so a tap is never lost to a redraw.
function renderQuestion(menu) {
  const key = JSON.stringify(menu);
  if (key === shownMenu) return;
  const isNew = !shownMenu || shownMenu === 'null';
  shownMenu = key;
  $('#question').hidden = !menu;
  if (!menu) return;
  $('#options').replaceChildren(...menu.options.map((label, option) => make('button', { className:option === menu.current ? 'current' : '', textContent:label, onclick:() => {
    const buttons = [...$('#options').querySelectorAll('button')], enable = on => buttons.forEach(b => { b.disabled = !on; });
    enable(false);
    setTimeout(() => enable(true), 4000); // in case Claude didn't react and the same question stays up
    post(`/api/sessions/${current}/choose`, { option, label }).then(() => showError(''), error => { showError(error.message); enable(true); });
  } })));
  if (isNew) $('#question').scrollIntoView({ block:'nearest', behavior:'smooth' });
}

$('#stop-button').addEventListener('click', () => input({ key:'esc' }).then(() => showError(''), error => showError(error.message)));
$('#end-button').addEventListener('click', () => {
  if (confirm('End this Claude session? Claude closes; the chat is still saved by Claude.')) post(`/api/sessions/${current}/end`).catch(error => showError(error.message));
});

$('#setup-form').addEventListener('submit', async event => {
  event.preventDefault();
  if ($('#setup-password').value !== $('#setup-confirm').value) return formError(event.target, 'The two passwords are different.');
  try { await post('/api/password/setup', { password:$('#setup-password').value }); event.target.reset(); startApp(); }
  catch (error) { formError(event.target, error.message); }
});

$('#login-form').addEventListener('submit', async event => {
  event.preventDefault();
  try {
    const { status, key } = await post('/api/login', { password:$('#login-password').value, pairCode });
    if (key) { localStorage.setItem(KEY, key); keepKey(key); }
    event.target.reset(); formError(event.target, '');
    status === 'approved' ? startApp() : waitForApproval();
  } catch (error) { formError(event.target, error.message); }
});

$('#sign-out').addEventListener('click', async () => { await post('/api/logout').catch(() => {}); localStorage.removeItem(KEY); keepKey(''); stopApp(); show('login'); });

$('#start-form').addEventListener('submit', async event => {
  event.preventDefault();
  try {
    const { session } = await post('/api/sessions', { cwd:$('#cwd').value });
    showError('');
    openSession(session.id);
  } catch (error) { showError(error.message); }
});

const input = payload => post(`/api/sessions/${current}/input`, payload);
$('#message-form').addEventListener('submit', async event => {
  event.preventDefault();
  const text = $('#message').value;
  if (!text.trim()) return;
  try { await input({ text }); $('#message').value = ''; showError(''); }
  catch (error) { showError(error.message); }
});
$('#message').addEventListener('keydown', event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) $('#message-form').requestSubmit(); });
document.querySelectorAll('[data-key]').forEach(button => button.addEventListener('click', () => input({ key:button.dataset.key }).then(() => showError(''), error => showError(error.message))));

// The fixed page without a computer yet asks for the QR code. A computer that can't be reached (asleep, offline, or
// just restarted and its new link not here yet) is tried again every few seconds.
function start() {
  boot().catch(error => {
    if (error.offline || error.status === 404) {
      $('#scan-title').textContent = onFixedPage ? 'Can\'t reach your computer' : 'Connect to your computer';
      $('#scan-text').textContent = onFixedPage ? OFFLINE : 'Open Pocket Agent on your computer and scan its QR code with this phone.';
      show('scan');
      if (onFixedPage) setTimeout(start, 5000);
      return;
    }
    show('login'); $('#login-note').textContent = error.message;
  });
}
start();
