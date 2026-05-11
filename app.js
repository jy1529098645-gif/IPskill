// dbskill frontend — app logic
// Depends on window.DBS_SKILLS / DBS_DICTIONARY (from skills-data.js) and marked (CDN).

(() => {
  'use strict';

  const SKILLS = window.DBS_SKILLS || {};
  const GROUPS = window.DBS_GROUPS || ['主入口', '诊断', '状态', '基建', '聊天室'];
  const DICTIONARY = window.DBS_DICTIONARY || '';
  const LS_KEY = 'dbskill.v1';
  const API_URL = 'https://api.anthropic.com/v1/messages';

  // ---------- State ----------
  const defaultSettings = {
    apiKey: '',
    project: '',
    model: 'claude-sonnet-4-6',
    maxTokens: 8192,
    loadKnowledge: true,
    streaming: true,
    currentSkill: 'dbs',
    conversations: {}, // { [id]: { id, skill, project, title, createdAt, updatedAt, messages: [...] } }
    activeId: null,
    filterByProject: false,
    skillSectionOpen: true,
  };

  let state = loadState();
  let abortController = null;
  /** @type {Array<{kind:'text'|'image'|'pdf', name:string, size:number, content?:string, mediaType?:string, data?:string}>} */
  const pendingAttachments = [];

  function loadState() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return { ...defaultSettings };
      const saved = JSON.parse(raw);
      return migrate({ ...defaultSettings, ...saved });
    } catch {
      return { ...defaultSettings };
    }
  }

  function migrate(s) {
    if (s.sessions && typeof s.sessions === 'object' && !s._migrated) {
      const now = new Date().toISOString();
      s.conversations = s.conversations || {};
      for (const [skill, msgs] of Object.entries(s.sessions)) {
        if (!Array.isArray(msgs) || msgs.length === 0) continue;
        const id = genId();
        s.conversations[id] = {
          id, skill,
          project: s.project || '默认项目',
          title: deriveTitle(msgs),
          createdAt: now, updatedAt: now,
          messages: msgs,
        };
        if (!s.activeId) s.activeId = id;
      }
      delete s.sessions;
      s._migrated = true;
    }
    if (!s.conversations) s.conversations = {};
    if (s.activeId && !s.conversations[s.activeId]) s.activeId = null;
    return s;
  }

  function genId() {
    return 'c_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  }

  function deriveTitle(msgs) {
    for (const m of msgs) {
      if (m.role !== 'user') continue;
      const t = extractText(m.content);
      if (t) return t.replace(/\s+/g, ' ').trim().slice(0, 30);
    }
    return '(空对话)';
  }

  let lastQuotaWarn = 0;
  function saveState() {
    try { localStorage.setItem(LS_KEY, JSON.stringify(state)); }
    catch (e) {
      if (Date.now() - lastQuotaWarn > 5000) {
        lastQuotaWarn = Date.now();
        flashStatus('⚠️ 浏览器存储已满(图片/PDF 占用太多),当前对话不会自动恢复 — 用 💾 存档下载到本地');
      }
    }
  }

  // ---------- Elements ----------
  const $ = (id) => document.getElementById(id);
  const messagesEl = $('messages');
  const composerEl = $('composer');
  const sendBtn = $('btn-send');
  const stopBtn = $('btn-stop');
  const statusBar = $('status-bar');
  const skillListEl = $('skill-list');
  const convListEl = $('conv-list');
  const convCountEl = $('conv-count');
  const filterProjectInput = $('filter-project');
  const newConvBtn = $('btn-new-conv');
  const skillSectionHeader = $('skill-section-header');
  const skillToggle = $('skill-toggle');
  const projectInput = $('project-name');
  const modelSelect = $('model-select');
  const settingsDialog = $('settings-dialog');
  const apiKeyInput = $('api-key-input');
  const maxTokensInput = $('max-tokens-input');
  const loadKnowledgeInput = $('load-knowledge-input');
  const streamingInput = $('streaming-input');
  const skillHeaderIcon = $('skill-header-icon');
  const skillHeaderName = $('skill-header-name');
  const skillHeaderDesc = $('skill-header-desc');
  const restoreFile = $('restore-file');
  const attachBtn = $('btn-attach');
  const attachInput = $('attach-input');
  const attachmentsPreview = $('attachments-preview');
  const dropZone = $('drop-zone');
  const dropOverlay = $('drop-overlay');

  // ---------- Conversation helpers ----------
  function currentConv() { return state.activeId ? state.conversations[state.activeId] : null; }
  function currentMessages() { const c = currentConv(); return c ? c.messages : []; }

  function createConv(skill) {
    skill = skill && SKILLS[skill] ? skill : (SKILLS[state.currentSkill] ? state.currentSkill : 'dbs');
    const id = genId();
    const now = new Date().toISOString();
    state.conversations[id] = {
      id, skill,
      project: state.project || '默认项目',
      title: '(新对话)',
      createdAt: now, updatedAt: now,
      messages: [],
    };
    state.activeId = id;
    state.currentSkill = skill;
    saveState();
    return state.conversations[id];
  }

  function ensureActiveConv() {
    return currentConv() || createConv(state.currentSkill);
  }

  function switchConv(id) {
    if (!state.conversations[id]) return;
    state.activeId = id;
    state.currentSkill = state.conversations[id].skill;
    saveState();
    renderAll();
  }

  function deleteConv(id) {
    if (!state.conversations[id]) return;
    delete state.conversations[id];
    if (state.activeId === id) {
      const remaining = Object.values(state.conversations)
        .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
      state.activeId = remaining[0]?.id || null;
      if (state.activeId) state.currentSkill = remaining[0].skill;
    }
    saveState();
    renderAll();
  }

  function touchConv(conv) {
    if (!conv) return;
    conv.updatedAt = new Date().toISOString();
    if (!conv.title || conv.title === '(新对话)' || conv.title === '(空对话)') {
      conv.title = deriveTitle(conv.messages);
    }
  }

  function renderAll() {
    renderConvList();
    renderSidebar();
    updateSkillHeader();
    renderMessages();
  }

  // ---------- Sidebar: skills ----------
  function renderSidebar() {
    skillListEl.innerHTML = '';
    if (!state.skillSectionOpen) {
      skillToggle.textContent = '▸';
      skillListEl.style.display = 'none';
      return;
    }
    skillToggle.textContent = '▾';
    skillListEl.style.display = '';

    const skillsByGroup = {};
    for (const name of Object.keys(SKILLS)) {
      const s = SKILLS[name];
      const g = s.group || '其他';
      if (!skillsByGroup[g]) skillsByGroup[g] = [];
      skillsByGroup[g].push(s);
    }
    const order = [...GROUPS, ...Object.keys(skillsByGroup).filter(g => !GROUPS.includes(g))];
    for (const g of order) {
      if (!skillsByGroup[g]) continue;
      const groupEl = document.createElement('div');
      groupEl.className = 'mb-3';
      groupEl.innerHTML = `<div class="section-label mb-1">${escapeHTML(g)}</div>`;
      for (const s of skillsByGroup[g]) {
        const desc = (s.description || '').split('\n')[0].slice(0, 60);
        const isActive = state.currentSkill === s.name;
        const btn = document.createElement('button');
        btn.className = `skill-btn ${isActive ? 'active' : ''}`;
        btn.dataset.skill = s.name;
        btn.innerHTML = `
          <div class="flex items-center gap-2">
            <span class="text-base leading-none">${s.icon || '•'}</span>
            <span class="font-medium text-[13px] truncate">${escapeHTML(s.label)}</span>
          </div>
          <div class="skill-desc text-[11px] truncate pl-7 mt-0.5">${escapeHTML(desc)}</div>
        `;
        btn.addEventListener('click', () => selectSkill(s.name));
        groupEl.appendChild(btn);
      }
      skillListEl.appendChild(groupEl);
    }
  }

  function selectSkill(name) {
    if (!SKILLS[name]) return;
    state.currentSkill = name;
    // Find the latest conversation for (current project if filtering, this skill).
    const cur = state.project || '默认项目';
    const matches = Object.values(state.conversations).filter(c =>
      c.skill === name && (!state.filterByProject || c.project === cur)
    ).sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
    if (matches.length > 0) {
      state.activeId = matches[0].id;
    } else {
      createConv(name);
    }
    saveState();
    renderAll();
  }

  function updateSkillHeader() {
    const conv = currentConv();
    const skillName = conv?.skill || state.currentSkill;
    const s = SKILLS[skillName];
    if (!s) return;
    skillHeaderIcon.textContent = s.icon || '•';
    skillHeaderName.textContent = conv ? `${s.label} · ${conv.title}` : s.label;
    skillHeaderDesc.textContent = conv ? `项目: ${conv.project}` : (s.description || '').split('\n')[0];
  }

  // ---------- Sidebar: conversation list ----------
  function renderConvList() {
    convListEl.innerHTML = '';
    let convs = Object.values(state.conversations);
    if (state.filterByProject) {
      const cur = state.project || '默认项目';
      convs = convs.filter(c => c.project === cur);
    }
    convs.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
    convCountEl.textContent = `(${convs.length})`;
    filterProjectInput.checked = !!state.filterByProject;

    if (convs.length === 0) {
      convListEl.innerHTML = '<div class="text-[11px] text-stone-400 px-2 py-4 text-center leading-relaxed">还没有对话<br>点上面 + 新对话开始</div>';
      return;
    }
    for (const c of convs) {
      const s = SKILLS[c.skill];
      const isActive = c.id === state.activeId;
      const row = document.createElement('div');
      row.className = `conv-row group ${isActive ? 'active' : ''}`;
      row.innerHTML = `
        <div class="flex items-center gap-1.5">
          <span class="text-sm leading-none shrink-0">${s?.icon || '•'}</span>
          <span class="font-medium text-[12px] truncate flex-1">${escapeHTML(c.title || '(新对话)')}</span>
          <button class="conv-del opacity-0 group-hover:opacity-100 text-base leading-none ${isActive ? 'text-stone-300 hover:text-red-300' : 'text-stone-400 hover:text-red-600'}" title="删除对话">×</button>
        </div>
        <div class="text-[10px] ${isActive ? 'text-stone-300' : 'text-stone-500'} truncate pl-[22px] mt-0.5">${escapeHTML(c.project)} · ${escapeHTML(formatDate(c.updatedAt))} · ${c.messages.length} 条</div>
      `;
      row.addEventListener('click', (e) => {
        if (e.target.closest('.conv-del')) return;
        switchConv(c.id);
      });
      row.querySelector('.conv-del').addEventListener('click', (e) => {
        e.stopPropagation();
        if (confirm(`删除对话 "${c.title}"?`)) deleteConv(c.id);
      });
      convListEl.appendChild(row);
    }
  }

  function formatDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    const now = new Date();
    const diff = (now - d) / 1000;
    if (diff < 60) return '刚刚';
    if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
    if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
    if (diff < 86400 * 7) return `${Math.floor(diff / 86400)} 天前`;
    return d.toLocaleDateString('zh-CN');
  }

  // ---------- Messages render ----------
  function renderMessages() {
    messagesEl.innerHTML = '';
    const conv = currentConv();
    const msgs = conv ? conv.messages : [];

    if (!conv) {
      const empty = document.createElement('div');
      empty.className = 'empty-hint mx-auto';
      empty.innerHTML = `
        <div class="text-4xl mb-3 opacity-50">💬</div>
        <div class="font-medium text-stone-700 mb-1.5">还没有对话</div>
        <div class="text-[12px] leading-relaxed text-stone-500">点左上角 + 新对话,或选一个 skill 开始</div>
      `;
      messagesEl.appendChild(empty);
      return;
    }
    if (msgs.length === 0) {
      const s = SKILLS[conv.skill];
      const empty = document.createElement('div');
      empty.className = 'empty-hint mx-auto';
      empty.innerHTML = `
        <div class="text-4xl mb-3 opacity-80">${s.icon || '•'}</div>
        <div class="font-medium text-stone-700 mb-1.5">${escapeHTML(s.label)}</div>
        <div class="text-[12px] leading-relaxed text-stone-500">${escapeHTML((s.description || '').split('\n').slice(0, 4).join(' '))}</div>
      `;
      messagesEl.appendChild(empty);
      return;
    }
    for (let i = 0; i < msgs.length; i++) {
      appendMessageEl(msgs[i].role, msgs[i].content, i);
    }
    scrollToBottom();
  }

  function extractText(content) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content.filter(b => b && b.type === 'text').map(b => b.text || '').join('\n\n');
  }

  function appendMessageEl(role, content, index) {
    const isUser = role === 'user';
    const wrap = document.createElement('div');
    wrap.className = `flex ${isUser ? 'justify-end' : 'justify-start'} group flex-col ${isUser ? 'items-end' : 'items-start'}`;
    wrap.dataset.idx = String(index);

    const blocks = Array.isArray(content)
      ? content
      : [{ type: 'text', text: typeof content === 'string' ? content : '' }];

    for (const b of blocks) {
      if (!b) continue;
      if (b.type === 'text') {
        if (!b.text) continue;
        const bubble = document.createElement('div');
        bubble.className = isUser ? 'bubble-user mb-1' : 'bubble-asst msg-md mb-1';
        if (isUser) bubble.textContent = b.text;
        else bubble.innerHTML = renderMarkdown(b.text);
        wrap.appendChild(bubble);
      } else if (b.type === 'image' && b.source?.data) {
        const img = document.createElement('img');
        img.src = `data:${b.source.media_type || 'image/png'};base64,${b.source.data}`;
        img.className = 'max-w-[260px] max-h-[260px] rounded-xl border border-stone-200 mb-1 cursor-pointer shadow-sm hover:shadow transition';
        img.title = '点击放大';
        img.onclick = () => window.open(img.src, '_blank');
        wrap.appendChild(img);
      } else if (b.type === 'document') {
        const doc = document.createElement('div');
        doc.className = 'bg-stone-100 border border-stone-200 rounded-xl px-3 py-2 text-xs mb-1 inline-flex items-center gap-1.5';
        doc.innerHTML = '<span>📄</span><span>PDF 附件</span>';
        wrap.appendChild(doc);
      }
    }

    if (!isUser) {
      const text = extractText(content);
      if (text) {
        const tools = document.createElement('div');
        tools.className = 'flex gap-1 mt-1 opacity-0 group-hover:opacity-100 transition';
        const copyBtn = document.createElement('button');
        copyBtn.className = 'text-[11px] text-stone-400 hover:text-stone-800 px-1.5 py-0.5 rounded hover:bg-stone-100 transition';
        copyBtn.textContent = '复制';
        copyBtn.onclick = () => { navigator.clipboard.writeText(text); copyBtn.textContent = '已复制'; setTimeout(() => copyBtn.textContent = '复制', 1200); };
        tools.appendChild(copyBtn);
        wrap.appendChild(tools);
      }
    }
    messagesEl.appendChild(wrap);
  }

  function renderMarkdown(text) {
    try { return marked.parse(text, { breaks: true, gfm: true }); }
    catch { return escapeHTML(text); }
  }

  function escapeHTML(str) {
    return String(str).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  function scrollToBottom() {
    requestAnimationFrame(() => { messagesEl.scrollTop = messagesEl.scrollHeight; });
  }

  // ---------- Attachments ----------
  const TEXT_EXT_RE = /\.(txt|md|markdown|mdx|rst|json|jsonl|ndjson|csv|tsv|yaml|yml|toml|ini|env|conf|xml|html|htm|css|scss|sass|less|js|mjs|cjs|jsx|ts|tsx|py|rb|go|rs|java|kt|swift|c|h|cpp|cxx|hpp|hxx|cs|php|pl|lua|sql|sh|bash|zsh|ps1|bat|cmd|log|gitignore|gitattributes|editorconfig|dockerfile)$/i;

  function detectKind(file) {
    if (file.type.startsWith('image/')) return 'image';
    if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) return 'pdf';
    if (file.type.startsWith('text/') || TEXT_EXT_RE.test(file.name)) return 'text';
    return 'unknown';
  }

  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => {
        const s = String(r.result || '');
        const i = s.indexOf('base64,');
        resolve(i >= 0 ? s.slice(i + 7) : '');
      };
      r.onerror = () => reject(new Error('read failed'));
      r.readAsDataURL(file);
    });
  }

  async function addAttachment(file) {
    const kind = detectKind(file);
    if (kind === 'unknown') {
      alert(`不支持的文件类型: ${file.name}\n支持: 纯文本(.txt/.md/.json/.csv/.js/.py/.html/...)、图片(.png/.jpg/.webp/.gif)、PDF`);
      return;
    }
    if (kind === 'image' && file.size > 5 * 1024 * 1024) { alert(`图片 ${file.name} 超过 5MB,Claude API 不接受`); return; }
    if (kind === 'pdf' && file.size > 32 * 1024 * 1024) { alert(`PDF ${file.name} 超过 32MB,Claude API 不接受`); return; }
    if (kind === 'text' && file.size > 2 * 1024 * 1024) {
      if (!confirm(`${file.name} 有 ${(file.size/1024/1024).toFixed(1)}MB,作为文本附件会很贵(几十万 tokens),确认?`)) return;
    }
    if (kind === 'text') {
      const content = await file.text();
      pendingAttachments.push({ kind, name: file.name, size: file.size, content });
    } else {
      const data = await fileToBase64(file);
      pendingAttachments.push({ kind, name: file.name, size: file.size, mediaType: file.type || (kind === 'pdf' ? 'application/pdf' : 'image/png'), data });
    }
    renderAttachments();
  }

  function formatSize(bytes) {
    if (bytes < 1024) return bytes + 'B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + 'KB';
    return (bytes / 1024 / 1024).toFixed(1) + 'MB';
  }

  function renderAttachments() {
    if (pendingAttachments.length === 0) {
      attachmentsPreview.classList.add('hidden');
      attachmentsPreview.innerHTML = '';
      return;
    }
    attachmentsPreview.classList.remove('hidden');
    attachmentsPreview.innerHTML = '';
    pendingAttachments.forEach((a, i) => {
      const chip = document.createElement('div');
      chip.className = 'attach-chip';
      const icon = a.kind === 'image' ? '🖼️' : a.kind === 'pdf' ? '📄' : '📝';
      chip.innerHTML = `
        <span>${icon}</span>
        <span class="font-medium max-w-[180px] truncate">${escapeHTML(a.name)}</span>
        <span class="text-stone-400">${formatSize(a.size)}</span>
        <button type="button" class="text-stone-400 hover:text-red-600 ml-1 text-base leading-none" aria-label="移除">×</button>
      `;
      chip.querySelector('button').addEventListener('click', () => {
        pendingAttachments.splice(i, 1);
        renderAttachments();
      });
      attachmentsPreview.appendChild(chip);
    });
  }

  function buildUserContent(text, attachments) {
    let combinedText = text || '';
    for (const a of attachments) {
      if (a.kind !== 'text') continue;
      combinedText += `\n\n📎 附件: ${a.name} (${formatSize(a.size)})\n\`\`\`\n${a.content}\n\`\`\``;
    }
    const mediaAtts = attachments.filter(a => a.kind === 'image' || a.kind === 'pdf');
    if (mediaAtts.length === 0) return combinedText;

    const blocks = [];
    if (combinedText.trim()) blocks.push({ type: 'text', text: combinedText });
    for (const a of mediaAtts) {
      if (a.kind === 'image') {
        blocks.push({ type: 'image', source: { type: 'base64', media_type: a.mediaType, data: a.data } });
      } else if (a.kind === 'pdf') {
        blocks.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: a.data } });
      }
    }
    if (blocks.length === 1 && blocks[0].type === 'text') return blocks[0].text;
    return blocks;
  }

  // ---------- System prompt ----------
  function buildSystemPrompt(skillName) {
    const s = SKILLS[skillName];
    if (!s) return '';
    let prompt = s.body;
    if (state.loadKnowledge && s.knowledge && s.knowledge.length > 0) {
      prompt += '\n\n---\n\n# 深度参考资料\n\n以下是这个 skill 的完整方法论与案例库,请在诊断时参考。\n\n';
      for (const k of s.knowledge) {
        prompt += `\n\n## ${k.name}\n\n${k.content}\n`;
      }
    }
    if (state.loadKnowledge && DICTIONARY) {
      prompt += `\n\n---\n\n# 高频概念词典(全局术语校准,所有 skill 共用)\n\n${DICTIONARY}\n`;
    }
    const conv = currentConv();
    const project = conv?.project || state.project || '默认项目';
    prompt += `\n\n---\n\n# 当前会话上下文\n- 当前项目: ${project}\n- 当前 skill: ${skillName}\n- 你正在通过一个浏览器前端运行,无法访问本地文件系统。如果 skill 提到"写入 ~/.dbs/sessions/" 这类本地操作,请改为把对应 JSON 内容贴到对话里,用户会通过界面的"存档"按钮自行保存。\n`;
    return prompt;
  }

  // ---------- Send / Stream ----------
  async function send() {
    const text = composerEl.value.trim();
    const hasAttachments = pendingAttachments.length > 0;
    if (!text && !hasAttachments) return;
    if (!state.apiKey) {
      flashStatus('请先在 ⚙️ 设置里填入 Anthropic API key');
      openSettings();
      return;
    }
    composerEl.value = '';
    const userContent = buildUserContent(text, pendingAttachments);
    pendingAttachments.length = 0;
    renderAttachments();

    const conv = ensureActiveConv();
    conv.messages.push({ role: 'user', content: userContent });
    touchConv(conv);
    saveState();
    renderConvList();
    renderMessages();
    updateSkillHeader();

    sendBtn.disabled = true;
    stopBtn.classList.remove('hidden');
    sendBtn.classList.add('hidden');
    setStatus('请求中…');

    const skillName = conv.skill;
    const system = buildSystemPrompt(skillName);
    const systemBlocks = [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }];

    abortController = new AbortController();
    let assistantText = '';
    let assistantEl = null;
    let assistantBubble = null;
    {
      const wrap = document.createElement('div');
      wrap.className = 'flex justify-start flex-col items-start group';
      const bubble = document.createElement('div');
      bubble.className = 'bubble-asst msg-md typing';
      bubble.innerHTML = '<span class="text-stone-400">思考中…</span>';
      wrap.appendChild(bubble);
      messagesEl.appendChild(wrap);
      scrollToBottom();
      assistantEl = wrap;
      assistantBubble = bubble;
    }

    try {
      const body = {
        model: state.model,
        max_tokens: state.maxTokens,
        system: systemBlocks,
        messages: conv.messages.map(m => ({ role: m.role, content: m.content })),
        stream: !!state.streaming,
      };
      const res = await fetch(API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': state.apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify(body),
        signal: abortController.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);

      if (state.streaming) {
        const reader = res.body.getReader();
        const decoder = new TextDecoder('utf-8');
        let buf = '';
        let usage = null;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let idx;
          while ((idx = buf.indexOf('\n\n')) !== -1) {
            const block = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            let dataStr = '';
            for (const line of block.split('\n')) {
              if (line.startsWith('data:')) dataStr += line.slice(5).trim();
            }
            if (!dataStr) continue;
            try {
              const data = JSON.parse(dataStr);
              if (data.type === 'content_block_delta' && data.delta?.type === 'text_delta') {
                assistantText += data.delta.text;
                assistantBubble.innerHTML = renderMarkdown(assistantText);
                scrollToBottom();
              } else if (data.type === 'message_delta' && data.usage) {
                usage = { ...(usage || {}), ...data.usage };
              } else if (data.type === 'message_start' && data.message?.usage) {
                usage = data.message.usage;
              } else if (data.type === 'error') {
                throw new Error(data.error?.message || JSON.stringify(data));
              }
            } catch (e) {
              if (e instanceof SyntaxError) continue;
              throw e;
            }
          }
        }
        assistantBubble.classList.remove('typing');
        setStatus(usage ? formatUsage(usage) : '完成');
      } else {
        const data = await res.json();
        assistantText = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
        assistantBubble.innerHTML = renderMarkdown(assistantText);
        assistantBubble.classList.remove('typing');
        if (data.usage) setStatus(formatUsage(data.usage));
      }
    } catch (err) {
      if (err.name === 'AbortError') {
        setStatus('已停止');
        assistantBubble.classList.remove('typing');
        assistantBubble.innerHTML = assistantText
          ? renderMarkdown(assistantText + '\n\n*— 用户停止 —*')
          : '<span class="text-stone-400">已停止</span>';
      } else {
        console.error(err);
        assistantBubble.classList.remove('typing');
        assistantBubble.innerHTML = `<div class="text-red-600 whitespace-pre-wrap">⚠️ 出错了:\n${escapeHTML(err.message || String(err))}</div>`;
        setStatus('出错');
      }
    } finally {
      if (assistantText) {
        conv.messages.push({ role: 'assistant', content: assistantText });
        touchConv(conv);
        saveState();
        assistantEl.remove();
        renderConvList();
        renderMessages();
        updateSkillHeader();
      } else {
        assistantEl.remove();
      }
      sendBtn.disabled = false;
      sendBtn.classList.remove('hidden');
      stopBtn.classList.add('hidden');
      abortController = null;
    }
  }

  function formatUsage(u) {
    const parts = [];
    if (u.input_tokens != null) parts.push(`in ${u.input_tokens}`);
    if (u.cache_creation_input_tokens) parts.push(`cache_create ${u.cache_creation_input_tokens}`);
    if (u.cache_read_input_tokens) parts.push(`cache_read ${u.cache_read_input_tokens}`);
    if (u.output_tokens != null) parts.push(`out ${u.output_tokens}`);
    return `tokens · ${parts.join(' · ')}`;
  }

  function setStatus(text) { statusBar.textContent = text; }
  function flashStatus(text) { setStatus(text); setTimeout(() => { if (statusBar.textContent === text) setStatus(''); }, 4000); }

  // ---------- Save / Restore / Report ----------
  function doSave() {
    const conv = currentConv();
    if (!conv || conv.messages.length === 0) { flashStatus('当前对话为空,没东西可存档'); return; }
    const summary = prompt('给这次存档起个名字(可选,会出现在文件名里):', conv.title || '') || '';
    const payload = {
      version: 2,
      tool: 'dbskill-frontend',
      project: conv.project,
      skill: conv.skill,
      title: conv.title,
      summary,
      createdAt: conv.createdAt,
      savedAt: new Date().toISOString(),
      messages: conv.messages,
    };
    const dateStr = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const safe = (s) => s.replace(/[^\w一-龥-]+/g, '_').slice(0, 40);
    const fname = `dbs_${safe(payload.project)}_${conv.skill}_${dateStr}${summary ? '_' + safe(summary) : ''}.json`;
    downloadJSON(payload, fname);
    flashStatus('已下载存档: ' + fname);
  }

  function doRestore() {
    restoreFile.multiple = false;
    restoreFile.onchange = async () => {
      const f = restoreFile.files[0];
      if (!f) return;
      try {
        const text = await f.text();
        const data = JSON.parse(text);
        if (!data.messages || !Array.isArray(data.messages)) throw new Error('文件里没有 messages 字段');
        const skill = data.skill && SKILLS[data.skill] ? data.skill : 'dbs';
        const id = genId();
        const now = new Date().toISOString();
        state.conversations[id] = {
          id, skill,
          project: data.project || state.project || '默认项目',
          title: data.title || data.summary || deriveTitle(data.messages),
          createdAt: data.createdAt || now,
          updatedAt: now,
          messages: data.messages,
        };
        state.activeId = id;
        state.currentSkill = skill;
        if (data.project) { state.project = data.project; projectInput.value = state.project; }
        saveState();
        renderAll();
        flashStatus(`已恢复对话 (${data.messages.length} 条消息,${skill})`);
      } catch (e) {
        alert('恢复失败: ' + e.message);
      }
      restoreFile.value = '';
    };
    restoreFile.click();
  }

  function doReport() {
    restoreFile.multiple = true;
    restoreFile.onchange = async () => {
      const files = Array.from(restoreFile.files || []);
      if (files.length === 0) return;
      try {
        const archives = [];
        for (const f of files) {
          const text = await f.text();
          const data = JSON.parse(text);
          if (data.messages && Array.isArray(data.messages)) archives.push(data);
        }
        if (archives.length === 0) throw new Error('没有合法的存档文件');
        archives.sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));

        const id = genId();
        const now = new Date().toISOString();
        const userText = buildReportRequest(archives);
        state.conversations[id] = {
          id, skill: 'dbs-report',
          project: archives[0].project || state.project || '默认项目',
          title: `合并报告(${archives.length} 份)`,
          createdAt: now, updatedAt: now,
          messages: [{ role: 'user', content: userText }],
        };
        state.activeId = id;
        state.currentSkill = 'dbs-report';
        saveState();
        renderAll();
        flashStatus(`已加载 ${archives.length} 份存档,自动触发 dbs-report 合并`);
        await sendInjected();
      } catch (e) {
        alert('合并失败: ' + e.message);
      }
      restoreFile.value = '';
    };
    restoreFile.click();
  }

  function buildReportRequest(archives) {
    let s = `请你按照 dbs-report 的方法论,把以下 ${archives.length} 份诊断存档合并成一份可分享的 markdown 报告。\n\n`;
    s += `项目: ${archives[0].project || '默认项目'}\n`;
    s += `时间范围: ${archives[0].createdAt || '?'} → ${archives[archives.length-1].createdAt || '?'}\n\n`;
    archives.forEach((a, i) => {
      s += `\n---\n\n## 存档 ${i + 1}: ${a.skill || '?'} · ${a.summary || a.title || '无摘要'}\n`;
      s += `时间: ${a.createdAt || '?'}\n\n`;
      for (const m of a.messages) {
        const content = extractText(m.content) || '(非文本内容)';
        s += `### ${m.role === 'user' ? '👤 用户' : '🤖 助手'}\n${content}\n\n`;
      }
    });
    s += `\n---\n\n请按 dbs-report SKILL.md 的指引输出一份完整的合并报告。`;
    return s;
  }

  async function sendInjected() {
    const conv = currentConv();
    if (!conv) return;
    if (!state.apiKey) { flashStatus('请先在 ⚙️ 设置里填入 API key'); openSettings(); return; }
    sendBtn.disabled = true;
    stopBtn.classList.remove('hidden');
    sendBtn.classList.add('hidden');
    setStatus('请求中…');
    const skillName = conv.skill;
    const system = buildSystemPrompt(skillName);
    const systemBlocks = [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }];
    abortController = new AbortController();
    let assistantText = '';
    const wrap = document.createElement('div');
    wrap.className = 'flex justify-start flex-col items-start group';
    const bubble = document.createElement('div');
    bubble.className = 'bubble-asst msg-md typing';
    bubble.innerHTML = '<span class="text-stone-400">合并中…</span>';
    wrap.appendChild(bubble);
    messagesEl.appendChild(wrap);
    scrollToBottom();
    try {
      const res = await fetch(API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': state.apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify({
          model: state.model, max_tokens: state.maxTokens,
          system: systemBlocks,
          messages: conv.messages.map(m => ({ role: m.role, content: m.content })),
          stream: true,
        }),
        signal: abortController.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          for (const line of block.split('\n')) {
            if (!line.startsWith('data:')) continue;
            const ds = line.slice(5).trim();
            if (!ds) continue;
            try {
              const data = JSON.parse(ds);
              if (data.type === 'content_block_delta' && data.delta?.type === 'text_delta') {
                assistantText += data.delta.text;
                bubble.innerHTML = renderMarkdown(assistantText);
                scrollToBottom();
              }
            } catch {}
          }
        }
      }
      bubble.classList.remove('typing');
      setStatus('报告完成 — 可点击复制或继续追问让 LLM 调整');
    } catch (err) {
      bubble.classList.remove('typing');
      bubble.innerHTML = `<div class="text-red-600 whitespace-pre-wrap">⚠️ ${escapeHTML(err.message || String(err))}</div>`;
      setStatus('出错');
    } finally {
      if (assistantText) {
        conv.messages.push({ role: 'assistant', content: assistantText });
        touchConv(conv);
        saveState();
        wrap.remove();
        renderConvList();
        renderMessages();
      } else {
        wrap.remove();
      }
      sendBtn.disabled = false;
      sendBtn.classList.remove('hidden');
      stopBtn.classList.add('hidden');
      abortController = null;
    }
  }

  function downloadJSON(obj, filename) {
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function doClearOrDelete() {
    const conv = currentConv();
    if (!conv) return;
    if (!confirm(`确认删除当前对话 "${conv.title}"?\n(只删这一条,其他对话不影响)`)) return;
    deleteConv(conv.id);
  }

  // ---------- Settings dialog ----------
  function openSettings() {
    apiKeyInput.value = state.apiKey || '';
    maxTokensInput.value = state.maxTokens;
    loadKnowledgeInput.checked = state.loadKnowledge;
    streamingInput.checked = state.streaming;
    if (typeof settingsDialog.showModal === 'function') settingsDialog.showModal();
    else settingsDialog.setAttribute('open', '');
  }
  function closeSettings(save) {
    if (save) {
      state.apiKey = apiKeyInput.value.trim();
      state.maxTokens = Math.max(512, Math.min(64000, parseInt(maxTokensInput.value) || 8192));
      state.loadKnowledge = !!loadKnowledgeInput.checked;
      state.streaming = !!streamingInput.checked;
      saveState();
      flashStatus('设置已保存');
    }
    if (typeof settingsDialog.close === 'function') settingsDialog.close();
    else settingsDialog.removeAttribute('open');
  }

  // ---------- Wire up ----------
  function init() {
    if (!SKILLS[state.currentSkill]) state.currentSkill = 'dbs';
    projectInput.value = state.project || '';
    modelSelect.value = state.model;

    renderAll();

    sendBtn.addEventListener('click', send);
    stopBtn.addEventListener('click', () => abortController?.abort());
    composerEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        send();
      }
    });
    projectInput.addEventListener('input', (e) => {
      state.project = e.target.value;
      saveState();
      if (state.filterByProject) renderConvList();
    });
    modelSelect.addEventListener('change', (e) => { state.model = e.target.value; saveState(); });

    newConvBtn.addEventListener('click', () => {
      createConv(state.currentSkill);
      renderAll();
      composerEl.focus();
    });
    filterProjectInput.addEventListener('change', () => {
      state.filterByProject = !!filterProjectInput.checked;
      saveState();
      renderConvList();
    });
    skillSectionHeader.addEventListener('click', () => {
      state.skillSectionOpen = !state.skillSectionOpen;
      saveState();
      renderSidebar();
    });

    $('btn-save').addEventListener('click', doSave);
    $('btn-restore').addEventListener('click', doRestore);
    $('btn-report').addEventListener('click', doReport);
    $('btn-clear').addEventListener('click', doClearOrDelete);
    $('btn-settings').addEventListener('click', openSettings);
    $('btn-cancel-settings').addEventListener('click', () => closeSettings(false));
    $('btn-save-settings').addEventListener('click', () => closeSettings(true));
    $('toggle-sidebar').addEventListener('click', () => $('sidebar').classList.toggle('hidden'));

    // ---- Attachment wiring ----
    attachBtn.addEventListener('click', () => attachInput.click());
    attachInput.addEventListener('change', async (e) => {
      const files = Array.from(e.target.files || []);
      for (const f of files) await addAttachment(f);
      attachInput.value = '';
    });
    composerEl.addEventListener('paste', async (e) => {
      const items = Array.from(e.clipboardData?.items || []);
      const files = items.map(it => it.kind === 'file' ? it.getAsFile() : null).filter(Boolean);
      if (files.length === 0) return;
      e.preventDefault();
      for (const f of files) await addAttachment(f);
    });
    let dragDepth = 0;
    const showOverlay = () => dropOverlay.classList.remove('hidden');
    const hideOverlay = () => dropOverlay.classList.add('hidden');
    dropZone.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; showOverlay(); });
    dropZone.addEventListener('dragover', (e) => { e.preventDefault(); });
    dropZone.addEventListener('dragleave', (e) => {
      e.preventDefault();
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) hideOverlay();
    });
    dropZone.addEventListener('drop', async (e) => {
      e.preventDefault();
      dragDepth = 0;
      hideOverlay();
      const files = Array.from(e.dataTransfer?.files || []);
      for (const f of files) await addAttachment(f);
    });
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => e.preventDefault());

    if (!state.apiKey) {
      setStatus('请先点 ⚙️ 填入 Anthropic API key 才能开始对话');
    } else {
      setStatus(`已就绪 · ${Object.keys(SKILLS).length} 个 skill · ${Object.keys(state.conversations).length} 个历史对话`);
    }
  }

  init();
})();
