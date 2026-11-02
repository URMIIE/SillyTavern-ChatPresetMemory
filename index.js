// Chat Preset Memory — remembers the Chat Completion preset and its prompt toggles per chat,
// and restores them when the chat is opened again.
// Stored in the chat file: chat_metadata.chatPresetMemory =
//   { preset: 마지막 프리셋, toggles: 그 프리셋의 토글, byPreset: { 프리셋 이름: 토글 }, at, off? }
// Optional character default: extension settings byChar[avatar | group:id] = 같은 꼴

import { oai_settings, promptManager, getPresetApplicationPromise } from '../../../openai.js';

const MODULE = 'chatPresetMemory';
const LOG = '[Chat Preset Memory]';
const DEFAULTS = Object.freeze({ enabled: true, restorePreset: true, charDefault: true, notify: true, byChar: {} });
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

function snapshot() {
    const order = promptManager.getPromptOrderForCharacter(promptManager.activeCharacter) || [];
    const toggles = {};
    for (const e of order) toggles[e.identifier] = !!e.enabled;
    return { preset: currentPreset(), toggles };
}

/** 새 상태를 기억에 얹음 (프리셋마다 따로) */
function merged(prev, snap, extra = {}) {
    const byPreset = { ...(prev?.byPreset || {}) };
    if (prev?.preset && prev?.toggles && !togglesFor({ byPreset }, prev.preset)) byPreset[prev.preset] = prev.toggles;
    for (const k of Object.keys(byPreset)) if (nfc(k) === nfc(snap.preset)) delete byPreset[k];
    byPreset[snap.preset] = snap.toggles;
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
    const urgent = !prev || nfc(prev.preset) !== nfc(snap.preset) || 'off' in extra;
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
    && JSON.stringify(togglesFor(mem, snap.preset)) === JSON.stringify(snap.toggles);

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

/** 채팅을 열 때: 마지막 프리셋으로 바꾸고(설정에 따라), 그 프리셋에서 기억한 토글을 맞춤 */
async function restore(mem, label) {
    const chatId = ctx().getCurrentChatId();
    const notes = [];
    restoring = true;
    try {
        if (settings().restorePreset && mem.preset && nfc(mem.preset) !== nfc(currentPreset())) {
            if (!(await switchPreset(mem.preset))) {
                toastr.warning(tr`Saved preset "${mem.preset}" was not found.`, tr`Chat Preset Memory`);
                return;
            }
            notes.push(tr`Preset: ${mem.preset}`);
        }
        if (ctx().getCurrentChatId() !== chatId) return;
        const changed = await applyToggles(togglesFor(mem, currentPreset()));
        if (changed) notes.push(tr`${changed} toggles`);
    } finally {
        restoring = false;
    }
    if (notes.length && settings().notify) toastr.info(notes.join(' · '), label, { timeOut: 2500 });
}

/** 채팅 안에서 사용자가 프리셋을 바꿨을 때: 이 채팅에서 그 프리셋으로 기억한 토글이 있으면 맞추고, 그 상태를 기억 */
async function onPresetChanged() {
    switching = false;
    if (!ready || restoring || !usable()) return;
    const mem = memory();
    if (mem && !mem.off) {
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

function showMemory() {
    const mem = memory();
    const e = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
    if (!mem) return void toastr.info(tr`Not remembered yet`);
    const nameOf = id => promptManager.getPromptById(id)?.name ?? id;
    const presets = Object.entries(mem.byPreset || { [mem.preset]: mem.toggles });
    const cur = togglesFor(mem, currentPreset());
    const onNames = cur ? Object.entries(cur).filter(([, v]) => v).map(([id]) => nameOf(id)) : [];
    const html = `
        <div class="cpm-info">
            <h3>${e(tr`What this chat remembers`)}</h3>
            ${mem.off ? `<p class="cpm-info-off">${e(tr`Remembering is off for this chat.`)}</p>` : ''}
            <p>${e(tr`Last preset`)}: <b>${e(mem.preset)}</b>${settings().restorePreset ? '' : ` <small>(${e(tr`the preset itself is not switched`)})</small>`}</p>
            <p>${e(tr`Presets with remembered toggles`)}:</p>
            <ul>${presets.map(([p, t]) => `<li>${e(p)} — ${e(tr`${Object.values(t || {}).filter(Boolean).length} on`)}</li>`).join('')}</ul>
            ${cur ? `<details><summary>${e(tr`Toggles on for the current preset (${onNames.length})`)}</summary><ol>${onNames.map(n => `<li>${e(n)}</li>`).join('')}</ol></details>` : `<p><small>${e(tr`Nothing remembered for the current preset yet.`)}</small></p>`}
        </div>`;
    ctx().callGenericPopup(html, ctx().POPUP_TYPE.TEXT, '', { allowVerticalScrolling: true });
}

function renderBar() {
    const list = document.getElementById('completion_prompt_manager_list');
    const host = document.getElementById('completion_prompt_manager');
    document.querySelectorAll('.cpm-bar').forEach(el => el.remove());
    if (!list || !host || ctx().mainApi !== 'openai' || !ctx().getCurrentChatId()) return;
    const enabled = settings().enabled;
    const mem = memory();
    const on = enabled && !mem?.off;
    const e = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
    const hint = !enabled ? tr`Chat preset memory is off. Turn it on in the extension settings.`
        : on ? (mem?.preset ? tr`Saved preset: ${mem.preset}` : tr`Not remembered yet`) : tr`Don't remember anything for this chat`;
    const bar = document.createElement('div');
    bar.className = 'cpm-bar' + (enabled ? '' : ' cpm-disabled');
    bar.innerHTML = `
        <label class="cpm-switch" title="${e(hint)}">
            <input type="checkbox" role="switch" ${on ? 'checked' : ''} ${enabled ? '' : 'disabled'}>
            <span class="cpm-track" aria-hidden="true"></span>
            <span class="cpm-text">${e(tr`Remember this chat's preset and toggles`)}</span>
        </label>
        <button type="button" class="cpm-info-btn" title="${e(tr`What this chat remembers`)}" aria-label="${e(tr`What this chat remembers`)}"><i class="fa-solid fa-circle-info"></i></button>`;
    bar.querySelector('input').addEventListener('change', ev => {
        store(snapshot(), { off: !ev.target.checked });
    });
    bar.querySelector('.cpm-info-btn').addEventListener('click', showMemory);
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
    // 프리셋을 바꾸는 동안(설정이 여러 번 저장됨)은 기억하지 않다가, 다 바뀐 뒤 그 프리셋 기준으로 처리
    eventSource.on(event_types.OAI_PRESET_CHANGED_BEFORE, () => { if (!restoring) switching = true; });
    eventSource.on(event_types.OAI_PRESET_CHANGED_AFTER, () => setTimeout(onPresetChanged, 300));
    eventSource.on(event_types.GENERATION_STARTED, (type, _opts, dryRun) => {
        if (!dryRun && type !== 'quiet') remember();
    });
    watchPromptManager();
});
