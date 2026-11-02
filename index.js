// Chat Preset Memory — remembers the Chat Completion preset and its prompt toggles per chat,
// and restores them when the chat is opened again.
// Stored in the chat file: chat_metadata.chatPresetMemory =
//   { preset: 마지막 프리셋, toggles: 그 프리셋의 토글, byPreset: { 프리셋 이름: 토글 }, world: [켜 둔 전역 월드인포],
//     regex: { 정규식 id: 켜짐 } (전역 · 프리셋 정규식), kinds: { toggles, world, regex } 무엇을 기억할지, at, off? }
// Optional character default: extension settings byChar[avatar | group:id] = 같은 꼴

import { oai_settings, promptManager, getPresetApplicationPromise } from '../../../openai.js';
import { selected_world_info, world_names, world_info } from '../../../world-info.js';
import { getScriptsByType, saveScriptsByType, SCRIPT_TYPES } from '../../regex/engine.js';

const MODULE = 'chatPresetMemory';
const LOG = '[Chat Preset Memory]';
const KINDS = ['toggles', 'world', 'regex'];
const DEFAULTS = Object.freeze({ enabled: true, restorePreset: true, charDefault: true, notify: true, byChar: {}, kinds: { toggles: true, world: false, regex: false } });
const ctx = () => SillyTavern.getContext();
const nfc = (s) => String(s ?? '').normalize('NFC');

// ---------------- 화면 글자 (한국어) ----------------
let KO = {};
async function loadKo() {
    try { KO = await (await fetch(new URL('i18n/ko-kr.json', import.meta.url))).json(); } catch { KO = {}; }
}
/** 영어 원문 키 → 한국어 (사전에 없으면 원문) */
function tr(strings, ...values) {
    const key = strings.reduce((r, s, i) => r + s + (values[i] !== undefined ? `\${${i}}` : ''), '');
    return (KO[key] ?? key).replace(/\$\{(\d+)\}/g, (m, i) => values[i]);
}

function settings() {
    const all = ctx().extensionSettings;
    all[MODULE] = Object.assign({}, structuredClone(DEFAULTS), all[MODULE]);
    if (!all[MODULE].byChar || typeof all[MODULE].byChar !== 'object') all[MODULE].byChar = {};
    all[MODULE].kinds = { ...DEFAULTS.kinds, ...(all[MODULE].kinds || {}) };
    return all[MODULE];
}

/** Only for Chat Completion with an open chat */
function usable() {
    const c = ctx();
    return settings().enabled && c.mainApi === 'openai' && !!c.getCurrentChatId() && !!promptManager?.activeCharacter;
}

function charKey() {
    const c = ctx();
    if (c.groupId) return 'group:' + c.groupId;
    return c.characters?.[c.characterId]?.avatar || null;
}

const memory = () => ctx().chatMetadata?.[MODULE] || null;
const currentPreset = () => oai_settings.preset_settings_openai;

/** 프리셋 이름 → 그 프리셋에서 기억한 토글 (예전 꼴 {preset, toggles} 도 읽음) */
function togglesFor(mem, preset) {
    if (!mem) return null;
    const hit = Object.entries(mem.byPreset || {}).find(([k]) => nfc(k) === nfc(preset));
    if (hit) return hit[1];
    return nfc(mem.preset) === nfc(preset) ? mem.toggles || null : null;
}

/** 이 채팅이 기억하는 종류 (채팅마다 고른 것, 없으면 설정의 기본값) */
const kindsOf = (mem = memory()) => ({ ...settings().kinds, ...(mem?.kinds || {}) });

const REGEX_TYPES = [SCRIPT_TYPES.GLOBAL, SCRIPT_TYPES.PRESET];
function regexState() {
    const out = {};
    for (const type of REGEX_TYPES) for (const script of getScriptsByType(type, { allowedOnly: false }) || []) if (script?.id) out[script.id] = !script.disabled;
    return out;
}
const worldState = () => [...selected_world_info].sort();

// 이 채팅에 걸린 로어북: 전역 선택 · 채팅 로어북 · 캐릭터(그룹이면 멤버들)의 연결 · 추가 로어북
function activeBooks() {
    const c = ctx(), books = new Set(selected_world_info);
    if (c.chatMetadata?.world_info) books.add(c.chatMetadata.world_info);
    const chars = c.groupId ? (c.groups?.find(g => g.id === c.groupId)?.members || []).map(a => c.characters.find(x => x.avatar === a)).filter(Boolean) : [c.characters?.[c.characterId]].filter(Boolean);
    for (const ch of chars) {
        if (ch.data?.extensions?.world) books.add(ch.data.extensions.world);
        const file = String(ch.avatar || '').replace(/\.[^.]+$/, '');
        world_info?.charLore?.find(e => e.name === file)?.extraBooks?.forEach(b => books.add(b));
    }
    return [...books].filter(n => world_names?.includes(n)).sort();
}
// 로어북 항목 켜짐/꺼짐 { 로어북: { uid: 켜짐 } } — 파일을 읽어야 해서 미리 읽어 두고(refreshEntries) 기억할 때는 그 값을 씀
let lastEntries = null;
async function readEntries() {
    const out = {};
    for (const name of activeBooks()) {
        const data = await ctx().loadWorldInfo(name);
        if (!data?.entries) continue;
        out[name] = {};
        for (const [uid, e] of Object.entries(data.entries)) out[name][uid] = !e.disable;
    }
    return out;
}
async function refreshEntries() { try { lastEntries = await readEntries(); } catch (err) { console.warn(LOG, 'world info', err); } }

/** 지금 상태 — 기억하는 종류만 (안 고른 종류는 담지 않아 저장도 안 일어남) */
function snapshot(kinds = kindsOf()) {
    const snap = { preset: currentPreset() };
    if (kinds.toggles) {
        snap.toggles = {};
        for (const e of promptManager.getPromptOrderForCharacter(promptManager.activeCharacter) || []) snap.toggles[e.identifier] = !!e.enabled;
    }
    if (kinds.world) { snap.world = worldState(); if (lastEntries) snap.entries = lastEntries; }
    if (kinds.regex) snap.regex = regexState();
    return snap;
}

/** 새 상태를 기억에 얹음 (프리셋마다 따로) */
function merged(prev, snap, extra = {}) {
    const byPreset = { ...(prev?.byPreset || {}) };
    if (snap.toggles) {
        if (prev?.preset && prev?.toggles && !togglesFor({ byPreset }, prev.preset)) byPreset[prev.preset] = prev.toggles;
        for (const k of Object.keys(byPreset)) if (nfc(k) === nfc(snap.preset)) delete byPreset[k];
        byPreset[snap.preset] = snap.toggles;
    }
    return { ...(prev || {}), ...snap, byPreset, ...extra, at: Date.now() };
}

// 채팅을 바꾸는 중·맞추는 중·프리셋을 바꾸는 중에는 기억하지 않음 (다른 채팅·다른 프리셋 상태가 섞이지 않게)
let ready = false;
let restoring = false;
let switching = false;

function store(snap, extra = {}) {
    const c = ctx();
    const prev = memory();
    c.chatMetadata[MODULE] = merged(prev, snap, extra);
    // 프리셋이 바뀌었거나 켬/끔을 바꿨으면 바로 저장(그 사이 채팅을 옮겨도 예전 프리셋으로 돌아가지 않게),
    // 토글만 바뀌었으면 몰아서 저장(채팅 파일 전체를 매번 쓰지 않게)
    const urgent = !prev || nfc(prev.preset) !== nfc(snap.preset) || 'off' in extra || 'kinds' in extra
        || JSON.stringify(prev.world) !== JSON.stringify(snap.world ?? prev.world)
        || JSON.stringify(prev.entries) !== JSON.stringify(snap.entries ?? prev.entries);
    if (urgent && c.saveMetadata) c.saveMetadata().catch?.(err => console.warn(LOG, err));
    else c.saveMetadataDebounced();
    const key = charKey();
    if (key && settings().charDefault) {
        settings().byChar[key] = merged(settings().byChar[key], snap);
        c.saveSettingsDebounced();
    }
    renderBar();
}

const sameAsMemory = (mem, snap) => !!mem && nfc(mem.preset) === nfc(snap.preset)
    && (!snap.toggles || JSON.stringify(togglesFor(mem, snap.preset)) === JSON.stringify(snap.toggles))
    && (!snap.world || JSON.stringify(mem.world) === JSON.stringify(snap.world))
    && (!snap.entries || JSON.stringify(mem.entries) === JSON.stringify(snap.entries))
    && (!snap.regex || JSON.stringify(mem.regex) === JSON.stringify(snap.regex));

/** 바꿀 때마다 기억 (이 채팅 기억을 끈 경우는 제외) */
let saveTimer = null;
function remember() {
    if (!ready || restoring || switching || !usable()) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
        if (!ready || restoring || switching || !usable()) return;
        const mem = memory();
        if (mem?.off) return;
        const now = snapshot();
        if (!sameAsMemory(mem, now)) store(now);
    }, 150);
}

async function switchPreset(name) {
    const opt = [...document.querySelectorAll('#settings_preset_openai option')].find(o => nfc(o.textContent) === nfc(name));
    if (!opt) return false;
    $('#settings_preset_openai').val(opt.value).trigger('change');
    await getPresetApplicationPromise();
    await new Promise(r => setTimeout(r, 300));
    return true;
}

/** 지금 프리셋에 기억한 토글을 맞춤 → 바꾼 개수 */
async function applyToggles(toggles) {
    if (!toggles) return 0;
    let changed = 0;
    for (const e of promptManager.getPromptOrderForCharacter(promptManager.activeCharacter) || []) {
        if (e.identifier in toggles && !!e.enabled !== toggles[e.identifier]) {
            e.enabled = toggles[e.identifier];
            changed++;
        }
    }
    if (changed) {
        promptManager.render();
        // 저장은 기다리지 않음 (기다리는 동안 기억이 늦어지고 화면도 잠깐 멈춤)
        Promise.resolve(promptManager.saveServiceSettings()).catch(err => console.warn(LOG, err));
    }
    return changed;
}

/** 기억한 전역 월드인포만 켜 둠 (없는 이름은 무시) → 바뀌었으면 true */
function applyWorld(names) {
    if (!Array.isArray(names)) return false;
    const want = names.filter(n => world_names?.includes(n)).sort();
    if (JSON.stringify(want) === JSON.stringify(worldState())) return false;
    $('#world_info').val(want.map(n => String(world_names.indexOf(n)))).trigger('change');
    return true;
}

/** 기억한 로어북 항목 켜짐/꺼짐 → 바꾼 항목 수. 지금 이 채팅에 걸린 로어북만, 바뀐 로어북만 저장 */
async function applyEntries(state) {
    if (!state) return 0;
    let changed = 0;
    for (const name of activeBooks()) {
        const want = state[name];
        if (!want) continue;
        const data = await ctx().loadWorldInfo(name);
        if (!data?.entries) continue;
        let here = 0;
        for (const [uid, on] of Object.entries(want)) {
            const e = data.entries[uid];
            if (!e || !e.disable === on) continue;
            e.disable = !on;
            here++;
        }
        if (here) { await ctx().saveWorldInfo(name, data, true); ctx().reloadWorldInfoEditor?.(name); changed += here; }
    }
    return changed;
}

/** 기억한 정규식 켜짐/꺼짐 (전역 · 프리셋) → 바꾼 개수. 기억에 없는 정규식은 그대로 */
async function applyRegex(state) {
    if (!state) return 0;
    let changed = 0;
    for (const type of REGEX_TYPES) {
        const scripts = getScriptsByType(type, { allowedOnly: false }) || [];
        let here = 0;
        for (const script of scripts) {
            if (!script?.id || !(script.id in state) || !script.disabled === state[script.id]) continue;
            script.disabled = !state[script.id];
            here++;
        }
        if (here) { await saveScriptsByType(scripts, type); changed += here; }
    }
    return changed;
}

/** 채팅을 열 때: 마지막 프리셋으로 바꾸고(설정에 따라), 그 프리셋에서 기억한 토글을 맞춤 */
async function restore(mem, label) {
    const chatId = ctx().getCurrentChatId();
    const notes = [];
    restoring = true;
    const kinds = kindsOf(mem);
    let regexChanged = 0;
    try {
        if (kinds.toggles && settings().restorePreset && mem.preset && nfc(mem.preset) !== nfc(currentPreset())) {
            if (!(await switchPreset(mem.preset))) {
                toastr.warning(tr`Saved preset "${mem.preset}" was not found.`, tr`Chat Preset Memory`);
                return;
            }
            notes.push(tr`Preset: ${mem.preset}`);
        }
        if (ctx().getCurrentChatId() !== chatId) return;
        if (kinds.toggles) {
            const changed = await applyToggles(togglesFor(mem, currentPreset()));
            if (changed) notes.push(tr`${changed} toggles`);
        }
        if (kinds.world) {
            const books = applyWorld(mem.world);
            const entries = await applyEntries(mem.entries);
            if (books || entries) notes.push(entries ? tr`World info ${entries}` : tr`World info`);
            await refreshEntries();
        }
        if (kinds.regex) {
            regexChanged = await applyRegex(mem.regex);
            if (regexChanged) notes.push(tr`${regexChanged} regex`);
        }
    } finally {
        restoring = false;
    }
    if (notes.length && settings().notify) toastr.info(notes.join(' · '), label, { timeOut: 2500 });
    // 화면에 그리는 정규식이 바뀌었으면 이 채팅을 한 번 다시 그림
    if (regexChanged && ctx().getCurrentChatId() === chatId) await ctx().reloadCurrentChat();
}

/** 채팅 안에서 사용자가 프리셋을 바꿨을 때: 이 채팅에서 그 프리셋으로 기억한 토글이 있으면 맞추고, 그 상태를 기억 */
async function onPresetChanged() {
    switching = false;
    if (!ready || restoring || !usable()) return;
    const mem = memory();
    if (mem && !mem.off && kindsOf(mem).toggles) {
        restoring = true;
        try {
            const changed = await applyToggles(togglesFor(mem, currentPreset()));
            if (changed && settings().notify) toastr.info(tr`${changed} toggles`, tr`Restored this chat's toggles for this preset`, { timeOut: 2000 });
        } finally {
            restoring = false;
        }
        // 기다리지 않고 바로 기억·저장 (그 사이 채팅을 옮겨도 예전 프리셋으로 돌아가지 않게)
        clearTimeout(saveTimer);
        if (!sameAsMemory(memory(), snapshot())) store(snapshot());
        return;
    }
    remember();
}

let seq = 0;
async function onChatChanged() {
    const my = ++seq;
    ready = false;
    renderBar();
    await new Promise(r => setTimeout(r, 500));
    if (my !== seq) return;
    await refreshEntries();
    if (my !== seq) return;
    try {
        if (usable()) {
            const mem = memory();
            const fallback = settings().charDefault ? settings().byChar[charKey()] : null;
            if (mem && !mem.off) await restore(mem, tr`Restored this chat's settings`);
            else if (!mem && fallback) await restore(fallback, tr`Started from this character's last settings`);
        }
    } catch (err) {
        console.warn(LOG, err);
    }
    await new Promise(r => setTimeout(r, 800));
    if (my !== seq) return;
    ready = true;
    remember(); // a chat without memory starts remembering from now
    renderBar();
}

// ---------------- Status bar above the prompt list ----------------

// ⓘ 창: 이 채팅이 기억하는 것을 보고 바로 고침 — 여기서 바꾸면 지금 설정이 바뀌고 기억도 따라감 (따로 저장 단추 없음)
async function showMemory() {
    const mem = memory();
    const e = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
    const kinds = kindsOf(mem);
    const root = document.createElement('div');
    root.className = 'cpm-info cpm-edit';
    let regexChanged = false;
    const off = KINDS.filter(k => !kinds[k]).map(k => KIND_LABEL[k]());
    root.innerHTML = `
        <h3>${e(tr`What this chat remembers`)}</h3>
        <p class="cpm-edit-sub">${e(tr`Changes here apply right away, and this chat remembers them.`)}</p>
        ${mem?.off ? `<p class="cpm-info-off">${e(tr`Remembering is off for this chat.`)}</p>` : ''}
        ${off.length ? `<p class="cpm-edit-sub">${e(tr`Not remembered in this chat: ${off.join(', ')} (turn it on in the bar)`)}</p>` : ''}
        <div class="cpm-sec" data-sec="toggles"></div>
        <div class="cpm-sec" data-sec="world"></div>
        <div class="cpm-sec" data-sec="regex"></div>`;
    const sec = k => root.querySelector(`[data-sec="${k}"]`);
    const search = (box, rows) => {
        const inp = box.querySelector('.cpm-search');
        inp?.addEventListener('input', () => { const q = inp.value.trim().toLowerCase(); rows().forEach(li => { li.hidden = !!q && !li.textContent.toLowerCase().includes(q); }); });
    };
    const row = (key, name, on, extra = '') => `<li><label><input type="checkbox" data-k="${e(key)}" ${on ? 'checked' : ''}><span>${e(name)}</span>${extra}</label></li>`;

    // 프롬프트: 지금 프리셋 토글 켜고 끄기 + 다른 프리셋에 기억한 것 지우기
    const paintToggles = () => {
        const box = sec('toggles');
        if (!kinds.toggles) { box.remove(); return; }
        const order = promptManager.getPromptOrderForCharacter(promptManager.activeCharacter) || [];
        const nameOf = id => promptManager.getPromptById(id)?.name || id;
        const others = Object.entries(memory()?.byPreset || {}).filter(([p]) => nfc(p) !== nfc(currentPreset()));
        box.innerHTML = `
            <h4>${e(tr`Prompts`)} <small>${e(currentPreset())} · ${e(tr`${order.filter(x => x.enabled).length} on`)}</small></h4>
            <input type="search" class="text_pole cpm-search" placeholder="${e(tr`Search`)}">
            <ul class="cpm-checks">${order.filter(x => promptManager.getPromptById(x.identifier)).map(x => row(x.identifier, nameOf(x.identifier), x.enabled)).join('')}</ul>
            ${others.length ? `<p class="cpm-edit-sub">${e(tr`Also remembered for other presets:`)}</p><ul class="cpm-others">${others.map(([p, t]) => `<li><span>${e(p)} — ${e(tr`${Object.values(t || {}).filter(Boolean).length} on`)}</span><button type="button" class="menu_button cpm-forget" data-p="${e(p)}">${e(tr`Forget`)}</button></li>`).join('')}</ul>` : ''}`;
        box.querySelectorAll('.cpm-checks input').forEach(cb => cb.addEventListener('change', () => {
            const entry = order.find(x => x.identifier === cb.dataset.k);
            if (!entry) return;
            entry.enabled = cb.checked;
            promptManager.render();
            Promise.resolve(promptManager.saveServiceSettings()).catch(err => console.warn(LOG, err));
            remember();
            box.querySelector('h4 small').textContent = `${currentPreset()} · ${tr`${order.filter(x => x.enabled).length} on`}`;
        }));
        box.querySelectorAll('.cpm-forget').forEach(btn => btn.addEventListener('click', () => {
            const m = memory(); if (!m?.byPreset) return;
            delete m.byPreset[btn.dataset.p];
            ctx().saveMetadata?.();
            paintToggles();
        }));
        search(box, () => box.querySelectorAll('.cpm-checks li'));
    };

    // 월드인포: 전역 선택 + 이 채팅에 걸린 로어북 항목
    const paintWorld = async () => {
        const box = sec('world');
        if (!kinds.world) { box.remove(); return; }
        const selected = new Set(worldState());
        const books = activeBooks();
        const parts = [];
        for (const book of books) {
            let data = null;
            try { data = await ctx().loadWorldInfo(book); } catch { /* 없어진 로어북 */ }
            const entries = Object.entries(data?.entries || {});
            const on = entries.filter(([, x]) => !x.disable).length;
            parts.push(`<details><summary>${e(book)} — ${e(tr`${on} on, ${entries.length - on} off`)}</summary><input type="search" class="text_pole cpm-search" placeholder="${e(tr`Search`)}"><ul class="cpm-checks" data-book="${e(book)}">${entries.map(([uid, x]) => row(uid, x.comment || (Array.isArray(x.key) ? x.key.slice(0, 3).join(', ') : '') || `#${uid}`, !x.disable)).join('')}</ul></details>`);
        }
        box.innerHTML = `
            <h4>${e(tr`World info`)}</h4>
            <details><summary>${e(tr`Global world info`)} — ${e(selected.size ? [...selected].join(', ') : tr`none`)}</summary><ul class="cpm-checks cpm-global">${(world_names || []).map(n => row(n, n, selected.has(n))).join('')}</ul></details>
            ${parts.length ? `<p class="cpm-edit-sub">${e(tr`Lorebook entries`)}:</p>${parts.join('')}` : `<p class="cpm-edit-sub">${e(tr`No lorebook is attached to this chat.`)}</p>`}`;
        box.querySelectorAll('.cpm-global input').forEach(cb => cb.addEventListener('change', () => {
            const want = [...box.querySelectorAll('.cpm-global input:checked')].map(x => x.dataset.k);
            applyWorld(want);
            refreshEntries().then(() => { remember(); paintWorld(); });
        }));
        box.querySelectorAll('ul[data-book] input').forEach(cb => cb.addEventListener('change', async () => {
            const book = cb.closest('ul').dataset.book;
            const data = await ctx().loadWorldInfo(book);
            const entry = data?.entries?.[cb.dataset.k];
            if (!entry) return;
            entry.disable = !cb.checked;
            await ctx().saveWorldInfo(book, data, true);
            ctx().reloadWorldInfoEditor?.(book);
            await refreshEntries(); remember();
            const all = Object.values(data.entries), n = all.filter(x => !x.disable).length;
            cb.closest('details').querySelector('summary').textContent = `${book} — ${tr`${n} on, ${all.length - n} off`}`;
        }));
        box.querySelectorAll('details').forEach(d => search(d, () => d.querySelectorAll('.cpm-checks li')));
    };

    // 정규식: 전역 · 프리셋 정규식 켜고 끄기
    const paintRegex = () => {
        const box = sec('regex');
        if (!kinds.regex) { box.remove(); return; }
        const groups = [[SCRIPT_TYPES.GLOBAL, tr`Global regex`], [SCRIPT_TYPES.PRESET, tr`Preset regex`]].map(([type, label]) => [type, label, getScriptsByType(type, { allowedOnly: false }) || []]);
        box.innerHTML = `<h4>${e(tr`Regex`)}</h4>` + groups.map(([type, label, list]) => `
            <details ${list.length ? '' : 'hidden'}><summary>${e(label)} — ${e(tr`${list.filter(x => !x.disabled).length} on, ${list.filter(x => x.disabled).length} off`)}</summary>
            <ul class="cpm-checks" data-type="${type}">${list.map(x => row(x.id, x.scriptName || x.id, !x.disabled)).join('')}</ul></details>`).join('');
        box.querySelectorAll('ul[data-type] input').forEach(cb => cb.addEventListener('change', async () => {
            const type = Number(cb.closest('ul').dataset.type);
            const list = getScriptsByType(type, { allowedOnly: false }) || [];
            const script = list.find(x => x.id === cb.dataset.k);
            if (!script) return;
            script.disabled = !cb.checked;
            await saveScriptsByType(list, type);
            regexChanged = true;
            remember();
            const on = list.filter(x => !x.disabled).length;
            cb.closest('details').querySelector('summary').textContent = `${groups.find(g => g[0] === type)[1]} — ${tr`${on} on, ${list.length - on} off`}`;
        }));
    };

    paintToggles(); paintRegex(); await paintWorld();
    await ctx().callGenericPopup(root, ctx().POPUP_TYPE.TEXT, '', { wide: true, allowVerticalScrolling: true });
    if (regexChanged) await ctx().reloadCurrentChat();   // 바뀐 정규식으로 채팅을 다시 그림
    renderBar();
}

const KIND_LABEL = { toggles: () => tr`Preset · toggles`, world: () => tr`World info`, regex: () => tr`Regex` };
function renderBar() {
    const list = document.getElementById('completion_prompt_manager_list');
    const host = document.getElementById('completion_prompt_manager');
    document.querySelectorAll('.cpm-bar').forEach(el => el.remove());
    if (!list || !host || ctx().mainApi !== 'openai' || !ctx().getCurrentChatId()) return;
    const enabled = settings().enabled;
    const mem = memory();
    const on = enabled && !mem?.off;
    const kinds = kindsOf(mem);
    const e = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
    const hint = !enabled ? tr`Chat preset memory is off. Turn it on in the extension settings.`
        : on ? (mem?.preset ? tr`Saved preset: ${mem.preset}` : tr`Not remembered yet`) : tr`Don't remember anything for this chat`;
    const bar = document.createElement('div');
    bar.className = 'cpm-bar' + (enabled ? '' : ' cpm-disabled');
    bar.innerHTML = `
        <label class="cpm-switch" title="${e(hint)}">
            <input type="checkbox" role="switch" ${on ? 'checked' : ''} ${enabled ? '' : 'disabled'}>
            <span class="cpm-track" aria-hidden="true"></span>
            <span class="cpm-text sr-only">${e(tr`Remember this chat`)}</span>
        </label>
        <span class="cpm-kinds" role="group" aria-label="${e(tr`What to remember`)}">${KINDS.map(k => `<button type="button" class="cpm-kind" data-kind="${k}" aria-pressed="${!!kinds[k]}" ${on ? '' : 'disabled'}>${e(KIND_LABEL[k]())}</button>`).join('')}</span>
        <button type="button" class="cpm-info-btn" title="${e(tr`What this chat remembers`)}" aria-label="${e(tr`What this chat remembers`)}"><i class="fa-solid fa-circle-info"></i></button>`;
    bar.querySelector('input').addEventListener('change', ev => {
        store(snapshot(), { off: !ev.target.checked });
    });
    bar.querySelector('.cpm-info-btn').addEventListener('click', showMemory);
    bar.querySelectorAll('.cpm-kind').forEach(btn => btn.addEventListener('click', () => {
        const next = { ...kindsOf(), [btn.dataset.kind]: btn.getAttribute('aria-pressed') !== 'true' };
        if (!KINDS.some(k => next[k])) return void toastr.info(tr`Pick at least one, or turn the switch off.`);
        (next.world ? refreshEntries() : Promise.resolve()).then(() => store(snapshot(next), { kinds: next }));   // 켠 종류는 지금 상태부터 기억
    }));
    // 다른 확장의 도구 줄(예: 프롬프트 그룹)이 먼저 붙어 있어도 늘 그 위에 — 나중에 붙느라 자리가 바뀌지 않게
    (host.querySelector('.pf-toolbar') ?? list).before(bar);
}

let barTimer = null;
function watchPromptManager() {
    const host = document.getElementById('completion_prompt_manager');
    if (!host) return void setTimeout(watchPromptManager, 1000);
    new MutationObserver(() => {
        if (host.querySelector('.cpm-bar') || !document.getElementById('completion_prompt_manager_list')) return;
        clearTimeout(barTimer);
        barTimer = setTimeout(renderBar, 20);
    }).observe(host, { childList: true, subtree: true });
    renderBar();
}

// ---------------- Settings panel ----------------

async function addSettingsPanel() {
    const host = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
    if (!host || document.getElementById('cpm_settings')) return;
    const html = await (await fetch(new URL('settings.html', import.meta.url))).text();
    host.insertAdjacentHTML('beforeend', html);
    const s = settings();
    for (const key of ['enabled', 'restorePreset', 'charDefault', 'notify']) {
        const cb = document.getElementById(`cpm_${key}`);
        if (!cb) continue;
        cb.checked = !!s[key];
        cb.addEventListener('change', () => {
            settings()[key] = cb.checked;
            ctx().saveSettingsDebounced();
            renderBar();
        });
    }
    for (const k of KINDS) {
        const cb = document.getElementById(`cpm_kind_${k}`);
        if (!cb) continue;
        cb.checked = !!s.kinds[k];
        cb.addEventListener('change', () => { settings().kinds = { ...settings().kinds, [k]: cb.checked }; ctx().saveSettingsDebounced(); renderBar(); });
    }
    document.getElementById('cpm_clear_chars')?.addEventListener('click', async () => {
        const n = Object.keys(settings().byChar).length;
        const ok = await ctx().callGenericPopup(tr`Clear the character defaults (${n})? Saved chat settings are kept.`, ctx().POPUP_TYPE.CONFIRM);
        if (!ok) return;
        settings().byChar = {};
        ctx().saveSettingsDebounced();
    });
}

jQuery(async () => {
    settings();
    await loadKo();
    try { await addSettingsPanel(); } catch (err) { console.warn(LOG, 'settings panel', err); }
    const { eventSource, event_types } = ctx();
    eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
    eventSource.on(event_types.SETTINGS_UPDATED, remember);
    // 로어북 항목을 켜고 끄면(월드인포 편집 창) 그 상태를 기억
    eventSource.on(event_types.WORLDINFO_UPDATED, () => { if (!restoring && kindsOf().world) refreshEntries().then(remember); });
    // 프리셋을 바꾸는 동안(설정이 여러 번 저장됨)은 기억하지 않다가, 다 바뀐 뒤 그 프리셋 기준으로 처리
    eventSource.on(event_types.OAI_PRESET_CHANGED_BEFORE, () => { if (!restoring) switching = true; });
    eventSource.on(event_types.OAI_PRESET_CHANGED_AFTER, () => setTimeout(onPresetChanged, 300));
    eventSource.on(event_types.GENERATION_STARTED, (type, _opts, dryRun) => {
        if (!dryRun && type !== 'quiet') remember();
    });
    watchPromptManager();
});
