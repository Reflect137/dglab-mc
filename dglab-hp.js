/* dglab-hp.js —— 《我的世界》× DG-LAB
 * 放进游戏脚本目录，进世界自动连中继。每刻读血量：掉血加电、回血减电、死亡拉满。
 * 用 JS ModAPI：socket / player / sp / minecraft / ImGui，事件是全局函数。
 * 波形数据来自 dglab-kit（GPL-3.0）。 */

'use strict';

var SCRIPT_NAME = 'dglab-hp';
var SCRIPT_VER = '1.1.0';
var PANEL_TITLE = 'DG-LAB';

/* ---- 1. 运行环境（取不到的模块不会让脚本崩） ---- */

var MOD = {
    socket: null,
    player: null,
    minecraft: null,
    app: null,
    sp: null,
    world: null,
    ImGui: null,
};

function safeRequire(name) {
    try {
        return require(name);
    } catch (e) {
        return null;
    }
}

MOD.socket = safeRequire('socket');
MOD.player = safeRequire('player');
MOD.minecraft = safeRequire('minecraft');
MOD.app = safeRequire('app');
MOD.sp = safeRequire('sp');
MOD.world = safeRequire('world');
MOD.ImGui = safeRequire('ImGui');

/* ---- 2. 小工具 ---- */

function nowMs() {
    return Date.now();
}

function clamp(v, lo, hi) {
    if (v < lo) return lo;
    if (v > hi) return hi;
    return v;
}

function round1(v) {
    return Math.round(v * 10) / 10;
}

function log() {
    if (!CONFIG.debug) return;
    var parts = ['[' + SCRIPT_NAME + ']'];
    for (var i = 0; i < arguments.length; i++) parts.push(String(arguments[i]));
    console.log(parts.join(' '));
}

function logAlways() {
    var parts = ['[' + SCRIPT_NAME + ']'];
    for (var i = 0; i < arguments.length; i++) parts.push(String(arguments[i]));
    console.log(parts.join(' '));
}

function chat(msg) {
    var m = String(msg);
    try {
        if (MOD.minecraft && MOD.minecraft.clientMessage) {
            MOD.minecraft.clientMessage(m);
            return;
        }
    } catch (e) { /* 换下一种 */ }
    try {
        if (MOD.minecraft && MOD.minecraft.sendChatMessage) {
            MOD.minecraft.sendChatMessage(m);
            return;
        }
    } catch (e2) { /* 忽略 */ }
    console.log(m);
}

/* 错误上报：出错就直接弹给玩家看 */

var ERR_LAST_AT = {};   // 出错位置 -> 上次上报时间（同一处 3 秒内只说一次，防刷屏）
var ERR_LIST = [];      // 最近 20 条，!dg errors 可以看
var ERR_COUNT = 0;      // 出错总次数

/* 异常整理成一条消息 */
function errText(where, e, extra) {
    var msg = (e && e.message) ? e.message : String(e);
    var stack = '';
    try {
        if (e && e.stack) {
            var lines = String(e.stack).split('\n');
            stack = lines.slice(0, 3).join(' ← ');
        }
    } catch (e2) { /* 拿不到就算了 */ }
    var out = '❌ ' + where + '：' + msg;
    if (stack && stack.indexOf(msg) < 0) out += '　' + stack;
    if (extra) out += '　[' + extra + ']';
    return '[DG-LAB] ' + out;
}

/* 记一笔 + 弹给玩家 */
function reportError(where, e, extra) {
    var now = 0;
    try { now = nowMs(); } catch (e2) { now = 0; }
    ERR_COUNT++;
    var text = errText(where, e, extra);
    S.lastError = text;
    try {
        ERR_LIST.push(text + '（第 ' + S.tickCount + ' 刻）');
        if (ERR_LIST.length > 20) ERR_LIST.shift();
    } catch (e3) { /* 忽略 */ }
    var last = ERR_LAST_AT[where] || 0;
    if (now && last && now - last < 3000) return;   // 同一处 3 秒内只报一次
    ERR_LAST_AT[where] = now;
    chat(text + '（v' + SCRIPT_VER + '）');
    try { log('错误上报', where, e); } catch (e4) { /* 忽略 */ }
}

/* 包一层，出错就上报 */
function guard(where, fn) {
    return function () {
        try {
            return fn.apply(null, arguments);
        } catch (e) {
            reportError(where, e);
            return undefined;
        }
    };
}

/* 提示消息：force=true 时忽略最小间隔（配对、归零这种一次性消息用） */
/* 常规提示：掉血、清电、死亡、复活回落这些，默认不出声（面板「聊天栏提示」可以打开） */
function noticeRoutine(msg) {
    if (!CONFIG.chatNotice) return;
    notice(msg);
}

function notice(msg, force) {
    if (!CONFIG.clientNotify) return;
    var gap = Number(CONFIG.notifyMinIntervalMs) || 0;
    if (!force && gap > 0) {
        var t = nowMs();
        if (t - S.lastNoticeAt < gap) return;
        S.lastNoticeAt = t;
    }
    chat('[DG-LAB] ' + msg);
}

function encodeURIComponentSafe(s) {
    try {
        return encodeURIComponent(s);
    } catch (e) {
        return s;
    }
}

/* ---- 3. 内置波形（数据来自 dglab-kit 的郊狼波形库，16 进制 8 字节/帧） ---- */

/*__WAVEFORMS_BEGIN__*/
var WAVEFORM_DATA = {
        "EXTRUSTION": {
            "cn": "挤压",
            "frames": [
                "0A0A0A0A00000000",
                "0A0A0A0A64646464"
            ]
        },
        "BUBBLE": {
            "cn": "气泡",
            "frames": [
                "2D2D2D2D00000000",
                "2D2D2D2D64646464"
            ]
        },
        "RHYTHM": {
            "cn": "律动",
            "frames": [
                "0A0A0A0A00000000",
                "0A0A0A0A32323232",
                "0A0A0A0A64646464",
                "0A0A0A0A00000000",
                "0A0A0A0A32323232",
                "0A0A0A0A64646464",
                "1919191964646464",
                "1D1D1D1D64646464",
                "2222222264646464",
                "2626262664646464",
                "2B2B2B2B64646464",
                "0A0A0A0A00000000",
                "0A0A0A0A00000000"
            ]
        },
        "AIR_WAVES": {
            "cn": "电波",
            "frames": [
                "0A0A0A0A64646464",
                "1717171764646464",
                "2424242464646464",
                "3232323264646464",
                "0A0A0A0A00000000",
                "0A0A0A0A64646464",
                "0A0A0A0A00000000",
                "0A0A0A0A64646464",
                "0A0A0A0A00000000",
                "0A0A0A0A64646464",
                "0A0A0A0A00000000",
                "0A0A0A0A64646464",
                "0A0A0A0A00000000"
            ]
        },
        "CLIMB": {
            "cn": "攀登",
            "frames": [
                "3030303032323232",
                "282828283C3C3C3C",
                "2020202046464646",
                "1919191950505050",
                "111111115A5A5A5A",
                "0A0A0A0A64646464"
            ]
        },
        "SHADE": {
            "cn": "树荫",
            "frames": [
                "6464646464646464",
                "6464646464646464"
            ]
        },
        "PULSE": {
            "cn": "脉冲",
            "frames": [
                "0A0A0A0A64646464",
                "0D0D0D0D64646464",
                "1010101064646464",
                "1313131364646464",
                "1616161664646464",
                "1C1C1C1C64646464",
                "2525252564646464",
                "2E2E2E2E64646464",
                "3737373764646464",
                "4040404064646464",
                "4E4E4E4E64646464",
                "6C6C6C6C64646464",
                "7979797964646464",
                "8686868664646464",
                "9393939364646464",
                "A0A0A0A064646464"
            ]
        },
        "BREATHING": {
            "cn": "呼吸",
            "frames": [
                "0A0A0A0A00000000",
                "0A0A0A0A14141414",
                "0A0A0A0A28282828",
                "0A0A0A0A3C3C3C3C",
                "0A0A0A0A50505050",
                "0A0A0A0A64646464",
                "0A0A0A0A64646464",
                "0A0A0A0A64646464",
                "0A0A0A0A00000000",
                "0A0A0A0A00000000",
                "0A0A0A0A00000000",
                "0A0A0A0A00000000"
            ]
        },
        "TIDE": {
            "cn": "潮汐",
            "frames": [
                "0A0A0A0A00000000",
                "0B0B0B0B10101010",
                "0D0D0D0D21212121",
                "0E0E0E0E32323232",
                "1010101042424242",
                "1212121253535353",
                "1313131364646464",
                "151515155C5C5C5C",
                "1616161654545454",
                "181818184C4C4C4C",
                "1A1A1A1A44444444",
                "1A1A1A1A00000000",
                "1B1B1B1B10101010",
                "1D1D1D1D21212121",
                "1E1E1E1E32323232",
                "2020202042424242",
                "2222222253535353",
                "2323232364646464",
                "252525255C5C5C5C",
                "2626262654545454",
                "282828284C4C4C4C",
                "2A2A2A2A44444444",
                "0A0A0A0A00000000"
            ]
        },
        "PULSATING": {
            "cn": "连击",
            "frames": [
                "0A0A0A0A64646464",
                "0A0A0A0A00000000",
                "0A0A0A0A64646464",
                "0A0A0A0A42424242",
                "0A0A0A0A21212121",
                "0A0A0A0A00000000",
                "0A0A0A0A00000000",
                "0A0A0A0A00000000",
                "0A0A0A0A64646464",
                "0A0A0A0A00000000",
                "0A0A0A0A64646464",
                "0A0A0A0A42424242",
                "0A0A0A0A21212121",
                "0A0A0A0A00000000",
                "0A0A0A0A00000000",
                "0A0A0A0A00000000",
                "0A0A0A0A64646464",
                "0A0A0A0A00000000",
                "0A0A0A0A64646464",
                "0A0A0A0A42424242",
                "0A0A0A0A21212121",
                "0A0A0A0A00000000",
                "0A0A0A0A00000000",
                "0A0A0A0A00000000"
            ]
        },
        "HEARTBEAT": {
            "cn": "心跳节奏",
            "frames": [
                "7070707064646464",
                "7070707064646464",
                "7070707064646464",
                "7070707064646464",
                "7070707064646464",
                "7070707064646464",
                "0A0A0A0A00000000",
                "0A0A0A0A00000000",
                "0A0A0A0A00000000",
                "0A0A0A0A00000000",
                "0A0A0A0A00000000",
                "0A0A0A0A4B4B4B4B",
                "0A0A0A0A53535353",
                "0A0A0A0A5B5B5B5B",
                "0A0A0A0A64646464",
                "0A0A0A0A00000000",
                "0A0A0A0A00000000",
                "0A0A0A0A00000000",
                "0A0A0A0A00000000",
                "0A0A0A0A00000000",
                "0A0A0A0A00000000",
                "0A0A0A0A00000000",
                "0A0A0A0A00000000",
                "0A0A0A0A00000000",
                "0A0A0A0A00000000",
                "0A0A0A0A4B4B4B4B",
                "0A0A0A0A53535353",
                "0A0A0A0A5B5B5B5B",
                "0A0A0A0A64646464",
                "0A0A0A0A00000000",
                "0A0A0A0A00000000",
                "0A0A0A0A00000000",
                "0A0A0A0A00000000",
                "0A0A0A0A00000000",
                "0A0A0A0A00000000"
            ]
        }
    };
/*__WAVEFORMS_END__*/

var WAVE_IDS = [];    // ['BUBBLE', ...]
var WAVE_FRAMES = {}; // id -> [ '0A0A..', ... ]

function buildWaveformIndex() {
    for (var id in WAVEFORM_DATA) {
        if (!WAVEFORM_DATA.hasOwnProperty(id)) continue;
        WAVE_IDS.push(id);
        WAVE_FRAMES[id] = WAVEFORM_DATA[id].frames;
    }
}

function waveformName(id) {
    var item = WAVEFORM_DATA[id];
    return item ? id + '(' + item.cn + ')' : String(id);
}

function resolveWaveform(text) {
    if (!text) return null;
    var t = String(text).trim();
    if (WAVE_FRAMES[t]) return t;
    var up = t.toUpperCase();
    if (WAVE_FRAMES[up]) return up;
    /* 中文名：先全等，再模糊（!dg wave 心跳 → HEARTBEAT 心跳节奏） */
    for (var i = 0; i < WAVE_IDS.length; i++) {
        if (WAVEFORM_DATA[WAVE_IDS[i]].cn === t) return WAVE_IDS[i];
    }
    for (var j = 0; j < WAVE_IDS.length; j++) {
        var cn = WAVEFORM_DATA[WAVE_IDS[j]].cn;
        if (cn.indexOf(t) >= 0 || t.indexOf(cn) >= 0) return WAVE_IDS[j];
    }
    for (var k = 0; k < WAVE_IDS.length; k++) {
        if (WAVE_IDS[k].indexOf(up) >= 0) return WAVE_IDS[k];
    }
    return null;
}

function waveformListText() {
    var out = [];
    for (var i = 0; i < WAVE_IDS.length; i++) {
        out.push(WAVE_IDS[i] + '(' + WAVEFORM_DATA[WAVE_IDS[i]].cn + ')');
    }
    return out.join(' ');
}

/* ---- 4. 配置 ---- */

var DEFAULT_CONFIG = {
    /* 连接 */
    relayUrl: 'ws://127.0.0.1:9999/',
    controllerId: 'mc-coyote',
    autoConnect: true,
    autoReconnect: true,
    reconnectSec: 2,                  // 断线后多久重连
    heartbeatSec: 30,                 // 心跳间隔（保持连接不被中继当僵尸）
    offlineStopSec: 60,               // 连不上这么多秒就自动停（0 = 一直重试，不停）
    channel: 'A',

    /* 通道 */
    bScale: 1,
    bOffset: 0,
    bWaveform: '',
    zeroBothChannels: true,
    keepInSync: false,
    keepInSyncMs: 1000,               // 跟随设备强度的检查间隔

    /* 加电曲线 */
    enabled: true,
    strengthPerDamage: 3,
    baseStrength: 0,
    maxStrength: 25,
    energyCap: 40,
    maxEnergyPerHit: 0,
    energyPerSecondCap: 0,
    energyPerMinuteCap: 0,
    minOutputEnergy: 0,
    damageCurve: 'linear',
    instantRise: true,
    startDelaySec: 0,
    stopBelowHp: 0,
    respawnGraceSec: 0,
    respawnDecaySec: 3,               // 复活后几秒内回落到 0（0 = 立刻清零）
    instantFall: true,
    maxRisePerSecond: 20,
    maxFallPerSecond: 30,
    minDamage: 0.5,
    countAbsorption: true,
    ignoreCreative: true,

    /* 回血 / 自然回落 */
    healReduces: true,
    healMode: 'full',
    healFactor: 2,
    hurtFloorEnergy: 0,
    healPulse: false,
    clearWhenFullHp: true,
    fullHpClearDelayMs: 800,
    decayPerSec: 0,
    holdSec: 0,
    holdResetDamage: 0,

    /* 死亡 */
    deathMode: 'max',
    deathInstant: true,
    deathBurstSec: 3,

    /* 波形 */
    burstEnabled: true,
    waveform: 'BUBBLE',
    burstBaseSec: 1,
    burstPerDamageSec: 0.5,
    burstMaxSec: 8,
    continuousPulse: true,
    waveSpeed: 1,
    bWaveShiftFrames: 0,
    randomWaveform: false,
    waveRotateMode: 'random',         // 波形轮换：随机 / 顺序 / 关
    waveRotateOnHit: true,            // 受伤时轮换
    waveRotateEveryN: 1,              // 每 N 次受伤换一次
    waveRotateIntervalSec: 0,         // 每隔 N 秒轮换（0 = 关）
    waveRotateDelayMs: 0,             // 受伤后延迟多久才换
    waveRotateMinGapMs: 2000,         // 两次轮换的最小间隔
    pulseCooldownMs: 0,
    pulseLeadMs: 0,

    /* 增益 */
    critEnabled: true,
    critDamage: 4,
    critFactor: 1.5,
    lowHpEnabled: false,
    lowHpThreshold: 0.3,
    lowHpFactor: 1.5,
    comboEnabled: false,
    comboWindowMs: 3000,
    comboStep: 0.2,
    comboMax: 2,

    /* 安全 */
    manualZeroHoldMs: 1500,
    maxSendPerSec: 10,
    pollEveryTicks: 1,

    /* 界面 */
    showPanel: true,
    clientNotify: true,
    chatNotice: false,                // 常规提示（掉血、清电、死亡这些）默认不刷聊天栏
    deviceZeroHintSec: 5,             // 发了强度但设备回报 0 多久后提示
    notifyMinIntervalMs: 0,
    panelCompact: false,
    hudEnabled: false,
    tipEnabled: true,                 // 用 showTipMessage 在屏幕上显示各通道数值
    tipIntervalMs: 1000,              // 刷新间隔（毫秒）
    tipContent: 'channel',            // channel = 各通道强度，both = 总电量+各通道，energy = 只看总电量
    tipSource: 'plan',                // plan = 脚本下发的值，device = 设备回传的值
    hudX: 20,
    hudY: 20,
    interceptChat: false,
    debug: false,
};

var CONFIG = {};

/* 设置项元数据：面板、指令、存档共用 */
var SETTING_GROUPS = ['连接', '通道', '加电曲线', '增益', '回血回落', '死亡', '波形', '安全', '界面'];

var SETTING_DEFS = [
    { key: 'relayUrl', cn: '中继地址', group: '连接', type: 'string' },
    { key: 'controllerId', cn: '固定配对编号', group: '连接', type: 'string' },
    { key: 'autoConnect', cn: '自动连接', group: '连接', type: 'bool' },
    { key: 'autoReconnect', cn: '断线重连', group: '连接', type: 'bool' },
    { key: 'reconnectSec', cn: '重连间隔', group: '连接', type: 'float', min: 0.5, max: 30, step: 0.5 },
    { key: 'heartbeatSec', cn: '心跳间隔', group: '连接', type: 'float', min: 5, max: 120, step: 5 },
    { key: 'offlineStopSec', cn: '连不上就自动停', group: '连接', type: 'float', min: 0, max: 600, step: 10 },

    { key: 'channel', cn: '控制通道', group: '通道', type: 'enum', values: ['A', 'B', 'AB'], labels: ['左路 A', '右路 B', '双路 A+B'], core: true },
    { key: 'bScale', cn: '右路强度倍率', group: '通道', type: 'float', min: 0, max: 2, step: 0.05 },
    { key: 'bOffset', cn: '右路强度偏移', group: '通道', type: 'int', min: -50, max: 50 },
    { key: 'bWaveform', cn: '右路波形', group: '通道', type: 'enum', values: [''], labels: ['跟随主波形'] },
    { key: 'zeroBothChannels', cn: '归零清两路', group: '通道', type: 'bool' },
    { key: 'keepInSync', cn: '强制同步强度', group: '通道', type: 'bool' },
    { key: 'keepInSyncMs', cn: '同步检查间隔', group: '通道', type: 'int', min: 300, max: 10000 },

    { key: 'enabled', cn: '总开关', group: '加电曲线', type: 'bool', core: true },
    { key: 'strengthPerDamage', cn: '每点伤害加电', group: '加电曲线', type: 'float', min: 0, max: 50, step: 0.5, core: true },
    { key: 'baseStrength', cn: '基础强度', group: '加电曲线', type: 'int', min: 0, max: 100 },
    { key: 'maxStrength', cn: '强度上限', group: '加电曲线', type: 'int', min: 0, max: 200, core: true },
    { key: 'energyCap', cn: '电量上限', group: '加电曲线', type: 'float', min: 1, max: 200, step: 1 },
    { key: 'maxEnergyPerHit', cn: '单次最多加电', group: '加电曲线', type: 'float', min: 0, max: 200, step: 1, core: true },
    { key: 'energyPerSecondCap', cn: '每秒最多加电', group: '加电曲线', type: 'float', min: 0, max: 200, step: 1 },
    { key: 'energyPerMinuteCap', cn: '每分钟最多加电', group: '加电曲线', type: 'float', min: 0, max: 600, step: 10 },
    { key: 'minOutputEnergy', cn: '最低输出电量', group: '加电曲线', type: 'float', min: 0, max: 50, step: 1 },
    { key: 'damageCurve', cn: '伤害换算曲线', group: '加电曲线', type: 'enum', values: ['linear', 'square', 'sqrt'], labels: ['线性', '平方（重伤更狠）', '开方（小伤也有感）'] },
    { key: 'instantRise', cn: '受伤瞬间到位', group: '加电曲线', type: 'bool' },
    { key: 'startDelaySec', cn: '受伤后延迟加电', group: '加电曲线', type: 'float', min: 0, max: 5, step: 0.5 },
    { key: 'stopBelowHp', cn: '低于血量就停', group: '加电曲线', type: 'float', min: 0, max: 20, step: 0.5 },
    { key: 'respawnGraceSec', cn: '复活保护时间', group: '加电曲线', type: 'float', min: 0, max: 30, step: 1 },
    { key: 'respawnDecaySec', cn: '复活后回落秒数', group: '死亡', type: 'float', min: 0, max: 60, step: 1, core: true },
    { key: 'instantFall', cn: '回血瞬间回落', group: '加电曲线', type: 'bool' },
    { key: 'maxRisePerSecond', cn: '每秒最大涨幅', group: '加电曲线', type: 'float', min: 0.5, max: 200, step: 0.5 },
    { key: 'maxFallPerSecond', cn: '每秒最大回落', group: '加电曲线', type: 'float', min: 0.5, max: 200, step: 0.5 },
    { key: 'minDamage', cn: '最小伤害', group: '加电曲线', type: 'float', min: 0, max: 20, step: 0.5 },
    { key: 'countAbsorption', cn: '黄心也算掉血', group: '加电曲线', type: 'bool' },
    { key: 'ignoreCreative', cn: '创造旁观不触发', group: '加电曲线', type: 'bool' },

    { key: 'critEnabled', cn: '重击加成', group: '增益', type: 'bool' },
    { key: 'critDamage', cn: '重击判定伤害', group: '增益', type: 'float', min: 1, max: 20, step: 0.5 },
    { key: 'critFactor', cn: '重击倍率', group: '增益', type: 'float', min: 1, max: 5, step: 0.1 },
    { key: 'lowHpEnabled', cn: '低血加成', group: '增益', type: 'bool' },
    { key: 'lowHpThreshold', cn: '低血阈值', group: '增益', type: 'float', min: 0.05, max: 1, step: 0.05 },
    { key: 'lowHpFactor', cn: '低血倍率', group: '增益', type: 'float', min: 1, max: 5, step: 0.1 },
    { key: 'comboEnabled', cn: '连击加成', group: '增益', type: 'bool' },
    { key: 'comboWindowMs', cn: '连击窗口', group: '增益', type: 'int', min: 200, max: 20000 },
    { key: 'comboStep', cn: '每层连击加成', group: '增益', type: 'float', min: 0, max: 2, step: 0.05 },
    { key: 'comboMax', cn: '连击倍率上限', group: '增益', type: 'float', min: 1, max: 10, step: 0.1 },

    { key: 'healReduces', cn: '回血减电', group: '回血回落', type: 'bool' },
    { key: 'healMode', cn: '回血怎么减', group: '回血回落', type: 'enum', values: ['full', 'ratio', 'ratioFloor'], labels: ['回满血才清', '按回血比例减', '比例减但保底'], core: true },
    { key: 'healFactor', cn: '回血减电倍率', group: '回血回落', type: 'float', min: 0, max: 20, step: 0.5 },
    { key: 'hurtFloorEnergy', cn: '没回满时电量保底', group: '回血回落', type: 'float', min: 0, max: 100, step: 1, core: true },
    { key: 'healPulse', cn: '回血也放波形', group: '回血回落', type: 'bool' },
    { key: 'clearWhenFullHp', cn: '满血自动清电', group: '回血回落', type: 'bool' },
    { key: 'fullHpClearDelayMs', cn: '满血判定延迟', group: '回血回落', type: 'int', min: 0, max: 5000 },
    { key: 'decayPerSec', cn: '每秒自然回落', group: '回血回落', type: 'float', min: 0, max: 50, step: 0.5 },
    { key: 'holdSec', cn: '受伤后保持', group: '回血回落', type: 'float', min: 0, max: 120, step: 1 },
    { key: 'holdResetDamage', cn: '碎伤害不刷新保持', group: '回血回落', type: 'float', min: 0, max: 20, step: 0.5 },

    { key: 'deathMode', cn: '死亡处理', group: '死亡', type: 'enum', values: ['max', 'zero', 'none'], labels: ['电量拉满', '立即归零', '不处理'], core: true },
    { key: 'deathInstant', cn: '死亡瞬间拉满', group: '死亡', type: 'bool' },
    { key: 'deathBurstSec', cn: '死亡波形时长', group: '死亡', type: 'float', min: 0, max: 60, step: 0.5, core: true },

    { key: 'burstEnabled', cn: '受伤出波形', group: '波形', type: 'bool' },
    { key: 'waveform', cn: '波形', group: '波形', type: 'enum', values: [], core: true },
    { key: 'burstBaseSec', cn: '波形基础时长', group: '波形', type: 'float', min: 0.5, max: 30, step: 0.5 },
    { key: 'burstPerDamageSec', cn: '每点伤害加时长', group: '波形', type: 'float', min: 0, max: 10, step: 0.1 },
    { key: 'burstMaxSec', cn: '波形最长', group: '波形', type: 'float', min: 1, max: 60, step: 1 },
    { key: 'continuousPulse', cn: '电量没清就一直放', group: '波形', type: 'bool', core: true },
    { key: 'waveSpeed', cn: '波形快慢', group: '波形', type: 'float', min: 0.5, max: 2, step: 0.05 },
    { key: 'bWaveShiftFrames', cn: '右路波形错开', group: '波形', type: 'int', min: 0, max: 20 },
    { key: 'randomWaveform', cn: '随机波形', group: '波形', type: 'bool' },
    { key: 'waveRotateMode', cn: '波形轮换', group: '波形', type: 'enum', values: ['off', 'sequence', 'random'], labels: ['关', '按顺序', '随机'] },
    { key: 'waveRotateOnHit', cn: '受伤时轮换', group: '波形', type: 'bool' },
    { key: 'waveRotateEveryN', cn: '每几次受伤换', group: '波形', type: 'int', min: 1, max: 50 },
    { key: 'waveRotateIntervalSec', cn: '定时轮换秒数', group: '波形', type: 'float', min: 0, max: 600, step: 5 },
    { key: 'waveRotateDelayMs', cn: '切换延迟', group: '波形', type: 'int', min: 0, max: 10000 },
    { key: 'waveRotateMinGapMs', cn: '切换最小间隔', group: '波形', type: 'int', min: 0, max: 60000 },
    { key: 'pulseCooldownMs', cn: '受伤波形冷却', group: '波形', type: 'int', min: 0, max: 10000 },
    { key: 'pulseLeadMs', cn: '续波形提前量', group: '波形', type: 'int', min: 0, max: 2000 },

    { key: 'manualZeroHoldMs', cn: '归零后静默', group: '安全', type: 'int', min: 0, max: 10000, core: true },
    { key: 'maxSendPerSec', cn: '每秒最多下发', group: '安全', type: 'int', min: 1, max: 50 },
    { key: 'pollEveryTicks', cn: '每几刻读血量', group: '安全', type: 'int', min: 1, max: 20 },

    { key: 'showPanel', cn: '显示设置面板', group: '界面', type: 'bool', core: true },
    { key: 'clientNotify', cn: '本地消息提示', group: '界面', type: 'bool' },
    { key: 'chatNotice', cn: '聊天栏提示', group: '界面', type: 'bool', core: true },
    { key: 'deviceZeroHintSec', cn: '无输出提示延迟', group: '界面', type: 'float', min: 1, max: 60, step: 1 },
    { key: 'notifyMinIntervalMs', cn: '提示最小间隔', group: '界面', type: 'int', min: 0, max: 60000 },
    { key: 'panelCompact', cn: '面板只显示常用', group: '界面', type: 'bool', core: true },
    { key: 'hudEnabled', cn: '屏幕状态条', group: '界面', type: 'bool', core: true },
    { key: 'tipEnabled', cn: '屏幕提示电量', group: '界面', type: 'bool', core: true },
    { key: 'tipIntervalMs', cn: '提示刷新间隔', group: '界面', type: 'int', min: 200, max: 10000 },
    { key: 'tipContent', cn: '提示显示内容', group: '界面', type: 'enum', values: ['channel', 'both', 'energy'], labels: ['各通道强度', '总电量+各通道', '只看总电量'] },
    { key: 'tipSource', cn: '提示取哪个值', group: '界面', type: 'enum', values: ['plan', 'device'], labels: ['脚本下发值', '设备回传值'] },
    { key: 'hudX', cn: '状态条横向位置', group: '界面', type: 'int', min: 0, max: 2000 },
    { key: 'hudY', cn: '状态条纵向位置', group: '界面', type: 'int', min: 0, max: 2000 },
    { key: 'interceptChat', cn: '接管聊天指令', group: '界面', type: 'bool', core: true },
    { key: 'debug', cn: '调试日志', group: '界面', type: 'bool' },
];

var SETTING_MAP = {};
for (var di = 0; di < SETTING_DEFS.length; di++) SETTING_MAP[SETTING_DEFS[di].key] = SETTING_DEFS[di];

function defOf(key) {
    return SETTING_MAP[key] || null;
}

function findKeyByCn(text) {
    for (var i = 0; i < SETTING_DEFS.length; i++) {
        if (SETTING_DEFS[i].cn === text) return SETTING_DEFS[i].key;
    }
    return null;
}

function copyDefaults() {
    var out = {};
    for (var k in DEFAULT_CONFIG) {
        if (DEFAULT_CONFIG.hasOwnProperty(k)) out[k] = DEFAULT_CONFIG[k];
    }
    return out;
}

function coerceValue(def, raw) {
    if (!def) return raw;
    if (def.type === 'bool') {
        if (typeof raw === 'boolean') return raw;
        var s = String(raw).toLowerCase();
        return s === '1' || s === 'true' || s === 'on' || s === 'yes' || s === '开' || s === '是';
    }
    if (def.type === 'int') {
        var n = Math.round(Number(raw));
        if (isNaN(n)) return null;
        return clamp(n, def.min === undefined ? -999999 : def.min, def.max === undefined ? 999999 : def.max);
    }
    if (def.type === 'float') {
        var f = Number(raw);
        if (isNaN(f)) return null;
        return clamp(f, def.min === undefined ? -999999 : def.min, def.max === undefined ? 999999 : def.max);
    }
    if (def.type === 'enum') {
        var t = String(raw).trim();
        for (var i = 0; i < def.values.length; i++) {
            if (String(def.values[i]).toLowerCase() === t.toLowerCase()) return def.values[i];
        }
        if (def.labels) {
            for (var j = 0; j < def.labels.length; j++) {
                if (String(def.labels[j]) === t) return def.values[j];
            }
        }
        return null;
    }
    return String(raw);
}

/* ---- 5. 设置持久化（sp 模块） ---- */

var SP_PREFIX = 'dglab_hp.';

function spAvailable() {
    return !!(MOD.sp && MOD.sp.contains);
}

function loadConfig() {
    CONFIG = copyDefaults();
    if (!spAvailable()) {
        log('sp 模块不可用，使用默认设置');
        return;
    }
    for (var i = 0; i < SETTING_DEFS.length; i++) {
        var def = SETTING_DEFS[i];
        var k = SP_PREFIX + def.key;
        try {
            if (!MOD.sp.contains(k)) continue;
            var v = null;
            if (def.type === 'bool') v = MOD.sp.getBoolean(k);
            else if (def.type === 'int') v = MOD.sp.getInt(k);
            else if (def.type === 'float') v = MOD.sp.getFloat(k);
            else v = MOD.sp.getString(k);
            if (v !== null && v !== undefined && typeof v !== 'object') {
                if (def.type === 'int' || def.type === 'float') {
                    var n = Number(v);
                    if (isNaN(n)) n = DEFAULT_CONFIG[def.key];
                    CONFIG[def.key] = clamp(n, def.min, def.max);   // 越界值会让功能失效（例如迟到 1e9 毫秒的切换）
                } else if (v !== '') {
                    CONFIG[def.key] = v;
                }
            }
        } catch (e) {
            reportError('读取设置（' + def.key + '）', e);
        }
    }
    fixPanelSetting();
    log('设置已读取', JSON.stringify(CONFIG));
}

/* 一次性修复：旧版本可能因为引擎乱写面板可见性，把「显示设置面板=false」存进了存档，
 * 之后面板再也不显示。升级后强制打开一次，之后用户怎么设都尊重。 */
function fixPanelSetting() {
    if (!spAvailable()) return;
    var key = SP_PREFIX + 'panelFix2';
    var saved = false;
    try { saved = MOD.sp.contains(SP_PREFIX + 'showPanel'); } catch (e) { saved = false; }
    if (!saved) return;          // 存档里还没存过这个设置，没什么可修
    var done = false;
    try { done = MOD.sp.getBoolean(key); } catch (e2) { done = false; }
    if (done) return;
    try {
        if (CONFIG.showPanel === false) {
            CONFIG.showPanel = true;
            try { MOD.sp.putBoolean(SP_PREFIX + 'showPanel', true); } catch (e3) { /* 写不进去就算了 */ }
            chat('[DG-LAB] 面板之前被旧版本的 bug 关掉了，已经帮你重新打开（不想看就在面板里关）');
        }
        MOD.sp.putBoolean(key, true);
    } catch (e2) { /* 存档读不了就算了 */ }
}

function saveConfig() {
    if (!spAvailable()) {
        log('sp 模块不可用，设置无法保存');
        return false;
    }
    for (var i = 0; i < SETTING_DEFS.length; i++) {
        var def = SETTING_DEFS[i];
        var k = SP_PREFIX + def.key;
        try {
            if (def.type === 'bool') MOD.sp.putBoolean(k, !!CONFIG[def.key]);
            else if (def.type === 'int') MOD.sp.putInt(k, Math.round(CONFIG[def.key]));
            else if (def.type === 'float') MOD.sp.putFloat(k, Number(CONFIG[def.key]));
            else MOD.sp.putString(k, String(CONFIG[def.key]));
        } catch (e) {
            reportError('保存设置（' + def.key + '）', e);
        }
    }
    log('设置已保存');
    return true;
}

/* ---- 6. 运行时状态 ---- */

var S = {
    inited: false,
    lastTickAt: 0,
    tickCount: 0,

    player: null,
    playerUid: '',
    lastHp: null,
    lastTotal: null,
    lastMaxHp: 20,
    lastAbsorb: 0,
    hurtFlag: false,
    lastDamage: 0,

    energy: 0,          // 累计电量（强度点）
    strength: 0,        // 当前强度（浮点，下发取整）
    lastDamageAt: -1e9, // 上次受伤时间
    chargeUntil: 0,     // 波形要播到什么时候
    nextPulseAt: 0,     // 下一次续波形的时间

    activeChannels: null, // 下发过强度的通道 {A:true,B:true}
    deathHandled: false,  // 死亡处理只做一次
    comboCount: 0,        // 连击层数
    comboLastAt: -1e9,    // 上次连击时间
    lastBurstAt: -1e9,    // 上次触发波形的时间
    lastPulseAt: 0,       // 上次真正发出波形的时间
    waveOverride: '',     // 随机波形时这一次用的波形
    waveNow: '',          // 轮换当前用的波形（只存在内存里，不写 sp）
    powerHinted: false,   // 本次世界是否已提示过「总开关/屏蔽输出」
    deviceZeroSince: 0,   // 设备回报强度一直是 0 的起始时间
    deviceZeroHinted: false,
    offlineStop: false,   // 连不上太久，已自动停止输出
    waveHits: 0,          // 距离上次轮换累计的受伤次数
    waveSwitchAt: 0,      // 延迟轮换的到点时间（0 = 没有待切换）
    waveNextAt: 0,        // 定时轮换的下次时间
    lastWaveSwitchAt: -1e9,  // 上次轮换的时间
    fullHpSince: 0,       // 从什么时候开始满血（兜底清电用）
    zeroHoldUntil: 0,     // 手动归零后的静默期
    lastAddAmount: 0,     // 上次加了多少电
    lastAddAt: 0,         // 上次加电的时间
    lastTipAt: 0,         // 上次发屏幕提示的时间
    tipShown: '',         // 上次提示的内容
    pendingAdd: 0,        // 「受伤后延迟加电」攒着的电量
    pendingAt: 0,         // 上面这批电量什么时候生效
    pendingBurstSec: 0,   // 上面这批电量对应的波形时长
    respawnGraceUntil: 0, // 复活保护到什么时候
    decayFrom: 0,         // 回落起始电量
    decayStart: 0,        // 回落开始时间
    decayUntil: 0,        // 回落结束时间（0 = 没在回落）
    minuteStartedAt: 0,   // 每分钟加电上限的窗口起点
    minuteEnergy: 0,      // 本分钟已加的电量
    lastNoticeAt: 0,      // 上一条提示的时间
    secondStartedAt: 0,   // 每秒加电上限用的窗口起点
    secondEnergy: 0,      // 本秒已加的电量
    paused: false,      // !dg pause 临时暂停
    lastError: '',
    pairingUrl: '',

    stats: { hits: 0, damage: 0, pulses: 0, sends: 0, heals: 0 },
};

/* ---- 通道相关小工具（A = 左路，B = 右路） ---- */

function channelPlan() {
    var ch = String(CONFIG.channel || 'A').toUpperCase();
    var out = [];
    var mainWave = S.waveNow || CONFIG.waveform;       // 轮换中的波形优先
    var waveA = mainWave;
    var waveB = CONFIG.bWaveform || mainWave;          // 右路可单独设波形
    if (ch === 'B') {
        out.push({ letter: 'B', scale: 1, offset: 0, wave: waveB });
    } else if (ch === 'AB') {
        out.push({ letter: 'A', scale: 1, offset: 0, wave: waveA });
        out.push({
            letter: 'B',
            scale: Number(CONFIG.bScale) === 0 ? 0 : (Number(CONFIG.bScale) || 1),
            offset: Number(CONFIG.bOffset) || 0,
            wave: waveB,
        });
    } else {
        out.push({ letter: 'A', scale: 1, offset: 0, wave: waveA });
    }
    return out;
}

function lettersForChannelValue(value) {
    var v = String(value === undefined || value === null ? 'A' : value).toUpperCase();
    if (v === 'AB') return ['A', 'B'];
    if (v === 'B') return ['B'];
    return ['A'];
}

function channelLetters() {
    var plan = channelPlan();
    var out = [];
    for (var i = 0; i < plan.length; i++) out.push(plan[i].letter);
    return out;
}

function markActiveChannel(letter) {
    if (!S.activeChannels) S.activeChannels = {};
    S.activeChannels[letter] = true;
}

function activeChannelLetters() {
    var out = [];
    var k;
    if (S.activeChannels) {
        for (k in S.activeChannels) {
            if (S.activeChannels.hasOwnProperty(k)) out.push(k);
        }
    }
    if (!out.length) out = channelLetters();
    return out;
}

function zeroLetters() {
    if (CONFIG.zeroBothChannels) return ['A', 'B'];
    return activeChannelLetters();
}

/* ---- 7. DG-LAB V3 客户端 ---- */

var DG = {
    ws: null,
    state: 'idle',   // idle | connecting | waiting | paired | closed
    myId: '',        // 控制端 clientId（配对地址里的那串）
    appId: '',       // APP 端 clientId
    sentStrength: -1,
    pendingStrength: null,
    lastSendAt: 0,
    lastHeartbeatAt: 0,
    reconnectAt: 0,
    retry: 0,
    device: { A: 0, B: 0, limitA: 0, limitB: 0 },

    url: function () {
        var base = String(CONFIG.relayUrl || '').trim();
        if (!base) base = DEFAULT_CONFIG.relayUrl;
        if (!CONFIG.controllerId) return base;
        var sep = base.indexOf('?') >= 0 ? '&' : '?';
        return base + sep + 'cid=' + encodeURIComponentSafe(CONFIG.controllerId);
    },

    buildPairing: function (id) {
        var base = String(CONFIG.relayUrl || '').trim();
        if (!base) base = DEFAULT_CONFIG.relayUrl;
        if (base.charAt(base.length - 1) === '/') base = base.slice(0, -1);
        var appUrl = base + '/' + id;
        S.pairingUrl = appUrl;
        return appUrl;
    },

    qrLink: function (appUrl) {
        return 'https://www.dungeon-lab.com/app-download.php#DGLAB-SOCKET#' + encodeURIComponentSafe(appUrl);
    },

    connect: function (url) {
        if (!MOD.socket || !MOD.socket.WebSocket) {
            S.lastError = 'socket 模块不可用，无法连接';
            logAlways(S.lastError);
            return false;
        }
        this.close(true);
        var self = this;
        var ws = null;
        try {
            ws = new MOD.socket.WebSocket(url);
        } catch (e) {
            S.lastError = '创建 WebSocket 失败: ' + e;
            reportError('创建 WebSocket 失败', e, '游戏里可能没有 socket 模块');
            logAlways(S.lastError);
            return false;
        }
        this.ws = ws;
        this.state = 'connecting';
        this.retry = 0;
        this.myId = '';
        this.appId = '';
        this.sentStrength = -1;
        this.pendingStrength = null;
        try {
            /* 回调先认自己的 socket：否则旧的关闭事件会把新连接打掉 */
            ws.setOnOpenListener(function () {
                if (self.ws !== ws) return;
                try {
                    self.state = 'waiting';
                    logAlways('已连接中继', url);
                } catch (e) {
                    reportError('WebSocket 连接成功回调', e);
                }
            });
            ws.setOnTextMessageListener(function (msg) {
                if (self.ws !== ws) return;
                try {
                    self.onText(msg);
                } catch (e) {
                    reportError('处理中继发来的消息', e, '内容前 60 字：' + String(msg).slice(0, 60));
                }
                try {
                    keepHooked('中继消息');     // 这条回调不受全局事件被替换的影响
                } catch (e2) { /* 忽略 */ }
            });
            ws.setOnClosedListener(function (code, reason) {
                if (self.ws !== ws) return;
                try {
                    self.onClosed(code, reason);
                } catch (e) {
                    reportError('WebSocket 断开回调', e, 'code=' + code);
                }
            });
            ws.setOnErrorListener(function (err) {
                if (self.ws !== ws) return;
                try {
                    reportError('连不上中继', new Error(String(err)),
                        '先确认 Termux 里 dglab 还在跑（地址 ' + url + '）');
                } catch (e) {
                    /* 忽略 */
                }
            });
            ws.connect();
        } catch (e) {
            reportError('连接中继失败', e, '先确认 Termux 里 dglab 还在跑（地址 ' + url + '）');
            this.state = 'closed';
            return false;
        }
        return true;
    },

    close: function (silent) {
        var ws = this.ws;
        this.ws = null;
        this.state = 'idle';
        this.myId = '';
        this.appId = '';
        this.sentStrength = -1;
        this.pendingStrength = null;
        if (ws) {
            try {
                ws.close();
            } catch (e) {
                /* 忽略 */
            }
        }
        if (!silent) {
            S.chargeUntil = 0;
            S.nextPulseAt = 0;
        }
    },

    frame: function (obj) {
        if (!this.ws || this.state !== 'paired') return false;
        try {
            this.ws.sendMessage(JSON.stringify(obj));
            S.stats.sends++;
            log('>', JSON.stringify(obj).slice(0, 300));
            return true;
        } catch (e) {
            var brief = '';
            try { brief = JSON.stringify(obj).slice(0, 60); } catch (e2) { brief = '(内容无法序列化)'; }
            reportError('发送消息给中继失败', e, '内容前 60 字：' + brief);
            logAlways(S.lastError);
            return false;
        }
    },

    queueStrength: function (v) {
        this.pendingStrength = Math.round(v);
    },

    /* 通道/倍率/偏移变了，重发一次当前强度 */
    invalidateStrength: function () {
        this.sentStrength = -1;
        this.pendingStrength = null;
    },

    resendStrength: function (t) {
        this.invalidateStrength();
        if (this.state !== 'paired') return;
        this.queueStrength(Math.round(clamp(S.strength, 0, CONFIG.maxStrength)));
        this.flushStrength(t, true);
    },

    flushStrength: function (t, force) {
        if (this.pendingStrength === null) return;
        if (this.state !== 'paired') return;   // 没配对就别消费掉待发值，等配对后再发
        /* 节流统一放这里，否则「受伤瞬间到位」会绕过每秒下发上限 */
        var interval = 1000 / clamp(CONFIG.maxSendPerSec, 1, 50);
        if (!force && t - this.lastSendAt < interval) return;   // 留在 pending，交给 pump 稍后发
        var v = this.pendingStrength;
        this.pendingStrength = null;
        this.lastSendAt = t;
        this.sentStrength = v;
        var plan = channelPlan();
        for (var i = 0; i < plan.length; i++) {
            var val = Math.round(v * plan[i].scale + plan[i].offset);
            if (val < 0) val = 0;
            if (val > CONFIG.maxStrength) val = CONFIG.maxStrength;
            markActiveChannel(plan[i].letter);
            this.frame({
                type: 3,
                clientId: this.myId,
                targetId: this.appId,
                channel: plan[i].letter,
                strength: val,
                message: 'set channel', // 不能用 'strength'：中继会当成 APP 回传直接透传
            });
        }
    },

    sendPulse: function (sec) {
        if (this.state !== 'paired') return false;
        var plan = channelPlan();
        var ok = false;
        var time = Math.max(1, Math.round(sec));
        var fallback = WAVE_FRAMES[S.waveNow || CONFIG.waveform] || WAVE_FRAMES.BUBBLE;
        for (var i = 0; i < plan.length; i++) {
            var letter = plan[i].letter;
            var followMain = (letter === 'A') || !CONFIG.bWaveform;
            var waveId = (CONFIG.randomWaveform && S.waveOverride && followMain) ? S.waveOverride : plan[i].wave;
            var frames = WAVE_FRAMES[waveId] || fallback;
            if (!frames || !frames.length) continue;
            frames = resampleFrames(frames, CONFIG.waveSpeed);
            if (letter === 'B') frames = shiftFrames(frames, CONFIG.bWaveShiftFrames);
            markActiveChannel(letter);
            if (this.frame({
                type: 'clientMsg',
                clientId: this.myId,
                targetId: this.appId,
                channel: letter,
                time: time,
                message: letter + ':' + JSON.stringify(frames),
            })) ok = true;
        }
        if (ok) {
            S.stats.pulses++;
            S.lastPulseAt = nowMs();
        }
        return ok;
    },

    clearChannel: function (letter) {
        if (this.state !== 'paired') return false;
        return this.frame({
            type: 4,
            clientId: this.myId,
            targetId: this.appId,
            channel: letter === 'B' ? 'B' : 'A',
            message: 'clear',
        });
    },

    clearPulse: function () {
        var letters = zeroLetters();
        var ok = false;
        for (var i = 0; i < letters.length; i++) {
            if (this.clearChannel(letters[i])) ok = true;
        }
        return ok;
    },

    zeroChannel: function (letter) {
        if (this.state !== 'paired') return;
        this.frame({
            type: 3,
            clientId: this.myId,
            targetId: this.appId,
            channel: letter === 'B' ? 'B' : 'A',
            strength: 0,
            message: 'set channel',
        });
        this.clearChannel(letter);
    },

    /* 立即归零：两路都清，避免另一路残留 */
    zero: function () {
        this.pendingStrength = null;
        this.sentStrength = 0;
        S.activeChannels = null;
        if (this.state !== 'paired') return;
        var letters = zeroLetters();
        for (var i = 0; i < letters.length; i++) this.zeroChannel(letters[i]);
    },

    onText: function (text) {
        var data = null;
        try {
            data = JSON.parse(text);
        } catch (e) {
            return;
        }
        if (!data || typeof data !== 'object') return;
        var type = data.type;

        if (type === 'bind') {
            if (typeof data.clientId !== 'string' || !data.clientId) return;
            var paired = data.message === '200' && typeof data.targetId === 'string' && data.targetId;
            if (paired) {
                this.myId = data.clientId;
                this.appId = data.targetId;
                this.state = 'paired';
                this.sentStrength = -1;
                this.pendingStrength = null;
                var appUrl = this.buildPairing(this.myId);
                logAlways('设备已连接，配对地址', appUrl);
                notice('设备已连接，当前强度 ' + Math.round(S.strength), true);
                if (!S.powerHinted) {
                    S.powerHinted = true;
                    notice('感觉不到电的话：APP 里打开「总开关」、关掉「屏蔽输出」', true);
                }
                this.queueStrength(0);
                this.flushStrength(nowMs(), true);   /* 配对瞬间要立刻生效，不受节流影响 */
            } else if (!data.targetId) {
                this.myId = data.clientId;
                this.state = 'waiting';
                var url = this.buildPairing(this.myId);
                logAlways('等待 APP 连接:', url);
            }
            return;
        }

        if (type === 'break') {
            this.appId = '';
            this.sentStrength = -1;
            if (this.state === 'paired') {
                this.state = 'waiting';
                notice('设备已断开，等待重新连接', true);
            }
            return;
        }

        if (type === 'error') {
            S.lastError = '中继错误 ' + String(data.message);
            logAlways(S.lastError);
            return;
        }

        if (type === 'heartbeat') return;

        if (type === 'notify') {
            log('中继通知:', data.message);
            return;
        }

        if (type === 'msg' || type === 4) {
            var m = String(data.message === undefined ? '' : data.message);
            /* APP 回传：strength-A强度+B强度+A上限+B上限 */
            var full = /^strength-(\d+)\+(\d+)\+(\d+)\+(\d+)$/.exec(m);
            if (full) {
                var oldA = this.device.A;
                var oldB = this.device.B;
                this.device.A = Number(full[1]);
                this.device.B = Number(full[2]);
                this.device.limitA = Number(full[3]);
                this.device.limitB = Number(full[4]);
                if (oldA !== this.device.A || oldB !== this.device.B) {
                    noticeRoutine('设备强度变化：左 ' + this.device.A + '　右 ' + this.device.B);
                }
                log('设备强度回传 A=' + this.device.A + ' B=' + this.device.B);
                return;
            }
            /* 单通道：strength-1+2+20 */
            var one = /^strength-(\d+)\+(\d+)\+(\d+)$/.exec(m);
            if (one) {
                if (Number(one[1]) === 1) this.device.A = Number(one[3]);
                else this.device.B = Number(one[3]);
                return;
            }
            /* APP 按钮：feedback-1 */
            var fb = /^feedback-(\d+)$/.exec(m);
            if (fb) {
                log('APP 反馈', fb[1]);
                return;
            }
            log('<', m);
            return;
        }

        log('<', text);
    },

    onClosed: function (code, reason) {
        var was = this.state;
        this.ws = null;
        this.state = 'closed';
        this.myId = '';
        this.appId = '';
        this.sentStrength = -1;
        this.pendingStrength = null;
        logAlways('连接关闭 code=' + code + ' reason=' + (reason || '-'));
        if (was === 'paired') chat('[DG-LAB] 与中继断开');
        /* 暂停时也排上重连计划，否则「暂停→掉线→恢复」后永远不重连 */
        if (CONFIG.autoReconnect) {
            var wait = Math.min(30000, 2000 * Math.pow(2, Math.min(this.retry, 4)));
            this.retry++;
            this.reconnectAt = nowMs() + wait;
            log('将在 ' + wait + 'ms 后重连');
        }
    },

    pump: function (t) {
        /* 连不上：到点就自动停，之后安静地继续重连；连上自动恢复 */
        if (this.state !== 'paired') {
            if (!this.offlineSince) this.offlineSince = t;
            var offSec = Math.round((t - this.offlineSince) / 1000);
            if (!S.offlineStop && CONFIG.offlineStopSec > 0 && offSec >= CONFIG.offlineStopSec) {
                S.offlineStop = true;
                resetOutput('连不上中继，已自动停');
                chat('[DG-LAB] 连不上中继已经 ' + offSec + ' 秒，先自动停下了（中继起来后会自动继续）');
            } else if (!S.offlineStop && offSec >= 60 && t - (this.lastOfflineTip || 0) >= 60000) {
                this.lastOfflineTip = t;
                chat('[DG-LAB] 还没连上中继（已 ' + offSec + ' 秒）' +
                    (CONFIG.paused ? '｜当前是暂停状态' : '｜去 Termux 里敲 dglab 启动中继') +
                    '，连上后会自动继续');
            }
        } else if (this.offlineSince) {
            this.offlineSince = 0;
            this.lastOfflineTip = 0;
            if (S.offlineStop) {
                S.offlineStop = false;
                chat('[DG-LAB] 中继已连上，自动继续');
            }
        }
        if (this.state === 'closed' && this.reconnectAt && t >= this.reconnectAt) {
            if (CONFIG.autoReconnect && !S.paused && CONFIG.enabled) {
                this.reconnectAt = 0;
                this.connect(this.url());
            } else {
                this.reconnectAt = t + Math.round(clamp(CONFIG.reconnectSec, 0.5, 30) * 1000);
            }
        }
        if (this.state === 'paired') {
            var interval = 1000 / clamp(CONFIG.maxSendPerSec, 1, 50);
            if (this.pendingStrength !== null && t - this.lastSendAt >= interval) this.flushStrength(t);
            if (t - this.lastHeartbeatAt > clamp(CONFIG.heartbeatSec, 5, 120) * 1000) {
                this.lastHeartbeatAt = t;
                this.frame({
                    type: 'heartbeat',
                    clientId: this.myId,
                    targetId: this.appId,
                    message: '200',
                });
            }
        }
    },
};

/* ---- 8. 玩家生命读取 ---- */

function resolvePlayer() {
    var p = null;
    try {
        if (MOD.player && MOD.player.getLocalPlayer) p = MOD.player.getLocalPlayer();
    } catch (e) {
        p = null;
    }
    if (p) return p;

    /* 回退路径不能直接取 getPlayers()[0]：多人时那是别人，会把别人的掉血算到自己头上。
     * 只在 uid 对得上、或刚进世界且只有一个人时才认。 */
    try {
        var world = MOD.world && MOD.world.getClientWorld ? MOD.world.getClientWorld() : null;
        if (world && world.getPlayers) {
            var list = world.getPlayers();
            if (!list || !list.length) return null;
            var i, uid;
            if (S.playerUid) {
                for (i = 0; i < list.length; i++) {
                    try {
                        uid = list[i] && list[i].getUniqueID ? String(list[i].getUniqueID()) : '';
                    } catch (e3) {
                        uid = '';
                    }
                    if (uid && uid === S.playerUid) return list[i];
                }
                log('回退找玩家：列表里没有 uid=' + S.playerUid + ' 的实体，本刻不读血量');
                return null;
            }
            if (list.length === 1) return list[0];
            log('回退找玩家：多人且 uid 未知，本刻不读血量');
            return null;
        }
    } catch (e2) {
        /* 忽略 */
    }
    return null;
}

function readAttr(actor, name, fallback) {
    try {
        if (!actor || !actor.getAttribute) return fallback;
        var a = actor.getAttribute(name);
        if (!a) return fallback;
        var cur = Number(a.current);
        return isNaN(cur) ? fallback : cur;
    } catch (e) {
        return fallback;
    }
}

/* 创造(1)/旁观(3) 是否要忽略：数字和字符串写法都认 */
function isIgnoredGameType(p) {
    try {
        if (!p || !p.getGameType) return false;
        var gt = p.getGameType();
        if (typeof gt === 'string') {
            var s = gt.toLowerCase();
            return s === 'creative' || s === 'spectator' || s === '1' || s === '3';
        }
        return gt === 1 || gt === 3;
    } catch (e) {
        return false;
    }
}

/* 返回 null 表示这刻读不到（还没进世界 / 切换维度中） */
function readVitals(p) {
    var hp = readAttr(p, 'minecraft:health', null);
    if (hp === null) return null;
    var maxHp = 20;
    try {
        var a = p.getAttribute('minecraft:health');
        if (a && a.max !== undefined) maxHp = Number(a.max) || 20;
    } catch (e) {
        /* 忽略 */
    }
    var absorb = 0;
    if (CONFIG.countAbsorption) absorb = readAttr(p, 'minecraft:absorption', 0);
    return { hp: hp, maxHp: maxHp, absorb: absorb, total: hp + absorb };
}

/* ---- 9. 加电引擎 ---- */

function resetOutput(reason, holdMs) {
    var hold = Number(holdMs) || 0;
    if (hold > 0) S.zeroHoldUntil = nowMs() + clamp(hold, 0, 10000);
    S.energy = 0;
    S.strength = 0;
    S.chargeUntil = 0;
    S.nextPulseAt = 0;
    S.comboCount = 0;
    S.waveOverride = '';
    S.decayUntil = 0;     // 归零/暂停/退出世界时，回落也一起停
    S.decayFrom = 0;
    S.waveSwitchAt = 0;   // 别把上个世界/归零前排队的切换带过来
    S.waveHits = 0;
    S.waveNow = '';
    S.secondEnergy = 0;
    S.pendingAdd = 0;
    S.pendingBurstSec = 0;
    DG.zero();
    log('输出归零:', reason || '');
}

function energyCapValue() {
    var cap = Math.min(CONFIG.energyCap, CONFIG.maxStrength - baseStrengthValue());
    return cap > 0 ? cap : 0;
}

/* 基础强度也不能超过强度上限，否则满血零电量也会常驻在上限上 */
function baseStrengthValue() {
    var b = Number(CONFIG.baseStrength) || 0;
    if (b > CONFIG.maxStrength) b = CONFIG.maxStrength;
    if (b < 0) b = 0;
    return b;
}

function strengthTarget() {
    var base = baseStrengthValue();
    var target = base + S.energy;
    if (target > base + energyCapValue()) target = base + energyCapValue();
    if (target > CONFIG.maxStrength) target = CONFIG.maxStrength;
    if (target < 0) target = 0;
    return target;
}

function isHpTooLow() {
    var line = Number(CONFIG.stopBelowHp) || 0;
    if (line <= 0) return false;
    if (S.lastHp === null) return false;
    return S.lastHp > 0.01 && S.lastHp <= line;
}

/* 把波形时间往后推（受伤 / 死亡 / 延迟到点都走这里） */
function extendCharge(t, durSec) {
    var until = t + Math.round(Number(durSec) * 1000);
    if (until > S.chargeUntil) S.chargeUntil = until;
}

function applyRateCaps(add, t) {
    if (CONFIG.energyPerSecondCap > 0) {
        if (t - S.secondStartedAt >= 1000) {
            S.secondStartedAt = t;
            S.secondEnergy = 0;
        }
        var roomS = CONFIG.energyPerSecondCap - S.secondEnergy;
        if (roomS < 0) roomS = 0;
        if (add > roomS) add = roomS;
        S.secondEnergy += add;
    }
    if (CONFIG.energyPerMinuteCap > 0) {
        if (t - S.minuteStartedAt >= 60000) {
            S.minuteStartedAt = t;
            S.minuteEnergy = 0;
        }
        var roomM = CONFIG.energyPerMinuteCap - S.minuteEnergy;
        if (roomM < 0) roomM = 0;
        if (add > roomM) add = roomM;
        S.minuteEnergy += add;
    }
    return add;
}

/* 立刻把强度推到目标值（不等节流、不做渐变）——受伤 / 死亡时用 */
function applyStrengthNow(t) {
    var target = strengthTarget();
    S.strength = target;
    var want = Math.round(clamp(target, 0, CONFIG.maxStrength));
    if (want !== DG.sentStrength || DG.pendingStrength !== null) {
        DG.queueStrength(want);
        DG.flushStrength(t);   /* 不强制：由 flushStrength 按「每秒最多下发」节流 */
    }
}

/* 波形速度：>1 抽帧（内容更快），<1 重复帧（内容更慢），长度不变 */
function resampleFrames(frames, speed) {
    var sp = Number(speed);
    if (!frames || !frames.length || !isFinite(sp) || sp === 1) return frames;
    var out = [];
    for (var i = 0; i < frames.length; i++) {
        var idx = Math.floor(i * sp) % frames.length;
        if (idx < 0) idx += frames.length;
        out.push(frames[idx]);
    }
    return out;
}

/* 把波形帧循环错开 n 帧（双路时让左右不同步） */
function shiftFrames(frames, n) {
    if (!frames || !frames.length) return frames;
    var k = Math.round(Number(n) || 0) % frames.length;
    if (k < 0) k += frames.length;
    if (!k) return frames;
    return frames.slice(k).concat(frames.slice(0, k));
}

/* 伤害换算曲线：让「小伤小电、重伤大电」的比例可控 */
function curveDamage(dmg) {
    var curve = CONFIG.damageCurve;
    if (curve === 'square') return dmg * dmg / 4;      // 4 点以下变轻，4 点以上变重
    if (curve === 'sqrt') return Math.sqrt(dmg) * 2;   // 小伤害也有明显感觉
    return dmg;
}

/* 这次受伤的倍率（重击 / 低血 / 连击） */
function damageMultiplier(dmg, t) {
    var mult = 1;
    var tags = [];
    if (CONFIG.critEnabled && dmg >= CONFIG.critDamage) {
        mult *= CONFIG.critFactor;
        tags.push('重击');
    }
    if (CONFIG.lowHpEnabled && S.lastMaxHp > 0 && S.lastHp !== null &&
        S.lastHp / S.lastMaxHp <= CONFIG.lowHpThreshold) {
        mult *= CONFIG.lowHpFactor;
        tags.push('低血');
    }
    if (CONFIG.comboEnabled) {
        if (t - S.comboLastAt <= CONFIG.comboWindowMs) S.comboCount++;
        else S.comboCount = 1;
        S.comboLastAt = t;
        if (S.comboCount > 1) {
            var cm = 1 + (S.comboCount - 1) * CONFIG.comboStep;
            if (cm > CONFIG.comboMax) cm = CONFIG.comboMax;
            mult *= cm;
            tags.push('连击' + S.comboCount);
        }
    }
    return { mult: mult, tags: tags };
}

function onDamage(dmg, t) {
    /* 暂停/关闭时绝不下发，否则会先加电再被抹掉，看起来像「归零无效」 */
    if (!CONFIG.enabled || S.paused) return;
    /* 刚手动归零的静默期：这段时间内不再加电 */
    if (t < S.zeroHoldUntil) {
        log('归零静默期内，忽略这次加电', round1(dmg));
        return;
    }
    if (t < S.respawnGraceUntil) {
        log('复活保护中（还剩 ' + Math.round((S.respawnGraceUntil - t) / 1000) + ' 秒），忽略这次加电');
        return;
    }
    if (isHpTooLow()) {
        log('血量低于停止线 ' + CONFIG.stopBelowHp + '，忽略这次加电');
        return;
    }

    S.stats.hits++;
    S.stats.damage += dmg;
    S.lastDamage = dmg;
    S.lastDamageAt = t;

    var info = damageMultiplier(dmg, t);
    var base = curveDamage(dmg);
    var add = base * CONFIG.strengthPerDamage * info.mult;
    if (CONFIG.maxEnergyPerHit > 0 && add > CONFIG.maxEnergyPerHit) add = CONFIG.maxEnergyPerHit;

    add = applyRateCaps(add, t);

    /* 回落中又挨打：让位给新伤害 */
    if (S.decayUntil) {
        S.decayUntil = 0;
        S.decayFrom = 0;
        log('复活回落中断：又挨打了');
    }

    /* 攒够次数就换波形 */
    if (CONFIG.waveRotateMode !== 'off' && CONFIG.waveRotateOnHit) {
        S.waveHits++;
        var everyN = Math.max(1, Math.round(CONFIG.waveRotateEveryN));
        if (S.waveHits >= everyN && !S.waveSwitchAt &&
            t - S.lastWaveSwitchAt >= CONFIG.waveRotateMinGapMs) {
            S.waveSwitchAt = t + Math.max(0, Math.round(CONFIG.waveRotateDelayMs));
        }
    }

    /* 这一段波形（算好时长，可能要延迟才用） */
    var burstSec = 0;
    if (CONFIG.burstEnabled && (CONFIG.pulseCooldownMs <= 0 || t - S.lastBurstAt >= CONFIG.pulseCooldownMs)) {
        burstSec = clamp(CONFIG.burstBaseSec + dmg * CONFIG.burstPerDamageSec, 0.5, CONFIG.burstMaxSec);
        S.lastBurstAt = t;
    }

    /* 受伤后延迟加电：先攒着，到点再一次性加上（波形也一起延后） */
    if (CONFIG.startDelaySec > 0) {
        S.pendingAdd += add;
        S.pendingAt = t + Math.round(CONFIG.startDelaySec * 1000);
        if (burstSec > S.pendingBurstSec) S.pendingBurstSec = burstSec;
    } else {
        S.energy = Math.min(S.energy + add, energyCapValue());
        S.lastAddAmount = add;
        S.lastAddAt = t;
        if (CONFIG.randomWaveform && CONFIG.waveRotateMode === 'off' && WAVE_IDS.length) {
            S.waveOverride = WAVE_IDS[Math.floor(Math.random() * WAVE_IDS.length)];
        }
        if (burstSec > 0) extendCharge(t, burstSec);
        if (CONFIG.instantRise) applyStrengthNow(t);
    }

    {
        noticeRoutine('掉血 ' + round1(dmg) + (info.tags.length ? '（' + info.tags.join('、') + '）' : '') +
            '，电量 ' + round1(S.energy) + '，强度 ' + Math.round(S.strength));
    }
    log('受伤', round1(dmg), 'x' + info.mult, '电量', round1(S.energy), '波形到', S.chargeUntil - t, 'ms');
}

/* 只有回血才减电量：默认「回满血才清」，没回满就一直电 */
function onHeal(amount, t) {
    if (!CONFIG.healReduces) return;
    if (!CONFIG.enabled || S.paused) return;
    S.stats.heals++;
    S.comboCount = 0;

    var full = (S.lastMaxHp > 0 && S.lastHp !== null && S.lastHp >= S.lastMaxHp - 0.01);
    var drop = amount * CONFIG.strengthPerDamage * CONFIG.healFactor;
    var floor = Math.min(CONFIG.hurtFloorEnergy, energyCapValue());

    if (CONFIG.healMode === 'full') {
        if (full && (S.decayUntil > t || (S.deathHandled && CONFIG.respawnDecaySec > 0))) {
            /* 复活这一下也是「回满血」，但要让回落曲线接管，不能瞬间清电 */
            log('复活/回落中，回满血不清电');
        } else if (full) {
            var hadEnergy = S.energy > 0;
            S.energy = 0;
            S.waveOverride = '';
            if (CONFIG.instantFall) applyStrengthNow(t);
            if (hadEnergy) noticeRoutine('回满血，电量已清');
        } else {
            log('回血 ' + round1(amount) + '（没回满，电量保持 ' + round1(S.energy) + '）');
        }
    } else if (CONFIG.healMode === 'ratioFloor') {
        S.energy = Math.max(0, S.energy - drop);
        if (!full && floor > 0 && S.energy < floor) S.energy = floor;
        if (CONFIG.instantFall) applyStrengthNow(t);
    } else {
        S.energy = Math.max(0, S.energy - drop);
        if (CONFIG.instantFall) applyStrengthNow(t);
    }

    if (CONFIG.healPulse && CONFIG.burstEnabled) {
        var until = t + Math.max(1000, Math.round(CONFIG.burstBaseSec * 1000 / 2));
        if (until > S.chargeUntil) S.chargeUntil = until;
    }

    log('回血', round1(amount), '模式', CONFIG.healMode, '剩余电量', round1(S.energy));
}

/* 提示内容：用哪个通道就显示哪个 */
function tipText() {
    var parts = [];
    var mode = CONFIG.tipContent;
    if (mode === 'energy' || mode === 'both') parts.push('电量 ' + round1(S.energy));
    if (mode !== 'energy') {
        var plan = channelPlan();
        for (var i = 0; i < plan.length; i++) {
            var letter = plan[i].letter;
            var v;
            if (CONFIG.tipSource === 'device') {
                v = (letter === 'A') ? DG.device.A : DG.device.B;
            } else {
                v = Math.round(S.strength * plan[i].scale + plan[i].offset);
            }
            if (!isFinite(v) || v < 0) v = 0;
            parts.push(letter + ' ' + Math.round(v));
        }
    }
    return 'DG-LAB｜' + parts.join('　');
}

/* 到间隔就刷一次屏幕提示 */
function tickTip(t) {
    if (!CONFIG.tipEnabled) {
        S.tipShown = '';
        S.lastTipAt = 0;
        return;
    }
    var gap = clamp(CONFIG.tipIntervalMs, 200, 10000);
    if (t - S.lastTipAt < gap) return;
    S.lastTipAt = t;
    var text;
    if (!CONFIG.enabled) text = 'DG-LAB｜已关闭';
    else if (S.paused) text = 'DG-LAB｜已暂停';
    else if (DG.state !== 'paired') text = 'DG-LAB｜等待设备';
    else text = tipText();
    S.tipShown = text;
    try {
        if (MOD.minecraft && MOD.minecraft.showTipMessage) MOD.minecraft.showTipMessage(text);
        else log('这个游戏的 ModAPI 没有 showTipMessage，屏幕提示用不了');
    } catch (e) {
        S.lastError = '屏幕提示失败: ' + e;
    }
}

/* 轮换：顺序取下一个，或随机取一个不同的 */
function rotateWave(t) {
    var mode = CONFIG.waveRotateMode;
    if ((mode !== 'sequence' && mode !== 'random') || WAVE_IDS.length < 2) return false;
    var idx = WAVE_IDS.indexOf(S.waveNow || CONFIG.waveform);
    if (idx < 0) idx = 0;
    var next;
    if (mode === 'random') {
        if (WAVE_IDS.length < 2) return false;
        do {
            next = Math.floor(Math.random() * WAVE_IDS.length);
        } while (next === idx);
    } else {
        next = (idx + 1) % WAVE_IDS.length;
    }
    S.waveNow = WAVE_IDS[next];
    S.waveOverride = '';       // 轮换换掉的波形不能被旧的「随机波形」结果盖住
    S.nextPulseAt = 0;         // 立刻用新波形，不等当前这段放完
    S.waveHits = 0;
    S.lastWaveSwitchAt = t;
    log('波形轮换 →', S.waveNow);
    return true;
}

/* 定时轮换 + 受伤后的延迟轮换 */
function tickWaveRotate(t) {
    var mode = CONFIG.waveRotateMode;
    if (mode !== 'sequence' && mode !== 'random') {
        S.waveSwitchAt = 0;
        S.waveNextAt = 0;
        return;
    }
    if (CONFIG.waveRotateIntervalSec > 0) {
        if (S.waveNextAt === 0) S.waveNextAt = t + Math.round(CONFIG.waveRotateIntervalSec * 1000);
        else if (t >= S.waveNextAt) {
            S.waveNextAt = t + Math.round(CONFIG.waveRotateIntervalSec * 1000);
            if (t - S.lastWaveSwitchAt >= CONFIG.waveRotateMinGapMs) {
                S.waveSwitchAt = 0;    // 定时轮换已经换了，取消待处理的延迟切换，避免同一刻连换两次
                rotateWave(t);
            } else if (!S.waveSwitchAt) {
                /* 被最小间隔挡住：不丢弃，等间隔一到就换（和受伤触发的语义一致） */
                S.waveSwitchAt = S.lastWaveSwitchAt + CONFIG.waveRotateMinGapMs;
            }
        }
    } else {
        S.waveNextAt = 0;
    }
    if (S.waveSwitchAt && t >= S.waveSwitchAt) {
        S.waveSwitchAt = 0;
        if (t - S.lastWaveSwitchAt >= CONFIG.waveRotateMinGapMs) rotateWave(t);
    }
}

function keepPulse(t) {
    if (!CONFIG.burstEnabled) return;
    if (t >= S.chargeUntil) return;
    if (t < S.nextPulseAt) return;
    var remain = S.chargeUntil - t;
    var sec = clamp(Math.ceil(remain / 1000), 1, CONFIG.burstMaxSec);
    if (DG.sendPulse(sec)) {
        /* 提前量不能吃掉整段波形，否则每个游戏刻都会重发 */
        var lead = clamp(CONFIG.pulseLeadMs, 0, 2000);
        var next = t + Math.round(sec * 1000) - lead;
        if (next < t + 300) next = t + 300;   /* 最短 300ms 一次，防止刷屏 */
        S.nextPulseAt = next;
        log('续波形', sec, 's 剩余', Math.round(remain), 'ms');
    } else {
        S.nextPulseAt = t + 500;
    }
}

function engineTick(t, dtMs) {
    var dt = dtMs / 1000;

    if (!CONFIG.enabled || S.paused || S.offlineStop) {
        if (S.energy > 0 || S.strength > 0 || DG.sentStrength > 0 || S.chargeUntil > 0) {
            resetOutput(S.paused ? '已暂停' : (S.offlineStop ? '连不上中继，已自动停' : '总开关关闭'));
        }
        return;
    }

    tickWaveRotate(t);

    /* 低于停止线：完全停手（血回来了会自动恢复） */
    if (isHpTooLow()) {
        if (S.energy > 0 || S.strength > 0 || S.chargeUntil > 0) {
            resetOutput('血量低于停止线');
            notice('血量过低，已停止加电', true);
        }
        return;
    }

    if (S.pendingAdd > 0 && t >= S.pendingAt) {
        var pa = S.pendingAdd;
        S.pendingAdd = 0;
        S.energy = Math.min(S.energy + pa, energyCapValue());
        S.lastAddAmount = pa;
        S.lastAddAt = t;
        if (CONFIG.randomWaveform && CONFIG.waveRotateMode === 'off' && WAVE_IDS.length) {
            S.waveOverride = WAVE_IDS[Math.floor(Math.random() * WAVE_IDS.length)];
        }
        if (S.pendingBurstSec > 0) {
            extendCharge(t, S.pendingBurstSec);
            S.pendingBurstSec = 0;
        }
        if (CONFIG.instantRise) applyStrengthNow(t);
        log('延迟加电生效', round1(pa));
    }

    /* 最低输出电量：低于它就彻底停（防止 1 点残电一直放） */
    if (CONFIG.minOutputEnergy > 0 && !(S.decayUntil > t) && S.energy < CONFIG.minOutputEnergy && S.energy > 0) {
        S.energy = 0;
        S.chargeUntil = 0;
        S.waveOverride = '';
    }

    /* 自然回落：默认关闭（decayPerSec = 0），只有回血才减电量 */
    if (CONFIG.decayPerSec > 0 && S.energy > 0 && t - S.lastDamageAt > CONFIG.holdSec * 1000) {
        S.energy -= CONFIG.decayPerSec * dt;
        if (S.energy < 0) S.energy = 0;
        S.comboCount = 0;
    }

    /* 满血兜底：黄心被打掉时血量没变，等不到回血事件，这里按时间兜底清电 */
    if (CONFIG.clearWhenFullHp && CONFIG.healReduces && !(S.decayUntil > t) && S.lastHp !== null && S.lastMaxHp > 0) {
        var isFullHp = (S.lastHp > 0.01 && S.lastHp >= S.lastMaxHp - 0.01);
        if (isFullHp) {
            if (!S.fullHpSince) S.fullHpSince = t;
            if (S.energy > 0 && t - S.fullHpSince >= clamp(CONFIG.fullHpClearDelayMs, 0, 5000)) {
                S.energy = 0;
                S.waveOverride = '';
                S.comboCount = 0;
                if (CONFIG.instantFall) applyStrengthNow(t);
                noticeRoutine('满血，电量已清');
            }
        } else {
            S.fullHpSince = 0;
        }
    } else {
        S.fullHpSince = 0;
    }

    /* 没回满血时的电量保底（要尊重手动归零的静默期） */
    if (CONFIG.hurtFloorEnergy > 0 && !(S.decayUntil > t) && t >= S.zeroHoldUntil &&
        S.lastHp !== null && S.lastMaxHp > 0 &&
        S.lastHp > 0.01 && S.lastHp < S.lastMaxHp - 0.01) {
        var floorE = Math.min(CONFIG.hurtFloorEnergy, energyCapValue());
        if (floorE < CONFIG.minOutputEnergy) floorE = 0;   // 低于最低输出就彻底停，别把电又抬回来
        if (floorE > 0 && S.energy < floorE) S.energy = floorE;
    }

    /* 回落放在清电/保底之后，让它说了算 */
    if (S.decayUntil > t) {
        var span = S.decayUntil - S.decayStart;
        var k = span > 0 ? clamp((t - S.decayStart) / span, 0, 1) : 1;
        S.energy = clamp(S.decayFrom * (1 - k), 0, energyCapValue());
        if (S.energy < 0.01) S.energy = 0;
        S.lastDamageAt = t;
    } else if (S.decayUntil) {
        S.decayUntil = 0;
        S.decayFrom = 0;
        S.energy = 0;              // 收尾：确保真的归 0，不留最后一丁点
        S.waveOverride = '';
        S.comboCount = 0;
        log('复活回落结束，电量已归 0');
    }

    /* 电量没清就一直续波形（真正「一直电」） */
    if (CONFIG.continuousPulse && CONFIG.burstEnabled && S.energy > 0) {
        var keep = t + 1000;
        if (keep > S.chargeUntil) S.chargeUntil = keep;
    }

    var target = strengthTarget();
    if (target > S.strength) {
        S.strength = CONFIG.instantRise ? target : Math.min(target, S.strength + CONFIG.maxRisePerSecond * dt);
    } else if (target < S.strength) {
        S.strength = CONFIG.instantFall ? target : Math.max(target, S.strength - CONFIG.maxFallPerSecond * dt);
    }

    var want = Math.round(clamp(S.strength, 0, CONFIG.maxStrength));
    if (want !== DG.sentStrength && want !== DG.pendingStrength) DG.queueStrength(want);

    /* 设备回报强度一直是 0（我们却在发）：多半是 APP 没开总开关 / 开着屏蔽输出 */
    if (DG.state === 'paired' && want >= 5) {
        var devMax = Math.max(DG.device.A || 0, DG.device.B || 0);
        if (devMax <= 0) {
            if (!S.deviceZeroSince) S.deviceZeroSince = t;
            else if (t - S.deviceZeroSince > clamp(CONFIG.deviceZeroHintSec, 1, 60) * 1000 && !S.deviceZeroHinted) {
                S.deviceZeroHinted = true;
                notice('发了 ' + Math.round((t - S.deviceZeroSince) / 1000) + ' 秒，设备回报强度一直是 0：' +
                    '去 APP 打开「总开关」、关掉「屏蔽输出」（也可能是电极没接好）', true);
            }
        } else {
            S.deviceZeroSince = 0;
            S.deviceZeroHinted = false;
        }
    } else {
        S.deviceZeroSince = 0;
    }

    /* 设备强度被手动改高时拉回来（可选） */
    if (CONFIG.keepInSync && DG.state === 'paired' && t - DG.lastSendAt > clamp(CONFIG.keepInSyncMs, 300, 10000)) {
        var plan = channelPlan();
        for (var i = 0; i < plan.length; i++) {
            var expect = Math.round(S.strength * plan[i].scale + plan[i].offset);
            if (expect < 0) expect = 0;
            var actual = plan[i].letter === 'A' ? DG.device.A : DG.device.B;
            if (actual > expect) {
                log('设备强度 ' + actual + ' 高于期望 ' + expect + '，拉回');
                DG.queueStrength(want);
                break;
            }
        }
    }

    keepPulse(t);
}

/* ---- 10. 每个游戏刻 ---- */

function pollVitals(t) {
    var p = resolvePlayer();
    if (!p) {
        if (S.lastHp !== null) {
            /* 退出世界 / 换维度：清状态，避免误判伤害 */
            S.lastHp = null;
            S.lastTotal = null;
            S.player = null;
            S.playerUid = '';
        }
        return;
    }
    S.player = p;

    var uid = '';
    try {
        uid = p.getUniqueID ? String(p.getUniqueID()) : '';
    } catch (e) {
        uid = '';
    }
    if (uid && uid !== S.playerUid) {
        /* 换了玩家对象（重进世界）：重新校准，不当作伤害 */
        S.playerUid = uid;
        S.lastHp = null;
        S.lastTotal = null;
    }

    var v = readVitals(p);
    if (!v) return;
    S.lastMaxHp = v.maxHp;

    if (CONFIG.ignoreCreative && isIgnoredGameType(p)) {
        S.lastHp = v.hp;
        S.lastTotal = v.total;
        S.lastAbsorb = v.absorb;
        if (S.energy > 0) resetOutput('创造/旁观');
        return;
    }

    if (S.lastTotal === null || S.lastHp === null) {
        S.lastHp = v.hp;
        S.lastTotal = v.total;
        S.lastAbsorb = v.absorb;
        log('血量校准', v.hp, '/', v.maxHp, '吸收', v.absorb);
        return;
    }

    var dmg = S.lastTotal - v.total;
    var heal = v.total - S.lastTotal;

    /* 先更新血量再派发事件：onHeal 要按回血后的血量判断是否回满 */
    S.lastHp = v.hp;
    S.lastTotal = v.total;
    S.lastAbsorb = v.absorb;

    /* dmg > 0 不能省：最小伤害设 0 时，dmg=0 会被每刻当成受伤，波形无限续播 */
    if (dmg > 0.0001 && dmg >= CONFIG.minDamage) {
        onDamage(dmg, t);
    } else if (heal > 0.01) {
        onHeal(heal, t);
    }

    /* 死亡处理：默认把电量直接拉满 */
    if (v.hp > 0.01) {
        if (S.deathHandled) {
            S.deathHandled = false;
            if (CONFIG.respawnGraceSec > 0) {
                S.respawnGraceUntil = t + Math.round(CONFIG.respawnGraceSec * 1000);
                log('复活保护 ' + CONFIG.respawnGraceSec + ' 秒');
            }
            /* 复活后电量从死亡时的值慢慢降到 0 */
            if (CONFIG.respawnDecaySec > 0 && S.energy > 0.01) {
                S.decayFrom = S.energy;
                S.decayStart = t;
                S.decayUntil = t + Math.round(CONFIG.respawnDecaySec * 1000);
                noticeRoutine('复活：电量将在 ' + round1(CONFIG.respawnDecaySec) + ' 秒内回落到 0');
                log('复活回落开始', round1(S.decayFrom), '→ 0，用时', CONFIG.respawnDecaySec, '秒');
            }
        }
    } else if (!S.deathHandled) {
        S.deathHandled = true;
        if (CONFIG.deathMode === 'max') {
            S.energy = energyCapValue();
            S.lastDamageAt = t;
            S.strength = strengthTarget();
            if (CONFIG.burstEnabled && CONFIG.deathBurstSec > 0) {
                extendCharge(t, CONFIG.deathBurstSec);
                S.nextPulseAt = 0;
            }
            if (CONFIG.deathInstant) applyStrengthNow(t);
            noticeRoutine('死亡：电量拉满 ' + round1(S.energy) + '，强度 ' + Math.round(S.strength));
        } else if (CONFIG.deathMode === 'zero') {
            resetOutput('死亡');
            noticeRoutine('死亡：已归零');
        }
    }
}

function dglabTick() {
    var t = nowMs();
    var dt = S.lastTickAt ? t - S.lastTickAt : 50;
    S.lastTickAt = t;
    if (dt < 1) dt = 1;
    if (dt > 1000) dt = 1000;
    S.tickCount++;

    if (!S.inited) {
        try {
            init('onTickEvent');
        } catch (e) {
            reportError('初始化 init()', e);
        }
    }

    try {
        DG.pump(t);
    } catch (e) {
        reportError('中继连接管理 DG.pump()', e);
    }

    if (S.tickCount % clamp(CONFIG.pollEveryTicks, 1, 20) === 0 || S.hurtFlag) {
        S.hurtFlag = false;
        try {
            pollVitals(t);
        } catch (e) {
            reportError('读取血量 / 判定伤害（pollVitals）', e,
                '第 ' + S.tickCount + ' 刻');
        }
    }

    try {
        engineTick(t, dt);
    } catch (e) {
        reportError('强度与波形计算（engineTick）', e);
    }
    try {
        tickTip(t);
    } catch (e) {
        reportError('屏幕提示（tickTip）', e);
    }

    if (S.tickCount % 100 === 0) keepHooked('每刻主循环');
}

/* 受伤动画（EntityBehavior.HURT_ANIMATION = 2）：只当作“立刻查一次血量”的信号 */
function dglabHurt(id, behavior, value) {
    if (behavior === 2) S.hurtFlag = true;
}

/* ---- 11. 初始化与生命周期 ---- */

function init(reason) {
    if (S.inited) return;
    S.inited = true;
    buildWaveformIndex();
    loadConfig();
    for (var i = 0; i < SETTING_DEFS.length; i++) {
        if (SETTING_DEFS[i].key !== 'waveform') continue;
        SETTING_DEFS[i].values = WAVE_IDS.slice(0);
        var cnLabels = [];
        for (var wi = 0; wi < WAVE_IDS.length; wi++) cnLabels.push(WAVEFORM_DATA[WAVE_IDS[wi]].cn);
        SETTING_DEFS[i].labels = cnLabels;
    }
    /* 右路波形：第一项是「跟随主波形」 */
    for (var j = 0; j < SETTING_DEFS.length; j++) {
        if (SETTING_DEFS[j].key !== 'bWaveform') continue;
        SETTING_DEFS[j].values = [''].concat(WAVE_IDS);
        var bLabels = ['跟随主波形'];
        for (var wj = 0; wj < WAVE_IDS.length; wj++) bLabels.push(WAVEFORM_DATA[WAVE_IDS[wj]].cn);
        SETTING_DEFS[j].labels = bLabels;
    }
    /* 把从 sp 读出来的值做一次合法性校验（旧版本残留 / 手改 sp 都可能塞进非法值） */
    for (var vi = 0; vi < SETTING_DEFS.length; vi++) {
        var vd = SETTING_DEFS[vi];
        if (vd.type !== 'enum') continue;
        if (vd.key === 'waveform' || vd.key === 'bWaveform') continue;   // 下面单独校验
        if (vd.values.indexOf(CONFIG[vd.key]) < 0) {
            log('设置 ' + vd.key + '=' + CONFIG[vd.key] + ' 不合法，回默认值');
            CONFIG[vd.key] = DEFAULT_CONFIG[vd.key];
        }
    }
    if (WAVE_IDS.indexOf(CONFIG.waveform) < 0) {
        log('波形 ' + CONFIG.waveform + ' 不合法，回默认值');
        CONFIG.waveform = WAVE_IDS.indexOf(DEFAULT_CONFIG.waveform) >= 0 ? DEFAULT_CONFIG.waveform : (WAVE_IDS[0] || 'BUBBLE');
    }
    if (CONFIG.bWaveform && WAVE_IDS.indexOf(CONFIG.bWaveform) < 0) {
        log('右路波形 ' + CONFIG.bWaveform + ' 不合法，改为跟随主波形');
        CONFIG.bWaveform = '';
    }
    S.lastTickAt = nowMs();
    logAlways('v' + SCRIPT_VER + ' 已加载（' + reason + '）：中继 ' + CONFIG.relayUrl +
        '，通道 ' + CONFIG.channel + '，波形 ' + waveformName(CONFIG.waveform));
    if (!MOD.socket) logAlways('⚠ 没有 socket 模块，无法连接 DG-LAB');
    if (CONFIG.autoConnect) connectRelay(false);
}

function connectRelay(manual) {
    if (!MOD.socket || !MOD.socket.WebSocket) {
        chat('[DG-LAB] socket 模块不可用，请检查运行环境');
        return;
    }
    var ok = DG.connect(DG.url());
    if (ok && manual) chat('[DG-LAB] 正在连接 ' + DG.url());
    if (!ok) chat('[DG-LAB] 连接失败：' + S.lastError);
}

function dglabReady() {
    try {
        if (!S.inited) init('onReadyEvent');
        else {
            loadConfig();
            if ((DG.state === 'idle' || DG.state === 'closed') && CONFIG.autoConnect) connectRelay(false);
        }
    } catch (e) {
        reportError('进入世界初始化（dglabReady）', e);
    }
    S.lastHp = null;
    S.lastTotal = null;
    logAlways('已进入世界');

    /* 只在有问题时才说话：缺模块 / 出过错 / 面板关着。正常加载不刷屏。 */
    var miss = [];
    if (!MOD.socket || !MOD.socket.WebSocket) miss.push('socket（连不上中继）');
    if (!MOD.player) miss.push('player（读不到血量）');
    if (!MOD.minecraft) miss.push('minecraft（发不了提示）');
    if (!MOD.ImGui) miss.push('ImGui（画不了面板）');
    if (!MOD.sp) miss.push('sp（设置无法保存）');
    keepHooked('进入世界');
    var line = '';
    if (miss.length) line += '⚠️ 缺少模块：' + miss.join('、');
    if (ERR_COUNT > 0) line += (line ? '｜' : '') + '出过错 ' + ERR_COUNT + ' 次，!dg errors 查看';
    if (!CONFIG.showPanel) line += (line ? '｜' : '') + '面板关着，聊天栏敲 !dg panel 打开';
    if (line) chat('[DG-LAB] ' + line);
    if (!CONFIG.showPanel) {
        /* 聊天栏容易被刷掉，再往屏幕顶部提示一次 */
        try {
            if (MOD.minecraft && MOD.minecraft.showTipMessage) {
                MOD.minecraft.showTipMessage('[DG-LAB] 面板关着：聊天栏敲 !dg panel 打开');
            }
        } catch (e) { /* 忽略 */ }
    }
}

function dglabLeave() {
    resetOutput('退出世界');
    try {
        DG.close(false);
    } catch (e) {
        /* 忽略 */
    }
    logAlways('已退出世界，输出归零');
}

/* ---- 12. 指令（聊天栏输入 !dg ...） ---- */

function fmtConfigList() {
    var lines = [];
    for (var g = 0; g < SETTING_GROUPS.length; g++) {
        var group = SETTING_GROUPS[g];
        var parts = [];
        for (var i = 0; i < SETTING_DEFS.length; i++) {
            var def = SETTING_DEFS[i];
            if (def.group !== group) continue;
            parts.push(def.key + '=' + CONFIG[def.key]);
        }
        if (parts.length) lines.push('【' + group + '】' + parts.join(' '));
    }
    return lines;
}

function statusText() {
    var lines = [];
    var st = DG.state === 'paired' ? '已配对' : DG.state === 'waiting' ? '等待设备' :
        DG.state === 'connecting' ? '连接中' : DG.state === 'closed' ? '已断开（将重连）' : '未连接';
    lines.push('连接：' + st + (DG.myId ? '（编号 ' + DG.myId + '）' : ''));
    lines.push('模式：' + (CONFIG.enabled ? (S.paused ? '已暂停' : '运行中') : '已关闭') +
        '　通道 ' + CONFIG.channel + '　波形 ' + waveformName(CONFIG.waveform));
    lines.push('电量：' + round1(S.energy) + ' / ' + energyCapValue() +
        '　下发强度：' + Math.round(S.strength) + ' / ' + CONFIG.maxStrength);
    lines.push('设备强度：左 ' + DG.device.A + '（上限 ' + DG.device.limitA + '）　右 ' + DG.device.B +
        '（上限 ' + DG.device.limitB + '）');
    lines.push('波形剩余：' + (S.chargeUntil > nowMs() ? round1((S.chargeUntil - nowMs()) / 1000) + ' 秒' : '无'));
    lines.push('血量：' + (S.lastHp === null ? '—' : round1(S.lastHp)) + ' / ' + S.lastMaxHp +
        '　上次掉血：' + round1(S.lastDamage) +
        '　累计：' + S.stats.hits + ' 次 / ' + round1(S.stats.damage));
    if (S.lastError) lines.push('最近错误：' + S.lastError);
    return lines;
}

function showPairing() {
    if (!DG.myId) {
        chat('[DG-LAB] 还没连上中继，先 !dg connect');
        return;
    }
    var appUrl = DG.buildPairing(DG.myId);
    chat('[DG-LAB] ① APP 手动输入地址: ' + appUrl);
    chat('[DG-LAB] ② 要扫码就把这行丢到别的设备生成二维码: ' + DG.qrLink(appUrl));
    chat('[DG-LAB] ③ 中继地址: ' + CONFIG.relayUrl + '（当前 ' + DG.state + '）');
}

function setSetting(key, raw, save, quiet) {
    key = SETTING_MAP[key] ? key : findKeyByCn(key);
    var def = defOf(key);
    if (!def) {
        if (!quiet) chat('[DG-LAB] 没有这个设置项: ' + raw);
        return false;
    }
    var v = coerceValue(def, raw);
    if (v === null) {
        if (!quiet) {
            chat('[DG-LAB] ' + def.cn + '(' + key + ') 只接受: ' +
                (def.type === 'enum' ? def.values.join('/') :
                    def.type === 'bool' ? 'true/false' : '数字 ' + def.min + '~' + def.max));
        }
        return false;
    }
    var prevValue = CONFIG[key];
    CONFIG[key] = v;
    if (key === 'channel' && prevValue !== v) {
        if (DG.state === 'paired') {
            var oldLetters = lettersForChannelValue(prevValue);
            var oi;
            for (oi = 0; oi < oldLetters.length; oi++) DG.zeroChannel(oldLetters[oi]); /* 旧通道归零 + 清波形 */
            var newLetters = channelLetters();
            for (oi = 0; oi < newLetters.length; oi++) DG.clearChannel(newLetters[oi]); /* 新通道也清一下 */
        }
        /* 换了通道必须立刻把当前强度重发一次，否则 sentStrength 相等会被判成「不用发」 */
        DG.resendStrength(nowMs());
    }
    /* 倍率/偏移变了，右路的实际值也变了，同样要重发 */
    if ((key === 'bScale' || key === 'bOffset') && DG.state === 'paired') {
        DG.resendStrength(nowMs());
    }
    /* 切换「黄心也算掉血」会改变被测量的量，必须重新校准，否则会误判一次大伤害/大回血 */
    if (key === 'countAbsorption') {
        S.lastHp = null;
        S.lastTotal = null;
        S.lastAbsorb = 0;
    }
    if (key === 'enabled' && !v) resetOutput('总开关关闭');
    /* 波形相关设置一改就立刻换（否则要等当前这段放完，最长 8 秒） */
    if (key === 'waveform' || key === 'bWaveform' || key === 'waveSpeed' || key === 'bWaveShiftFrames' ||
        key === 'pulseLeadMs') {
        S.nextPulseAt = 0;
    }
    if (key === 'waveform') {
        S.waveNow = '';              // 玩家手动选的优先，轮换状态作废
        S.waveHits = 0;
        S.waveSwitchAt = 0;
        S.waveNextAt = 0;            // B8：定时轮换从这一刻重新计时
        S.lastWaveSwitchAt = nowMs();
    }
    if (key === 'randomWaveform' && !v) S.waveOverride = '';
    if (key === 'waveRotateMode' && v === 'off') S.waveNow = '';
    if (key === 'waveRotateIntervalSec' || key === 'waveRotateMode') S.waveNextAt = 0;
    if (save) {
        if (key === 'showPanel') {
            /* 标记：这个值是本版本有意存的，别再当成老 bug 的残留去"修" */
            try {
                if (spAvailable()) MOD.sp.putBoolean(SP_PREFIX + 'panelFix2', true);
            } catch (e) { /* 忽略 */ }
        }
        saveConfig();
    }
    /* 面板刚被关掉：当场说一句怎么打开，免得下次进世界找不到 */
    if (key === 'showPanel' && !v) {
        chat('[DG-LAB] 面板已关闭。想再打开：聊天栏敲 !dg panel');
    }
    if (!quiet) chat('[DG-LAB] ' + def.cn + ' = ' + v);
    log('设置', key, '=', v);
    return true;
}

function handleCommand(msg) {
    var body = msg.replace(/^[!.]dg\b/, '').trim();
    var parts = body.length ? body.split(/\s+/) : [];
    var cmd = (parts[0] || 'help').toLowerCase();

    if (cmd === 'help' || cmd === '?') {
        chat('[DG-LAB] 指令: !dg ui | on/off | pause/resume | stop | zero | status | pair | ' +
            'connect | disconnect | wave <名字> | set <项> <值> | list | save | reset | test [秒] | errors | diag');
        chat('[DG-LAB] 例: !dg set 每点伤害加电 2   !dg wave 心跳节奏   !dg test 3');
        return true;
    }
    if (cmd === 'ui' || cmd === 'panel') {
        setSetting('showPanel', !CONFIG.showPanel, true);
        return true;
    }
    if (cmd === 'on') {
        CONFIG.enabled = true;
        S.paused = false;
        saveConfig();
        chat('[DG-LAB] 已开启');
        return true;
    }
    if (cmd === 'off') {
        CONFIG.enabled = false;
        resetOutput('总开关关闭', CONFIG.manualZeroHoldMs);
        saveConfig();
        chat('[DG-LAB] 已关闭并归零');
        return true;
    }
    if (cmd === 'pause') {
        S.paused = true;
        resetOutput('暂停');
        chat('[DG-LAB] 已暂停（!dg resume 恢复）');
        return true;
    }
    if (cmd === 'resume') {
        S.paused = false;
        if ((DG.state === 'idle' || DG.state === 'closed') && CONFIG.autoConnect) connectRelay(false);
        chat('[DG-LAB] 已恢复');
        return true;
    }
    if (cmd === 'stop' || cmd === 'zero') {
        if (cmd === 'stop') S.paused = true;
        resetOutput('手动归零', CONFIG.manualZeroHoldMs);
        chat('[DG-LAB] 已归零' + (S.paused ? '并暂停' : ''));
        return true;
    }
    if (cmd === 'status' || cmd === 'st') {
        var lines = statusText();
        for (var i = 0; i < lines.length; i++) chat('[DG-LAB] ' + lines[i]);
        return true;
    }
    if (cmd === 'pair' || cmd === 'qr') {
        showPairing();
        return true;
    }
    if (cmd === 'connect') {
        connectRelay(true);
        return true;
    }
    if (cmd === 'disconnect') {
        CONFIG.autoReconnect = false;
        DG.close(false);
        chat('[DG-LAB] 已断开（自动重连关闭，!dg connect 可重连）');
        return true;
    }
    if (cmd === 'wave' || cmd === 'waveform') {
        var w = resolveWaveform(parts.slice(1).join(''));
        if (!w) {
            chat('[DG-LAB] 可用波形: ' + waveformListText());
            return true;
        }
        setSetting('waveform', w, true);
        return true;
    }
    if (cmd === 'set') {
        if (parts.length < 3) {
            chat('[DG-LAB] 用法: !dg set <设置项> <值>，!dg list 看全部设置项');
            return true;
        }
        setSetting(parts[1], parts.slice(2).join(' '), true);
        return true;
    }
    if (cmd === 'get') {
        var k = parts[1] ? (SETTING_MAP[parts[1]] ? parts[1] : findKeyByCn(parts[1])) : null;
        if (!k) {
            chat('[DG-LAB] 用法: !dg get <设置项>');
            return true;
        }
        chat('[DG-LAB] ' + k + ' = ' + CONFIG[k]);
        return true;
    }
    if (cmd === 'diag' || cmd === '诊断') {
        chat('[DG-LAB] 诊断 v' + SCRIPT_VER + '｜刻 ' + S.tickCount + '｜错误 ' + ERR_COUNT + ' 次');
        var modList = [];
        modList.push('socket' + (MOD.socket && MOD.socket.WebSocket ? '✓' : '✗'));
        modList.push('player' + (MOD.player ? '✓' : '✗'));
        modList.push('sp' + (MOD.sp ? '✓' : '✗'));
        modList.push('minecraft' + (MOD.minecraft ? '✓' : '✗'));
        modList.push('ImGui' + (MOD.ImGui ? '✓' : '✗'));
        modList.push('world' + (MOD.world ? '✓' : '✗'));
        chat('  模块 ' + modList.join(' '));
        chat('  全局 ' + (findGlobal() ? '有' : '没有') + '｜面板 showPanel=' + CONFIG.showPanel +
            ' compact=' + CONFIG.panelCompact + ' hud=' + CONFIG.hudEnabled +
            '｜ImGui签名=' + (UI.sig.begin || 0) + ' 画不出帧=' + (S.panelFailFrames || 0) +
            ' 正常帧=' + (S.panelFrames || 0) + ' UI.ok=' + UI.ok);
        chat('  中继 ' + DG.state + '｜' + DG.url() + '｜id=' + (DG.myId || '-') + '｜app=' + (DG.appId || '-'));
        chat('  设备回报 A=' + (DG.device.A || 0) + ' B=' + (DG.device.B || 0) +
            '（发了强度但这里一直是 0 = APP 没开总开关或开着屏蔽）');
        chat('  数值 电量' + round1(S.energy) + ' 强度' + Math.round(S.strength) + ' 通道' + CONFIG.channel +
            ' 血量' + (S.lastHp === null ? '-' : round1(S.lastHp) + '/' + round1(S.lastMaxHp)) +
            ' 总开关' + (CONFIG.enabled ? '开' : '关') + (S.paused ? '(暂停)' : '') +
            (S.offlineStop ? '(连不上已自动停)' : ''));
        if (ERR_LIST.length) chat('  最后错误 ' + ERR_LIST[ERR_LIST.length - 1]);
        return true;
    }

    if (cmd === 'errors' || cmd === 'err') {
        if (!ERR_COUNT) {
            chat('[DG-LAB] 目前没有错误记录');
            return true;
        }
        chat('[DG-LAB] 出错 ' + ERR_COUNT + ' 次，最近 ' + Math.min(ERR_LIST.length, 8) + ' 条：');
        var from = Math.max(0, ERR_LIST.length - 8);
        for (var ei = from; ei < ERR_LIST.length; ei++) chat('  ' + (ei + 1) + '. ' + ERR_LIST[ei]);
        return true;
    }

    if (cmd === 'list') {
        var ls = fmtConfigList();
        for (var j = 0; j < ls.length; j++) chat('[DG-LAB] ' + ls[j]);
        chat('[DG-LAB] 波形: ' + waveformListText());
        return true;
    }
    if (cmd === 'save') {
        chat(saveConfig() ? '[DG-LAB] 设置已保存' : '[DG-LAB] 保存失败（sp 不可用）');
        return true;
    }
    if (cmd === 'load') {
        loadConfig();
        chat('[DG-LAB] 设置已重新读取');
        return true;
    }
    if (cmd === 'reset') {
        CONFIG = copyDefaults();
        saveConfig();
        resetOutput('恢复默认', CONFIG.manualZeroHoldMs);
        chat('[DG-LAB] 已恢复默认设置');
        return true;
    }
    if (cmd === 'test') {
        var sec = clamp(Number(parts[1]) || 3, 1, 30);
        if (DG.state !== 'paired') {
            chat('[DG-LAB] 还没和 APP 配对，先 !dg pair');
            return true;
        }
        S.chargeUntil = Math.max(S.chargeUntil, nowMs() + sec * 1000);
        S.nextPulseAt = 0;
        chat('[DG-LAB] 测试波形 ' + sec + ' 秒，当前强度 ' + Math.round(S.strength));
        return true;
    }
    chat('[DG-LAB] 未知指令，!dg help 看帮助');
    return true;
}

function dglabChat(message) {
    /* 面板关了就让指令生效，否则没法把面板打开 */
    if (!CONFIG.interceptChat && CONFIG.showPanel) return false;
    if (!CONFIG.interceptChat && !CONFIG.showPanel) log('面板已关闭，聊天指令自动生效（!dg panel 可以打开面板）');
    if (typeof message !== 'string') return false;
    var m = message.trim();
    if (m.indexOf('!dg') !== 0 && m.indexOf('.dg') !== 0) return false;
    if (!S.inited) init('chat');
    try {
        handleCommand(m);
    } catch (e) {
        chat('[DG-LAB] 指令出错: ' + e);
    }
    return true; /* 拦截，不当作普通聊天发出 */
}

/* ---- 13. 游戏内设置面板（ImGui，取不到就自动跳过，用 !dg 指令一样能设） ---- */

var AV = {};

function getAV(key) {
    var g = MOD.ImGui;
    if (!g || !g.AccessValue) return null;
    if (!AV[key]) {
        try {
            AV[key] = new g.AccessValue(CONFIG[key]);
        } catch (e) {
            return null;
        }
    }
    return AV[key];
}

function syncAV(key) {
    if (AV[key] && AV[key].value !== CONFIG[key]) AV[key].value = CONFIG[key];
}

var UI = {
    ok: false,
    sig: {},

    init: function () {
        var g = MOD.ImGui;
        if (!g || typeof g.Begin !== 'function' || typeof g.End !== 'function') return false;
        this.ok = true;
        return true;
    },

    begin: function (title, avShow) {
        var g = MOD.ImGui;
        var idx = this.sig.begin || 0;
        var r = false;
        try {
            r = (idx === 0) ? g.Begin(title, avShow) : g.Begin(title);
        } catch (e) {
            this.sig.begin = (idx + 1) % 2;      // 抛异常：下一帧换另一个签名
            return false;
        }
        if (r === false || r === null || r === undefined) {
            /* 有的版本签名不对时是"返回 false"而不是报错，连着 30 帧就换一个试试 */
            this.failCount = (this.failCount || 0) + 1;
            if (this.failCount >= 30) {
                this.failCount = 0;
                this.sig.begin = (idx + 1) % 2;
            }
        } else {
            this.failCount = 0;
        }
        return r;
    },

    end: function () {
        try {
            MOD.ImGui.End();
        } catch (e) {
            /* 忽略 */
        }
    },

    text: function (s) {
        try {
            if (MOD.ImGui.Text) MOD.ImGui.Text(String(s));
        } catch (e) {
            reportError('画面板：Text 调用失败', e);
        }
    },

    sameLine: function () {
        try {
            if (MOD.ImGui.SameLine) MOD.ImGui.SameLine();
        } catch (e) {
            reportError('画面板：SameLine 调用失败', e);
        }
    },

    separator: function () {
        try {
            if (MOD.ImGui.Separator) MOD.ImGui.Separator();
        } catch (e) {
            reportError('画面板：Separator 调用失败', e);
        }
    },

    spacing: function () {
        try {
            if (MOD.ImGui.Spacing) MOD.ImGui.Spacing();
        } catch (e) {
            reportError('画面板：Spacing 调用失败', e);
        }
    },

    button: function (label) {
        try {
            if (!MOD.ImGui.Button) return false;
            return !!MOD.ImGui.Button(label);
        } catch (e) {
            return false;
        }
    },

    checkbox: function (label, av) {
        var g = MOD.ImGui;
        if (!g.Checkbox || !av) return null;
        var variants = [
            function () { return g.Checkbox(label, av); },
            function () { return g.Checkbox(label, av, 0); },
        ];
        var start = this.sig.checkbox || 0;
        for (var i = 0; i < variants.length; i++) {
            var idx = (start + i) % variants.length;
            try {
                var r = variants[idx]();
                this.sig.checkbox = idx;
                return !!r;
            } catch (e) {
                /* 换下一个签名 */
            }
        }
        return null;
    },

    slider: function (isInt, label, av, min, max) {
        var g = MOD.ImGui;
        var f = isInt ? g.SliderInt : g.SliderFloat;
        if (!f || !av) return null;
        var fmt = isInt ? '%d' : '%.1f';
        var variants = [
            function () { return f(label, av, min, max); },
            function () { return f(label, av, min, max, fmt); },
            function () { return f(label, av, min, max, fmt, 0); },
        ];
        var cacheKey = isInt ? 'sliderInt' : 'sliderFloat';
        var start = this.sig[cacheKey] || 0;
        for (var i = 0; i < variants.length; i++) {
            var idx = (start + i) % variants.length;
            try {
                var r = variants[idx]();
                this.sig[cacheKey] = idx;
                return !!r;
            } catch (e) {
                /* 换下一个签名 */
            }
        }
        return null;
    },

    combo: function (label, av, items) {
        var g = MOD.ImGui;
        if (!g.Combo || !av) return null;
        var variants = [
            function () { return g.Combo(label, av, items, items.length); },
            function () { return g.Combo(label, av, items); },
        ];
        var start = this.sig.combo || 0;
        for (var i = 0; i < variants.length; i++) {
            var idx = (start + i) % variants.length;
            try {
                var r = variants[idx]();
                this.sig.combo = idx;
                return !!r;
            } catch (e) {
                /* 换下一个签名 */
            }
        }
        return null;
    },
};

function drawBool(def) {
    var av = getAV(def.key);
    if (!av) return;
    syncAV(def.key);
    var before = av.value;
    var r = UI.checkbox(def.cn + '##' + def.key, av);
    if (r === null) {
        if (UI.button((CONFIG[def.key] ? '开' : '关') + '##' + def.key)) {
            setSetting(def.key, !CONFIG[def.key], true, true);
        }
        return;
    }
    if (av.value !== before) setSetting(def.key, av.value, true, true);
}

function drawNumber(def) {
    var av = getAV(def.key);
    if (!av) return;
    syncAV(def.key);
    var before = av.value;
    var isInt = def.type === 'int';
    var min = def.min === undefined ? 0 : def.min;
    var max = def.max === undefined ? 100 : def.max;
    var r = UI.slider(isInt, def.cn + '##' + def.key, av, min, max);
    if (r === null) {
        UI.text(def.cn + '：' + CONFIG[def.key]);
        return;
    }
    if (av.value !== before) setSetting(def.key, av.value, true, true);
}

function drawEnum(def) {
    var av = getAV(def.key);
    if (!av) return;
    var idx = 0;
    for (var i = 0; i < def.values.length; i++) {
        if (def.values[i] === CONFIG[def.key]) idx = i;
    }
    if (av.value !== idx) av.value = idx;
    var before = av.value;
    var items = (def.labels && def.labels.length === def.values.length) ? def.labels : def.values;
    var r = UI.combo(def.cn + '##' + def.key, av, items);
    if (r === null) {
        UI.text(def.cn + '：' + (items[idx] !== undefined ? items[idx] : CONFIG[def.key]));
        UI.sameLine();
        if (UI.button('上一个##' + def.key + 'p')) {
            var prev = (idx - 1 + def.values.length) % def.values.length;
            setSetting(def.key, def.values[prev], true, true);
        }
        UI.sameLine();
        if (UI.button('下一个##' + def.key + 'n')) {
            var next = (idx + 1) % def.values.length;
            setSetting(def.key, def.values[next], true, true);
        }
        return;
    }
    if (av.value !== before) {
        var v = def.values[Number(av.value)];
        if (v !== undefined) setSetting(def.key, v, true, true);
    }
}

function drawString(def) {
    UI.text(def.cn + '：' + CONFIG[def.key]);
}

function drawPanel() {
    if (!CONFIG.showPanel) return;
    if (!UI.ok && !UI.init()) return;

    var avShow = getAV('showPanel');
    if (avShow) avShow.value = true;
    var open = UI.begin(PANEL_TITLE, avShow);
    if (open === false) {
        S.panelFailFrames = (S.panelFailFrames || 0) + 1;
        if (S.panelFailFrames === 120) {         // 约 2 秒都画不出来
            reportError('面板画不出来', new Error('ImGui.Begin 一直返回 false'),
                '聊天栏敲 !dg panel 试试；或先开「屏幕状态条」，敲 !dg diag 看详情');
        }
    } else {
        S.panelFailFrames = 0;
    }

    try {
        if (open !== false) {
            var t = nowMs();
            var st = DG.state === 'paired' ? '已配对' : DG.state === 'waiting' ? '等待设备' :
                DG.state === 'connecting' ? '连接中' : DG.state === 'closed' ? '已断开，重连中' : '未连接';

            UI.text('连接：' + st);
            UI.text('设备强度：左 ' + DG.device.A + '　右 ' + DG.device.B +
                '　（上限 左 ' + DG.device.limitA + ' 右 ' + DG.device.limitB + '）');
            UI.text('下发强度：' + Math.round(S.strength) +
                '　电量：' + round1(S.energy) + ' / ' + energyCapValue());
            UI.text('血量：' + (S.lastHp === null ? '—' : round1(S.lastHp)) + ' / ' + S.lastMaxHp +
                '　上次掉血：' + round1(S.lastDamage));
            UI.text('波形剩余：' + (S.chargeUntil > t ? round1((S.chargeUntil - t) / 1000) + ' 秒' : '无') +
                '　累计：' + S.stats.hits + ' 次 / ' + round1(S.stats.damage));
            var addAgo = S.lastAddAt ? round1((t - S.lastAddAt) / 1000) : -1;
            UI.text('上次加电：' + (S.lastAddAt ? '+' + round1(S.lastAddAmount) + '（' + addAgo + ' 秒前）' : '无') +
                (t < S.zeroHoldUntil ? '　归零静默中 ' + round1((S.zeroHoldUntil - t) / 1000) + ' 秒' : ''));
            UI.text('状态：' + (CONFIG.enabled ? (S.paused ? '已暂停' : '运行中') : '已关闭') +
                (S.offlineStop ? '（连不上中继，已自动停）' : '') + '　通道：' + CONFIG.channel);
            if (S.decayUntil > t) {
                UI.text('复活回落中：还剩 ' + round1((S.decayUntil - t) / 1000) + ' 秒（电量 ' + round1(S.energy) + '）');
            }
            if (CONFIG.waveRotateMode !== 'off') {
                var wIdx = WAVE_IDS.indexOf(S.waveNow || CONFIG.waveform);
                UI.text('波形轮换：' + (CONFIG.waveRotateMode === 'sequence' ? '顺序' : '随机') +
                    '（第 ' + (wIdx < 0 ? 1 : wIdx + 1) + '/' + WAVE_IDS.length + ' 种）' +
                    (S.waveSwitchAt > t ? '　' + round1((S.waveSwitchAt - t) / 1000) + ' 秒后换' : ''));
            }
            if (S.pairingUrl) UI.text('设备连接地址：' + S.pairingUrl);
            if (CONFIG.panelCompact && UI.button('显示全部设置##btn_expand')) {
                setSetting('panelCompact', false);   // 紧凑模式下的逃生口
            }
            if (ERR_COUNT > 0) UI.text('错误 ' + ERR_COUNT + ' 次：' + String(S.lastError || '').slice(0, 80));
            else if (S.lastError) UI.text('最近错误：' + S.lastError);
            UI.separator();

            for (var g = 0; g < SETTING_GROUPS.length; g++) {
                var group = SETTING_GROUPS[g];
                var header = false;
                for (var i = 0; i < SETTING_DEFS.length; i++) {
                    var def = SETTING_DEFS[i];
                    if (def.group !== group) continue;
                    if (CONFIG.panelCompact && !def.core) continue;
                    if (!header) {
                        UI.spacing();
                        UI.text('—— ' + group + ' ——');
                        header = true;
                    }
                    if (def.type === 'bool') drawBool(def);
                    else if (def.type === 'enum') drawEnum(def);
                    else if (def.type === 'string') drawString(def);
                    else drawNumber(def);
                }
            }

            UI.separator();
            if (UI.button('立即归零##btn_zero')) {
                resetOutput('面板归零', CONFIG.manualZeroHoldMs);
                notice('已归零');
            }
            UI.sameLine();
            if (UI.button((S.paused ? '恢复' : '暂停') + '##btn_pause')) {
                S.paused = !S.paused;
                if (S.paused) resetOutput('面板暂停');
                notice(S.paused ? '已暂停' : '已恢复');
            }
            UI.sameLine();
            if (UI.button((DG.state === 'paired' || DG.state === 'waiting' || DG.state === 'connecting') ?
                '断开连接##btn_link' : '连接设备##btn_link')) {
                if (DG.state === 'paired' || DG.state === 'waiting' || DG.state === 'connecting') {
                    CONFIG.autoReconnect = false;
                    DG.close(false);
                    notice('已断开连接');
                } else {
                    CONFIG.autoReconnect = true;
                    connectRelay(true);
                }
            }
            UI.sameLine();
            if (UI.button('保存设置##btn_save')) {
                saveConfig();
                notice('设置已保存');
            }
            UI.sameLine();
            if (UI.button('配对信息##btn_pair')) showPairing();
        }
    } catch (e) {
        reportError('画面板（drawPanel）', e);
    }

    try { UI.end(); } catch (e) { /* 面板收尾失败就算了 */ }
    if (open !== false) {
        S.panelFrames = (S.panelFrames || 0) + 1;      // 正常画出来的帧数
    } else if (avShow && avShow.value === false && S.panelFrames > 30) {
        /* 用户点了窗口的关闭：Begin 返回 false 且可见性被置 false，这才算数。
         * 有的引擎会把 AccessValue 乱写成 false（窗口其实开着），那种不能信，
         * 否则面板会自己关掉并存进存档，下次进世界再也不显示。 */
        log('面板被用户关闭，记住这个选择');
        setSetting('showPanel', false, true, true);
    }
}

function drawHud() {
    if (!CONFIG.hudEnabled) return;
    if (!UI.ok && !UI.init()) return;
    try {
        if (MOD.ImGui && MOD.ImGui.SetNextWindowPos) {
            MOD.ImGui.SetNextWindowPos(Number(CONFIG.hudX) || 20, Number(CONFIG.hudY) || 20);
        }
    } catch (e) {
        /* 位置设置不支持就忽略 */
    }
    var open = UI.begin('DG-LAB 状态');
    try {
        if (open !== false) {
            var t = nowMs();
            var st = DG.state === 'paired' ? '已连接' : DG.state === 'waiting' ? '等设备' :
                DG.state === 'closed' ? '重连中' : DG.state === 'connecting' ? '连接中' : '未连接';
            UI.text('电量 ' + round1(S.energy) + '／强度 ' + Math.round(S.strength));
            UI.text('设备 左 ' + DG.device.A + '　右 ' + DG.device.B + '　' + st);
            UI.text('波形 ' + (S.chargeUntil > t ? round1((S.chargeUntil - t) / 1000) + ' 秒' : '无') +
                '　血量 ' + (S.lastHp === null ? '—' : round1(S.lastHp)));
        }
    } catch (e) {
        /* 忽略 */
    }
    UI.end();
}

function dglabImgui() {
    try {
        keepHooked('画面板');
    } catch (e) { /* 忽略 */ }
    try {
        drawPanel();
    } catch (e) {
        reportError('画面板（外层）', e);
    }
    try {
        drawHud();
    } catch (e) {
        reportError('画屏幕状态条', e);
    }
}

/* ---- 14. 自动初始化（有的环境不会自动调 onReadyEvent） ---- */

try {
    if (typeof setTimeout === 'function') {
        setTimeout(function () {
            try {
                if (!S.inited) init('setTimeout');
            } catch (e) {
                logAlways('初始化失败: ' + e);
            }
        }, 800);
    }
} catch (e) {
    /* 忽略 */
}

/* ---- 15. 游戏事件入口（和别的脚本共存） ----
 * 用 var 不用 function 声明：声明会提升，读不到别的脚本先注册的同名函数。
 * 先记下旧的，再装自己的，之后链式调用两边都跑。 */

var PREV_HANDLERS = {};

(function capturePrevHandlers() {
    var G = (typeof globalThis !== 'undefined') ? globalThis : null;
    if (!G) return;
    var names = ['onTickEvent', 'onEntityBehaviorEvent', 'onReadyEvent', 'onLeaveGameEvent',
        'onSendChatMessageEvent', 'onImGuiRenderEvent'];
    for (var i = 0; i < names.length; i++) {
        var f = G[names[i]];
        if (typeof f === 'function') PREV_HANDLERS[names[i]] = f;
    }
})();

function callPrevHandler(name, args) {
    var f = PREV_HANDLERS[name];
    if (!f) return undefined;
    try {
        return f.apply(null, args);
    } catch (e) {
        log('调用旧事件处理失败', name, e);
    }
    return undefined;
}

var onTickEvent = function () {
    callPrevHandler('onTickEvent', arguments);
    try {
        dglabTick();
    } catch (e) {
        reportError('onTickEvent（每刻主循环）', e);
    }
};

var onEntityBehaviorEvent = function (id, behavior, value) {
    callPrevHandler('onEntityBehaviorEvent', arguments);
    try {
        dglabHurt(id, behavior, value);
    } catch (e) {
        reportError('onEntityBehaviorEvent（受伤事件）', e);
    }
};

var onReadyEvent = function () {
    callPrevHandler('onReadyEvent', arguments);
    try {
        dglabReady();
    } catch (e) {
        reportError('onReadyEvent（进入世界初始化）', e);
    }
};

var onLeaveGameEvent = function () {
    callPrevHandler('onLeaveGameEvent', arguments);
    try {
        dglabLeave();
    } catch (e) {
        reportError('onLeaveGameEvent（退出世界）', e);
    }
};

/* 聊天指令：自己先处理 !dg，处理了才拦截；否则交还给旧的处理函数 */
var onSendChatMessageEvent = function (message) {
    try {
        if (dglabChat(message)) return true;
    } catch (e) {
        reportError('onSendChatMessageEvent（聊天指令）', e);
    }
    return callPrevHandler('onSendChatMessageEvent', arguments) === true;
};

var onImGuiRenderEvent = function () {
    callPrevHandler('onImGuiRenderEvent', arguments);
    try {
        dglabImgui();
    } catch (e) {
        reportError('onImGuiRenderEvent（画面板）', e);
    }
};

/* ---- 15. 对外接口（测试脚手架 / 其它脚本也能调用） ---- */

var API = {
    VERSION: SCRIPT_VER,
    MOD: MOD,
    CONFIG: function () { return CONFIG; },
    DEFAULT_CONFIG: DEFAULT_CONFIG,
    SETTING_DEFS: SETTING_DEFS,
    WAVEFORM_DATA: WAVEFORM_DATA,
    S: S,
    DG: DG,
    init: init,
    connectRelay: connectRelay,
    onTickEvent: onTickEvent,
    onReadyEvent: onReadyEvent,
    onLeaveGameEvent: onLeaveGameEvent,
    onEntityBehaviorEvent: onEntityBehaviorEvent,
    onSendChatMessageEvent: onSendChatMessageEvent,
    onImGuiRenderEvent: onImGuiRenderEvent,
    handleCommand: handleCommand,
    setSetting: setSetting,
    resetOutput: resetOutput,
    statusText: statusText,
    readVitals: readVitals,
};

/* 只给测试用；游戏里没有 module */
try {
    if (typeof module !== 'undefined' && module && module.exports) module.exports = API;
} catch (e) {
    /* 游戏里没有 module，忽略 */
}

/* 事件函数挂到全局（游戏按全局名调用）；同名旧函数已在开头抓进 PREV_HANDLERS */
/* 找全局对象：老引擎可能没有 globalThis（只有 window / self / global） */
function findGlobal() {
    try { if (typeof globalThis !== 'undefined' && globalThis) return globalThis; } catch (e) { /* 下一个 */ }
    try { if (typeof window !== 'undefined' && window) return window; } catch (e) { /* 下一个 */ }
    try { if (typeof self !== 'undefined' && self) return self; } catch (e) { /* 下一个 */ }
    try { if (typeof global !== 'undefined' && global) return global; } catch (e) { /* 下一个 */ }
    try { return Function('return this')(); } catch (e) { /* 拿不到 */ }
    return null;
}

var OUR_HANDLERS = {
    onTickEvent: onTickEvent,
    onEntityBehaviorEvent: onEntityBehaviorEvent,
    onReadyEvent: onReadyEvent,
    onLeaveGameEvent: onLeaveGameEvent,
    onSendChatMessageEvent: onSendChatMessageEvent,
    onImGuiRenderEvent: onImGuiRenderEvent
};

var GLOBAL = findGlobal();
if (GLOBAL) {
    for (var hookName in OUR_HANDLERS) {
        if (OUR_HANDLERS.hasOwnProperty(hookName)) GLOBAL[hookName] = OUR_HANDLERS[hookName];
    }
} else {
    logAlways('找不到全局对象，事件函数挂不上');
    try { chat('[DG-LAB] ⚠️ 挂不上游戏事件函数（这个引擎没有全局对象），脚本不会生效'); } catch (e) { /* 忽略 */ }
}

/* 有的加载器会在本脚本之后把全局事件函数换掉，那样本脚本就再也不跑了
 *（症状：加载完啥都没发生）。定期检查，被换掉就抢回来，对方的实现接进调用链。 */
function keepHooked(where) {
    var G = findGlobal();
    if (!G) return;
    for (var name in OUR_HANDLERS) {
        if (!OUR_HANDLERS.hasOwnProperty(name)) continue;
        if (G[name] === OUR_HANDLERS[name]) continue;
        var other = G[name];
        if (typeof other === 'function' && PREV_HANDLERS[name] !== other) {
            PREV_HANDLERS[name] = other;      // 对方的实现保留在调用链里
            reportError('事件函数被别的脚本替换（已抢回）', new Error(name + ' 被换成了别的函数'),
                where + '｜已把对方的实现接进调用链');
        } else {
            reportError('事件函数被顶掉（已抢回）', new Error(name + ' 不是本脚本的函数'), where);
        }
        try {
            G[name] = OUR_HANDLERS[name];
        } catch (e2) {
            reportError('抢回事件函数失败（' + name + '）', e2);
        }
    }
}
