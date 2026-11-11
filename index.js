// Chat Preset Memory (이 채팅 기억) — 채팅마다 쓰던 설정을 기억했다가, 그 채팅을 다시 열면 그대로 맞춤.
// 채팅 하나의 기억 =
//   { preset: 마지막 프리셋, byPreset: { 프리셋 이름: 토글 }, world: [켜 둔 전역 월드인포], entries: { 로어북: { uid: 켜짐 } },
//     regex: { 정규식 id: 켜짐 } (전역 · 프리셋 정규식), connection: { profile | source, model },
//     persona: { avatar, au? } (페르소나와 그 페르소나에 고른 AU), card: { 저장 키: { t: 판 이름, i: 순서 } | { e: 1 } 빈칸 } (캐릭터 카드 칸별 판),
//     kinds: { toggles, connection, regex, world, persona, card } 무엇을 기억할지, at, off? }
// 기억은 채팅 파일이 아니라 서버 파일 user/files/chat-preset-memory.<캐릭터 · 그룹>-<번호>.json { owner, ids, chats: { 채팅 id: 기억 } } 에 둠
// — 채팅 파일을 다시 쓰지 않아 최근 채팅 목록 순서가 바뀌지 않음. 예전 기억(chat_metadata · 한 파일 chat-preset-memory.json)은 읽어서 옮김
// 캐릭터별 마지막 설정: extension settings byChar[avatar | group:id] = 같은 꼴 (새 채팅을 열 때 씀)

import { oai_settings, promptManager, getPresetApplicationPromise, getChatCompletionModel } from '../../../openai.js';
import { extension_settings } from '../../../extensions.js';
import { selected_world_info, world_names, world_info } from '../../../world-info.js';
import { getScriptsByType, saveScriptsByType, SCRIPT_TYPES } from '../../regex/engine.js';
import { user_avatar, setUserAvatar } from '../../../personas.js';
import { power_user } from '../../../power-user.js';
import { t as coreT } from '../../../i18n.js';

const MODULE = 'chatPresetMemory';
const LOG = '[Chat Preset Memory]';
// 알약 순서 = 두 묶음: 프롬프트 · 연결 · 정규식 | 월드인포 · 페르소나 AU · 캐릭터 AU
const KINDS = ['toggles', 'connection', 'regex', 'world', 'persona', 'card'];
const KIND_GROUPS = [['toggles', 'connection', 'regex'], ['world', 'persona', 'card']];
const DEFAULTS = Object.freeze({ enabled: true, restorePreset: true, charDefault: true, notify: true, byChar: {}, pending: {}, showBar: true, barPos: 'top', kinds: { toggles: true, world: false, regex: false, connection: false, persona: false, card: false } });
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
    // 같은 객체를 그대로 씀(부를 때마다 새로 만들면, 한 줄에서 두 번 부를 때 앞 객체에 쓴 값이 사라짐)
    if (!all[MODULE] || typeof all[MODULE] !== 'object') all[MODULE] = {};
    for (const [k, v] of Object.entries(DEFAULTS)) if (!(k in all[MODULE])) all[MODULE][k] = structuredClone(v);
    if (!all[MODULE].byChar || typeof all[MODULE].byChar !== 'object') all[MODULE].byChar = {};
    if (!all[MODULE].byCharTrimmed) {   // 예전에 쌓인 캐릭터별 마지막 설정도 한 번 줄임
        for (const [k, v] of Object.entries(all[MODULE].byChar)) all[MODULE].byChar[k] = trimChar(v);
        all[MODULE].byCharTrimmed = true;
    }
    if (!all[MODULE].pending || typeof all[MODULE].pending !== 'object') all[MODULE].pending = {};
    if (!Array.isArray(all[MODULE].files)) all[MODULE].files = [];   // 기억 파일이 있는 캐릭터 · 그룹 키 — 주인이 없어진 파일을 지우려고
    // 「켜기」 · 「마지막 프리셋으로도 바꾸기」는 설정 칸에서 뺌 — 늘 켬 (확장 전체는 실리태번 확장 관리에서 끔)
    all[MODULE].enabled = true; all[MODULE].restorePreset = true;
    // 「프롬프트 목록 위에도 설정 보이기」 기본값이 꺼짐이던 때 저장된 값은 한 번만 켬
    if (!all[MODULE].showBarSet) { all[MODULE].showBar = true; all[MODULE].showBarSet = true; }
    all[MODULE].kinds = { ...DEFAULTS.kinds, ...(all[MODULE].kinds || {}) };
    // 알림: 켜고 끄기(notify) + 알림에 보일 종류(notifyKinds) — 예전 알림 모양(notifyMode) 값에서 한 번 이어받음
    if (!all[MODULE].notifyKinds || typeof all[MODULE].notifyKinds !== 'object') {
        const m = all[MODULE].notifyMode;
        if (m === 'off') all[MODULE].notify = false;
        all[MODULE].notifyKinds = Object.fromEntries(KINDS.map(k => [k, m !== 'plain']));
        delete all[MODULE].notifyMode;
    }
    all[MODULE].notifyKinds = { ...Object.fromEntries(KINDS.map(k => [k, true])), ...all[MODULE].notifyKinds };
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

// ---------------- 기억 저장소 (캐릭터 · 그룹마다 서버 파일 하나) ----------------
// user/files/chat-preset-memory.<이름>-<해시>.json = { owner, chats: { 채팅 id: 기억 } }
// 채팅이 많아도 저장할 때는 그 캐릭터 파일만 읽고 씀. 채팅을 다 지우거나 캐릭터를 지우면 파일도 지움.
const LEGACY_FILE = 'chat-preset-memory.json';   // 예전: 모든 채팅을 파일 하나에 — 열 때 캐릭터별 파일로 옮김
// 지금까지 읽은 캐릭터들의 기억(채팅 id → 기억). 파일에서 읽은 채팅은 짧은 꼴 그대로 두었다가 처음 쓸 때 풂
// (한 캐릭터에 채팅이 수천 개여도 그 캐릭터를 열 때 전부 풀지 않게)
const PACKED = Symbol('packed');
const lazy = (m, ids) => ({ [PACKED]: m, ids });
let STORE = { chats: new Proxy({}, {
    get(target, id) { const v = target[id]; if (v && v[PACKED]) return (target[id] = unpackChat(v[PACKED], v.ids)); return v; },
}) };
const ownerOf = {};                               // 채팅 id → 캐릭터 · 그룹 키
const loaded = new Map();                         // 캐릭터 · 그룹 키 → 읽기 Promise
const dirty = new Set();
const gone = new Set();                           // 지운 캐릭터 · 그룹 — 늦게 도는 저장이 파일을 다시 만들지 않게
let storeTimer = null;
function fileOf(key) {
    let h = 0x811c9dc5;
    for (const ch of String(key)) { h ^= ch.codePointAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
    const slug = String(key).replace(/\.png$/i, '').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 30);
    return `chat-preset-memory.${slug || 'char'}-${h.toString(36)}.json`;   // 영문 · 숫자가 없는 이름(한글 · 한자)은 char-해시
}
/** 파일이 없을 때만 null — 서버 오류 · 끊김 · 깨진 글은 오류로 던짐
 *  (예전엔 모두 「없음」으로 봐서, 잠깐 못 읽은 순간에 저장하면 그 캐릭터의 다른 채팅 기억을 빼고 덮어쓰거나 파일을 지웠음) */
async function readJson(name) {
    const r = await fetch(`/user/files/${name}`, { cache: 'no-store' });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`read ${name}: ${r.status}`);
    return await r.json();
}
async function writeJson(name, obj) {
    const bytes = new TextEncoder().encode(JSON.stringify(obj)); let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));   // 큰 파일도 한 번에 펼치지 않게
    const r = await fetch('/api/files/upload', { method: 'POST', headers: ctx().getRequestHeaders(), body: JSON.stringify({ name, data: btoa(bin) }) });
    if (!r.ok) throw new Error(`write ${name}: ${r.status}`);
}
// 저장이 끝내 안 되면 한 번만 알림 (다시 저장되면 풀림)
let saveWarned = false;
let retryTimer = null;
function warnSaveFailed(err) {
    console.warn(LOG, 'save', err);
    if (saveWarned) return;
    saveWarned = true;
    toastr.warning(tr`Couldn't save this chat's memory to the server. It will keep trying.`, tr`Chat Preset Memory`);
}
async function removeFile(name) {
    await fetch('/api/files/delete', { method: 'POST', headers: ctx().getRequestHeaders(), body: JSON.stringify({ path: `user/files/${name}` }) }).catch(() => {});
}
/** 기억 파일 목록(확장 설정) — 새 파일이 생기거나 지울 때만 설정 저장 */
function noteFile(key, exists) {
    const list = settings().files, has = list.includes(key);
    if (exists === has) return;
    if (exists) list.push(key); else list.splice(list.indexOf(key), 1);
    ctx().saveSettingsDebounced();
}
/** 실리태번을 켤 때: 캐릭터 · 그룹이 없어진 기억 파일을 지움 (지우는 신호를 놓쳤어도 남지 않게) */
async function pruneFiles() {
    const c = ctx();
    if (!c.characters?.length) return;   // 목록을 못 읽었으면 아무것도 지우지 않음
    let groups = null;   // 그룹 목록은 서버에 직접 물음 — 못 읽으면 그룹 파일은 남김
    try { const r = await fetch('/api/groups/all', { method: 'POST', headers: c.getRequestHeaders() }); if (r.ok) groups = await r.json(); } catch { /* 못 읽음 */ }
    const alive = new Set([...c.characters.map(x => x.avatar), ...(Array.isArray(groups) ? groups : []).map(g => 'group:' + g.id)]);
    for (const key of [...settings().files]) {
        if (alive.has(key)) continue;
        if (key.startsWith('group:') && !Array.isArray(groups)) continue;
        await removeFile(fileOf(key));
        noteFile(key, false);
    }
}
let legacyReady = null;
const loadLegacy = () => legacyReady ??= readJson(LEGACY_FILE).then(j => j?.chats && typeof j.chats === 'object' ? j : null).catch(err => { legacyReady = null; throw err; });
/** 이 캐릭터(그룹)의 기억 파일을 읽음 — 예전 한 파일에 이 캐릭터 채팅이 있으면 여기로 옮김 */
function loadOwner(key = charKey()) {
    if (!key) return Promise.resolve();
    if (!loaded.has(key)) loaded.set(key, (async () => {
        gone.delete(key);
        const file = await readJson(fileOf(key));
        for (const [id, m] of Object.entries(file?.chats || {})) {
            if (!m || typeof m !== 'object') continue;
            ownerOf[id] = key;
            if (!dirty.has(id)) STORE.chats[id] = lazy(m, file.ids);
        }
        const legacy = await loadLegacy();
        if (!legacy || !Object.keys(legacy.chats).length) return;
        const mine = new Set(await chatsOf(key).catch(() => []));
        const here = ctx().getCurrentChatId(); if (here && charKey() === key) mine.add(here);
        const moved = Object.keys(legacy.chats).filter(id => mine.has(id));
        if (!moved.length) return;
        for (const id of moved) {
            const m = legacy.chats[id];
            if (m && typeof m === 'object' && !STORE.chats[id]) { STORE.chats[id] = compact(m); ownerOf[id] = key; dirty.add(id); }
            delete legacy.chats[id];
        }
        await saveStore();
        if (Object.keys(legacy.chats).length) await writeJson(LEGACY_FILE, legacy); else await removeFile(LEGACY_FILE);
    })().catch(err => { console.warn(LOG, 'load', err); loaded.delete(key); }));   // 못 읽었으면 다음에 다시 읽음
    return loaded.get(key);
}
/** 캐릭터 · 그룹의 채팅 id 목록 */
async function chatsOf(key) {
    const c = ctx();
    if (String(key).startsWith('group:')) return c.groups?.find(g => g.id === key.slice(6))?.chats || [];
    const res = await fetch('/api/characters/chats', { method: 'POST', headers: c.getRequestHeaders(), body: JSON.stringify({ avatar_url: key, simple: true }) });
    const data = await res.json();
    const list = Array.isArray(data) ? data : Object.values(data || {});
    return list.map(x => String(x.file_name || '').replace(/\.jsonl$/, '')).filter(Boolean);
}
/** 기억 하나를 가볍게: 같은 토글을 두 번 담지 않고 쓰지 않는 칸을 뺌 (바뀐 게 없으면 같은 객체) */
function compact(m) {
    const extra = 'locked' in m;
    const dup = m.toggles && m.byPreset && Object.entries(m.byPreset).some(([k]) => nfc(k) === nfc(m.preset));
    if (!extra && !dup) return m;
    const out = { ...m };
    delete out.locked;
    if (dup) delete out.toggles;
    return out;
}
// 파일 안 토글은 짧게: 프리셋마다 토글 id 목록(ids)을 파일에 한 번만 두고, 채팅에는 그 순서대로 '1'(켬) · '0'(끔) · '.'(기억 없음) 한 줄
// (토글 148개면 148글자 — 예전엔 토글마다 긴 id 를 다시 적어 채팅 하나에 6KB 넘게 들었음)
function packChat(m, ids) {
    if (!m || typeof m !== 'object') return m;
    const out = { ...m };
    const by = { ...(m.byPreset || {}) };
    if (m.toggles && m.preset && !Object.keys(by).some(k => nfc(k) === nfc(m.preset))) by[m.preset] = m.toggles;
    delete out.toggles;
    if (!Object.keys(by).length) { delete out.byPreset; return out; }
    out.byPreset = {};
    for (const [p, t] of Object.entries(by)) {
        if (typeof t === 'string') { out.byPreset[p] = t; continue; }
        const list = ids[p] ||= [];
        for (const id of Object.keys(t || {})) if (!list.includes(id)) list.push(id);
        out.byPreset[p] = list.map(id => id in t ? (t[id] ? '1' : '0') : '.').join('').replace(/\.+$/, '');
    }
    return out;
}
function unpackChat(m, ids) {
    if (!m || typeof m !== 'object' || !m.byPreset) return m;
    const out = { ...m, byPreset: {} };
    for (const [p, t] of Object.entries(m.byPreset)) {
        if (typeof t !== 'string') { out.byPreset[p] = t; continue; }
        const list = ids?.[p] || [], obj = {};
        [...t].forEach((ch, i) => { if (list[i] && ch !== '.') obj[list[i]] = ch === '1'; });
        out.byPreset[p] = obj;
    }
    return out;
}
/** 바뀐 채팅이 든 캐릭터 파일만 — 저장 직전에 그 파일을 다시 읽어 다른 탭 · 기기의 기억을 덮지 않음. 비면 파일을 지움
 *  저장은 한 번에 하나씩: 겹치면 뒤 저장이 앞 저장 전 파일을 읽어 방금 지운 기억을 되살렸음(마지막 채팅을 지우면 새 채팅이 바로 저장됨) */
let saving = Promise.resolve();
function saveStore() {
    saving = saving.then(saveStoreNow, saveStoreNow);
    return saving;
}
async function saveStoreNow() {
    const ids = [...dirty]; dirty.clear();
    const byOwner = new Map();
    for (const id of ids) { const k = ownerOf[id]; if (k) (byOwner.get(k) || byOwner.set(k, []).get(k)).push(id); }
    for (const [key, list] of byOwner) {
        // 다른 탭 · 기기가 같은 순간에 같은 파일을 쓰면 한쪽 변경이 덮일 수 있음 → 쓴 뒤 다시 읽어 내 변경이 빠졌으면 합쳐서 다시 씀
        // 읽기 · 쓰기가 실패하거나 끝내 맞지 않으면 그 채팅들을 「저장할 것」으로 되돌림 (다음 변경 때 다시 저장)
        let ok = false;
        try { for (let tries = 0; tries < 4; tries++) {
            if (gone.has(key)) break;
            const name = fileOf(key);
            const latest = await readJson(name) || {};
            const ids = latest.ids && typeof latest.ids === 'object' ? latest.ids : {};
            const chats = latest.chats && typeof latest.chats === 'object' ? latest.chats : {};
            for (const id of list) { if (STORE.chats[id] === undefined) delete chats[id]; else chats[id] = packChat(STORE.chats[id], ids); }
            for (const [id, m] of Object.entries(chats)) if (!list.includes(id) && !dirty.has(id)) { STORE.chats[id] = lazy(m, ids); ownerOf[id] = key; }
            const want = Object.fromEntries(list.map(id => [id, JSON.stringify(chats[id] ?? null)]));
            const presets = new Set(list.flatMap(id => Object.keys(chats[id]?.byPreset || {})));
            const wantIds = [...presets].map(p => [p, ids[p] || []]);
            if (Object.keys(chats).length) { await writeJson(name, { owner: key, ids, chats }); noteFile(key, true); }
            else { await removeFile(name); noteFile(key, false); }
            await new Promise(r => setTimeout(r, 150 + Math.random() * 250));
            const check = await readJson(name);
            const back = check?.chats || {};
            // 채팅 줄도, 그 줄이 가리키는 토글 id 목록(앞부분)도 그대로여야 함
            const idsOk = wantIds.every(([p, l]) => l.every((x, i) => check?.ids?.[p]?.[i] === x));
            if (idsOk && list.every(id => JSON.stringify(back[id] ?? null) === want[id])) { ok = true; break; }
        } } catch (err) { console.warn(LOG, 'save', err); }
        if (gone.has(key)) continue;
        if (ok) { saveWarned = false; continue; }
        for (const id of list) dirty.add(id);
        warnSaveFailed(`${fileOf(key)}`);
        clearTimeout(retryTimer);
        retryTimer = setTimeout(() => saveStore().catch(err => console.warn(LOG, 'save', err)), 30000);   // 변경이 없어도 30초 뒤 한 번 더
    }
}
function scheduleStore(urgent) {
    clearTimeout(storeTimer);
    storeTimer = setTimeout(() => saveStore().catch(err => console.warn(LOG, 'save', err)), urgent ? 0 : 1500);
}
function putMemory(id, value, urgent = true, key = ownerOf[id] || charKey()) {
    if (!id || !key) return;
    ownerOf[id] = key;
    if (value === undefined) delete STORE.chats[id]; else STORE.chats[id] = value;
    dirty.add(id);
    scheduleStore(urgent);
}
const memory = () => { const id = ctx().getCurrentChatId(); return (id && STORE.chats[id]) || ctx().chatMetadata?.[MODULE] || null; };
const currentPreset = () => oai_settings.preset_settings_openai;

/** 프리셋 이름 → 그 프리셋에서 기억한 토글 (예전 꼴 {preset, toggles} 도 읽음) */
function togglesFor(mem, preset) {
    if (!mem) return null;
    const hit = Object.entries(mem.byPreset || {}).find(([k]) => nfc(k) === nfc(preset));
    if (hit) return hit[1];
    return nfc(mem.preset) === nfc(preset) ? mem.toggles || null : null;
}

/** 이 채팅이 기억하는 종류 (채팅마다 고른 것, 없으면 설정의 기본값) */
const rawKinds = (mem = memory()) => ({ ...settings().kinds, ...(mem?.kinds || {}) });
// 페르소나 종류는 페르소나마다 버전(AU)을 고르는 확장이 켜져 있을 때만 보이고 작동 (그 확장의 빠른 전환 단추로 판단)
const auReady = () => !!document.getElementById('ps-quick-trigger');
// 캐릭터 AU 는 캐릭터 카드 칸마다 여러 판을 저장해 두는 확장이 켜져 있고(그 확장의 단추로 판단) 지금 캐릭터 카드에 저장판이 있을 때만
const cardReady = () => !!document.querySelector('.alt_fields_button');
const kindReady = k => k === 'persona' ? auReady() : k === 'card' ? cardReady() && !!cardFields().length : true;
const kindList = () => KINDS.filter(kindReady);
const kindsOf = (mem = memory()) => { const k = rawKinds(mem); for (const x of KINDS) if (!kindReady(x)) k[x] = false; return k; };
/** 알약을 두 묶음으로 (묶음 사이 세로선) */
const kindPills = (kinds, e) => KIND_GROUPS.map(g => g.filter(kindReady)).filter(g => g.length)
    .map(g => `<span class="cpm-kind-group">${g.map(k => `<button type="button" class="cpm-kind" data-kind="${k}" aria-pressed="${!!kinds[k]}">${e(KIND_LABEL[k]())}</button>`).join('')}</span>`).join('');
function syncAuOption() {
    for (const pre of ['cpm_kind_', 'cpm_nkind_']) {
        const label = document.getElementById(`${pre}persona`)?.closest('label');
        if (label) label.hidden = !auReady();
        const card = document.getElementById(`${pre}card`)?.closest('label');
        if (card) card.hidden = !cardReady();
    }
    document.querySelectorAll('.cpm-au-word').forEach(x => { x.hidden = !auReady() && !cardReady(); });
}

// 캐릭터 AU: 카드 칸마다 저장해 둔 판 중 지금 어느 판인지 { 저장 키: { t: 판 이름, i: 몇 번째 } } (이름이 같은 판이 있어 순서도 적음) — 그 확장의 「사용」처럼 카드 칸 글을 바꿔 넣음(실리태번이 카드를 저장)
const CARD_FIELDS = [
    { key: 'alt_descriptions', area: 'description_textarea', prop: 'description', label: () => tr`Character description` },
    { key: 'alt_personalities', area: 'personality_textarea', prop: 'personality', label: () => tr`Personality summary` },
    { key: 'alt_scenarios', area: 'scenario_pole', prop: 'scenario', label: () => tr`Scenario` },
    { key: 'alt_example_dialogue', area: 'mes_example_textarea', prop: 'mes_example', label: () => tr`Examples of dialogue` },
    { key: 'alt_main_prompts', area: 'system_prompt_textarea', prop: 'system_prompt', label: () => tr`Main prompt` },
    { key: 'alt_post_history', area: 'post_history_instructions_textarea', prop: 'post_history_instructions', label: () => tr`Post-history instructions` },
];
function cardChar() {
    const c = ctx();
    if (c.groupId) return null;
    const ch = c.characters?.[c.characterId];
    // 캐릭터 편집 칸이 지금 캐릭터 것일 때만 (다른 캐릭터 칸에 쓰지 않게)
    return ch && document.getElementById('avatar_url_pole')?.value === ch.avatar ? ch : null;
}
/** 지금 캐릭터 카드에서 저장판이 있는 칸 [{ ...칸, list }] */
function cardFields() {
    const ch = cardChar();
    const alts = ch?.data?.extensions?.alternate_fields || {};
    return CARD_FIELDS.map(f => ({ ...f, list: Array.isArray(alts[f.key]) ? alts[f.key].filter(x => x && typeof x.content === 'string') : [] })).filter(f => f.list.length && document.getElementById(f.area));
}
// 카드 파일엔 줄바꿈이 \r\n 으로 저장되기도 해서 \r 은 빼고 비교
const same = (a, b) => String(a ?? '').replace(/\r/g, '').trim() === String(b ?? '').replace(/\r/g, '').trim();
function cardState() {
    const out = {};
    for (const f of cardFields()) {
        const text = document.getElementById(f.area).value;
        const i = f.list.findIndex(x => same(x.content, text));
        if (i >= 0) out[f.key] = { t: f.list[i].title, i };
        else if (!text.trim()) out[f.key] = { e: 1 };   // 빈칸도 하나의 상태로 기억 (빈 시나리오로 돌아갈 수 있게)
    }
    return Object.keys(out).length ? out : null;
}
/** 카드 칸에 글을 넣음 — 편집 칸과 메모리의 캐릭터 값을 같이 바꿈.
 *  편집 칸만 바꾸면, 저장되기 전에 실리태번이 채팅을 다시 불러올 때(연결 프로필을 바꿀 때 등) 칸을 메모리의 옛 글로 다시 채워 되돌아갔음 */
function setCardText(f, text) {
    const ch = cardChar(), area = document.getElementById(f.area);
    if (!ch || !area) return;
    if (f.prop in ch) ch[f.prop] = text;
    if (ch.data) ch.data[f.prop] = text;
    area.value = text;
    area.dispatchEvent(new Event('input', { bubbles: true }));
}
/** 지금 칸 글이 어느 저장판에도 없으면 그 글을 판으로 남김 — 다른 판으로 바꾸면 사라지니까. 남긴 판의 순서 (안 남겼으면 -1) */
async function keepUnsaved(f) {
    const ch = cardChar(), text = document.getElementById(f.area)?.value ?? '';
    if (!ch || !text.trim() || f.list.some(x => same(x.content, text))) return -1;
    const alts = (ch.data.extensions ||= {}).alternate_fields ||= {};
    const list = alts[f.key] ||= [];
    const d = new Date(), p = n => String(n).padStart(2, '0');
    const title = list.some(x => x.title === tr`Original text`) ? `${tr`Edited text`} ${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}` : tr`Original text`;
    list.push({ title, content: text });
    await ctx().writeExtensionField(ctx().characterId, 'alternate_fields', alts);
    return list.length - 1;
}
/** 기억한 판으로 → 바꾼 칸 [[칸 이름, 판 이름]] — 지금 글이 어느 저장판과도 다르면(직접 고친 글) 그 칸은 건드리지 않음 */
function applyCard(state) {
    const done = [];
    if (!state) return done;
    for (const f of cardFields()) {
        const want = state[f.key];
        // 순서 · 이름이 둘 다 맞는 판 → 없으면 이름이 같은 첫 판 (판을 지우거나 옮긴 경우)
        const target = want?.e ? { title: tr`Empty`, content: '' } : want && (f.list[want.i]?.title === want.t ? f.list[want.i] : f.list.find(x => x.title === want.t));
        const area = document.getElementById(f.area);
        if (!target || same(target.content, area.value) || (area.value.trim() && !f.list.some(x => same(x.content, area.value)))) continue;
        setCardText(f, target.content);
        done.push([f.label(), target.title]);
    }
    return done;
}

const REGEX_TYPES = [SCRIPT_TYPES.GLOBAL, SCRIPT_TYPES.PRESET];
function regexState() {
    const out = {};
    for (const type of REGEX_TYPES) for (const script of getScriptsByType(type, { allowedOnly: false }) || []) if (script?.id) out[script.id] = !script.disabled;
    return out;
}
const worldState = () => [...selected_world_info].sort();

// 연결: 연결 프로필을 쓰면 그 이름, 아니면 공급자 + 모델
function connectionState() {
    const cm = extension_settings.connectionManager;
    const profile = cm?.profiles?.find(p => p.id === cm.selectedProfile)?.name || null;
    return profile ? { profile } : { source: oai_settings.chat_completion_source, model: getChatCompletionModel() };
}
/** 기억한 연결로 → 바뀌었으면 true (같으면 아무것도 안 함) */
async function applyConnection(state) {
    if (!state || JSON.stringify(state) === JSON.stringify(connectionState())) return false;
    if (state.profile) {
        if (!extension_settings.connectionManager?.profiles?.some(p => p.name === state.profile)) {
            toastr.warning(tr`Saved connection profile "${state.profile}" was not found.`, tr`Chat Preset Memory`);
            return false;
        }
        await ctx().executeSlashCommandsWithOptions(`/profile await=true ${JSON.stringify(state.profile)}`);
        return true;
    }
    if (!state.source) return false;
    if (oai_settings.chat_completion_source !== state.source) {
        $('#chat_completion_source').val(state.source).trigger('change');
        await new Promise(r => setTimeout(r, 300));
    }
    if (state.model && getChatCompletionModel() !== state.model) {
        // API 연결 칸이 닫혀 있어도 찾게: 화면에 보이는지 말고 그 공급자 칸(data-source)의 모델 목록에서
        const sel = [...document.querySelectorAll('select[id^="model_"][id$="_select"]')].find(x => String(x.closest('[data-source]')?.dataset.source || '').split(',').includes(state.source) && [...x.options].some(o => o.value === state.model));
        if (sel) $(sel).val(state.model).trigger('change');
        else if (state.source === 'custom') $('#custom_model_id').val(state.model).trigger('input');
        if (getChatCompletionModel() !== state.model) toastr.warning(tr`Saved model "${state.model}" was not found.`, tr`Chat Preset Memory`);
    }
    return true;
}
const connectionLabel = st => st?.profile || [st?.source, st?.model].filter(Boolean).join(' · ');

// 페르소나: 지금 페르소나 + (페르소나마다 버전(AU)을 고르는 확장을 쓰면) 그 페르소나에 고른 버전 이름
const VERSION_KEY = 'st-persona-au-manager';
const versionsOf = avatar => extension_settings[VERSION_KEY]?.personaHistoryByAvatar?.[avatar] || [];
const versionOf = avatar => extension_settings[VERSION_KEY]?.activeVersionByAvatar?.[avatar] || '';
function personaState() {
    if (!user_avatar) return null;
    const au = versionOf(user_avatar);
    return au ? { avatar: user_avatar, au } : { avatar: user_avatar };
}
const personaName = avatar => power_user.personas?.[avatar] || String(avatar || '').replace(/\.[^.]+$/, '');
const personaLabel = st => st?.avatar ? personaName(st.avatar) + (st.au ? ` · ${st.au}` : '') : '';
// 실리태번이 채팅을 열며 띄운 알림 하나를 지움 (곧바로 이 확장이 다시 바꿀 때 — 알림이 틀린 말이 되지 않게)
// 알림이 조금 늦게 뜰 수도 있어서 2초 동안 새로 뜨는 것도 봄
function dropToast(match, ms = 2000) {
    const sweep = () => { for (const el of document.querySelectorAll('#toast-container .toast')) if (match(el)) el.remove(); };
    sweep();
    const mo = new MutationObserver(sweep);
    mo.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => mo.disconnect(), ms);
}
/** 기억한 페르소나 · 버전으로 → 바꾼 것 설명(없으면 '') — 채팅에 잠근 페르소나가 있으면 그걸 따름 */
async function applyPersona(state, stale = () => false) {
    if (!state?.avatar) return '';
    const locked = ctx().chatMetadata?.persona;
    if (locked && locked !== state.avatar) return '';
    if (!power_user.personas?.[state.avatar]) {
        toastr.warning(tr`Saved persona "${personaName(state.avatar)}" was not found.`, tr`Chat Preset Memory`);
        return '';
    }
    const notes = [];
    // 실리태번의 채팅 열기(캐릭터 연결 · 기본 페르소나 고르기)가 끝난 뒤에 바꿈 — 늦게 끝나면 한 번 더 맞춤
    for (let i = 0; i < 2 && user_avatar !== state.avatar; i++) {
        if (stale()) return '';
        await setUserAvatar(state.avatar, { toastPersonaNameChange: false });
        notes.push(1);
        await new Promise(r => setTimeout(r, 400));
    }
    // 실리태번의 「페르소나 자동 선택」 알림 (번역된 제목 · 영어 본문 둘 다 봄)
    if (notes.length) dropToast(el => [coreT`Persona Auto Selected`, '페르소나 자동 선택됨'].includes(el.querySelector('.toast-title')?.textContent?.trim()) || /Auto-selected persona/i.test(el.querySelector('.toast-message')?.textContent || ''));
    // 버전: 그 확장의 빠른 전환 메뉴 항목을 대신 눌러 그 확장이 직접 적용하게(설명 · 아바타 · 저장)
    if (state.au && user_avatar === state.avatar && versionOf(state.avatar) !== state.au && versionsOf(state.avatar).some(v => v.name === state.au)) {
        const trigger = document.getElementById('ps-quick-trigger');
        if (trigger && !trigger.disabled) {
            trigger.click();
            const item = [...document.querySelectorAll('.ps-quick-menu .ps-quick-item')].find(b => b.title === state.au);
            if (item) item.click(); else document.querySelector('.ps-quick-menu') && trigger.click();
        }
        if (versionOf(state.avatar) === state.au) {
            notes.push(2);
            dropToast(el => el.querySelector('.toast-message')?.textContent?.startsWith(`'${state.au}'`));
        }
    }
    if (!notes.length) return '';
    return notes.includes(2) ? `${personaName(state.avatar)} · ${state.au}` : personaName(state.avatar);
}

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
    if (kinds.connection) snap.connection = connectionState();
    if (kinds.persona && auReady()) snap.persona = personaState();
    if (kinds.card && cardReady()) { const st = cardState(); if (st) snap.card = st; }
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
    const out = { ...(prev || {}), ...snap, byPreset, ...extra, at: Date.now() };
    if (out.toggles && togglesFor({ byPreset }, out.preset)) delete out.toggles;   // byPreset 에 이미 있음 (파일을 가볍게)
    return out;
}

// 채팅을 바꾸는 중·맞추는 중·프리셋을 바꾸는 중에는 기억하지 않음 (다른 채팅·다른 프리셋 상태가 섞이지 않게)
let ready = false;
// 기억을 시작한 채팅 — 실리태번이 「지금 채팅」을 먼저 바꾸고 「채팅 바뀜」 신호는 늦게 보내서, 그 틈에 앞 채팅 상태가 새 채팅 기억으로 들어가지 않게
let readyChat = null;
const sameChat = () => ready && readyChat === ctx().getCurrentChatId();
let restoring = false;
let switching = false;

function store(snap, extra = {}) {
    const c = ctx();
    if (!sameChat()) return;
    const prev = memory();
    const next = merged(prev, snap, extra);
    // 프리셋이 바뀌었거나 켬/끔을 바꿨으면 바로 저장(그 사이 채팅을 옮겨도 예전 프리셋으로 돌아가지 않게),
    // 토글만 바뀌었으면 몰아서 저장(채팅 파일 전체를 매번 쓰지 않게)
    const urgent = !prev || nfc(prev.preset) !== nfc(snap.preset) || 'off' in extra || 'kinds' in extra
        || JSON.stringify(prev.world) !== JSON.stringify(snap.world ?? prev.world)
        || JSON.stringify(prev.entries) !== JSON.stringify(snap.entries ?? prev.entries)
        || JSON.stringify(prev.connection) !== JSON.stringify(snap.connection ?? prev.connection)
        || JSON.stringify(prev.persona) !== JSON.stringify(snap.persona ?? prev.persona)
        || JSON.stringify(prev.card) !== JSON.stringify(snap.card ?? prev.card);
    putMemory(c.getCurrentChatId(), next, urgent);
    const key = charKey();
    if (key && settings().charDefault) {
        const before = settings().byChar[key];
        settings().byChar[key] = trimChar(merged(before, snap));
        if (!before) renderChars();
        // 캐릭터별 마지막 설정은 새 채팅을 열 때만 쓰므로, 처음 적을 때와 프리셋이 바뀔 때만 바로 저장.
        // 토글만 바뀌었으면 메모리에 두고 실리태번의 다음 설정 저장에 같이 실림 (토글마다 설정 파일 전체를 한 번 더 쓰던 것)
        if (!before || nfc(before.preset) !== nfc(snap.preset)) c.saveSettingsDebounced();
    }
    renderBar();
}

/** 캐릭터별 마지막 설정은 새 채팅을 열 때만 쓰므로 최근에 쓴 프리셋 3개의 토글만 남김
 *  (예전엔 쓴 적 있는 프리셋 토글을 전부 들고 있어 설정 파일이 캐릭터 하나에 수백 KB까지 커졌음) */
const CHAR_PRESETS = 3;
function trimChar(m) {
    const keys = Object.keys(m?.byPreset || {});
    if (keys.length <= CHAR_PRESETS) return m;
    // 넣은 순서가 쓴 순서(merged 가 지금 프리셋을 맨 뒤에 다시 넣음) — 지금 프리셋은 늘 남김
    const keep = new Set(keys.slice(-CHAR_PRESETS));
    for (const k of keys) if (nfc(k) === nfc(m.preset)) keep.add(k);
    return { ...m, byPreset: Object.fromEntries(keys.filter(k => keep.has(k)).map(k => [k, m.byPreset[k]])) };
}

const sameAsMemory = (mem, snap) => !!mem && nfc(mem.preset) === nfc(snap.preset)
    && (!snap.toggles || JSON.stringify(togglesFor(mem, snap.preset)) === JSON.stringify(snap.toggles))
    && (!snap.world || JSON.stringify(mem.world) === JSON.stringify(snap.world))
    && (!snap.entries || JSON.stringify(mem.entries) === JSON.stringify(snap.entries))
    && (!snap.regex || JSON.stringify(mem.regex) === JSON.stringify(snap.regex))
    && (!snap.connection || JSON.stringify(mem.connection) === JSON.stringify(snap.connection))
    && (!snap.persona || JSON.stringify(mem.persona) === JSON.stringify(snap.persona))
    && (!snap.card || JSON.stringify(mem.card) === JSON.stringify(snap.card));

/** 바꿀 때마다 기억 (이 채팅 기억을 끈 경우는 제외) */
let saveTimer = null;
function remember() {
    if (!sameChat() || restoring || switching || !usable()) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
        if (!sameChat() || restoring || switching || !usable()) return;
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

// 이 확장이 설정을 맞췄을 때 알림은 모두 같은 모양: 머리줄(무엇을 했는지 · 되돌리기) + 바뀐 것 한 줄에 하나씩 [이름 | 값]
// 알림 설정: 끄면 안 띄움(always 는 사용자가 누른 일의 결과라 늘 띄움), 「알림에 보일 것」에서 고른 종류의 줄만 보임 — 안 고른 종류는 줄을 빼고 머리줄만
// 전체 목록은 늘 마우스를 올리면 보임. notes = [[이름, 값, 종류]]
function notice(head, notes, { onUndo, timeOut = 8000, always = false } = {}) {
    if (!settings().notify && !always) return;
    const esc = x => String(x).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
    const show = settings().notifyKinds;
    const shown = notes.filter(([, , kind]) => !kind || show[kind] !== false);
    const rows = shown.map(([k, v]) => `<span class="cpm-tn-k">${esc(k)}</span><span class="cpm-tn-v">${esc(v)}</span>`).join('');
    const undo = onUndo ? `<u>${esc(tr`Undo`)}</u>` : '';
    const t = toastr.info(`<div class="cpm-tn-head"><span>${esc(head)}</span>${undo}</div>${rows ? `<div class="cpm-tn">${rows}</div>` : ''}`, tr`Chat Preset Memory`, {
        escapeHtml: false, timeOut, extendedTimeOut: 4000, ...(onUndo ? { onclick: onUndo } : {}),
    });
    if (notes.length) t?.attr?.('title', notes.map(([k, v]) => `${k}: ${v}`).join('\n'));
}

/** 채팅을 열 때: 마지막 프리셋으로 바꾸고(설정에 따라), 그 프리셋에서 기억한 토글을 맞춤 */
async function restore(mem, label, my) {
    const chatId = ctx().getCurrentChatId();
    // 그 사이 다른 채팅을 열었으면 멈춤 (빠르게 옮길 때 앞 채팅 설정이 늦게 덮지 않게)
    const stale = () => ctx().getCurrentChatId() !== chatId || (my !== undefined && my !== seq);
    // 알림: 바뀐 것을 한 줄에 하나씩 [이름 칸 | 값 칸] — 값이 길면 그 줄 끝에서 … (전체 글은 마우스를 올리면 보임)
    const notes = [];
    const note = (label, value, kind) => notes.push([label, String(value), kind]);
    restoring = true;
    const kinds = kindsOf(mem);
    // 되돌리기용: 바꾸기 전 상태(이 채팅이 맞출 종류만)
    const before = { preset: currentPreset(), toggles: snapshot({ toggles: true }).toggles, world: worldState(), entries: lastEntries, regex: kinds.regex ? regexState() : null, connection: kinds.connection ? connectionState() : null, persona: kinds.persona ? personaState() : null, card: kinds.card ? cardState() : null };
    let regexChanged = 0;
    try {
        // 캐릭터 AU 는 연결보다 먼저 — 연결 프로필을 바꾸면 실리태번이 채팅을 다시 불러오며 캐릭터 편집 칸을 잠깐 비우는데, 그때는 칸을 못 찾아 건너뜀
        const cardDone = kinds.card ? applyCard(mem.card) : [];
        // 연결은 프리셋보다 먼저 — 연결 프로필이 프리셋까지 바꿀 수 있어서, 그 뒤에 프리셋 · 토글을 맞춤
        if (kinds.connection && await applyConnection(mem.connection)) note(tr`Connection`, connectionLabel(mem.connection), 'connection');
        if (stale()) return;
        if (kinds.persona) { const p = await applyPersona(mem.persona, stale); if (p) note(tr`Persona`, p, 'persona'); }
        if (stale()) return;
        for (const [k, v] of cardDone) note(k, v, 'card');
        if (kinds.toggles && settings().restorePreset && mem.preset && nfc(mem.preset) !== nfc(currentPreset())) {
            if (!(await switchPreset(mem.preset))) {
                toastr.warning(tr`Saved preset "${mem.preset}" was not found.`, tr`Chat Preset Memory`);
                return;
            }
            note(tr`Preset`, mem.preset, 'toggles');
        }
        if (stale()) return;
        if (kinds.toggles) {
            const changed = await applyToggles(togglesFor(mem, currentPreset()));
            if (changed) note(tr`Toggles`, tr`${changed} changed`, 'toggles');
        }
        if (stale()) return;
        if (kinds.world) {
            const books = applyWorld(mem.world);
            const entries = await applyEntries(mem.entries);
            if (books || entries) note(tr`World info`, entries ? tr`${entries} entries` : tr`Selection changed`, 'world');
            await refreshEntries();
        }
        if (stale()) return;
        if (kinds.regex) {
            regexChanged = await applyRegex(mem.regex);
            if (regexChanged) note(tr`Regex`, tr`${regexChanged} changed`, 'regex');
        }
    } finally {
        restoring = false;
    }
    if (notes.length) notice(label, notes, { onUndo: () => undoRestore(before, kinds, chatId) });
    // 화면에 그리는 정규식이 바뀌었으면 이 채팅을 한 번 다시 그림 — 기다리지 않음(다시 그리기가 채팅 바뀜을 다시 부르고, 그게 이 맞추기가 끝나길 기다려서 서로 멈춤)
    if (regexChanged && ctx().getCurrentChatId() === chatId) setTimeout(() => { if (ctx().getCurrentChatId() === chatId) ctx().reloadCurrentChat(); }, 0);
}

/** 채팅을 열며 바뀐 것을 그 전으로 — 되돌린 상태를 이 채팅이 기억함 */
async function undoRestore(before, kinds, chatId) {
    if (ctx().getCurrentChatId() !== chatId) return void toastr.warning(tr`You're in another chat now, so this can't be undone.`, tr`Chat Preset Memory`);
    restoring = true;
    let regexChanged = 0;
    try {
        if (kinds.card) applyCard(before.card);   // 연결보다 먼저 (restore 와 같은 까닭)
        if (kinds.connection) await applyConnection(before.connection);
        if (kinds.persona) await applyPersona(before.persona);
        if (kinds.toggles && nfc(before.preset) !== nfc(currentPreset())) await switchPreset(before.preset);
        if (kinds.toggles) await applyToggles(before.toggles);
        if (kinds.world) { applyWorld(before.world); await applyEntries(before.entries); await refreshEntries(); }
        if (kinds.regex) regexChanged = await applyRegex(before.regex);
    } finally {
        restoring = false;
    }
    store(snapshot());
    notice(tr`Back to the settings before opening this chat.`, [], { timeOut: 2500, always: true });
    if (regexChanged) await ctx().reloadCurrentChat();
}

/** 채팅 안에서 사용자가 프리셋을 바꿨을 때: 이 채팅에서 그 프리셋으로 기억한 토글이 있으면 맞추고, 그 상태를 기억 */
async function onPresetChanged() {
    switching = false;
    if (!sameChat() || restoring || !usable()) return;
    const mem = memory();
    if (mem && !mem.off && kindsOf(mem).toggles) {
        restoring = true;
        try {
            const changed = await applyToggles(togglesFor(mem, currentPreset()));
            if (changed) notice(tr`Restored this chat's toggles for this preset`, [[tr`Toggles`, tr`${changed} changed`, 'toggles']], { timeOut: 4000 });
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
let running = Promise.resolve();
async function onChatChanged() {
    const my = ++seq;
    ready = false; readyChat = null;
    clearTimeout(saveTimer);
    renderBar();
    await new Promise(r => setTimeout(r, 500));
    if (my !== seq) return;
    await loadOwner(charKey());
    // 예전 방식의 예약(설정 파일 pending)이 남아 있으면 저장소로 옮김 — 채팅 파일은 건드리지 않음
    const chatId = ctx().getCurrentChatId(), pend = chatId && settings().pending[chatId];
    if (pend) { putMemory(chatId, { ...structuredClone(pend), at: Date.now() }); delete settings().pending[chatId]; ctx().saveSettingsDebounced(); }
    // 예전에 채팅 파일에 넣어 둔 기억은 저장소로 옮겨 씀(읽기만)
    else if (chatId && !STORE.chats[chatId]) {
        // 분기(Branch)는 원래 채팅(main_chat)의 지금 기억을 물려받고, 그게 없으면 채팅 파일에 남은 예전 기억을 옮김
        const parent = ctx().chatMetadata?.main_chat && STORE.chats[ctx().chatMetadata.main_chat];
        const old = parent || ctx().chatMetadata?.[MODULE];
        if (old) putMemory(chatId, compact({ ...structuredClone(old), at: Date.now() }), false);
    }
    // 로어북 파일 읽기는 월드인포를 기억하는 채팅에서만 (채팅을 열 때 일을 줄임)
    lastEntries = null;
    if (kindsOf().world) await refreshEntries();
    // 앞 채팅의 맞추기가 아직 돌고 있으면 끝날 때까지 기다린 뒤 이 채팅 것을 맞춤
    await running;
    if (my !== seq) return;
    const job = (async () => {
        if (!usable()) return;
        const mem = memory();
        const fallback = settings().charDefault ? settings().byChar[charKey()] : null;
        if (mem && !mem.off) await restore(mem, tr`Restored this chat's settings`, my);
        else if (!mem && fallback) await restore(fallback, tr`Started from this character's last settings`, my);
    })().catch(err => console.warn(LOG, err));
    running = job;
    await job;
    await new Promise(r => setTimeout(r, 800));
    if (my !== seq) return;
    ready = true; readyChat = ctx().getCurrentChatId();
    remember(); // a chat without memory starts remembering from now
    renderBar();
}

// ---------------- Status bar above the prompt list ----------------

/**
 * 꾸민 고르기 칸: 단추(지금 값 ⌄)를 누르면 아래(자리가 모자라면 위)로 목록이 펼쳐짐 — 기본 select 대신.
 * items: [{ v, label, sub?, sep? }] (sep: 그 줄 위에 가는 선), value: 지금 v, onPick(v)
 */
let openPick = null;   // 지금 펼친 고르기 칸의 닫기 — 한 번에 하나만 펼침
function makePick({ items, value, onPick, empty = '—' }) {
    const wrap = document.createElement('div');
    wrap.className = 'cpm-pick';
    const cur = items.find(x => x.v === value);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'cpm-pick-btn';
    btn.setAttribute('aria-haspopup', 'listbox');
    btn.setAttribute('aria-expanded', 'false');
    btn.innerHTML = '<span class="cpm-pick-val"></span><span class="cpm-pick-sub"></span><i class="fa-solid fa-chevron-down cpm-pick-arrow" aria-hidden="true"></i>';
    btn.querySelector('.cpm-pick-val').textContent = cur?.label ?? empty;
    btn.querySelector('.cpm-pick-sub').textContent = cur?.sub ?? '';
    btn.title = cur?.label ?? '';
    const pop = document.createElement('div');
    pop.className = 'cpm-pick-pop';
    pop.hidden = true;
    const list = document.createElement('div');
    list.className = 'cpm-pick-list';
    list.setAttribute('role', 'listbox');
    if (items.length > 8) {
        const q = document.createElement('input');
        q.type = 'search';
        q.className = 'text_pole cpm-pick-search';
        q.placeholder = tr`Search`;
        q.addEventListener('input', () => { const t = q.value.trim().toLowerCase(); opts.forEach(o => { o.hidden = !!t && !o.textContent.toLowerCase().includes(t); }); move(0, true); });
        pop.append(q);
    }
    const opts = items.map(x => {
        const o = document.createElement('div');
        o.className = 'cpm-pick-opt' + (x.sep ? ' cpm-pick-sep' : '');
        o.setAttribute('role', 'option');
        o.setAttribute('aria-selected', String(x.v === value));
        o.innerHTML = '<i class="fa-solid fa-check cpm-pick-check" aria-hidden="true"></i><span class="cpm-pick-label"></span><span class="cpm-pick-sub"></span>';
        o.querySelector('.cpm-pick-label').textContent = x.label;
        o.querySelector('.cpm-pick-sub').textContent = x.sub ?? '';
        o.title = x.label;
        o.addEventListener('click', () => choose(x));
        o.addEventListener('pointermove', () => setActive(o));
        return o;
    });
    list.append(...opts);
    pop.append(list);
    wrap.append(btn, pop);

    let active = null;
    const setActive = o => { active?.classList.remove('cpm-active'); active = o; o?.classList.add('cpm-active'); };
    const shown = () => opts.filter(o => !o.hidden);
    const move = (d, reset) => {
        const s = shown();
        if (!s.length) return setActive(null);
        let i = reset ? 0 : s.indexOf(active) + d;
        i = Math.max(0, Math.min(s.length - 1, i));
        setActive(s[i]);
        s[i].scrollIntoView({ block: 'nearest' });
    };
    const outside = ev => { if (!wrap.contains(ev.target)) close(); };
    function open() {
        if (!pop.hidden) return;
        openPick?.();
        openPick = close;
        pop.hidden = false;
        wrap.classList.add('cpm-open');
        btn.setAttribute('aria-expanded', 'true');
        // 창(스크롤 칸) 안에서 아래 자리가 모자라면 위로 펼침
        const pane = wrap.closest('.popup-content') || document.documentElement;
        const r = btn.getBoundingClientRect(), pr = pane.getBoundingClientRect();
        const below = pr.bottom - r.bottom - 12, above = r.top - pr.top - 12;
        const up = below < 200 && above > below;
        wrap.classList.toggle('cpm-up', up);
        list.style.maxHeight = `${Math.max(120, Math.min(300, (up ? above : below) - (pop.querySelector('.cpm-pick-search') ? 52 : 12)))}px`;
        const sel = opts.find(o => o.getAttribute('aria-selected') === 'true');
        setActive(sel || shown()[0]);
        sel?.scrollIntoView({ block: 'nearest' });
        (pop.querySelector('.cpm-pick-search') || list).focus({ preventScroll: true });
        document.addEventListener('pointerdown', outside, true);
    }
    function close(focus) {
        if (pop.hidden) return;
        if (openPick === close) openPick = null;
        pop.hidden = true;
        wrap.classList.remove('cpm-open', 'cpm-up');
        btn.setAttribute('aria-expanded', 'false');
        document.removeEventListener('pointerdown', outside, true);
        if (focus) btn.focus();
    }
    function choose(x) {
        close(true);
        if (x.v !== value) onPick(x.v);
    }
    list.tabIndex = -1;
    btn.addEventListener('click', () => (pop.hidden ? open() : close()));
    btn.addEventListener('keydown', ev => { if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') { ev.preventDefault(); open(); } });
    pop.addEventListener('keydown', ev => {
        // Esc 는 목록만 닫음 (ⓘ 창 자체가 취소되지 않게)
        if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); close(true); }
        else if (ev.key === 'ArrowDown') { ev.preventDefault(); move(1); }
        else if (ev.key === 'ArrowUp') { ev.preventDefault(); move(-1); }
        else if (ev.key === 'Enter') { ev.preventDefault(); ev.stopPropagation(); const i = opts.indexOf(active); if (i >= 0) choose(items[i]); }
        else if (ev.key === 'Tab') close();
    });
    return wrap;
}

// ⓘ 창: 이 채팅이 기억하는 것을 보고 바로 고침 — 여기서 바꾸면 지금 설정이 바뀌고 기억도 따라감 (따로 저장 단추 없음)
async function showMemory() {
    const mem = memory();
    const e = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
    let kinds = kindsOf(mem);
    const root = document.createElement('div');
    root.className = 'cpm-info cpm-edit';
    let regexChanged = false;
    const addedAlts = [];   // 이 창에서 카드에 새로 남긴 판 [{ key, item }] — 「취소」하면 지움
    const closed = new AbortController();   // 창이 닫히면 문서에 붙인 이벤트도 뗌
    // 「취소」용: 창을 열 때의 실제 설정과 이 채팅의 기억
    const openChat = ctx().getCurrentChatId();
    const openMem = openChat && STORE.chats[openChat] ? structuredClone(STORE.chats[openChat]) : undefined;
    let openEntries = null;
    try { openEntries = await readEntries(); } catch (err) { console.warn(LOG, 'world info', err); }
    const before = { preset: currentPreset(), toggles: snapshot({ toggles: true }).toggles, world: worldState(), entries: openEntries, regex: regexState(), connection: connectionState(), card: cardState() };
    root.innerHTML = `
        <h3>${e(tr`What this chat remembers`)}</h3>
        <p class="cpm-edit-sub">${e(tr`Changes apply right away. Cancel puts everything back as it was when you opened this.`)}</p>
        <div class="cpm-edit-top">
            <label class="cpm-switch"><input type="checkbox" role="switch" class="cpm-edit-on" ${mem?.off ? '' : 'checked'}><span class="cpm-track" aria-hidden="true"></span><span>${e(tr`Remember this chat`)}</span></label>
            <span class="cpm-kinds" role="group" aria-label="${e(tr`What to remember`)}">${kindPills(kinds, e)}</span>
        </div>
        <div class="cpm-sec" data-sec="toggles"></div>
        <div class="cpm-sec" data-sec="connection"></div>
        <div class="cpm-sec" data-sec="regex"></div>
        <div class="cpm-sec" data-sec="world"></div>
        <div class="cpm-sec" data-sec="persona"></div>
        <div class="cpm-sec" data-sec="card"></div>
        <div class="cpm-sec cpm-copy" data-sec="copy"></div>`;
    const sec = k => root.querySelector(`[data-sec="${k}"]`);
    // 칸을 다시 그려도 펼친 줄 · 목록 스크롤 · 창 스크롤은 그대로
    const keep = async (k, paint) => {
        const box = sec(k);
        const titleOf = d => d.querySelector(':scope > summary .cpm-g-title')?.textContent;
        const was = new Map([...box.querySelectorAll('details.cpm-group')].map(d => [titleOf(d), { open: d.open, top: d.querySelector('.cpm-checks')?.scrollTop ?? 0 }]));
        const pane = root.closest('.popup-content');
        const top = pane?.scrollTop;
        await paint();
        box.querySelectorAll('details.cpm-group').forEach(d => {
            const w = was.get(titleOf(d));
            if (!w) return;
            if (w.open) d.open = true;
            const ul = d.querySelector('.cpm-checks');
            if (ul) ul.scrollTop = w.top;
        });
        if (pane && top != null) pane.scrollTop = top;
    };
    const search = (box, rows) => {
        const inp = box.querySelector('.cpm-search');
        inp?.addEventListener('input', () => { const q = inp.value.trim().toLowerCase(); rows().forEach(li => { li.hidden = !!q && !li.textContent.toLowerCase().includes(q); }); });
    };
    // 칸마다 같은 꼴: 접는 줄(제목 — 개수) 안에 검색 + 체크 목록
    const group = (title, count, list, attrs = '') => `<details class="cpm-group"><summary><span class="cpm-g-title">${e(title)}</span><span class="cpm-count">${e(count)}</span></summary><input type="search" class="text_pole cpm-search" placeholder="${e(tr`Search`)}"><ul class="cpm-checks" ${attrs}>${list}</ul></details>`;
    const row = (key, name, on, extra = '') => `<li><label><input type="checkbox" data-k="${e(key)}" ${on ? 'checked' : ''}><span>${e(name)}</span>${extra}</label></li>`;

    // 프롬프트: 지금 프리셋 토글 켜고 끄기 + 다른 프리셋에 기억한 것 지우기
    const paintToggles = () => {
        const box = sec('toggles');
        box.hidden = !kinds.toggles;
        if (!kinds.toggles) { box.innerHTML = ''; return; }
        const order = promptManager.getPromptOrderForCharacter(promptManager.activeCharacter) || [];
        const nameOf = id => promptManager.getPromptById(id)?.name || id;
        const others = Object.entries(memory()?.byPreset || {}).filter(([p]) => nfc(p) !== nfc(currentPreset()));
        box.innerHTML = `
            <h4>${e(tr`Prompts`)}</h4>
            ${group(currentPreset(), tr`${order.filter(x => x.enabled).length} on`, order.filter(x => promptManager.getPromptById(x.identifier)).map(x => row(x.identifier, nameOf(x.identifier), x.enabled)).join(''), 'data-kind="toggles"')}
            ${others.length ? `<details class="cpm-group"><summary><span class="cpm-g-title">${e(tr`Other presets`)}</span><span class="cpm-count">${e(String(others.length))}</span></summary><ul class="cpm-others">${others.map(([p, t]) => `<li><span>${e(p)} — ${e(tr`${Object.values(t || {}).filter(Boolean).length} on`)}</span><button type="button" class="menu_button cpm-forget" data-p="${e(p)}">${e(tr`Forget`)}</button></li>`).join('')}</ul></details>` : ''}`;
        box.querySelectorAll('.cpm-checks input').forEach(cb => cb.addEventListener('change', () => {
            const entry = order.find(x => x.identifier === cb.dataset.k);
            if (!entry) return;
            entry.enabled = cb.checked;
            promptManager.render();
            Promise.resolve(promptManager.saveServiceSettings()).catch(err => console.warn(LOG, err));
            remember();
            cb.closest('details').querySelector('.cpm-count').textContent = tr`${order.filter(x => x.enabled).length} on`;
        }));
        // 지우기는 그 줄만 뺌 (다시 그리면 펼친 칸이 접히고 스크롤이 튐)
        box.querySelectorAll('.cpm-forget').forEach(btn => btn.addEventListener('click', () => {
            const m = memory(); if (!m?.byPreset) return;
            delete m.byPreset[btn.dataset.p];
            putMemory(ctx().getCurrentChatId(), m);
            const details = btn.closest('details');
            btn.closest('li').remove();
            const left = details.querySelectorAll('.cpm-others li').length;
            if (left) details.querySelector('.cpm-count').textContent = String(left);
            else details.remove();
        }));
        box.querySelectorAll('details').forEach(d => search(d, () => d.querySelectorAll('.cpm-checks li')));
    };

    // 월드인포: 전역 선택 + 이 채팅에 걸린 로어북 항목
    const paintWorld = async () => {
        const box = sec('world');
        box.hidden = !kinds.world;
        if (!kinds.world) { box.innerHTML = ''; return; }
        const selected = new Set(worldState());
        const books = activeBooks();
        const parts = [];
        for (const book of books) {
            let data = null;
            try { data = await ctx().loadWorldInfo(book); } catch { /* 없어진 로어북 */ }
            const entries = Object.entries(data?.entries || {});
            const on = entries.filter(([, x]) => !x.disable).length;
            parts.push(group(book, tr`${on} on, ${entries.length - on} off`, entries.map(([uid, x]) => row(uid, x.comment || (Array.isArray(x.key) ? x.key.slice(0, 3).join(', ') : '') || `#${uid}`, !x.disable)).join(''), `data-book="${e(book)}"`));
        }
        box.innerHTML = `
            <h4>${e(tr`World info`)}</h4>
            ${group(tr`Global world info`, selected.size ? [...selected].join(', ') : tr`none`, (world_names || []).map(n => row(n, n, selected.has(n))).join(''), 'data-global="1"')}
            ${parts.join('') || `<p class="cpm-edit-sub">${e(tr`No lorebook is attached to this chat.`)}</p>`}`;
        box.querySelectorAll('ul[data-global] input').forEach(cb => cb.addEventListener('change', () => {
            const want = [...box.querySelectorAll('ul[data-global] input:checked')].map(x => x.dataset.k);
            applyWorld(want);
            refreshEntries().then(() => { remember(); keep('world', paintWorld); });
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
            cb.closest('details').querySelector('.cpm-count').textContent = tr`${n} on, ${all.length - n} off`;
        }));
        box.querySelectorAll('details').forEach(d => search(d, () => d.querySelectorAll('.cpm-checks li')));
    };

    // 정규식: 전역 · 프리셋 정규식 켜고 끄기
    const paintRegex = () => {
        const box = sec('regex');
        box.hidden = !kinds.regex;
        if (!kinds.regex) { box.innerHTML = ''; return; }
        const groups = [[SCRIPT_TYPES.GLOBAL, tr`Global regex`], [SCRIPT_TYPES.PRESET, tr`Preset regex`]].map(([type, label]) => [type, label, getScriptsByType(type, { allowedOnly: false }) || []]);
        box.innerHTML = `<h4>${e(tr`Regex`)}</h4>` + groups.filter(g => g[2].length).map(([type, label, list]) => group(label, tr`${list.filter(x => !x.disabled).length} on, ${list.filter(x => x.disabled).length} off`, list.map(x => row(x.id, x.scriptName || x.id, !x.disabled)).join(''), `data-type="${type}"`)).join('');
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
            cb.closest('details').querySelector('.cpm-count').textContent = tr`${on} on, ${list.length - on} off`;
        }));
        box.querySelectorAll('details').forEach(d => search(d, () => d.querySelectorAll('.cpm-checks li')));
    };

    // 연결: 지금 연결과 이 채팅이 기억한 연결 (바꾸는 건 실리태번 연결 화면에서 — 바꾸면 따라 기억)
    const paintConnection = () => {
        const box = sec('connection');
        box.hidden = !kinds.connection;
        if (!kinds.connection) { box.innerHTML = ''; return; }
        const now = connectionState(), saved = memory()?.connection;
        const profiles = extension_settings.connectionManager?.profiles || [];
        const differs = saved && JSON.stringify(saved) !== JSON.stringify(now);
        box.innerHTML = `<h4>${e(tr`Connection`)}</h4>
            <dl class="cpm-conn cpm-picks"><dt>${e(tr`Now`)}</dt><dd class="cpm-conn-now"></dd>${!saved || differs ? `<dt>${e(tr`Remembered`)}</dt><dd>${e(connectionLabel(saved) || tr`Not remembered yet`)}</dd>` : ''}</dl>
            <p class="cpm-edit-sub">${e(profiles.length ? tr`Pick a profile to switch right away; this chat remembers it. To change only the model, use SillyTavern's API panel.` : tr`Change the connection profile or model in SillyTavern's API panel; this chat follows it.`)}</p>`;
        const dd = box.querySelector('.cpm-conn-now');
        if (!profiles.length) { dd.textContent = connectionLabel(now) || '—'; return; }
        const items = profiles.map(p => ({ v: p.name, label: p.name }));
        if (!now.profile) items.unshift({ v: '', label: tr`No profile`, sub: connectionLabel(now) });
        dd.append(makePick({ items, value: now.profile || '', onPick: async name => {
            if (!name) return;
            await applyConnection({ profile: name });
            remember();
            paintConnection();
        } }));
    };

    // 페르소나: 지금 페르소나와 이 채팅이 기억한 페르소나 (바꾸는 건 실리태번 페르소나 화면에서 — 바꾸면 따라 기억)
    const paintPersona = () => {
        const box = sec('persona');
        box.hidden = !kinds.persona;
        if (!kinds.persona) { box.innerHTML = ''; return; }
        const now = personaState(), saved = memory()?.persona, locked = ctx().chatMetadata?.persona;
        box.innerHTML = `<h4>${e(tr`Persona`)}</h4>
            <dl class="cpm-conn"><dt>${e(tr`Now`)}</dt><dd>${e(personaLabel(now) || '—')}</dd><dt>${e(tr`Remembered`)}</dt><dd>${e(personaLabel(saved) || tr`Not remembered yet`)}</dd></dl>
            <p class="cpm-edit-sub">${e(locked ? tr`A persona is locked to this chat (${personaName(locked)}), so the lock wins.` : tr`Change the persona in SillyTavern's persona panel; this chat follows it.`)}</p>`;
    };

    // 캐릭터 AU: 저장판이 있는 칸마다 지금 판을 고름 — 고르면 카드 칸에 바로 넣고 이 채팅이 따라 기억
    const paintCard = () => {
        const box = sec('card');
        box.hidden = !kinds.card;
        if (!kinds.card) { box.innerHTML = ''; return; }
        const fields = cardFields();
        const unsaved = fields.some(f => { const t = document.getElementById(f.area).value; return t.trim() && !f.list.some(x => same(x.content, t)); });
        box.innerHTML = `<h4>${e(tr`Character AU`)}</h4><dl class="cpm-conn cpm-picks cpm-card">${fields.map(f => `<dt>${e(f.label())}</dt><dd data-k="${e(f.key)}"></dd>`).join('')}</dl>
            ${unsaved ? `<p class="cpm-edit-sub">${e(tr`Text that isn't a saved version is kept as a new version before you switch, so you can pick it again.`)}</p>` : ''}`;
        const n = s => tr`${s.replace(/\r/g, '').trim().length.toLocaleString()} chars`;
        for (const f of fields) {
            const text = document.getElementById(f.area).value;
            const curI = f.list.findIndex(x => same(x.content, text));
            const items = f.list.map((x, i) => ({ v: String(i), label: x.title || '—', sub: n(x.content) }));
            if (curI < 0 && text.trim()) items.push({ v: 'now', label: f.list.some(x => x.title === tr`Original text`) ? tr`Edited text` : tr`Original text`, sub: tr`not saved yet`, sep: true });
            if (f.key !== 'alt_descriptions' || !text.trim()) items.push({ v: 'empty', label: tr`Empty`, sep: !items.at(-1)?.sep });
            const value = curI >= 0 ? String(curI) : text.trim() ? 'now' : 'empty';
            box.querySelector(`dd[data-k="${f.key}"]`).append(makePick({ items, value, onPick: async v => {
                const live = cardFields().find(x => x.key === f.key);
                if (!live) return;
                const kept = await keepUnsaved(live);
                if (kept >= 0) { const it = cardFields().find(x => x.key === f.key).list[kept]; addedAlts.push({ key: f.key, item: { title: it.title, content: it.content } }); }
                // 창을 열 때의 글이 지금 남긴 판이면 「취소」가 그 판으로 돌아가게
                if (kept >= 0 && !before.card?.[f.key]) (before.card ||= {})[f.key] = { t: cardFields().find(x => x.key === f.key).list[kept].title, i: kept };
                const item = v === 'empty' ? { content: '' } : cardFields().find(x => x.key === f.key)?.list[Number(v)];
                if (!item) return;
                setCardText(f, item.content);
                remember();
                paintCard();
            } }));
        }
    };

    // 다른 채팅에 적용: 고른 채팅을 열 때 이 기억으로 바뀜 (지금 그 채팅 파일을 열거나 다시 쓰지 않음)
    const paintCopy = (open = false) => {
        const box = sec('copy');
        const on = !memory()?.off && !!memory();
        box.innerHTML = `<details class="cpm-group"${open ? ' open' : ''}><summary><span class="cpm-g-title">${e(tr`Apply to other chats`)}</span><span class="cpm-count"></span></summary>
            <p class="cpm-edit-sub">${e(tr`The chats you pick switch to this chat's settings the next time you open them.`)}</p>
            <div class="cpm-copy-body"><p class="cpm-edit-sub">${e(on ? tr`Loading…` : tr`Turn on remembering for this chat first.`)}</p></div></details>`;
        if (!on) return;
        // 이 캐릭터의 다른 채팅 목록은 한 번만 받아서 오른쪽 숫자와 펼친 목록에 같이 씀
        const chats = otherChats().catch(err => { console.warn(LOG, err); return []; });
        // 오른쪽 숫자: 이 캐릭터의 다른 채팅 중 지금 이 채팅과 같은 설정을 기억하는 채팅 수 (= 적용된 채팅)
        chats.then(ids => {
            const n = ids.filter(id => sameMemory(STORE.chats[id], memory())).length;
            const c = box.querySelector('.cpm-count');
            if (c) c.textContent = n ? tr`${n} applied` : tr`None applied`;
        });
        const details = box.querySelector('details');
        let shown = false;
        const show = async () => {
            if (shown || !details.open) return;
            shown = true;
            const body = box.querySelector('.cpm-copy-body');
            const ids = await chats;
            if (!ids.length) { body.innerHTML = `<p class="cpm-edit-sub">${e(tr`No other chats for this character.`)}</p>`; return; }
            const touch = matchMedia('(pointer: coarse)').matches;
            body.innerHTML = `<input type="search" class="text_pole cpm-search" placeholder="${e(tr`Search`)}">
                <p class="cpm-edit-sub cpm-pick-hint">${e(touch ? tr`Pick many: long-press, then drag` : tr`Pick many: drag · Shift+click for a range`)}</p>
                <ul class="cpm-checks cpm-chats">${ids.map(id => row(id, id, false, sameMemory(STORE.chats[id], memory()) ? `<small class="cpm-pend">${e(tr`applied`)}</small>` : STORE.chats[id] ? `<small class="cpm-pend">${e(tr`has settings`)}</small>` : '')).join('')}</ul>
                <div class="cpm-copy-bar"><label class="cpm-all"><input type="checkbox"><span>${e(tr`All`)}</span></label><button type="button" class="menu_button cpm-apply" disabled>${e(tr`Apply`)}</button></div>`;
            const boxes = () => [...body.querySelectorAll('.cpm-chats input')];
            const btn = body.querySelector('.cpm-apply');
            const sync = () => { const n = boxes().filter(x => x.checked).length; btn.disabled = !n; btn.textContent = n ? tr`Apply to ${n}` : tr`Apply`; };
            body.querySelector('.cpm-all input').addEventListener('change', x => { boxes().filter(b => !b.closest('li').hidden).forEach(b => { b.checked = x.target.checked; }); sync(); });
            boxes().forEach(b => b.addEventListener('change', sync));
            // 여러 개 고르기: 마우스는 누른 채 끌기 · Shift+클릭 범위, 터치는 길게 누른 뒤 끌기 (짧게 누르면 하나)
            const ul = body.querySelector('.cpm-chats'), lis = () => [...ul.querySelectorAll('li')];
            let last = null, paint = null, press = null;
            const setLi = (li, on) => { const b = li.querySelector('input'); if (b && !li.hidden) b.checked = on; };
            ul.addEventListener('click', ev => ev.preventDefault());
            ul.addEventListener('pointerdown', ev => {
                const li = ev.target.closest('li'); if (!li || ev.button !== 0) return;
                const idx = lis().indexOf(li), on = !li.querySelector('input').checked;
                if (ev.pointerType !== 'mouse') {
                    press = { li, idx, x: ev.clientX, y: ev.clientY, long: false };
                    press.t = setTimeout(() => { if (!press) return; press.long = true; paint = on; setLi(li, on); last = idx; sync(); navigator.vibrate?.(12); }, 450);
                    return;
                }
                ev.preventDefault();
                if (ev.shiftKey && last != null) { const [a, z] = [Math.min(last, idx), Math.max(last, idx)]; lis().slice(a, z + 1).forEach(x => setLi(x, on)); }
                else { setLi(li, on); paint = on; }
                last = idx; sync();
            });
            ul.addEventListener('pointerover', ev => { if (paint === null || press) return; const li = ev.target.closest('li'); if (li) { setLi(li, paint); sync(); } });
            ul.addEventListener('pointermove', ev => { if (press && !press.long && Math.hypot(ev.clientX - press.x, ev.clientY - press.y) > 8) { clearTimeout(press.t); press = null; } });
            ul.addEventListener('touchmove', ev => {
                if (!press?.long) return;
                ev.preventDefault();
                const t = ev.touches[0], li = document.elementFromPoint(t.clientX, t.clientY)?.closest?.('li');
                if (li && ul.contains(li)) { setLi(li, paint); sync(); }
            }, { passive: false });
            ul.addEventListener('pointerup', () => { if (press && !press.long) { clearTimeout(press.t); setLi(press.li, !press.li.querySelector('input').checked); last = press.idx; sync(); press = null; } });
            ul.addEventListener('touchend', () => { if (press?.long) { press = null; paint = null; } });
            ul.addEventListener('contextmenu', ev => { if (ev.target.closest('li')) ev.preventDefault(); });
            const stop = () => { paint = null; };
            document.addEventListener('pointerup', stop, { signal: closed.signal });
            search(body, () => body.querySelectorAll('.cpm-chats li'));
            btn.addEventListener('click', () => {
                const mem = memory(); if (!mem) return;
                const copy = structuredClone(mem); delete copy.at; delete copy.off;
                const picked = boxes().filter(x => x.checked).map(x => x.dataset.k);
                picked.forEach(id => putMemory(id, { ...structuredClone(copy), at: Date.now() }, true, charKey()));   // 이 캐릭터 기억 파일만 씀 — 고른 채팅 파일은 열지도 쓰지도 않음
                toastr.success(tr`Applied to ${picked.length} chats. They switch to these settings when opened.`, tr`Chat Preset Memory`);
                paintCopy(true);
            });
        };
        details.addEventListener('toggle', show);
        show();
    };

    // 위 스위치 · 알약: 막대와 같음 — 켜면 그 칸이 바로 나타남
    const paintTop = () => {
        const on = !memory()?.off;
        root.querySelector('.cpm-edit-on').checked = on;
        root.querySelectorAll('.cpm-edit-top .cpm-kind').forEach(b => { b.setAttribute('aria-pressed', String(!!kinds[b.dataset.kind])); b.disabled = !on; });
        root.querySelectorAll('.cpm-sec').forEach(x => x.classList.toggle('cpm-dim', !on));
    };
    root.querySelector('.cpm-edit-on').addEventListener('change', ev => { store(snapshot(), { off: !ev.target.checked }); paintTop(); keep('copy', () => paintCopy()); });
    root.querySelectorAll('.cpm-edit-top .cpm-kind').forEach(btn => btn.addEventListener('click', async () => {
        const next = { ...rawKinds(), [btn.dataset.kind]: btn.getAttribute('aria-pressed') !== 'true' };
        if (!kindList().some(k => next[k])) return void toastr.info(tr`Pick at least one, or turn the switch off.`, tr`Chat Preset Memory`);
        if (next.world) await refreshEntries();
        store(snapshot(next), { kinds: next });
        kinds = kindsOf();
        paintTop();
        await keep('toggles', paintToggles); await keep('regex', paintRegex); await keep('connection', paintConnection); await keep('persona', paintPersona); await keep('card', paintCard); await keep('world', paintWorld); await keep('copy', () => paintCopy());
    }));
    paintTop(); paintToggles(); paintRegex(); paintConnection(); paintPersona(); paintCard(); paintCopy(); await paintWorld();
    const result = await ctx().callGenericPopup(root, ctx().POPUP_TYPE.CONFIRM, '', { wide: true, allowVerticalScrolling: true, okButton: tr`OK`, cancelButton: tr`Cancel` });
    if (result !== ctx().POPUP_RESULT.AFFIRMATIVE && ctx().getCurrentChatId() === openChat) {
        // 취소 (Esc 포함): 창에서 바꾼 실제 설정과 이 채팅의 기억을 연 때로 되돌림 — 「다른 채팅에 적용」은 이미 적용한 것으로 둠
        restoring = true;
        try {
            if (nfc(before.preset) === nfc(currentPreset())) await applyToggles(before.toggles);
            applyWorld(before.world);
            if (before.entries) { await applyEntries(before.entries); await refreshEntries(); }
            if (await applyRegex(before.regex)) regexChanged = true;
            applyCard(before.card);
            // 이 창에서 남긴 판도 지움 (글은 위에서 그 판의 글로 이미 되돌림)
            const ch = cardChar(), alts = ch?.data?.extensions?.alternate_fields;
            if (alts && addedAlts.length) {
                for (const { key, item } of addedAlts) if (Array.isArray(alts[key])) { const at = alts[key].findLastIndex(x => x.title === item.title && x.content === item.content); if (at >= 0) alts[key].splice(at, 1); }   // 저장하면 캐릭터 목록이 새 객체로 바뀌어서 이름 · 글로 찾음
                await ctx().writeExtensionField(ctx().characterId, 'alternate_fields', alts);
            }
            // 연결은 카드 다음에 (연결을 바꾸면 채팅을 다시 불러오며 캐릭터 편집 칸을 잠깐 비움)
            if (kinds.connection) await applyConnection(before.connection);
        } finally {
            restoring = false;
        }
        // 기억이 실제로 바뀌었을 때만 되돌려 저장 (아무것도 안 바꾸고 취소하면 파일을 쓰지 않음)
        if (JSON.stringify(STORE.chats[openChat]) !== JSON.stringify(openMem)) putMemory(openChat, openMem);
    }
    closed.abort();
    if (regexChanged) await ctx().reloadCurrentChat();   // 바뀐 정규식으로 채팅을 다시 그림
    renderBar();
}

const KIND_LABEL = { toggles: () => tr`Preset · toggles`, world: () => tr`World info`, regex: () => tr`Regex`, connection: () => tr`Connection`, persona: () => tr`Persona`, card: () => tr`Character AU` };

/** 이 캐릭터(그룹)의 다른 채팅 id — 이름만 받음(내용은 안 읽음) */
// 두 기억이 같은 설정인지 (기억한 시각 · 끔 표시는 빼고 비교)
function sameMemory(a, b) {
    if (!a || !b) return false;
    const norm = v => Array.isArray(v) ? v.map(norm) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).filter(k => k !== 'at' && k !== 'off').sort().map(k => [k, norm(v[k])])) : v;
    return JSON.stringify(norm(a)) === JSON.stringify(norm(b));
}
async function otherChats() {
    const c = ctx(), here = c.getCurrentChatId();
    if (c.groupId) return (c.groups?.find(g => g.id === c.groupId)?.chats || []).filter(id => id !== here);
    const avatar = c.characters?.[c.characterId]?.avatar;
    if (!avatar) return [];
    return (await chatsOf(avatar)).filter(id => id !== here).sort().reverse();
}
/** 막대 자리: top = 목록 바로 위 · head = 「프롬프트」 제목 줄 안 · under = 제목 줄 바로 아래 · bottom = 목록 맨 밑 */
const BAR_SPOTS = ['top', 'head', 'under', 'bottom'];
const barSpot = () => BAR_SPOTS.includes(settings().barPos) ? settings().barPos : 'top';
/** 목록 위 도구 줄(.pf-toolbar)이 우리와 같은 자리에 있으면 그 줄 — 그때만 한 줄로 합침 */
function sharedToolbar(host) {
    const toolbar = host?.querySelector('.pf-toolbar');
    if (!toolbar) return null;
    const prev = toolbar.previousElementSibling;
    const at = toolbar.closest('.completion_prompt_manager_header') ? 'head'
        : prev?.classList.contains('completion_prompt_manager_header') ? 'under'
            : prev?.id === 'completion_prompt_manager_list' ? 'bottom' : 'top';
    return at === barSpot() ? toolbar : null;
}
function placeOwnBar(host, list, bar) {
    const wrap = list.parentElement;
    const head = wrap?.querySelector(':scope > .completion_prompt_manager_header');
    const spot = barSpot();
    bar.classList.toggle('cpm-at-head', spot === 'head' && !!head);
    if (spot === 'head' && head) (head.firstElementChild || head).after(bar);
    else if (spot === 'under' && head) {
        // 그 자리에 다른 확장 줄이 먼저 있으면 그 아래로
        let at = head;
        while (at.nextElementSibling && at.nextElementSibling !== bar && !at.nextElementSibling.classList.contains('completion_prompt_manager_footer') && at.nextElementSibling.id !== 'completion_prompt_manager_list') at = at.nextElementSibling;
        at.after(bar);
    }
    else if (spot === 'bottom') list.after(bar);
    else list.before(bar);
}
function renderBar() {
    const list = document.getElementById('completion_prompt_manager_list');
    const host = document.getElementById('completion_prompt_manager');
    document.querySelectorAll('.cpm-bar').forEach(el => el.remove());
    const here = document.getElementById('cpm_here');
    if (here) here.innerHTML = ctx().mainApi !== 'openai' ? `<small class="cpm-help">${tr`This extension works only when you connect with a Chat Completion API.`}</small>`
        : ctx().getCurrentChatId() ? '' : `<small class="cpm-help">${tr`Open a chat to see and edit what it remembers here.`}</small>`;
    if (ctx().mainApi !== 'openai' || !ctx().getCurrentChatId()) return;
    const inPanel = settings().showBar && list && host;
    if (!inPanel && !here) return;
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
            <span class="cpm-text">${e(tr`Remember this chat`)}</span>
        </label>
        <button type="button" class="cpm-info-btn" title="${e(tr`What this chat remembers`)}" aria-label="${e(tr`What this chat remembers`)}"><i class="fa-solid fa-circle-info"></i></button>`;
    bindBar(bar);
    // 확장 설정 칸에는 늘 · 프롬프트 목록 위에는 설정을 켰을 때만 (같은 막대 두 벌)
    if (here) here.append(bar);
    if (inPanel) {
        const copy = bar.cloneNode(true);
        bindBar(copy);
        const toolbar = sharedToolbar(host);
        if (toolbar) {
            // 프롬프트 그룹 도구 줄이 목록 위에 있으면 한 줄로: 스위치와 ⓘ 는 그 줄 왼쪽
            // (cpm-bar 클래스를 달아 둬야 프롬프트 그룹이 「목록이 바뀜」으로 보고 다시 그리지 않음)
            const sw = document.createElement('div');
            sw.className = 'cpm-bar cpm-inpf cpm-inpf-switch' + (enabled ? '' : ' cpm-disabled');
            sw.append(copy.querySelector('.cpm-switch'), copy.querySelector('.cpm-info-btn'));
            toolbar.prepend(sw);
        } else {
            placeOwnBar(host, list, copy);
        }
    }
}

function bindBar(bar) {
    bar.querySelector('input').addEventListener('change', ev => {
        store(snapshot(), { off: !ev.target.checked });
    });
    bar.querySelector('.cpm-info-btn').addEventListener('click', showMemory);
    bar.querySelectorAll('.cpm-kind').forEach(btn => btn.addEventListener('click', () => {
        const next = { ...rawKinds(), [btn.dataset.kind]: btn.getAttribute('aria-pressed') !== 'true' };
        if (!kindList().some(k => next[k])) return void toastr.info(tr`Pick at least one, or turn the switch off.`, tr`Chat Preset Memory`);
        (next.world ? refreshEntries() : Promise.resolve()).then(() => store(snapshot(next), { kinds: next }));   // 켠 종류는 지금 상태부터 기억
    }));
}

let barTimer = null;
function watchPromptManager() {
    const host = document.getElementById('completion_prompt_manager');
    if (!host) return void setTimeout(watchPromptManager, 1000);
    new MutationObserver(() => {
        if (!settings().showBar || !document.getElementById('completion_prompt_manager_list')) return;
        const toolbar = sharedToolbar(host);
        // 도구 줄이 같은 자리에 있으면 그 안에, 없으면 목록 위에 우리 막대가 있는지 (도구 줄은 다시 그려질 때 통째로 바뀜)
        if (toolbar ? toolbar.querySelector('.cpm-inpf') : host.querySelector('.cpm-bar:not(.cpm-inpf)')) return;
        clearTimeout(barTimer);
        barTimer = setTimeout(renderBar, 20);
    }).observe(host, { childList: true, subtree: true });
    renderBar();
}

// ---------------- Settings panel ----------------

/** 캐릭터 목록 검색: 이름 · 프리셋 글자로 거름 */
function filterChars() {
    const box = document.getElementById('cpm_chars');
    const q = box?.querySelector('.cpm-search')?.value.trim().toLowerCase() || '';
    box?.querySelectorAll('.cpm-char-list li[data-key]').forEach(li => { li.hidden = !!q && !li.textContent.toLowerCase().includes(q); });
}

/** 설정 칸: 캐릭터별 마지막 설정 목록 — 한 줄씩 지우기(되돌리기 알림) */
function renderChars() {
    const box = document.getElementById('cpm_chars');
    if (!box) return;
    const c = ctx();
    const byChar = settings().byChar;
    const keys = Object.keys(byChar);
    box.querySelector('.cpm-count').textContent = keys.length ? tr`${keys.length} characters` : tr`None`;
    box.querySelector('.cpm-char-foot').hidden = !keys.length;
    if (!box.open) return;
    const nameOf = key => key.startsWith('group:')
        ? c.groups?.find(g => String(g.id) === key.slice(6))?.name
        : c.characters?.find(ch => ch.avatar === key)?.name;
    const here = charKey();
    const rows = keys.map(key => ({ key, name: nameOf(key), mem: byChar[key] }))
        .sort((a, b) => (b.key === here) - (a.key === here) || (a.name ? 0 : 1) - (b.name ? 0 : 1) || String(a.name ?? a.key).localeCompare(String(b.name ?? b.key)));
    const e = x => String(x ?? '').replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);
    const list = box.querySelector('.cpm-char-list');
    list.innerHTML = rows.length ? rows.map(r => `<li data-key="${e(r.key)}">
        <span class="cpm-char-main"><span class="cpm-char-name">${e(r.name ?? (r.key.startsWith('group:') ? tr`Group` : r.key.replace(/\.png$/i, '')))}${r.key === here ? ` <small>${e(tr`now`)}</small>` : ''}${r.name ? '' : ` <small>${e(r.key.startsWith('group:') ? tr`deleted group` : tr`deleted`)}</small>`}</span>
        <span class="cpm-char-sub">${e(r.mem?.preset || tr`No preset`)}</span></span>
        <button type="button" class="cpm-char-del fa-solid fa-xmark" title="${e(tr`Remove`)}" aria-label="${e(tr`Remove`)}"></button></li>`).join('')
        : `<li class="cpm-char-empty">${e(tr`There are no character defaults yet.`)}</li>`;
    filterChars();
    list.querySelectorAll('.cpm-char-del').forEach(btn => btn.addEventListener('click', () => {
        const key = btn.closest('li').dataset.key;
        const old = settings().byChar[key];
        if (!old) return;
        const name = nameOf(key) ?? key;
        delete settings().byChar[key];
        ctx().saveSettingsDebounced();
        renderChars();
        const esc = x => String(x).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);
        toastr.success(`${esc(tr`Removed the last settings for ${name}.`)} <u>${esc(tr`Undo`)}</u>`, tr`Chat Preset Memory`, {
            escapeHtml: false, timeOut: 8000, extendedTimeOut: 4000,
            onclick: () => { if (!settings().byChar[key]) settings().byChar[key] = old; ctx().saveSettingsDebounced(); renderChars(); },
        });
    }));
}

async function addSettingsPanel() {
    const host = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
    if (!host || document.getElementById('cpm_settings')) return;
    const html = await (await fetch(new URL('settings.html', import.meta.url))).text();
    host.insertAdjacentHTML('beforeend', html);
    const s = settings();
    // 알림에 보일 것: 기억할 것과 같은 알약 — 알림을 끄면 흐리게
    const syncNotify = () => document.querySelector('#cpm_settings .cpm-notify-kinds')?.classList.toggle('cpm-off', !settings().notify);
    for (const k of KINDS) {
        const cb = document.getElementById(`cpm_nkind_${k}`);
        if (!cb) continue;
        cb.checked = s.notifyKinds[k] !== false;
        cb.addEventListener('change', () => { settings().notifyKinds = { ...settings().notifyKinds, [k]: cb.checked }; ctx().saveSettingsDebounced(); });
    }
    const bp = document.getElementById('cpm_barPos');
    if (bp) {
        bp.value = barSpot();
        bp.addEventListener('change', () => { settings().barPos = bp.value; ctx().saveSettingsDebounced(); renderBar(); });
    }
    for (const key of ['charDefault', 'showBar', 'notify']) {
        const cb = document.getElementById(`cpm_${key}`);
        if (!cb) continue;
        cb.checked = !!s[key];
        cb.addEventListener('change', () => {
            settings()[key] = cb.checked;
            ctx().saveSettingsDebounced();
            renderBar();
        });
    }
    document.getElementById('cpm_notify')?.addEventListener('change', syncNotify);
    syncNotify();
    for (const k of KINDS) {
        const cb = document.getElementById(`cpm_kind_${k}`);
        if (!cb) continue;
        cb.checked = !!s.kinds[k];
        cb.addEventListener('change', () => { settings().kinds = { ...settings().kinds, [k]: cb.checked }; ctx().saveSettingsDebounced(); renderBar(); });
    }
    syncAuOption();
    const charBox = document.getElementById('cpm_chars');
    charBox?.addEventListener('toggle', () => { if (charBox.open) renderChars(); });
    charBox?.querySelector('.cpm-search')?.addEventListener('input', filterChars);
    renderChars();
    document.getElementById('cpm_clear_chars')?.addEventListener('click', async () => {
        const n = Object.keys(settings().byChar).length;
        if (!n) return;
        const ok = await ctx().callGenericPopup(tr`Clear the character defaults (${n})? Saved chat settings are kept.`, ctx().POPUP_TYPE.CONFIRM);
        if (!ok) return;
        const undo = structuredClone(settings().byChar);
        settings().byChar = {};
        ctx().saveSettingsDebounced();
        renderChars();
        toastr.success(`${tr`Cleared ${n} character defaults.`} <u>${tr`Undo`}</u>`, tr`Chat Preset Memory`, {
            escapeHtml: false, timeOut: 10000, extendedTimeOut: 4000,
            onclick: () => { settings().byChar = { ...undo, ...settings().byChar }; ctx().saveSettingsDebounced(); renderChars(); toastr.info(tr`Restored the character defaults.`, tr`Chat Preset Memory`); },
        });
    });
}

// 다른 확장이 읽을 수 있게: 채팅 id → 그 채팅이 기억한 { avatar, au? } (페르소나를 기억하는 채팅만, 이 캐릭터 파일을 읽은 뒤)
globalThis[Symbol.for('chat-preset-memory.api')] = {
    async persona(chatId, owner = charKey()) {
        await loadOwner(owner);
        const m = STORE.chats[chatId];
        return m && !m.off && kindsOf(m).persona && m.persona?.avatar ? { ...m.persona } : null;
    },
};

jQuery(async () => {
    settings();
    await loadKo();
    loadOwner(charKey());
    try { await addSettingsPanel(); } catch (err) { console.warn(LOG, 'settings panel', err); }
    const { eventSource, event_types } = ctx();
    // 실리태번은 이벤트 처리를 하나씩 기다리므로, 일부러 쉬는 이 처리가 채팅 열기 · 첫 화면을 막지 않게 따로 돌림
    eventSource.on(event_types.CHAT_CHANGED, () => { void onChatChanged().catch(err => console.warn(LOG, err)); });
    // 채팅 이름을 바꾸면 기억도 새 이름으로, 지우면 기억도 지움
    const bare = n => String(n || '').replace(/\.jsonl$/, '');
    eventSource.on(event_types.CHAT_RENAMED, async d => { await loadOwner(charKey()); const a = bare(d?.oldFileName), b = bare(d?.newFileName); if (a && b && STORE.chats[a]) { putMemory(b, STORE.chats[a], true, ownerOf[a]); putMemory(a, undefined); } });
    // 채팅을 지우면 그 기억을 빼고, 캐릭터 파일이 비면 파일도 지움
    for (const ev of [event_types.CHAT_DELETED, event_types.GROUP_CHAT_DELETED]) if (ev) eventSource.on(ev, async name => { await loadOwner(charKey()); const id = bare(name); if (STORE.chats[id]) putMemory(id, undefined); });
    // 캐릭터를 지우면 그 캐릭터 기억 파일을 통째로, 이름(아바타)을 바꾸면 새 이름 파일로 옮김
    eventSource.on(event_types.CHARACTER_DELETED, async ({ character } = {}) => {
        const key = character?.avatar; if (!key) return;
        gone.add(key);
        if (settings().byChar[key]) { delete settings().byChar[key]; ctx().saveSettingsDebounced(); renderChars(); }
        for (const id of Object.keys(ownerOf)) if (ownerOf[id] === key) { delete ownerOf[id]; delete STORE.chats[id]; dirty.delete(id); }
        loaded.delete(key);
        await saving.catch(() => {});   // 이미 돌고 있는 저장이 끝난 뒤에 지움
        await removeFile(fileOf(key)); noteFile(key, false);
    });
    eventSource.on(event_types.CHARACTER_RENAMED, async (oldKey, newKey) => {
        if (!oldKey || !newKey || oldKey === newKey) return;
        try {
            const file = await readJson(fileOf(oldKey)); if (!file?.chats) return;
            await writeJson(fileOf(newKey), { ...file, owner: newKey }); await removeFile(fileOf(oldKey)); noteFile(oldKey, false); noteFile(newKey, true);
        } catch (err) { return void warnSaveFailed(err); }   // 옛 파일은 그대로 둠
        for (const id of Object.keys(ownerOf)) if (ownerOf[id] === oldKey) ownerOf[id] = newKey;
        loaded.delete(oldKey); loaded.delete(newKey);
    });
    eventSource.on(event_types.SETTINGS_UPDATED, remember);
    eventSource.on(event_types.PERSONA_CHANGED, () => { if (kindsOf().persona) remember(); });
    // 캐릭터 카드 칸이 바뀌면(저장판 「사용」 · 직접 고침) 캐릭터 AU 를 따라 기억
    eventSource.on(event_types.CHARACTER_EDITED, () => { if (kindsOf().card) remember(); });
    // 로어북 항목을 켜고 끄면(월드인포 편집 창) 그 상태를 기억
    eventSource.on(event_types.WORLDINFO_UPDATED, () => { if (!restoring && kindsOf().world) refreshEntries().then(remember); });
    // 프리셋을 바꾸는 동안(설정이 여러 번 저장됨)은 기억하지 않다가, 다 바뀐 뒤 그 프리셋 기준으로 처리
    eventSource.on(event_types.OAI_PRESET_CHANGED_BEFORE, () => { if (!restoring) switching = true; });
    eventSource.on(event_types.OAI_PRESET_CHANGED_AFTER, () => setTimeout(onPresetChanged, 300));
    // 연결 프로필 · 공급자 · 모델을 바꾸면 (연결을 기억하는 채팅에서) 기억
    for (const ev of [event_types.CONNECTION_PROFILE_LOADED, event_types.CHATCOMPLETION_SOURCE_CHANGED, event_types.CHATCOMPLETION_MODEL_CHANGED]) if (ev) eventSource.on(ev, () => { if (kindsOf().connection) remember(); });
    eventSource.on(event_types.GENERATION_STARTED, (type, _opts, dryRun) => {
        if (!dryRun && type !== 'quiet') remember();
    });
    watchPromptManager();
    if (event_types.APP_READY) eventSource.on(event_types.APP_READY, () => { syncAuOption(); renderBar(); pruneFiles().catch(err => console.warn(LOG, 'prune', err)); });
});
