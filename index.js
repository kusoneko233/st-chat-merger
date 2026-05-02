import { getRequestHeaders } from "../../../../script.js";

const extensionName = "st-chat-merger";
const extensionFolderPath = `scripts/extensions/third-party/${extensionName}`;

let chatListCache = [];
let selectedChats = [];
let loadedChatData = new Map();
let externalFiles = [];
let activeTab = 'current';
let lastPreviewData = null;

// ===== API =====
async function fetchChatList(avatarUrl) {
    const r = await fetch('/api/chats/search', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ avatar_url: avatarUrl }),
    });
    if (!r.ok) throw new Error(`获取列表失败: ${r.status}`);
    return await r.json();
}

async function fetchChatContent(charName, fileName, avatarUrl) {
    if (loadedChatData.has(fileName)) return loadedChatData.get(fileName);
    const r = await fetch('/api/chats/get', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({
            ch_name: charName,
            file_name: fileName.replace('.jsonl', ''),
            avatar_url: avatarUrl,
        }),
    });
    if (!r.ok) throw new Error(`读取聊天失败: ${r.status}`);
    const messages = await r.json();
    const jsonl = messages.map(m => JSON.stringify(m)).join('\n');
    const sizeBytes = new Blob([jsonl]).size;
    const entry = { messages: Array.isArray(messages) ? messages : [], sizeBytes };
    loadedChatData.set(fileName, entry);
    return entry;
}

async function importViaSillyTavern(jsonlContent, fileName) {
    const file = new File([jsonlContent], fileName, { type: 'application/jsonl' });
    const possibleSelectors = [
        '#chat_import_file_input',
        'input[name="chat_import"]',
        '#import_chat_file',
        'input#chat_import',
    ];
    let fileInput = null;
    for (const sel of possibleSelectors) {
        fileInput = document.querySelector(sel);
        if (fileInput) break;
    }
    if (!fileInput) {
        const importBtns = document.querySelectorAll('#chat_import, [id*="import_chat"], [id*="chat_import"]');
        for (const btn of importBtns) {
            const nearbyInput = btn.querySelector('input[type="file"]') ||
                btn.parentElement?.querySelector('input[type="file"]') ||
                btn.nextElementSibling;
            if (nearbyInput && nearbyInput.type === 'file') {
                fileInput = nearbyInput;
                break;
            }
        }
    }
    if (!fileInput) {
        const allInputs = document.querySelectorAll('input[type="file"]');
        console.log('[ChatMerger] 页面上所有 file input:', Array.from(allInputs).map(i => ({
            id: i.id, name: i.name, accept: i.accept, className: i.className,
        })));
        for (const inp of allInputs) {
            if (inp.accept && (inp.accept.includes('.jsonl') || inp.accept.includes('jsonl'))) {
                fileInput = inp;
                break;
            }
        }
    }
    if (!fileInput) {
        console.error('[ChatMerger] 未找到导入聊天的 file input，所有 file inputs:',
            Array.from(document.querySelectorAll('input[type="file"]')).map(i => ({
                id: i.id, name: i.name, accept: i.accept,
            }))
        );
        throw new Error('找不到酒馆的导入聊天接口，请用"合并并下载"后手动导入');
    }
    console.log('[ChatMerger] 找到导入 file input:', fileInput.id, fileInput.name, fileInput.accept);
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(file);
    fileInput.files = dataTransfer.files;
    fileInput.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
}

// ===== 工具 =====
function escapeHtml(t) {
    const d = document.createElement('div');
    d.textContent = t;
    return d.innerHTML;
}

function getCharInfo() {
    const ctx = SillyTavern.getContext();
    if (ctx.characterId == null) return null;
    const c = ctx.characters[ctx.characterId];
    return c ? { id: ctx.characterId, name: c.name, avatar: c.avatar } : null;
}

function getChatDate(chat) {
    for (const k of ['last_mes', 'file_date', 'date', 'create_date']) {
        if (chat[k] != null) return chat[k];
    }
    if (chat.file_name) {
        const m = chat.file_name.match(/(\d{8})-?(\d{6})/);
        if (m) return `${m[1].slice(0, 4)}-${m[1].slice(4, 6)}-${m[1].slice(6, 8)}T${m[2].slice(0, 2)}:${m[2].slice(2, 4)}:${m[2].slice(4, 6)}`;
    }
    return null;
}

function dateToTs(v) {
    if (!v) return 0;
    if (typeof v === 'number') return v;
    const t = Date.parse(String(v));
    return isNaN(t) ? 0 : t;
}

function fmtDate(v) {
    if (!v) return '';
    const t = dateToTs(v);
    return t ? new Date(t).toLocaleString() : String(v).substring(0, 25);
}

function fmtSize(b) {
    if (b == null || isNaN(b)) return '';
    if (b < 1024) return b + 'B';
    if (b < 1048576) return (b / 1024).toFixed(1) + 'KB';
    return (b / 1048576).toFixed(1) + 'MB';
}

function isFirstSysMsg(m) {
    return !!(m.is_system || (m.user_name && m.character_name && !m.mes));
}

function msgFP(m) {
    return `${m.name || ''}|||${(m.mes || '').trim()}|||${m.send_date || ''}`;
}

function fmtTime(sendDate) {
    if (typeof sendDate === 'number') return new Date(sendDate).toLocaleString();
    return String(sendDate || '').substring(0, 25);
}

// ===== 渲染 =====
function renderCharInfo() {
    const el = document.getElementById('merger-char-section');
    if (!el) return;
    const info = getCharInfo();
    if (!info) {
        el.innerHTML = '<div class="merger-no-char"><i class="fa-solid fa-triangle-exclamation"></i> 请先选择一个角色卡</div>';
        return;
    }
    const src = info.avatar ? `/characters/${encodeURIComponent(info.avatar)}` : '/img/ai4.png';
    el.innerHTML = `<div class="merger-char-info">
        <img class="char-avatar" src="${src}" onerror="this.src='/img/ai4.png'" />
        <div>
            <div class="char-name">${escapeHtml(info.name)}</div>
            <div class="char-detail">角色头像: ${escapeHtml(info.avatar || '无')}</div>
        </div>
    </div>`;
}

async function loadAndRenderChatList() {
    const el = document.getElementById('merger-chat-list');
    if (!el) return;
    const info = getCharInfo();
    if (!info) {
        el.innerHTML = '<div class="merger-loading"><p>请先选择一个角色卡</p></div>';
        return;
    }
    el.innerHTML = '<div class="merger-loading"><i class="fa-solid fa-spinner fa-spin"></i><p>正在加载聊天列表...</p></div>';
    try {
        let list = await fetchChatList(info.avatar);
        if (!Array.isArray(list)) list = [];
        list.sort((a, b) => dateToTs(getChatDate(a)) - dateToTs(getChatDate(b)));
        chatListCache = list;
        loadedChatData.clear();
        if (!list.length) {
            el.innerHTML = '<div class="merger-loading"><p>该角色暂无聊天记录</p></div>';
            return;
        }
        el.innerHTML = `<div class="merger-loading"><i class="fa-solid fa-spinner fa-spin"></i><p>正在读取聊天详情... (0/${list.length})</p></div>`;
        for (let i = 0; i < list.length; i++) {
            try {
                await fetchChatContent(info.name, list[i].file_name, info.avatar);
            } catch (e) {
                console.warn('[ChatMerger]', e);
            }
            const p = el.querySelector('p');
            if (p) p.textContent = `正在读取聊天详情... (${i + 1}/${list.length})`;
        }
        renderChatList(list, SillyTavern.getContext().chatMetadata?.file_name || null);
    } catch (e) {
        el.innerHTML = `<div class="merger-loading" style="color:#f66;"><p>加载失败: ${escapeHtml(e.message)}</p></div>`;
    }
}

function renderChatList(list, curFile) {
    const el = document.getElementById('merger-chat-list');
    if (!el) return;
    el.innerHTML = '';
    for (let i = 0; i < list.length; i++) {
        const chat = list[i];
        const fn = chat.file_name;
        const cached = loadedChatData.get(fn);
        const msgCount = cached ? cached.messages.length : null;
        const fileSize = cached ? cached.sizeBytes : null;
        const chatDate = getChatDate(chat);
        const isCur = curFile && fn && (fn === curFile || fn === curFile + '.jsonl' || fn.replace('.jsonl', '') === curFile);
        const isSel = selectedChats.some(s => s.file_name === fn);
        const oi = selectedChats.findIndex(s => s.file_name === fn);
        const item = document.createElement('div');
        item.className = `merger-chat-item${isSel ? ' selected' : ''}${isCur ? ' current-chat' : ''}`;
        let meta = [];
        if (msgCount != null) meta.push(`<span><i class="fa-regular fa-message"></i> ${msgCount} 条</span>`);
        if (fileSize) meta.push(`<span><i class="fa-regular fa-hard-drive"></i> ${fmtSize(fileSize)}</span>`);
        if (chatDate) meta.push(`<span><i class="fa-regular fa-clock"></i> ${escapeHtml(fmtDate(chatDate))}</span>`);
        item.innerHTML = `<input type="checkbox" class="chat-cb" ${isSel ? 'checked' : ''} />
            <div class="chat-order">${isSel ? oi + 1 : ''}</div>
            <div class="chat-info">
                <div class="chat-file-name" title="${escapeHtml(fn)}">${escapeHtml(fn)}${isCur ? ' <span style="color:#4a9eff;font-size:0.8em;">● 当前</span>' : ''}</div>
                <div class="chat-meta">${meta.join(' ')}</div>
            </div>
            <div class="order-actions">
                <button class="order-up" title="上移"><i class="fa-solid fa-caret-up"></i></button>
                <button class="order-down" title="下移"><i class="fa-solid fa-caret-down"></i></button>
            </div>`;
        const cb = item.querySelector('.chat-cb');
        cb.addEventListener('change', () => {
            if (cb.checked) {
                if (!selectedChats.some(s => s.file_name === fn)) selectedChats.push(chat);
            } else {
                selectedChats = selectedChats.filter(s => s.file_name !== fn);
            }
            renderChatList(list, curFile);
        });
        item.addEventListener('click', e => {
            if (e.target.closest('.order-actions') || e.target.closest('.chat-cb')) return;
            cb.checked = !cb.checked;
            cb.dispatchEvent(new Event('change'));
        });
        item.querySelector('.order-up')?.addEventListener('click', e => {
            e.stopPropagation();
            const idx = selectedChats.findIndex(s => s.file_name === fn);
            if (idx > 0) {
                [selectedChats[idx - 1], selectedChats[idx]] = [selectedChats[idx], selectedChats[idx - 1]];
                renderChatList(list, curFile);
            }
        });
        item.querySelector('.order-down')?.addEventListener('click', e => {
            e.stopPropagation();
            const idx = selectedChats.findIndex(s => s.file_name === fn);
            if (idx >= 0 && idx < selectedChats.length - 1) {
                [selectedChats[idx], selectedChats[idx + 1]] = [selectedChats[idx + 1], selectedChats[idx]];
                renderChatList(list, curFile);
            }
        });
        el.appendChild(item);
    }
    updateUI();
}

// ===== 外部文件 =====
function parseJsonl(text) {
    return text.split('\n').filter(l => l.trim()).map(l => {
        try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
}

async function handleExtFiles(files) {
    for (const f of files) {
        if (!f.name.endsWith('.jsonl')) {
            toastr.warning(`跳过非JSONL: ${f.name}`);
            continue;
        }
        if (externalFiles.some(e => e.name === f.name)) {
            toastr.info(`已存在: ${f.name}`);
            continue;
        }
        try {
            const text = await f.text();
            const msgs = parseJsonl(text);
            if (!msgs.length) {
                toastr.warning(`空文件: ${f.name}`);
                continue;
            }
            externalFiles.push({ name: f.name, messages: msgs, sizeBytes: new Blob([text]).size });
            toastr.success(`已导入: ${f.name} (${msgs.length} 条)`);
        } catch (e) {
            toastr.error(`读取失败: ${f.name}`);
        }
    }
    renderExtFileList();
}

function renderExtFileList() {
    const el = document.getElementById('merger-ext-file-list');
    const info = document.getElementById('merger-ext-info');
    if (!el) return;
    el.innerHTML = '';
    if (info) info.textContent = `已导入 ${externalFiles.length} 个文件`;
    for (let i = 0; i < externalFiles.length; i++) {
        const f = externalFiles[i];
        const item = document.createElement('div');
        item.className = 'merger-chat-item ext-file-item selected';
        item.innerHTML = `<div class="chat-order">${i + 1}</div>
            <div class="chat-info">
                <div class="chat-file-name">${escapeHtml(f.name)}</div>
                <div class="chat-meta">
                    <span><i class="fa-regular fa-message"></i> ${f.messages.length} 条</span>
                    <span><i class="fa-regular fa-hard-drive"></i> ${fmtSize(f.sizeBytes)}</span>
                </div>
            </div>
            <div class="order-actions">
                <button class="order-up"><i class="fa-solid fa-caret-up"></i></button>
                <button class="order-down"><i class="fa-solid fa-caret-down"></i></button>
            </div>
            <button class="remove-ext-btn"><i class="fa-solid fa-xmark"></i></button>`;
        item.querySelector('.order-up').addEventListener('click', () => {
            if (i > 0) {
                [externalFiles[i - 1], externalFiles[i]] = [externalFiles[i], externalFiles[i - 1]];
                renderExtFileList();
            }
        });
        item.querySelector('.order-down').addEventListener('click', () => {
            if (i < externalFiles.length - 1) {
                [externalFiles[i], externalFiles[i + 1]] = [externalFiles[i + 1], externalFiles[i]];
                renderExtFileList();
            }
        });
        item.querySelector('.remove-ext-btn').addEventListener('click', () => {
            externalFiles.splice(i, 1);
            renderExtFileList();
        });
        el.appendChild(item);
    }
    updateUI();
}

function updateUI() {
    const n = activeTab === 'current' ? selectedChats.length : externalFiles.length;
    const si = document.getElementById('merger-select-info');
    if (si) si.textContent = `已选择 ${selectedChats.length} 个聊天`;
    const eb = document.getElementById('merger-export-btn');
    const ib = document.getElementById('merger-import-btn');
    if (eb) eb.disabled = n < 1;
    if (ib) ib.disabled = n < 1;
}

// ===== 合并 =====
async function getEntries() {
    if (activeTab === 'current') {
        const info = getCharInfo();
        if (!info || !selectedChats.length) throw new Error('未选择聊天');
        let entries = [];
        for (const chat of selectedChats) {
            const c = loadedChatData.get(chat.file_name);
            const msgs = c ? c.messages : (await fetchChatContent(info.name, chat.file_name, info.avatar)).messages;
            entries.push({ fileName: chat.file_name, messages: [...msgs], chat });
        }
        return entries;
    } else {
        if (!externalFiles.length) throw new Error('未导入文件');
        return externalFiles.map(f => ({ fileName: f.name, messages: [...f.
