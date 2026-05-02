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
        return externalFiles.map(f => ({ fileName: f.name, messages: [...f.messages], chat: null }));
    }
}

async function performMerge() {
    const orderMode = document.getElementById('merger-order')?.value || 'list-order';
    const dedup = document.getElementById('merger-dedup')?.checked || false;
    const keepFirst = document.getElementById('merger-keep-first-only')?.checked || false;
    const addSep = document.getElementById('merger-add-separator')?.checked || false;
    let entries = await getEntries();
    if (orderMode === 'list-order' && activeTab === 'current') {
        const om = new Map();
        chatListCache.forEach((c, i) => om.set(c.file_name, i));
        entries.sort((a, b) => (om.get(a.fileName) ?? 999) - (om.get(b.fileName) ?? 999));
    } else if (orderMode === 'name-asc') {
        entries.sort((a, b) => a.fileName.localeCompare(b.fileName));
    }

    let all = [];
    let total = 0;
    let firstDone = false;
    let boundaries = [];

    for (const e of entries) {
        let msgs = [...e.messages];
        total += msgs.length;
        if (keepFirst && firstDone && msgs.length > 0 && isFirstSysMsg(msgs[0])) {
            msgs = msgs.slice(1);
        }
        if (addSep && firstDone && msgs.length > 0) {
            all.push({
                name: '',
                is_user: false,
                is_system: true,
                send_date: Date.now(),
                mes: `───── ✂ 以下合并自: ${e.fileName} ─────`,
                extra: { chat_merger_separator: true },
            });
        }

        const startIdx = all.length;
        all.push(...msgs);
        const endIdx = all.length - 1;
        boundaries.push({ startIdx, endIdx, fileName: e.fileName, msgCount: msgs.length });

        firstDone = true;
    }

    let dedupN = 0;
    if (dedup) {
        const seen = new Set();
        const u = [];
        const oldToNew = new Map();
        for (let i = 0; i < all.length; i++) {
            const m = all[i];
            if (m.extra?.chat_merger_separator) {
                oldToNew.set(i, u.length);
                u.push(m);
                continue;
            }
            const fp = msgFP(m);
            if (!seen.has(fp)) {
                seen.add(fp);
                oldToNew.set(i, u.length);
                u.push(m);
            } else {
                dedupN++;
            }
        }
        all = u;
        boundaries = boundaries.map(b => {
            let newStart = null;
            let newEnd = null;
            for (let i = b.startIdx; i <= b.endIdx; i++) {
                if (oldToNew.has(i)) {
                    if (newStart === null) newStart = oldToNew.get(i);
                    newEnd = oldToNew.get(i);
                }
            }
            return {
                ...b,
                startIdx: newStart ?? 0,
                endIdx: newEnd ?? 0,
                msgCount: newStart !== null ? newEnd - newStart + 1 : 0,
            };
        }).filter(b => b.msgCount > 0);
    }

    return {
        messages: all,
        stats: { files: entries.length, total, deduped: dedupN, result: all.length },
        boundaries,
    };
}

function toJsonl(msgs) {
    return msgs.map(m => JSON.stringify(m)).join('\n');
}

function getOutputFileName() {
    const c = document.getElementById('merger-output-name')?.value?.trim();
    if (c) return c.endsWith('.jsonl') ? c : c + '.jsonl';
    const info = getCharInfo();
    const ts = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
    return `${info?.name || 'merged'}_merged_${ts}.jsonl`;
}

// ===== 结果弹窗 =====
function showResult(type, title, bodyHtml) {
    document.getElementById('result-icon').className = `result-icon ${type}`;
    document.getElementById('result-icon').innerHTML = type === 'success'
        ? '<i class="fa-solid fa-circle-check"></i>'
        : '<i class="fa-solid fa-triangle-exclamation"></i>';
    document.getElementById('result-title').textContent = title;
    document.getElementById('result-body').innerHTML = bodyHtml;
    document.getElementById('merger-result-overlay')?.classList.add('active');
}

function closeResult() {
    document.getElementById('merger-result-overlay')?.classList.remove('active');
}

// ===== 预览（三段式） =====

// 构建预览要显示的区间列表
function buildPreviewSections(messages, boundaries) {
    const EDGE = 3;
    const SEAM = 2;
    const totalMsgs = messages.length;

    if (totalMsgs <= 20) {
        return { mode: 'all', sections: null };
    }

    let sections = [];

    sections.push({
        type: 'head',
        label: '开头（前 ' + EDGE + ' 条）',
        icon: 'fa-flag',
        start: 0,
        end: Math.min(EDGE - 1, totalMsgs - 1),
    });

    if (boundaries.length > 1) {
        for (let i = 0; i < boundaries.length - 1; i++) {
            const bA = boundaries[i];
            const bB = boundaries[i + 1];
            const seamAStart = Math.max(bA.endIdx - SEAM + 1, bA.startIdx);
            let seamBStart = bB.startIdx;
            if (seamBStart > 0 && messages[seamBStart - 1]?.extra?.chat_merger_separator) {
                seamBStart = seamBStart - 1;
            }
            const seamBEnd = Math.min(bB.startIdx + SEAM - 1, bB.endIdx);
            sections.push({
                type: 'seam',
                label: '拼接处 ' + (i + 1) + '：' + bA.fileName + ' → ' + bB.fileName,
                icon: 'fa-scissors',
                start: seamAStart,
                end: seamBEnd,
            });
        }
    }

    sections.push({
        type: 'tail',
        label: '结尾（最后 ' + EDGE + ' 条）',
        icon: 'fa-flag-checkered',
        start: Math.max(totalMsgs - EDGE, 0),
        end: totalMsgs - 1,
    });

    sections.sort((a, b) => a.start - b.start);

    let merged = [];
    for (const sec of sections) {
        if (merged.length > 0) {
            const last = merged[merged.length - 1];
            if (sec.start <= last.end + 2) {
                last.end = Math.max(last.end, sec.end);
                last.labels.push({ label: sec.label, icon: sec.icon, at: sec.start });
                continue;
            }
        }
        merged.push({
            start: sec.start,
            end: sec.end,
            labels: [{ label: sec.label, icon: sec.icon, at: sec.start }],
        });
    }

    return { mode: 'sections', sections: merged };
}

function collectPreviewIndices(messages, sectionData) {
    let indices = [];
    if (sectionData.mode === 'all') {
        for (let i = 0; i < messages.length; i++) indices.push(i);
    } else {
        for (const sec of sectionData.sections) {
            for (let i = sec.start; i <= sec.end; i++) {
                if (!indices.includes(i)) indices.push(i);
            }
        }
    }
    return indices;
}

function renderPreviewMsg(m, index, container, truncate) {
    if (m.extra?.chat_merger_separator) {
        const s = document.createElement('div');
        s.className = 'preview-sep';
        s.textContent = m.mes;
        container.appendChild(s);
        return;
    }
    const d = document.createElement('div');
    d.className = `preview-msg ${m.is_system ? 'system' : m.is_user ? 'user' : 'char'}`;

    const content = m.mes || '';
    let displayContent;
    let needExpand = false;
    if (truncate && content.length > 150) {
        displayContent = content.substring(0, 150);
        needExpand = true;
    } else {
        displayContent = content;
    }

    d.innerHTML = `<div class="pm-header">
            <span class="pm-index">#${index + 1}</span>
            <span class="pm-sender">${escapeHtml(m.name || (m.is_user ? 'User' : 'Char'))}</span>
            <span class="pm-time">${escapeHtml(fmtTime(m.send_date))}</span>
        </div>
        <div class="pm-content">${escapeHtml(displayContent)}${needExpand ? '…' : ''}</div>`;

    if (truncate && needExpand) {
        const expandBtn = document.createElement('span');
        expandBtn.className = 'pm-expand-btn';
        expandBtn.textContent = '展开 ▼';
        expandBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const contentEl = d.querySelector('.pm-content');
            if (expandBtn.textContent === '展开 ▼') {
                contentEl.textContent = content;
                contentEl.classList.add('expanded');
                expandBtn.textContent = '收起 ▲';
            } else {
                contentEl.textContent = content.substring(0, 150) + '…';
                contentEl.classList.remove('expanded');
                expandBtn.textContent = '展开 ▼';
            }
        });
        d.querySelector('.pm-header').appendChild(expandBtn);
    }

    container.appendChild(d);
}

function renderSectionLabel(text, icon, container, anchorId) {
    const label = document.createElement('div');
    label.className = 'preview-section-label';
    if (anchorId) label.id = anchorId;
    label.innerHTML = `<i class="fa-solid ${icon}"></i> ${escapeHtml(text)}`;
    container.appendChild(label);
}

function renderOmission(count, container) {
    if (count <= 0) return;
    const el = document.createElement('div');
    el.className = 'preview-omission';
    el.textContent = `··· 省略 ${count} 条消息 ···`;
    container.appendChild(el);
}
// 渲染三段式内容到指定容器（预览和全屏共用）
// anchorPrefix: 传入时给区域标签加 id，用于跳转
function renderPreviewContent(messages, sectionData, container, truncate, anchorPrefix) {
    container.innerHTML = '';
    const totalMsgs = messages.length;
    let anchorIndex = 0;

    if (sectionData.mode === 'all') {
        const aid = anchorPrefix ? anchorPrefix + anchorIndex++ : null;
        renderSectionLabel('全部消息（共 ' + totalMsgs + ' 条）', 'fa-list', container, aid);
        for (let i = 0; i < totalMsgs; i++) {
            renderPreviewMsg(messages[i], i, container, truncate);
        }
        return;
    }

    const merged = sectionData.sections;
    for (let si = 0; si < merged.length; si++) {
        const sec = merged[si];

        const aid = anchorPrefix ? anchorPrefix + anchorIndex++ : null;
        renderSectionLabel(sec.labels[0].label, sec.labels[0].icon, container, aid);

        if (si === 0 && sec.start > 0) {
            renderOmission(sec.start, container);
        }

        let labelMap = new Map();
        for (let li = 1; li < sec.labels.length; li++) {
            const innerAid = anchorPrefix ? anchorPrefix + anchorIndex++ : null;
            labelMap.set(sec.labels[li].at, { lbl: sec.labels[li], aid: innerAid });
        }

        for (let i = sec.start; i <= sec.end; i++) {
            if (labelMap.has(i)) {
                const entry = labelMap.get(i);
                renderSectionLabel(entry.lbl.label, entry.lbl.icon, container, entry.aid);
            }
            renderPreviewMsg(messages[i], i, container, truncate);
        }

        if (si < merged.length - 1) {
            const gap = merged[si + 1].start - sec.end - 1;
            renderOmission(gap, container);
        }
    }
}

// 收集所有区域标签信息，用于生成导航按钮
function collectNavLabels(sectionData) {
    let labels = [];
    if (sectionData.mode === 'all') {
        labels.push({ label: '全部消息', icon: 'fa-list' });
    } else {
        for (const sec of sectionData.sections) {
            for (const lbl of sec.labels) {
                labels.push({ label: lbl.label, icon: lbl.icon });
            }
        }
    }
    return labels;
}

async function showPreview() {
    const pe = document.getElementById('merger-preview');
    const se = document.getElementById('merger-stats');
    if (!pe || !se) return;
    const n = activeTab === 'current' ? selectedChats.length : externalFiles.length;
    if (!n) {
        toastr.info('请先勾选/导入聊天');
        return;
    }
    pe.innerHTML = '<div class="merger-loading"><i class="fa-solid fa-spinner fa-spin"></i><p>正在合并预览...</p></div>';
    pe.classList.add('active');
    try {
        const { messages, stats, boundaries } = await performMerge();
        se.classList.add('active');
        document.getElementById('stat-files').textContent = stats.files;
        document.getElementById('stat-messages').textContent = stats.total;
        document.getElementById('stat-dedup').textContent = stats.deduped;
        document.getElementById('stat-result').textContent = stats.result;

        const sectionData = buildPreviewSections(messages, boundaries);

        // 保存预览数据供全屏使用
        lastPreviewData = { messages, boundaries, sectionData, stats };

        // 渲染缩略预览（截断模式，不加锚点）
        renderPreviewContent(messages, sectionData, pe, true, null);

        // 显示全屏按钮
        const fullBtn = document.getElementById('merger-fullscreen-btn');
        if (fullBtn) fullBtn.style.display = 'inline-flex';

        updateUI();
    } catch (e) {
        pe.innerHTML = `<div class="merger-loading" style="color:#f66;"><p>${escapeHtml(e.message)}</p></div>`;
    }
}

// ===== 全屏预览 =====
function openFullPreview() {
    if (!lastPreviewData) {
        toastr.info('请先生成预览');
        return;
    }
    const overlay = document.getElementById('merger-full-preview-overlay');
    const container = document.getElementById('merger-full-preview-content');
    const statsEl = document.getElementById('merger-full-preview-stats');
    const navEl = document.getElementById('merger-full-preview-nav');
    if (!overlay || !container) return;

    const { messages, sectionData, stats } = lastPreviewData;

    // 统计信息
    if (statsEl) {
        statsEl.innerHTML = `<span>${stats.files} 个文件</span>
            <span>${stats.total} 条总消息</span>
            <span>${stats.deduped} 条去重</span>
            <span>${stats.result} 条最终</span>`;
    }

    // 渲染完整内容（不截断，带锚点）
    renderPreviewContent(messages, sectionData, container, false, 'fp-anchor-');

    // 生成导航按钮
    if (navEl) {
        navEl.innerHTML = '';
        const labels = collectNavLabels(sectionData);
        labels.forEach((item, idx) => {
            const btn = document.createElement('button');
            btn.className = 'nav-jump-btn';
            // 短标签：开头/拼接处1/拼接处2/结尾
            let shortLabel = item.label;
            if (shortLabel.startsWith('开头')) shortLabel = '🚩 开头';
            else if (shortLabel.startsWith('拼接处')) shortLabel = '✂️ ' + shortLabel.split('：')[0];
            else if (shortLabel.startsWith('结尾')) shortLabel = '🏁 结尾';
            else if (shortLabel.startsWith('全部')) shortLabel = '📋 全部';
            btn.textContent = shortLabel;
            btn.title = item.label;
            btn.addEventListener('click', () => {
                const target = document.getElementById('fp-anchor-' + idx);
                if (target) {
                    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
                }
            });
            navEl.appendChild(btn);
        });
    }

    overlay.classList.add('active');
}

function closeFullPreview() {
    document.getElementById('merger-full-preview-overlay')?.classList.remove('active');
    const container = document.getElementById('merger-full-preview-content');
    if (container) container.innerHTML = '';
    const navEl = document.getElementById('merger-full-preview-nav');
    if (navEl) navEl.innerHTML = '';
}

// ===== 下载 =====
function downloadBlob(blob, fileName) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

async function doExport() {
    const n = activeTab === 'current' ? selectedChats.length : externalFiles.length;
    if (!n) {
        toastr.info('请先勾选/导入聊天');
        return;
    }
    try {
        toastr.info('正在合并...');
        const { messages, stats } = await performMerge();
        const jsonl = toJsonl(messages);
        const blob = new Blob([jsonl], { type: 'application/x-ndjson' });
        const fn = getOutputFileName();
        downloadBlob(blob, fn);
        showResult('success', '✅ 合并下载完成',
            `<p>已合并 <b>${stats.files}</b> 个聊天 → <b>${stats.result}</b> 条消息（${fmtSize(blob.size)}）</p>
            <p>文件：<b>${escapeHtml(fn)}</b></p>
            <p style="font-size:0.85em;color:#888;margin-top:8px;">如需导入酒馆，请使用聊天管理面板中的"导入聊天"按钮。</p>`);
    } catch (e) {
        toastr.error(`导出失败: ${e.message}`);
    }
}

// ===== 合并并导入 =====
async function doImport() {
    const info = getCharInfo();
    if (!info) {
        toastr.error('请先选择角色卡才能导入');
        return;
    }
    const n = activeTab === 'current' ? selectedChats.length : externalFiles.length;
    if (!n) {
        toastr.info('请先勾选/导入聊天');
        return;
    }
    try {
        toastr.info('正在合并...');
        const { messages, stats } = await performMerge();
        const jsonl = toJsonl(messages);
        const fn = getOutputFileName();
        const blob = new Blob([jsonl]);
        toastr.info('正在通过酒馆导入...');
        closeDialog();
        await new Promise(r => setTimeout(r, 300));
        try {
            await importViaSillyTavern(jsonl, fn);
            toastr.success(
                `已合并 ${stats.files} 个聊天 → ${stats.result} 条消息\n文件大小：${fmtSize(blob.size)}\n文件已通过酒馆"导入聊天"功能导入`,
                '✅ 合并导入成功',
                { timeOut: 8000 }
            );
        } catch (importErr) {
            console.error('[ChatMerger] 酒馆导入失败:', importErr);
            downloadBlob(new Blob([jsonl], { type: 'application/x-ndjson' }), fn);
            toastr.warning(
                `自动导入失败，已转为下载\n\n错误：${importErr.message}\n\n已下载文件：${fn}（${fmtSize(blob.size)}）\n请在聊天管理面板中点击"导入聊天"按钮手动导入。`,
                '需要手动导入',
                { timeOut: 15000 }
            );
        }
    } catch (e) {
        toastr.error(`合并失败: ${e.message}`);
    }
}

// ===== 对话框 =====
function openDialog() {
    document.getElementById('chat-merger-overlay')?.classList.add('active');
    renderCharInfo();
    selectedChats = [];
    loadedChatData.clear();
    externalFiles = [];
    activeTab = 'current';
    lastPreviewData = null;
    document.querySelectorAll('.merger-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === 'current'));
    document.querySelectorAll('.merger-tab-content').forEach(c => c.classList.toggle('active', c.id === 'tab-current'));
    const pe = document.getElementById('merger-preview');
    const se = document.getElementById('merger-stats');
    if (pe) {
        pe.classList.remove('active');
        pe.innerHTML = '';
    }
    if (se) se.classList.remove('active');
    const fullBtn = document.getElementById('merger-fullscreen-btn');
    if (fullBtn) fullBtn.style.display = 'none';
    renderExtFileList();
    loadAndRenderChatList();
}

function closeDialog() {
    document.getElementById('chat-merger-overlay')?.classList.remove('active');
}

// ===== 初始化 =====
jQuery(async () => {
    const html = await $.get(`${extensionFolderPath}/merger.html`);
    $('body').append(html);

    // 魔法棒菜单项
    const wandBtn = document.createElement('div');
    wandBtn.id = 'chat-merger-wand-btn';
    wandBtn.className = 'list-group-item flex-container flexGap5';
    wandBtn.title = '合并多个聊天记录';
    wandBtn.innerHTML = '<i class="fa-solid fa-code-merge extensionsMenuExtensionButton"></i> 合并聊天记录';
    wandBtn.addEventListener('click', () => {
        $('#extensionsMenu').closest('.drawer-content').closest('.drawer').find('.drawer-icon').trigger('click');
        openDialog();
    });

    function injectWand() {
        const menu = document.getElementById('extensionsMenu');
        if (menu && !document.getElementById('chat-merger-wand-btn')) {
            menu.appendChild(wandBtn);
            console.log('[ChatMerger] ✅ 已添加到魔法棒菜单');
            return true;
        }
        return false;
    }

    if (!injectWand()) {
        const obs = new MutationObserver(() => {
            if (injectWand()) obs.disconnect();
        });
        obs.observe(document.body, { childList: true, subtree: true });
        setTimeout(() => {
            obs.disconnect();
            injectWand();
        }, 10000);
    }

    // Tab 切换
    $(document).on('click', '.merger-tab', function () {
        activeTab = $(this).data('tab');
        $('.merger-tab').removeClass('active');
        $(this).addClass('active');
        $('.merger-tab-content').removeClass('active');
        $(`#tab-${activeTab}`).addClass('active');
        updateUI();
    });

    // 关闭
    $('#merger-cancel-btn').on('click', closeDialog);
    $('#chat-merger-overlay').on('click', e => {
        if (e.target.id === 'chat-merger-overlay') closeDialog();
    });
    $(document).on('keydown', e => {
        if (e.key === 'Escape') {
            if (document.getElementById('merger-full-preview-overlay')?.classList.contains('active')) {
                closeFullPreview();
            } else if (document.getElementById('merger-result-overlay')?.classList.contains('active')) {
                closeResult();
            } else if (document.getElementById('chat-merger-overlay')?.classList.contains('active')) {
                closeDialog();
            }
        }
    });

    // 结果弹窗
    $('#result-close-btn').on('click', closeResult);
    $('#merger-result-overlay').on('click', e => {
        if (e.target.id === 'merger-result-overlay') closeResult();
    });

    // 全屏预览
    $('#merger-fullscreen-btn').on('click', openFullPreview);
    $('#merger-full-preview-close').on('click', closeFullPreview);
    $('#merger-full-preview-overlay').on('click', e => {
        if (e.target.id === 'merger-full-preview-overlay') closeFullPreview();
    });

    // 列表操作
    $('#merger-select-all').on('click', () => {
        selectedChats = [...chatListCache];
        renderChatList(chatListCache, SillyTavern.getContext().chatMetadata?.file_name || null);
    });
    $('#merger-select-none').on('click', () => {
        selectedChats = [];
        renderChatList(chatListCache, SillyTavern.getContext().chatMetadata?.file_name || null);
    });
    $('#merger-refresh-list').on('click', () => {
        selectedChats = [];
        loadedChatData.clear();
        loadAndRenderChatList();
    });

    // 外部文件
    const dz = document.getElementById('merger-drop-zone');
    const fi = document.getElementById('merger-file-input');
    if (dz && fi) {
        dz.addEventListener('click', () => fi.click());
        dz.addEventListener('dragover', e => {
            e.preventDefault();
            dz.classList.add('drag-over');
        });
        dz.addEventListener('dragleave', () => dz.classList.remove('drag-over'));
        dz.addEventListener('drop', e => {
            e.preventDefault();
            dz.classList.remove('drag-over');
            if (e.dataTransfer.files.length) handleExtFiles(e.dataTransfer.files);
        });
        fi.addEventListener('change', () => {
            if (fi.files.length) {
                handleExtFiles(fi.files);
                fi.value = '';
            }
        });
    }
    $('#merger-ext-clear').on('click', () => {
        externalFiles = [];
        renderExtFileList();
        toastr.info('已清空');
    });

    // 预览/导出/导入
    $('#merger-preview-btn').on('click', showPreview);
    $('#merger-export-btn').on('click', doExport);
    $('#merger-import-btn').on('click', doImport);

    // 监听角色切换
    const ctx = SillyTavern.getContext();
    if (ctx.eventSource && ctx.event_types) {
        ctx.eventSource.on(ctx.event_types.CHAT_CHANGED, () => {
            if (document.getElementById('chat-merger-overlay')?.classList.contains('active')) {
                renderCharInfo();
                selectedChats = [];
                loadedChatData.clear();
                loadAndRenderChatList();
            }
        });
    }

    console.log('[ChatMerger] 聊天记录合并插件已加载 ✅');
});
