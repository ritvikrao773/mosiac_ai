const $ = selector => document.querySelector(selector);
const form = $('#chat-form');
const input = $('#message-input');
const conversation = $('#conversation');
const welcome = $('#welcome');
const modelTrigger = $('#model-trigger');
const modelPopover = $('#model-popover');
const modelList = $('#model-list');
const searchInput = $('#model-search');
const notice = $('#setup-notice');
const historyList = $('#history-list');
const state = { models: [], model: null, messages: [], conversations: [], sending: false, configured: false };

function esc(value) {
  return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function loadSaved() {
  try {
    const saved = JSON.parse(localStorage.getItem('mosaic-chats') || '[]');
    state.conversations = Array.isArray(saved) ? saved.filter(item => item && typeof item.title === 'string' && Array.isArray(item.messages)).slice(0, 20) : [];
  } catch { state.conversations = []; }
  renderHistory();
}

function saveConversation() {
  if (!state.messages.length) return;
  const title = state.messages.find(message => message.role === 'user')?.content.slice(0, 52) || 'New conversation';
  const record = { id: Date.now(), title, messages: state.messages, model: state.model?.id || '' };
  state.conversations.unshift(record);
  state.conversations = state.conversations.slice(0, 20);
  try { localStorage.setItem('mosaic-chats', JSON.stringify(state.conversations)); } catch { showToast('Could not save chat history in this browser.'); }
  renderHistory();
}

function renderHistory() {
  if (!state.conversations.length) {
    historyList.innerHTML = '<div class="history-empty">Your conversations<br>will appear here.</div>';
    return;
  }
  historyList.innerHTML = state.conversations.map(chat => `<button class="history-item" data-chat-id="${esc(chat.id)}" title="${esc(chat.title)}"><span>&#9673;</span><span>${esc(chat.title)}</span></button>`).join('');
  historyList.querySelectorAll('[data-chat-id]').forEach(button => button.addEventListener('click', () => openConversation(Number(button.dataset.chatId))));
}

function openConversation(id) {
  const saved = state.conversations.find(chat => chat.id === id);
  if (!saved) return;
  state.messages = saved.messages.slice();
  if (saved.model) state.model = state.models.find(model => model.id === saved.model) || state.model;
  if (state.model) $('#current-model-name').textContent = state.model.name;
  renderMessages();
  notice.classList.add('hidden');
  welcome.classList.add('hidden');
  input.focus();
}

function resetChat() {
  if (state.messages.length && !state.messages.at(-1).pending) saveConversation();
  state.messages = [];
  conversation.innerHTML = '';
  welcome.classList.remove('hidden');
  notice.classList.toggle('hidden', state.configured);
  input.value = '';
  resizeInput();
  input.focus();
}

function renderModelList(filter = '') {
  const query = filter.trim().toLowerCase();
  const models = state.models.filter(model => `${model.name} ${model.id} ${model.brand}`.toLowerCase().includes(query));
  if (!models.length) {
    modelList.innerHTML = `<div class="model-empty">${state.models.length ? 'No models match your search.' : 'No models are available.'}</div>`;
    return;
  }
  modelList.innerHTML = models.map(model => `<button class="model-option ${state.model?.id === model.id ? 'selected' : ''}" data-model-id="${esc(model.id)}"><span class="model-provider-icon">${esc((model.brand || model.id.split('/')[0] || 'AI').slice(0, 2))}</span><span class="model-option-copy"><strong>${esc(model.name)}</strong><span>${esc(model.id)}</span></span>${model.is_free ? '<span class="model-badge">FREE</span>' : ''}</button>`).join('');
  modelList.querySelectorAll('[data-model-id]').forEach(button => button.addEventListener('click', () => {
    state.model = state.models.find(model => model.id === button.dataset.modelId) || null;
    if (state.model) $('#current-model-name').textContent = state.model.name;
    modelPopover.classList.add('hidden');
    renderModelList(searchInput.value);
  }));
}

async function loadModels() {
  try {
    const [configResponse, modelsResponse] = await Promise.all([fetch('/api/config'), fetch('/api/models')]);
    const config = await configResponse.json();
    state.configured = Boolean(config.configured);
    notice.classList.toggle('hidden', state.configured);
    const data = await modelsResponse.json();
    if (!modelsResponse.ok) throw new Error(data.error || 'Unable to load models.');
    state.models = data.models || [];
    $('#model-count').textContent = state.models.length ? String(state.models.length) : '0';
    state.model = state.models.find(model => model.is_free) || state.models[0] || null;
    if (state.model) $('#current-model-name').textContent = state.model.name;
    renderModelList();
  } catch (error) {
    $('#model-count').textContent = '--';
    modelList.innerHTML = `<div class="model-empty">${esc(error.message || 'Could not load models.')}</div>`;
  }
}

function appendMessage(role, content, pending = false) {
  const message = { role, content, pending };
  state.messages.push(message);
  const wrapper = document.createElement('article');
  wrapper.className = `message ${role === 'user' ? 'user' : 'ai'}`;
  wrapper.dataset.messageIndex = String(state.messages.length - 1);
  const avatar = document.createElement('span');
  avatar.className = 'message-avatar';
  avatar.textContent = role === 'user' ? 'Y' : '\u2733';
  const bubble = document.createElement('div');
  bubble.className = 'message-bubble';
  if (pending) bubble.innerHTML = '<span class="typing-indicator"><i></i><i></i><i></i></span>';
  else if (role === 'user') bubble.textContent = content;
  else bubble.innerHTML = formatAnswer(content);
  if (role === 'user') wrapper.append(bubble, avatar); else wrapper.append(avatar, bubble);
  conversation.append(wrapper);
  wrapper.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  return wrapper;
}

function formatAnswer(text) {
  const escaped = esc(text || '').replace(/```([\w-]*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>');
  return escaped.split(/\n{2,}/).map(part => `<p>${part.replace(/\n/g, '<br>')}</p>`).join('') || '<p></p>';
}

function renderMessages() {
  conversation.innerHTML = '';
  state.messages.forEach(message => appendRenderedMessage(message));
}

function appendRenderedMessage(message) {
  const wrapper = document.createElement('article');
  wrapper.className = `message ${message.role === 'user' ? 'user' : 'ai'}`;
  const avatar = document.createElement('span');
  avatar.className = 'message-avatar';
  avatar.textContent = message.role === 'user' ? 'Y' : '\u2733';
  const bubble = document.createElement('div');
  bubble.className = 'message-bubble';
  if (message.pending) bubble.innerHTML = '<span class="typing-indicator"><i></i><i></i><i></i></span>';
  else if (message.role === 'user') bubble.textContent = message.content;
  else bubble.innerHTML = formatAnswer(message.content);
  if (message.role === 'user') wrapper.append(bubble, avatar); else wrapper.append(avatar, bubble);
  conversation.append(wrapper);
}

async function sendMessage(text) {
  if (state.sending) return;
  if (!state.model) {
    showToast(state.configured ? 'No models are available for this account.' : 'The site owner needs to connect Mesh API first.');
    notice.classList.toggle('hidden', state.configured);
    return;
  }
  state.sending = true;
  welcome.classList.add('hidden');
  notice.classList.add('hidden');
  $('#send-button').disabled = true;
  appendMessage('user', text);
  const assistantMessage = { role: 'assistant', content: '', pending: true };
  state.messages.push(assistantMessage);
  appendRenderedMessage(assistantMessage);
  const messageNode = conversation.lastElementChild;
  try {
    const response = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: state.model.id, messages: state.messages.filter(message => !message.pending).map(({ role, content }) => ({ role, content })) }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'The request failed. Please try again.');
    assistantMessage.content = typeof data.reply === 'string' ? data.reply : JSON.stringify(data.reply);
    assistantMessage.pending = false;
    const bubble = messageNode.querySelector('.message-bubble');
    bubble.innerHTML = formatAnswer(assistantMessage.content);
    addMessageActions(messageNode, assistantMessage.content);
    messageNode.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    saveConversation();
  } catch (error) {
    state.messages.pop();
    messageNode.remove();
    showToast(error.message || 'Something went wrong. Please try again.');
    if (!state.configured) notice.classList.remove('hidden');
  } finally {
    state.sending = false;
    $('#send-button').disabled = false;
    input.focus();
  }
}

function addMessageActions(node, text) {
  const actions = document.createElement('div');
  actions.className = 'message-tools';
  const copy = document.createElement('button');
  copy.type = 'button'; copy.textContent = 'Copy';
  copy.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(text); showToast('Copied to clipboard.'); }
    catch { showToast('Clipboard access is unavailable in this browser.'); }
  });
  actions.append(copy);
  node.querySelector('.message-bubble').append(actions);
}

function resizeInput() {
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 145)}px`;
}

let toastTimer;
function showToast(message) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add('hidden'), 3200);
}

form.addEventListener('submit', event => {
  event.preventDefault();
  const text = input.value.trim();
  if (!text || state.sending) return;
  input.value = '';
  resizeInput();
  sendMessage(text);
});
input.addEventListener('input', resizeInput);
input.addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); form.requestSubmit(); }
});
$('#new-chat').addEventListener('click', resetChat);
modelTrigger.addEventListener('click', () => {
  modelPopover.classList.toggle('hidden');
  renderModelList(searchInput.value);
  if (!modelPopover.classList.contains('hidden')) searchInput.focus();
});
searchInput.addEventListener('input', () => renderModelList(searchInput.value));
document.addEventListener('click', event => {
  if (!modelPopover.contains(event.target) && !modelTrigger.contains(event.target)) modelPopover.classList.add('hidden');
});
document.querySelectorAll('.suggestion-card').forEach(button => button.addEventListener('click', () => { input.value = button.dataset.prompt || ''; resizeInput(); input.focus(); }));
$('#share-button').addEventListener('click', async () => {
  try {
    if (navigator.share) await navigator.share({ title: 'Mosaic AI', text: 'A calm place to chat with AI models.', url: location.href });
    else { await navigator.clipboard.writeText(location.href); showToast('Link copied to clipboard.'); }
  } catch (error) { if (error.name !== 'AbortError') showToast('Could not share this link.'); }
});
$('.search-history').addEventListener('click', () => {
  const query = prompt('Search saved conversations:');
  if (query === null) return;
  const matches = state.conversations.filter(chat => chat.title.toLowerCase().includes(query.toLowerCase()));
  if (!matches.length) { showToast('No matching saved conversations.'); return; }
  renderHistory();
  openConversation(matches[0].id);
});
document.addEventListener('keydown', event => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); resetChat(); }
  if (event.key === 'Escape') modelPopover.classList.add('hidden');
});

loadSaved();
loadModels();
