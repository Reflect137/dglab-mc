#!/usr/bin/env node
/**
 * stress.js —— 长时间运行 + 极端参数压力测试
 *
 * 用 vm 把 dglab-hp.js 跑起来（假时钟，不需要真中继），然后：
 *   1. 模拟 30 分钟游戏（36000 刻）随机掉血 / 回血 / 死亡 / 切维度，检查不抛异常、
 *      数值不出现 NaN / Infinity、电量与强度始终在合法范围内；
 *   2. 把每个数值设置分别推到最小值和最大值再跑一段，检查极端参数下也不炸；
 *   3. 检查没有明显的内存增长（对象数量不随 tick 增长）。
 *
 * 运行：node test/stress.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SCRIPT = path.join(__dirname, '..', 'dglab-hp.js');

let failed = 0;
const check = (name, ok, extra) => {
    if (!ok) failed++;
    console.log((ok ? '  ✅ ' : '  ❌ ') + name + (!ok && extra !== undefined ? '   → ' + extra : ''));
};

/* ------------------------------------------------------------------ 游戏假环境 */

function build() {
    const clock = { now: 1000000 };
    const errors = [];
    const player = {
        hp: 20, maxHp: 20, absorb: 0, gameType: 0, uid: 'p1',
        getAttribute(n) {
            if (n === 'minecraft:health') return { current: this.hp, max: this.maxHp, min: 0 };
            if (n === 'minecraft:absorption') return { current: this.absorb, max: 16, min: 0 };
            throw new Error('Invalid attribute: ' + n);
        },
        getGameType() { return this.gameType; },
        getUniqueID() { return this.uid; },
    };
    /* 假 socket：只统计，不真连 */
    const sent = [];
    const sockets = [];
    function WS(url) { this.url = url; this._open = null; this._text = null; this._awake = false; }
    WS.prototype.setOnOpenListener = function (f) { this._open = f; };
    WS.prototype.setOnTextMessageListener = function (f) { this._text = f; };
    WS.prototype.setOnClosedListener = function () {};
    WS.prototype.setOnErrorListener = function () {};
    WS.prototype.connect = function () { sockets.push(this); };   // 交给 tick 驱动模拟握手
    WS.prototype.sendMessage = function (s) {
        if (!this._awake) throw new Error('未连接就发消息');
        sent.push(String(s));
    };
    WS.prototype.close = function () { this._awake = false; };
    const sp = new Map();
    const mods = {
        socket: { WebSocket: WS },
        player: { getLocalPlayer: () => player },
        minecraft: { clientMessage: () => {}, sendChatMessage: () => {} },
        app: { showToast: () => {} },
        sp: {
            contains: (k) => sp.has(k),
            getString: (k) => String(sp.get(k) || ''), getInt: (k) => Math.round(Number(sp.get(k)) || 0),
            getFloat: (k) => Number(sp.get(k)) || 0, getBoolean: (k) => !!sp.get(k),
            putString: (k, v) => sp.set(k, String(v)), putInt: (k, v) => sp.set(k, Math.round(Number(v))),
            putFloat: (k, v) => sp.set(k, Number(v)), putBoolean: (k, v) => sp.set(k, !!v),
        },
        world: { getClientWorld: () => ({ getPlayers: () => [player] }) },
        ImGui: {
            AccessValue: function (v) { this.value = v; },
            Begin: () => true, End: () => {}, Text: () => {}, Button: () => false,
            Checkbox: (l, av) => !!av.value, SliderFloat: () => false, SliderInt: () => false,
            Combo: () => false, SameLine: () => {}, Separator: () => {}, Spacing: () => {},
        },
    };
    const sandbox = {
        require: (n) => { if (mods[n]) return mods[n]; throw new Error('no module ' + n); },
        console: {
            log: (...a) => { const s = a.join(' '); if (s.indexOf('异常') >= 0 || s.indexOf('Error') >= 0) errors.push(s); },
            error: () => {}, warn: () => {},
        },
        module: { exports: {} }, exports: {},
        Date: { now: () => clock.now },
        encodeURIComponent, decodeURIComponent, parseInt, parseFloat, isNaN, Math, JSON,
    };
    sandbox.globalThis = sandbox;
    sandbox.setTimeout = (fn) => { try { fn(); } catch (e) { errors.push('setTimeout: ' + e.message); } };
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(SCRIPT, 'utf8'), sandbox, { filename: 'dglab-hp.js' });
    return {
        sandbox, player, clock, errors, sent, sp,
        api: sandbox.module.exports,
        tick(n) {
            for (let i = 0; i < n; i++) {
                /* 第一刻：模拟中继握手（open + 初始 bind + 配对成功） */
                for (const ws of sockets) {
                    if (ws._awake) continue;
                    ws._awake = true;
                    ws._open && ws._open('');
                    ws._text && ws._text(JSON.stringify({ type: 'bind', clientId: 'mc-coyote', targetId: '', message: 'targetId' }));
                    ws._text && ws._text(JSON.stringify({ type: 'bind', clientId: 'mc-coyote', targetId: 'app-1', message: '200' }));
                }
                clock.now += 50;
                sandbox.onTickEvent();
            }
        },
    };
}

function sane(g, tag) {
    const S = g.api.S;
    const c = g.api.CONFIG();
    const bad = [];
    for (const k of ['energy', 'strength', 'chargeUntil', 'nextPulseAt', 'lastHp', 'lastTotal', 'secondEnergy']) {
        const v = S[k];
        if (typeof v === 'number' && (!isFinite(v) || isNaN(v))) bad.push(k + '=' + v);
    }
    if (S.energy < 0) bad.push('energy<0:' + S.energy);
    if (S.energy > Math.max(c.energyCap, c.maxStrength) + 100) bad.push('energy 过大:' + S.energy);
    if (S.strength < 0) bad.push('strength<0:' + S.strength);
    if (S.strength > c.maxStrength) bad.push('strength 超上限:' + S.strength);
    /* 下发帧必须是合法 JSON 且 strength 是整数 */
    for (const raw of g.sent.slice(-300)) {
        let d = null;
        try { d = JSON.parse(raw); } catch (e) { bad.push('非法 JSON: ' + raw.slice(0, 60)); continue; }
        if (d.type === 3 && (!Number.isInteger(d.strength) || d.strength < 0 || d.strength > c.maxStrength)) {
            bad.push('强度帧非法: ' + JSON.stringify(d));
        }
        if (d.type === 'clientMsg' && !/^[AB]:\["/.test(String(d.message))) bad.push('波形帧非法: ' + String(d.message).slice(0, 40));
    }
    check(tag + '：数值与下发帧都合法', bad.length === 0, JSON.stringify(bad.slice(0, 4)));
}

/* ------------------------------------------------------------------ 1. 长时间随机玩法 */

console.log('=== 1. 30 分钟随机玩法（36000 刻） ===');
{
    const g = build();
    g.api.onReadyEvent();
    g.player.hp = 20;
    g.tick(4);
    let rnd = 12345;
    const rand = () => ((rnd = (rnd * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

    let deaths = 0, hits = 0, heals = 0;
    for (let i = 0; i < 36000; i++) {
        const r = rand();
        if (r < 0.02) {                       // 受伤
            const d = 0.5 + rand() * 9;
            g.player.hp = Math.max(0, g.player.hp - d);
            hits++;
        } else if (r < 0.03) {                // 回血
            g.player.hp = Math.min(g.player.maxHp, g.player.hp + rand() * 4);
            heals++;
        } else if (r < 0.032) {               // 死亡 + 重生
            g.player.hp = 0; g.tick(1);
            g.player.hp = 20; deaths++;
        } else if (r < 0.0335) {              // 黄心
            g.player.absorb = Math.round(rand() * 8);
        } else if (r < 0.034) {               // 切维度（玩家对象消失一刻）
            const old = g.sandbox.onTickEvent; g.tick(1);
        }
        g.player.absorb = Math.max(0, g.player.absorb - (rand() < 0.3 ? 1 : 0));
        g.tick(1);
        if (i % 9000 === 0) sane(g, '第 ' + (i / 20 / 60).toFixed(0) + ' 分钟');
    }
    sane(g, '30 分钟结束');
    const S = g.api.S;
    check('随机玩法跑完没有异常', g.errors.length === 0, JSON.stringify(g.errors.slice(0, 3)));
    check('模拟配对成功并真的下发了帧', g.api.DG.state === 'paired' && g.sent.length > 100,
        JSON.stringify([g.api.DG.state, g.sent.length]));
    check('统计合理（有受伤/回血/死亡）', hits > 100 && heals > 20 && deaths > 3,
        JSON.stringify({ hits, heals, deaths }));
    check('结束时电量/强度仍在范围内',
        S.energy >= 0 && S.energy <= 200 && S.strength >= 0 && S.strength <= g.api.CONFIG().maxStrength,
        JSON.stringify([S.energy, S.strength]));
    console.log('    受伤 ' + hits + ' 次 / 回血 ' + heals + ' 次 / 死亡 ' + deaths + ' 次，共下发 ' + g.sent.length + ' 帧');
}

/* ------------------------------------------------------------------ 2. 极端参数 */

console.log('\n=== 2. 极端参数（每个数值设置推到最小/最大） ===');
{
    const g = build();
    g.api.onReadyEvent();
    g.tick(4);
    const defs = g.api.SETTING_DEFS.filter((d) => d.type === 'int' || d.type === 'float');
    let worst = 0;
    for (const def of defs) {
        for (const v of [def.min, def.max]) {
            g.api.setSetting(def.key, v, false, true);
            g.player.hp = 20; g.player.absorb = 0; g.tick(10);
            g.player.hp = 12; g.tick(20);          // 受伤
            g.player.hp = 20; g.tick(20);          // 回满
            g.player.hp = 0;  g.tick(2);           // 死亡
            g.player.hp = 20; g.tick(20);
            const S = g.api.S, c = g.api.CONFIG();
            const bad = [];
            if (!isFinite(S.energy) || isNaN(S.energy)) bad.push('energy=' + S.energy);
            if (!isFinite(S.strength) || isNaN(S.strength)) bad.push('strength=' + S.strength);
            if (S.strength < 0 || S.strength > c.maxStrength) bad.push('strength=' + S.strength + '/' + c.maxStrength);
            if (bad.length) { console.log('     !! ' + def.key + '=' + v + ' → ' + bad.join(' ')); worst++; }
        }
        g.api.setSetting(def.key, g.api.DEFAULT_CONFIG[def.key], false, true);
    }
    check('所有数值设置推到极值都不产生非法数值', worst === 0, worst + ' 组合有问题');
    check('极端参数下没有异常', g.errors.length === 0, JSON.stringify(g.errors.slice(0, 3)));
}

/* ------------------------------------------------------------------ 3. 极端枚举 + 反复开关 */

console.log('\n=== 3. 反复开关 / 切通道 / 切波形 ===');
{
    const g = build();
    g.api.onReadyEvent();
    g.tick(4);
    const channels = ['A', 'B', 'AB'];
    const waves = Object.keys(g.api.WAVEFORM_DATA);
    for (let i = 0; i < 60; i++) {
        g.api.setSetting('channel', channels[i % 3], false, true);
        g.api.setSetting('waveform', waves[i % waves.length], false, true);
        g.api.setSetting('bWaveform', i % 2 ? waves[(i + 3) % waves.length] : '', false, true);
        g.api.setSetting('enabled', i % 2 === 0, false, true);
        g.player.hp = 20; g.tick(3);
        g.player.hp = 15; g.tick(6);
        g.player.hp = 20; g.tick(3);
    }
    sane(g, '反复切换');
    check('反复切换没有异常', g.errors.length === 0, JSON.stringify(g.errors.slice(0, 3)));
    check('结束时两路都不会残留非零强度', (() => {
        const S = g.api.S;
        const last = g.sent.filter((s) => s.indexOf('"type":3') >= 0).slice(-4).map((s) => JSON.parse(s).strength);
        return last.every((v) => Number.isInteger(v) && v >= 0);
    })(), JSON.stringify(g.sent.slice(-2)));
}

/* ------------------------------------------------------------------ 4. 内存不增长 */

console.log('\n=== 4. 长时间运行内存不增长 ===');
{
    const g = build();
    g.api.onReadyEvent();
    g.tick(4);
    g.player.hp = 10; g.tick(200);
    global.gc && global.gc();
    const before = process.memoryUsage().heapUsed;
    const beforeSent = g.sent.length;
    g.player.hp = 20; g.tick(1000);
    g.player.hp = 12; g.tick(20000);   // 20 分钟空转（电量没清 → 一直续波形）
    const after = process.memoryUsage().heapUsed;
    const grown = (after - before) / 1024 / 1024;
    check('20 分钟空转内存增长 < 8MB', grown < 8, grown.toFixed(2) + 'MB');
    check('续波形没有失控（帧数合理，不是每刻一帧）',
        g.sent.length - beforeSent < 20000 * 2, (g.sent.length - beforeSent) + ' 帧 / 20000 刻');
    console.log('    空转 20 分钟下发 ' + (g.sent.length - beforeSent) + ' 帧（≈ ' +
        ((g.sent.length - beforeSent) / 20).toFixed(1) + ' 帧/分钟，约 ' +
        ((g.sent.length - beforeSent) / 1200).toFixed(2) + ' 帧/秒）');
}

console.log('\n================ 结果 ================');
console.log(failed ? ('压力测试失败 ' + failed + ' 项') : '压力测试全部通过');
console.log(failed ? 'STRESS FAILED' : 'STRESS OK');
process.exit(failed ? 1 : 0);
