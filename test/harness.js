#!/usr/bin/env node
/**
 * harness.js —— dglab-hp.js 的端到端测试脚手架
 *
 * 做法：
 *   1. 真起一个 DG-LAB V3 中继（tools/dglab-relay.js）；
 *   2. 用 vm 把 dglab-hp.js 跑起来，喂进假的游戏 API（socket/player/minecraft/sp/ImGui）；
 *   3. 再起一个「假 DG-LAB APP」用真 WebSocket 连上中继；
 *   4. 模拟掉血 / 回血 / 死亡 / 指令，检查下发到 APP 的协议帧对不对，加电曲线对不对。
 *
 * 运行：node test/harness.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(ROOT, 'dglab-hp.js');
const RELAY_PATH = path.join(ROOT, 'tools', 'dglab-relay.js');

/* ------------------------------------------------------------------ 断言 */

const RESULTS = [];
let failed = 0;

function check(name, cond, extra) {
    const ok = !!cond;
    if (!ok) failed++;
    RESULTS.push({ name, ok, extra });
    console.log(`${ok ? '  ✅' : '  ❌'} ${name}${extra !== undefined && !ok ? '   → ' + extra : ''}`);
}

function section(title) {
    console.log('\n=== ' + title + ' ===');
}

/* ------------------------------------------------------------------ 工具 */

const realNow = Date.now;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* tick 是同步的，WebSocket 消息要过真事件循环才到对端，断言前先让出一下 */
const settle = (ms = 250) => sleep(ms);

async function waitFor(cond, timeout = 3000, step = 20) {
    const t0 = realNow();
    for (;;) {
        let v = false;
        try {
            v = cond();
        } catch (e) {
            v = false;
        }
        if (v) return true;
        if (realNow() - t0 > timeout) return false;
        await sleep(step);
    }
}

/* -------------------------------------------------------------- 游戏假环境 */

function buildGameContext(opts) {
    const clock = { now: opts.startTime || 1000000, timers: [] };
    const log = { chat: [], toast: [], console: [] };
    const sp = new Map();

    const player = {
        hp: 20,
        maxHp: 20,
        absorb: 0,
        gameType: 0,
        uid: 'player-1',
        counter: 0,
        getAttribute(name) {
            if (name === 'minecraft:health') return { current: this.hp, max: this.maxHp, min: 0 };
            if (name === 'minecraft:absorption') return { current: this.absorb, max: 16, min: 0 };
            throw new Error('Invalid attribute: ' + name);
        },
        getGameType() {
            return this.gameType;
        },
        getUniqueID() {
            return this.uid;
        },
    };

    const openSockets = [];

    function StubWebSocket(url) {
        this.url = url;
        this._ws = null;
        this.onopen = null;
        this.ontext = null;
        this.onclosed = null;
        this.onerror = null;
    }
    StubWebSocket.prototype.setOnOpenListener = function (f) { this.onopen = f; };
    StubWebSocket.prototype.setOnTextMessageListener = function (f) { this.ontext = f; };
    StubWebSocket.prototype.setOnClosedListener = function (f) { this.onclosed = f; };
    StubWebSocket.prototype.setOnErrorListener = function (f) { this.onerror = f; };
    StubWebSocket.prototype.connect = function () {
        const self = this;
        const ws = new WebSocket(this.url);
        this._ws = ws;
        openSockets.push(ws);
        ws.onopen = () => self.onopen && self.onopen('');
        ws.onmessage = (ev) => self.ontext && self.ontext(String(ev.data));
        ws.onclose = (ev) => self.onclosed && self.onclosed(ev.code, ev.reason);
        ws.onerror = () => self.onerror && self.onerror('ws error');
    };
    StubWebSocket.prototype.sendMessage = function (s) {
        if (!this._ws) throw new Error('not connected');
        if (this._ws.readyState !== 1) throw new Error('not open');
        this._ws.send(s);
    };
    StubWebSocket.prototype.close = function () {
        try {
            if (this._ws) this._ws.close();
        } catch (e) { /* 忽略 */ }
    };

    const imguCalls = { Begin: 0, End: 0, Text: 0, Button: 0, Checkbox: 0, SliderFloat: 0, SliderInt: 0, Combo: 0 };

    function AccessValue(v) { this.value = v; }

    const ImGui = {
        AccessValue,
        Begin: function () { imguCalls.Begin++; return true; },
        End: function () { imguCalls.End++; },
        Text: function () { imguCalls.Text++; },
        Button: function () { imguCalls.Button++; return false; },
        Checkbox: function (label, av) { imguCalls.Checkbox++; return !!av.value; },
        SliderFloat: function (label, av) { imguCalls.SliderFloat++; return false; },
        SliderInt: function (label, av) { imguCalls.SliderInt++; return false; },
        Combo: function (label, av) { imguCalls.Combo++; return false; },
        SameLine: function () {},
        Separator: function () {},
        Spacing: function () {},
    };

    const modules = {
        socket: { WebSocket: StubWebSocket },
        player: { getLocalPlayer: () => player },
        minecraft: {
            sendChatMessage: (m) => log.chat.push(String(m)),
            clientMessage: (m) => log.chat.push(String(m)),
        },
        app: { showToast: (m) => log.toast.push(String(m)) },
        sp: {
            contains: (k) => sp.has(k),
            getString: (k) => (sp.has(k) ? String(sp.get(k)) : ''),
            getInt: (k) => (sp.has(k) ? Math.round(Number(sp.get(k))) : 0),
            getFloat: (k) => (sp.has(k) ? Number(sp.get(k)) : 0),
            getBoolean: (k) => (sp.has(k) ? !!sp.get(k) : false),
            putString: (k, v) => sp.set(k, String(v)),
            putInt: (k, v) => sp.set(k, Math.round(Number(v))),
            putFloat: (k, v) => sp.set(k, Number(v)),
            putBoolean: (k, v) => sp.set(k, !!v),
            remove: (k) => sp.delete(k),
            clear: () => sp.clear(),
        },
        world: {
            getClientWorld: () => ({ getPlayers: () => [player] }),
        },
        ImGui,
    };

    const sandbox = {
        require: (name) => {
            if (Object.prototype.hasOwnProperty.call(modules, name)) return modules[name];
            throw new Error('Cannot find module ' + name);
        },
        console: {
            log: (...a) => log.console.push(a.join(' ')),
            error: (...a) => log.console.push(a.join(' ')),
            warn: (...a) => log.console.push(a.join(' ')),
        },
        module: { exports: {} },
        exports: {},
        Date: { now: () => clock.now },
        encodeURIComponent,
        decodeURIComponent,
        parseInt,
        parseFloat,
        isNaN,
        setTimeout: (fn, ms) => {
            clock.timers.push({ fn, at: clock.now + (ms || 0) });
            return clock.timers.length;
        },
        clearTimeout: () => {},
    };
    sandbox.globalThis = sandbox;

    /* 模拟「别的脚本先加载并定义了同名全局事件」 */
    if (opts.preGlobals) {
        for (const k in opts.preGlobals) sandbox[k] = opts.preGlobals[k];
    }

    const code = fs.readFileSync(SCRIPT, 'utf8');
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox, { filename: 'dglab-hp.js' });

    const api = sandbox.module.exports;

    return {
        api,
        sandbox,
        player,
        clock,
        log,
        sp,
        mods: modules,
        imguCalls,
        openSockets,
        /* 推进假时钟并跑若干游戏刻（默认 50ms/刻 ≈ 20 TPS） */
        tick(ms) {
            const steps = Math.max(1, Math.round((ms || 50) / 50));
            for (let i = 0; i < steps; i++) {
                clock.now += 50;
                sandbox.onTickEvent();
            }
        },
        /* 触发待执行的 setTimeout 回调 */
        runTimers() {
            const due = clock.timers.filter((t) => t.at <= clock.now);
            clock.timers = clock.timers.filter((t) => t.at > clock.now);
            due.forEach((t) => t.fn());
        },
    };
}

/* ------------------------------------------------------- 假 DG-LAB APP 端 */

function buildFakeApp(url) {
    const app = {
        url,
        received: [],   // 解析后的 JSON
        raw: [],
        myId: '',
        ctrlId: '',
        ws: null,
        strength: { A: 0, B: 0, limitA: 30, limitB: 30 },
        reportBack: true,
    };
    app.connect = function () {
        return new Promise((resolve, reject) => {
            const ws = new WebSocket(url);
            app.ws = ws;
            ws.onopen = () => resolve(app);
            ws.onerror = (e) => reject(new Error('app connect failed'));
            ws.onmessage = (ev) => {
                const text = String(ev.data);
                app.raw.push(text);
                let data = null;
                try {
                    data = JSON.parse(text);
                } catch (e) {
                    return;
                }
                app.received.push(data);

                if (data.type === 'bind') {
                    if (data.message === '200') {
                        app.ctrlId = data.clientId;
                        app.myId = data.targetId;
                    } else if (!data.targetId) {
                        app.myId = data.clientId;
                    }
                    return;
                }
                if (typeof data.message !== 'string') return;

                const m = data.message;
                const one = /^strength-(\d+)\+2\+(\d+)$/.exec(m);
                if (one) {
                    const ch = Number(one[1]);
                    const val = Number(one[2]);
                    if (ch === 1) app.strength.A = val; else app.strength.B = val;
                    /* 模仿真 APP：把当前强度与上限回传 */
                    if (app.reportBack) {
                        app.send({
                            type: 'msg',
                            clientId: app.myId,
                            targetId: app.ctrlId,
                            message: `strength-${app.strength.A}+${app.strength.B}+${app.strength.limitA}+${app.strength.limitB}`,
                        });
                    }
                }
            };
        });
    };
    app.send = function (obj) {
        if (app.ws && app.ws.readyState === 1) app.ws.send(JSON.stringify(obj));
    };
    app.close = function () {
        try {
            app.ws && app.ws.close();
        } catch (e) { /* 忽略 */ }
    };
    /* 收到的强度帧（通道 A） */
    app.strengths = function (channel) {
        const ch = channel === 'B' ? 2 : 1;
        const re = new RegExp('^strength-' + ch + '\\+2\\+(\\d+)$');
        return app.received
            .map((d) => (typeof d.message === 'string' ? re.exec(d.message) : null))
            .filter(Boolean)
            .map((m) => Number(m[1]));
    };
    app.pulses = function (channel) {
        /* 注意：中继把波形包前缀写成通道字母（pulse-A:），强度/清除才是数字（strength-1 / clear-1） */
        const letter = channel === 'B' ? 'B' : 'A';
        return app.received
            .map((d) => (typeof d.message === 'string' ? d.message : ''))
            .filter((m) => m.indexOf('pulse-' + letter + ':') === 0);
    };
    app.pulseFrames = function (channel) {
        return app.pulses(channel).map((m) => JSON.parse(m.slice(m.indexOf(':') + 1)));
    };
    app.clears = function (channel) {
        const ch = channel === 'B' ? 2 : 1;
        return app.received.filter((d) => d.message === 'clear-' + ch).length;
    };
    return app;
}

/* ------------------------------------------------------------------- 主流程 */

async function main() {
    if (!fs.existsSync(RELAY_PATH)) {
        console.error('找不到中继实现: ' + RELAY_PATH);
        process.exit(2);
    }
    const { createRelay } = require(RELAY_PATH);
    const relay = createRelay({ port: 0, host: '127.0.0.1', verbose: process.env.RELAY_VERBOSE === '1', quiet: true });
    const { port } = await relay.listen();
    const relayPulses = [];
    relay.on('pulse', (evt) => relayPulses.push(evt));
    const relayFrames = [];
    relay.on('message', (evt) => relayFrames.push(evt));

    console.log(`[harness] 中继已启动 ws://127.0.0.1:${port}`);

    const prev = { ticks: 0, chats: [], readies: 0, hurts: 0 };
    const game = buildGameContext({
        preGlobals: {
            /* 模拟 TimeUnity.js / KuSug.js 那类脚本已经占用同名全局函数 */
            onTickEvent: function () { prev.ticks++; },
            onReadyEvent: function () { prev.readies++; },
            onEntityBehaviorEvent: function () { prev.hurts++; },
            onSendChatMessageEvent: function (m) { prev.chats.push(String(m)); return String(m).indexOf('!!') === 0; },
        },
    });
    const api = game.api;

    /* 把本次测试的中继地址写进假的 sp（脚本初始化时会从 sp 读设置） */
    game.sp.set('dglab_hp.relayUrl', `ws://127.0.0.1:${port}/`);

    /* ---------------- T1 初始化 / 连接 / 配对 ---------------- */
    section('T1 初始化与配对');
    check('脚本导出接口正常', api && typeof api.onTickEvent === 'function');
    api.onReadyEvent();
    api.onReadyEvent(); // 幂等

    const waiting = await waitFor(() => !!api.DG.myId && (api.DG.state === 'waiting' || api.DG.state === 'paired'));
    check('连接中继并拿到 bind 帧', waiting, api.DG.state + ' myId=' + JSON.stringify(api.DG.myId) + ' ' + api.S.lastError);
    check('中继地址从 sp 读回', api.CONFIG().relayUrl === `ws://127.0.0.1:${port}/`, api.CONFIG().relayUrl);

    const myId = api.DG.myId;
    check('拿到控制端 clientId', !!myId, JSON.stringify(myId));
    check('固定配对 ID 生效（?cid=mc-coyote）', myId === 'mc-coyote', myId);
    check('配对地址拼接正确', api.S.pairingUrl === `ws://127.0.0.1:${port}/${myId}`, api.S.pairingUrl);

    const app = await buildFakeApp(`ws://127.0.0.1:${port}/${myId}`).connect();
    const paired = await waitFor(() => api.DG.state === 'paired');
    check('APP 接入后进入已配对', paired, api.DG.state);
    check('设备侧也拿到配对信息', app.ctrlId === myId && !!app.myId, JSON.stringify([app.myId, app.ctrlId]));

    await waitFor(() => app.strengths('A').length > 0);
    check('配对后立即下发一次强度 0', app.strengths('A')[0] === 0, JSON.stringify(app.strengths('A')));

    /* ---------------- T2 掉血 → 加电 ---------------- */
    section('T2 掉血加电（每点伤害 ×3，默认瞬间到位、重击加成 ×1.5）');
    api.CONFIG().debug = false;
    api.CONFIG().critEnabled = false;   // 这一节先关掉重击加成，单独看基础曲线
    game.tick(100); // 先跑两刻校准 20 点血（进世界时的第一次读数不算伤害）
    check('校准后不产生电量', api.S.energy === 0 && api.S.lastHp === 20, JSON.stringify([api.S.energy, api.S.lastHp]));
    game.player.hp = 17; // 掉 3 点血
    game.tick(50);
    await settle(150);
    check('掉血后累计电量 = 3 × 3 = 9', Math.abs(api.S.energy - 9) < 0.001, api.S.energy);
    check('强度瞬间到位（不用等渐变）', api.S.strength === 9, api.S.strength);
    const strengths = app.strengths('A');
    check('设备收到 9（最后一条强度指令）', strengths.slice(-1)[0] === 9, JSON.stringify(strengths));
    check('没有中间档位（不是慢慢爬）', strengths.filter((v) => v > 0 && v < 9).length === 0, JSON.stringify(strengths));
    check('没有超过强度上限 25', Math.max(...strengths) <= 25, JSON.stringify(strengths));

    /* 重击加成：单次伤害 ≥ 4 点时 ×1.5 */
    game.player.hp = 20;   // 先回满血 → 电量清零
    game.tick(60);
    await settle(120);
    check('回血把电量清了', api.S.energy === 0 && api.S.strength === 0, JSON.stringify([api.S.energy, api.S.strength]));
    api.CONFIG().critEnabled = true;
    game.player.hp = 16;   // 单次掉 4 点 = 重击
    game.tick(60);
    await settle(120);
    check('重击加成生效（4 × 3 × 1.5 = 18）', Math.abs(api.S.energy - 18) < 0.001, api.S.energy);
    check('强度跟着瞬间到顶', api.S.strength === api.S.energy, JSON.stringify([api.S.strength, api.S.energy]));

    /* ---------------- T3 波形 ---------------- */
    section('T3 受伤触发波形');
    await settle();
    const pulseFrames = app.pulseFrames('A');
    check('APP 收到波形帧', pulseFrames.length > 0, JSON.stringify(app.pulses('A').slice(0, 1)));
    const bubble = api.WAVEFORM_DATA.BUBBLE.frames;
    check('波形内容是当前预设(气泡)',
        pulseFrames.length > 0 &&
        pulseFrames[0][0] === bubble[0] &&
        pulseFrames[0].every((f) => bubble.indexOf(f) >= 0),
        JSON.stringify(pulseFrames[0]));
    check('每包 10 帧（中继按 100ms/帧 补齐）',
        pulseFrames[0].length === 10 && pulseFrames[0][1] === bubble[1 % bubble.length],
        JSON.stringify(pulseFrames[0].length));
    check('波形帧都是 16 位十六进制', pulseFrames.every((fs) => fs.every((f) => /^[0-9A-F]{16}$/.test(f))));
    check('波形时长随伤害（1 + 3×0.5 = 2.5s → 3 秒）',
        relayPulses.length > 0 && relayPulses[0].seconds >= 3, JSON.stringify(relayPulses.map((p) => p.seconds)));
    check('中继预排：每秒 1 包、总帧数 = 秒数 × 10',
        relayPulses.length > 0 && relayPulses[0].packets === relayPulses[0].seconds &&
        relayPulses[0].frames.length === relayPulses[0].seconds * 10,
        JSON.stringify([relayPulses[0].packets, relayPulses[0].frames.length, relayPulses[0].seconds]));

    /* 等真时间，让中继把 3 个包发完 */
    await sleep(2300);
    const pkt = app.pulses('A').length;
    check('波形包陆续发完（≥2 包）', pkt >= 2, pkt);

    /* ---------------- T4 不回血就不减电量；默认回满血才清 ---------------- */
    section('T4 电量只在回血时下降（默认：回满血才清）');
    const energyIdle = api.S.energy;
    const strengthIdle = api.S.strength;
    const pulsesIdle = app.pulses('A').length;
    game.tick(30000); // 空转 30 秒（不回血、不挨打）
    await settle(400);
    check('不回血时电量完全不变', api.S.energy === energyIdle, JSON.stringify([energyIdle, api.S.energy]));
    check('强度也保持不变（一直放电）', api.S.strength === strengthIdle, JSON.stringify([strengthIdle, api.S.strength]));
    check('电量没清就一直续波形', app.pulses('A').length > pulsesIdle,
        JSON.stringify([pulsesIdle, app.pulses('A').length]));

    game.player.hp = 18;   // 只回了一点，没回满
    game.tick(300);
    await settle(200);
    check('没回满血 → 电量保持（一直电）', api.S.energy === energyIdle, JSON.stringify([energyIdle, api.S.energy]));
    check('没回满血 → 强度保持', api.S.strength === strengthIdle, JSON.stringify([strengthIdle, api.S.strength]));

    game.player.hp = 20;   // 回满
    game.tick(300);
    await settle(200);
    check('回满血 → 电量清零', api.S.energy === 0 && api.S.strength === 0, JSON.stringify([api.S.energy, api.S.strength]));
    check('回满血后下发过 0', app.strengths('A').slice(-1)[0] === 0, JSON.stringify(app.strengths('A').slice(-3)));

    /* ---------------- T5 死亡拉满 ---------------- */
    section('T5 死亡电量拉满');
    game.player.hp = 20;
    game.tick(60);
    const clearsBefore = app.clears('A');
    game.player.hp = 0;   // 死亡
    game.tick(100);
    await settle(200);
    check('死亡后电量拉满（= 电量上限 25）', api.S.energy === 25, JSON.stringify(api.S.energy));
    check('死亡瞬间强度到位', api.S.strength === 25, api.S.strength);
    check('设备收到 25', app.strengths('A').slice(-1)[0] === 25, JSON.stringify(app.strengths('A').slice(-3)));
    check('死亡也放了波形', app.pulses('A').length > 0 && api.S.chargeUntil > 0, JSON.stringify([app.pulses('A').length, api.S.chargeUntil]));
    check('死亡只处理一次（不会每刻重复触发）', (() => {
        const before = app.strengths('A').length;
        game.tick(500);
        return app.strengths('A').length - before <= 2;
    })());

    /* 改成归零模式再验证一次 */
    api.setSetting('deathMode', 'zero', true);
    game.player.hp = 20; game.tick(80);   // 复活
    game.player.hp = 12; game.tick(80);   // 先掉点血攒电量
    game.player.hp = 0;  game.tick(100);  // 再死
    await settle(200);
    check('死亡处理可切成归零', api.S.energy === 0 && api.S.strength === 0, JSON.stringify([api.S.energy, api.S.strength]));
    check('归零时清空了波形', app.clears('A') > clearsBefore, JSON.stringify([clearsBefore, app.clears('A')]));
    api.setSetting('deathMode', 'max', true);
    game.player.hp = 20;
    game.player.absorb = 0;
    game.tick(60);

    /* ---------------- T6 小伤害过滤 / 吸收 / 创造 ---------------- */
    section('T6 伤害过滤');
    game.player.hp = 20;
    game.player.absorb = 0;
    game.tick(60);
    const e0 = api.S.energy;
    game.player.hp = 19.7; // 0.3 < minDamage 0.5
    game.tick(60);
    check('小于最小伤害不计', api.S.energy === e0, JSON.stringify([e0, api.S.energy]));

    game.player.hp = 20;
    game.player.absorb = 4;
    api.CONFIG().critEnabled = false;   // 这一条只看吸收，不受重击加成影响
    game.tick(60);
    game.player.absorb = 0; // 黄心被打掉 4 点
    game.tick(60);
    check('伤害吸收被打掉也算掉血', Math.abs(api.S.energy - 12) < 0.01, api.S.energy);
    api.CONFIG().critEnabled = true;

    game.player.gameType = 1; // 创造
    game.player.hp = 5;
    game.tick(200);
    check('创造模式不触发并按归零处理', api.S.energy === 0 && api.S.strength === 0, JSON.stringify([api.S.energy, api.S.strength]));
    game.player.gameType = 0;
    game.player.hp = 20;
    game.player.absorb = 0;
    game.tick(60);

    /* ---------------- T7 聊天指令 ---------------- */
    section('T7 聊天指令（默认不接管，需要时再打开）');
    check('默认不接管聊天（!dg 不会被吃）', game.sandbox.onSendChatMessageEvent('!dg status') === false);
    api.setSetting('interceptChat', true, false);
    check('打开接管后生效', api.CONFIG().interceptChat === true);
    const intercepted = game.sandbox.onSendChatMessageEvent('!dg set 每点伤害加电 10');
    check('指令被拦截（不会当聊天发出去）', intercepted === true);
    check('中文设置名生效', api.CONFIG().strengthPerDamage === 10, api.CONFIG().strengthPerDamage);
    check('设置写入到 sp 持久化', game.sp.get('dglab_hp.strengthPerDamage') === 10, game.sp.get('dglab_hp.strengthPerDamage'));

    game.sandbox.onSendChatMessageEvent('!dg wave 心跳');
    check('波形按中文名切换', api.CONFIG().waveform === 'HEARTBEAT', api.CONFIG().waveform);

    const clearsA = app.clears('A');
    const zeroA = app.strengths('A').length;
    game.sandbox.onSendChatMessageEvent('!dg set channel B');
    await settle(150);
    check('通道切换为 B', api.CONFIG().channel === 'B', api.CONFIG().channel);
    check('切通道时旧通道(A)被归零',
        app.strengths('A').length > zeroA && app.strengths('A').slice(-1)[0] === 0,
        JSON.stringify(app.strengths('A').slice(-3)));
    check('切通道时旧通道(A)波形被清',
        app.clears('A') > clearsA, JSON.stringify([clearsA, app.clears('A')]));

    const chatBefore = game.log.chat.length;
    game.sandbox.onSendChatMessageEvent('!dg status');
    check('status 有输出', game.log.chat.length > chatBefore, game.log.chat.slice(-5).join(' | '));

    game.sandbox.onSendChatMessageEvent('!dg pair');
    check('pair 输出配对地址', game.log.chat.slice(-3).join(' ').includes(`/${myId}`), game.log.chat.slice(-3).join(' '));

    /* B 通道 + 心跳波形 再打一次 */
    game.player.hp = 10; // 掉 10 点
    game.tick(300);
    await settle();
    const bpulses = app.pulses('B');
    check('切到 B 通道后波形发到 B', bpulses.length > 0, JSON.stringify(app.pulses('A').length));
    const hbFrames = api.WAVEFORM_DATA.HEARTBEAT.frames;
    check('波形换成心跳节奏', app.pulseFrames('B').length > 0 &&
        app.pulseFrames('B')[0][0] === hbFrames[0], JSON.stringify(app.pulseFrames('B')[0] && app.pulseFrames('B')[0][0]));
    check('B 通道强度在涨', Math.max(...app.strengths('B').concat([0])) > 0, JSON.stringify(app.strengths('B')));

    game.sandbox.onSendChatMessageEvent('!dg stop');
    await settle(120);
    check('stop 会归零', api.S.energy === 0 && api.S.strength === 0, JSON.stringify([api.S.energy, api.S.strength]));
    check('stop 会暂停', api.S.paused === true);
    game.tick(100);
    check('暂停期间挨打也不加电', (() => { game.player.hp = 1; game.tick(300); return api.S.energy === 0; })());

    game.sandbox.onSendChatMessageEvent('!dg resume');
    check('resume 恢复运行', api.S.paused === false);

    game.sandbox.onSendChatMessageEvent('!dg set channel A');
    game.sandbox.onSendChatMessageEvent('!dg test 2');
    check('test 指令排了波形', api.S.chargeUntil > game.clock.now, JSON.stringify([api.S.chargeUntil, game.clock.now]));

    game.sandbox.onSendChatMessageEvent('!dg reset');
    check('reset 恢复默认设置', api.CONFIG().strengthPerDamage === 3 && api.CONFIG().channel === 'A',
        JSON.stringify([api.CONFIG().strengthPerDamage, api.CONFIG().channel]));

    check('非指令消息不拦截', game.sandbox.onSendChatMessageEvent('hello world') === false);

    /* ---------------- T8 协议帧格式 ---------------- */
    section('T8 协议帧格式（发给中继的原始帧）');
    const inFrames = relayFrames.filter((e) => e.dir === 'in');
    const strengthFrame = inFrames.map((e) => e.data).filter((d) => d && d.type === 3).slice(-1)[0];
    check('强度帧 type=3', !!strengthFrame && strengthFrame.type === 3, JSON.stringify(strengthFrame));
    check('强度帧带 clientId/targetId/channel/message(=set channel)',
        !!strengthFrame && strengthFrame.clientId === myId && strengthFrame.targetId === app.myId &&
        (strengthFrame.channel === 'A' || strengthFrame.channel === 'B') && strengthFrame.message === 'set channel',
        JSON.stringify(strengthFrame));
    const pulseFrame = inFrames.map((e) => e.data).filter((d) => d && d.type === 'clientMsg').slice(-1)[0];
    check('波形帧 type=clientMsg 且 message 形如 A:[...]',
        !!pulseFrame && /^[AB]:\["/.test(pulseFrame.message) && typeof pulseFrame.time === 'number',
        JSON.stringify(pulseFrame && { t: pulseFrame.type, time: pulseFrame.time, head: String(pulseFrame.message).slice(0, 24) }));

    /* ---------------- T9 设置持久化 / 重新读回 ---------------- */
    section('T9 设置持久化');
    api.setSetting('strengthPerDamage', 7, true);
    check('保存后 sp 里有值', game.sp.get('dglab_hp.strengthPerDamage') === 7, game.sp.get('dglab_hp.strengthPerDamage'));
    check('sp 里存了全部设置项', game.sp.has('dglab_hp.maxStrength') && game.sp.has('dglab_hp.relayUrl'),
        Array.from(game.sp.keys()).length);

    /* ---------------- T10 面板与断线重连 ---------------- */
    section('T10 ImGui 面板 / 断线重连');
    api.setSetting('interceptChat', true, false);   // T7 的 !dg reset 会把它关回去
    game.sandbox.onSendChatMessageEvent(`!dg set relayUrl ws://127.0.0.1:${port}/`);
    check('中继地址可在线改回', api.CONFIG().relayUrl === `ws://127.0.0.1:${port}/`, api.CONFIG().relayUrl);
    api.CONFIG().showPanel = true;
    game.sandbox.onImGuiRenderEvent();
    check('面板渲染不报错且画了控件', game.imguCalls.Begin > 0 && game.imguCalls.End > 0 && game.imguCalls.Text > 0,
        JSON.stringify(game.imguCalls));
    check('面板画了滑条/勾选框', game.imguCalls.SliderFloat > 0 && game.imguCalls.Checkbox > 0, JSON.stringify(game.imguCalls));

    app.close();
    const closed = await waitFor(() => api.DG.state === 'closed' || api.DG.state === 'waiting', 3000);
    check('APP 断开后进入断开/等待状态', closed, api.DG.state);
    game.tick(3000); // 推进重连倒计时
    const reconnected = await waitFor(() => api.DG.state === 'waiting' || api.DG.state === 'paired', 4000);
    check('自动重连成功', reconnected, api.DG.state + ' ' + api.S.lastError + ' url=' + api.DG.url());

    /* ---------------- T11 与别的脚本共存 ---------------- */
    section('T11 与别的脚本共存（全局事件链式调用）');
    api.setSetting('interceptChat', true, false);
    check('暴露了 globalThis.DGLAB_HP', !!game.sandbox.DGLAB_HP && typeof game.sandbox.DGLAB_HP.onTickEvent === 'function',
        typeof game.sandbox.DGLAB_HP);
    check('DGLAB_HP.config 能读到配置', game.sandbox.DGLAB_HP.config().relayUrl === api.CONFIG().relayUrl);
    check('旧 onReadyEvent 也被调到', prev.readies >= 2, prev.readies);
    const tickBefore = prev.ticks;
    const hpBefore = api.S.lastHp;
    game.tick(200);
    check('旧 onTickEvent 每次都被调到', prev.ticks - tickBefore >= 4, prev.ticks - tickBefore);
    check('脚本自己的 tick 也照常跑', api.S.lastHp === hpBefore, JSON.stringify([hpBefore, api.S.lastHp]));

    const hurtBefore = prev.hurts;
    game.sandbox.onEntityBehaviorEvent('player-1', 2, 0);
    check('旧 onEntityBehaviorEvent 被调到', prev.hurts === hurtBefore + 1, prev.hurts);

    const chatCountBefore = prev.chats.length;
    check('自己的指令仍然拦截（优先处理）', game.sandbox.onSendChatMessageEvent('!dg status') === true);
    check('自己的指令不会漏给旧脚本', prev.chats.length === chatCountBefore, JSON.stringify(prev.chats.slice(-3)));
    check('非指令交给旧脚本处理', game.sandbox.onSendChatMessageEvent('hello 世界') === false &&
        prev.chats.indexOf('hello 世界') >= 0, JSON.stringify(prev.chats.slice(-3)));
    check('旧脚本自己的指令（!!）仍被它拦截', game.sandbox.onSendChatMessageEvent('!!自定义') === true &&
        prev.chats.indexOf('!!自定义') >= 0, JSON.stringify(prev.chats.slice(-3)));

    /* ---------------- T12 新参数 / 新守卫 ---------------- */
    section('T12 新参数与新守卫');

    /* T10 里把假 APP 关掉了，这里重新配对，才能断言下发帧 */
    const appX = await buildFakeApp(`ws://127.0.0.1:${port}/${myId}`).connect();
    const rePaired = await waitFor(() => api.DG.state === 'paired');
    check('重新配对成功（后续帧检查用）', rePaired, api.DG.state);
    api.setSetting('strengthPerDamage', 3, false);   // T9 改成过 7，这里还原

    /* 12.1 伤害换算曲线：平方 */
    api.setSetting('channel', 'A', false);
    api.setSetting('damageCurve', 'square', false);
    api.CONFIG().critEnabled = false;
    api.S.energy = 0; api.S.strength = 0;
    game.player.hp = 20; game.tick(120);     // 回满 → 电量 0
    await settle(120);
    game.player.hp = 18; game.tick(60);      // 掉 2 点 → 2*2/4 = 1 → 电量 3
    await settle(120);
    check('平方曲线：2 点伤害 = 1 → 电量 3', Math.abs(api.S.energy - 3) < 0.001, api.S.energy);
    game.player.hp = 14; game.tick(60);      // 再掉 4 点 → 4 → 累计 15
    await settle(120);
    check('平方曲线：4 点伤害 = 4 → 累计 15', Math.abs(api.S.energy - 15) < 0.001, api.S.energy);
    api.setSetting('damageCurve', 'linear', false);

    /* 12.2 每秒加电上限 */
    api.setSetting('energyPerSecondCap', 5, false);
    api.S.energy = 0; api.S.strength = 0;
    game.player.hp = 20; game.tick(120);
    await settle(120);
    game.player.hp = 16; game.tick(60);      // 掉 4 点 → 12，被限成 5
    await settle(120);
    check('每秒加电上限生效（12 → 5）', api.S.energy === 5, api.S.energy);
    api.setSetting('energyPerSecondCap', 0, false);

    /* 12.3 满血兜底：黄心被打掉（血量没变）也要清电 */
    api.S.energy = 0;
    game.player.hp = 20; game.player.absorb = 6;
    game.tick(200);
    await settle(120);
    game.player.absorb = 0;                  // 黄心被打掉 6 点
    game.tick(60);
    await settle(120);
    check('黄心被打掉也会加电（即使满血）', api.S.energy > 0, api.S.energy);
    game.tick(2000);                          // 一直满血 → 兜底清电
    await settle(200);
    check('满血持续一会儿 → 自动清电（兜底）', api.S.energy === 0, api.S.energy);

    /* 12.4 保底电量：没回满就一直电 */
    api.setSetting('hurtFloorEnergy', 8, false);
    game.player.hp = 20; game.tick(120);
    await settle(120);
    check('回满血时不受保底影响', api.S.energy === 0, api.S.energy);
    game.player.hp = 18; game.tick(120);
    await settle(150);
    check('没回满时电量保底 8', api.S.energy === 8, api.S.energy);
    api.setSetting('hurtFloorEnergy', 0, false);
    game.player.hp = 20; game.tick(200);
    await settle(150);

    /* 12.5 手动归零静默期 */
    api.setSetting('manualZeroHoldMs', 3000, false);
    api.S.energy = 20; api.S.strength = 20;
    api.resetOutput('测试归零', api.CONFIG().manualZeroHoldMs);
    check('归零后电量立刻为 0', api.S.energy === 0, api.S.energy);
    game.player.hp = 16; game.tick(200);
    await settle(150);
    check('静默期内受伤不加电', api.S.energy === 0, api.S.energy);
    game.tick(3200);
    game.player.hp = 14; game.tick(60);
    await settle(150);
    check('静默期过后恢复加电', api.S.energy > 0, api.S.energy);
    api.setSetting('manualZeroHoldMs', 1500, false);
    game.player.hp = 20; game.tick(200);
    await settle(150);

    /* 12.6 暂停时受伤不加电、也不下发 */
    api.S.paused = true;
    const sentBefore = appX.strengths('A').length;
    game.player.hp = 10; game.tick(300);
    await settle(200);
    check('暂停期间受伤不加电', api.S.energy === 0, api.S.energy);
    check('暂停期间不偷偷下发强度', appX.strengths('A').length - sentBefore <= 2,
        JSON.stringify(appX.strengths('A').length - sentBefore));
    api.S.paused = false;
    game.player.hp = 20; game.tick(200);
    await settle(150);

    /* 12.7 AB 双路 + 左右独立参数 */
    api.setSetting('channel', 'AB', false);
    api.setSetting('bScale', 0.5, false);
    api.setSetting('bOffset', 2, false);
    api.setSetting('bWaveform', 'HEARTBEAT', false);
    api.CONFIG().critEnabled = false;
    api.S.energy = 0; api.S.strength = 0;
    game.tick(120);
    game.player.hp = 12; game.tick(300);     // 掉 8 点 → 电量 24
    await settle(300);
    const aLast = appX.strengths('A').slice(-1)[0];
    const bLast = appX.strengths('B').slice(-1)[0];
    const wantA = Math.round(api.S.strength);
    const wantB = Math.round(api.S.strength * 0.5 + 2);
    check('双路都下发强度（右路倍率+偏移）', aLast === wantA && bLast === wantB,
        JSON.stringify([aLast, bLast, wantA, wantB]));
    check('左路用主波形（气泡）',
        appX.pulseFrames('A').length > 0 && appX.pulseFrames('A')[0][0] === api.WAVEFORM_DATA.BUBBLE.frames[0],
        JSON.stringify(appX.pulseFrames('A')[0] && appX.pulseFrames('A')[0][0]));
    check('右路用独立波形（心跳节奏）',
        appX.pulseFrames('B').length > 0 && appX.pulseFrames('B')[0][0] === api.WAVEFORM_DATA.HEARTBEAT.frames[0],
        JSON.stringify(appX.pulseFrames('B')[0] && appX.pulseFrames('B')[0][0]));
    const beforeZero = [appX.strengths('A').length, appX.strengths('B').length];
    api.resetOutput('测试归零', 0);
    await settle(250);
    check('归零把两路都清零', appX.strengths('A').slice(-1)[0] === 0 && appX.strengths('B').slice(-1)[0] === 0 &&
        appX.strengths('A').length > beforeZero[0] && appX.strengths('B').length > beforeZero[1],
        JSON.stringify([appX.strengths('A').slice(-2), appX.strengths('B').slice(-2)]));
    api.setSetting('channel', 'A', false);
    api.setSetting('bOffset', 0, false);
    api.setSetting('bWaveform', '', false);
    api.setSetting('bScale', 1, false);
    game.player.hp = 20; game.tick(200);
    await settle(150);

    /* ---------------- T13 独立审查报告 B1~B7 / S1 / S2 回归 ---------------- */
    section('T13 审查报告回归（B1~B7 / S1 / S2）');

    /* B1：切通道后必须把当前强度补发给新通道 */
    api.setSetting('channel', 'A', false);
    api.setSetting('baseStrength', 0, false);
    api.setSetting('hurtFloorEnergy', 0, false);
    api.setSetting('manualZeroHoldMs', 0, false);
    api.S.energy = 18; api.S.strength = 18;
    game.player.hp = 20; game.player.absorb = 0;
    game.tick(120); await settle(250);
    const bBefore = appX.strengths('B').length;
    api.setSetting('channel', 'B', false);
    await settle(300);
    check('B1 切通道后立刻把当前强度补发给新通道',
        appX.strengths('B').length > bBefore && appX.strengths('B').slice(-1)[0] === 18,
        JSON.stringify([bBefore, appX.strengths('B').slice(-3), api.S.strength]));

    /* B1 同根因：改右路倍率后，右路要拿到新值 */
    api.setSetting('channel', 'AB', false);
    await settle(300);
    api.setSetting('bScale', 0.5, false);
    await settle(350);
    const wantB2 = Math.round(api.S.strength * 0.5);
    check('B1 改右路倍率后立刻重发右路强度',
        appX.strengths('B').slice(-1)[0] === wantB2,
        JSON.stringify([appX.strengths('B').slice(-2), wantB2, api.S.strength]));
    api.setSetting('bScale', 1, false);
    api.setSetting('channel', 'A', false);
    await settle(250);

    /* B2：提前量拉满也不能每刻重发波形 */
    api.setSetting('pulseLeadMs', 2000, false);
    const pulseFramesBefore = relayFrames.filter((e) => e.dir === 'in' && e.data && e.data.type === 'clientMsg').length;
    game.tick(2000);           // 2 秒
    await settle(300);
    const pulseSent = relayFrames.filter((e) => e.dir === 'in' && e.data && e.data.type === 'clientMsg').length - pulseFramesBefore;
    check('B2 提前量 2000ms 也不会每刻重发波形（2 秒 ≤ 6 条）', pulseSent <= 6, pulseSent + ' 条');
    api.setSetting('pulseLeadMs', 0, false);

    /* B3：归零静默期内，保底电量不能把电补回来 */
    api.setSetting('hurtFloorEnergy', 8, false);
    game.player.hp = 10; game.tick(80);
    api.S.energy = 0; api.S.strength = 0;
    api.resetOutput('测试归零', 3000);
    game.tick(600);            // 静默期内跑 0.6 秒
    await settle(200);
    check('B3 归零静默期内保底不会补电', api.S.energy === 0 && api.S.strength === 0,
        JSON.stringify([api.S.energy, api.S.strength]));
    api.setSetting('hurtFloorEnergy', 0, false);
    game.player.hp = 20; game.tick(200); await settle(150);

    /* B4：回退找玩家时不能把别人当自己 */
    api.S.playerUid = 'player-1';
    api.S.energy = 0; api.S.strength = 0;
    const otherPlayer = {
        hp: 4, uid: 'other-guy',
        getAttribute: (n) => (n === 'minecraft:health' ? { current: 4, max: 20, min: 0 } : { current: 0, max: 16, min: 0 }),
        getGameType: () => 0,
        getUniqueID: () => 'other-guy',
    };
    game.mods.player.getLocalPlayer = () => { throw new Error('boom'); };
    game.mods.world.getClientWorld = () => ({ getPlayers: () => [otherPlayer, game.player] });
    game.tick(200); await settle(200);
    check('B4 回退时不会把列表里第一个（别人）当自己',
        api.S.energy === 0 && api.S.lastHp === 20,
        JSON.stringify([api.S.energy, api.S.lastHp]));

    api.S.playerUid = 'nobody';
    game.tick(200); await settle(150);
    check('B4 uid 对不上时干脆不读血量', api.S.energy === 0, api.S.energy);
    game.mods.player.getLocalPlayer = () => game.player;
    game.mods.world.getClientWorld = () => ({ getPlayers: () => [game.player] });
    api.S.playerUid = 'player-1';
    api.S.lastHp = null; api.S.lastTotal = null;
    game.tick(120); await settle(150);

    /* B5：每秒下发上限对「瞬间到位」同样有效 */
    api.setSetting('maxSendPerSec', 10, false);
    const framesBefore = relayFrames.filter((e) => e.dir === 'in' && e.data && e.data.type === 3).length;
    for (let i = 0; i < 40; i++) {
        game.player.hp = Math.max(1, game.player.hp - 0.6);
        game.tick(50);
    }
    await settle(300);
    const sent = relayFrames.filter((e) => e.dir === 'in' && e.data && e.data.type === 3).length - framesBefore;
    check('B5 瞬间到位路径也受每秒下发上限约束（2 秒 ≤ 22 条）', sent <= 22, sent + ' 条');
    api.setSetting('maxSendPerSec', 10, false);

    /* B6：暂停期间掉线，恢复后仍能自动重连 */
    api.S.paused = true;
    appX.close();
    const wentClosed = await waitFor(() => api.DG.state === 'closed' || api.DG.state === 'waiting', 3000);
    check('B6 暂停中掉线能看到断开状态', wentClosed, api.DG.state);
    api.S.paused = false;
    game.tick(4000);
    const reconnected2 = await waitFor(() => api.DG.state === 'waiting' || api.DG.state === 'paired', 5000);
    check('B6 恢复后自动重连成功', reconnected2, api.DG.state + ' ' + api.S.lastError);

    /* B7：切换「黄心也算掉血」不该误判一次大伤害/大回血 */
    api.S.energy = 0; api.S.strength = 0;
    game.player.hp = 20; game.player.absorb = 8;
    game.tick(200); await settle(150);
    api.setSetting('countAbsorption', false, false);
    game.tick(200); await settle(150);
    check('B7 关掉「黄心也算掉血」不会误判成一次伤害', api.S.energy === 0, api.S.energy);
    api.setSetting('countAbsorption', true, false);
    game.tick(200); await settle(150);
    check('B7 再打开也不会误判成一次回血', api.S.energy === 0, api.S.energy);
    game.player.absorb = 0; game.tick(120);

    /* S1：基础强度不能超过强度上限 */
    api.setSetting('baseStrength', 50, false);
    api.setSetting('maxStrength', 25, false);
    api.S.energy = 0;
    game.tick(200); await settle(150);
    check('S1 基础强度被夹在上限内', api.S.strength <= 25 && api.S.energy === 0,
        JSON.stringify([api.S.strength, api.S.energy]));
    api.setSetting('baseStrength', 0, false);

    /* S2：sp 里的非法枚举在开机时被纠正 */
    const g2 = buildGameContext({});
    g2.sp.set('dglab_hp.channel', 'XX');
    g2.sp.set('dglab_hp.bWaveform', 'NOT_A_WAVE');
    g2.sp.set('dglab_hp.damageCurve', 'nope');
    g2.api.onReadyEvent();
    check('S2 非法枚举开机时被纠正回默认值',
        g2.api.CONFIG().channel === 'A' && g2.api.CONFIG().bWaveform === '' && g2.api.CONFIG().damageCurve === 'linear',
        JSON.stringify([g2.api.CONFIG().channel, g2.api.CONFIG().bWaveform, g2.api.CONFIG().damageCurve]));

    /* ---------------- T14 新参数（延迟/濒死/限流/波形加工/界面） ---------------- */
    section('T14 新参数回归');

    /* 先连一个新的假 APP（T13 里那个已经关了） */
    const appY = await buildFakeApp(`ws://127.0.0.1:${port}/${myId}`).connect();
    check('T14 重新配对', await waitFor(() => api.DG.state === 'paired'), api.DG.state);

    /* 14.1 受伤后延迟加电 */
    api.setSetting('manualZeroHoldMs', 0, false);
    api.setSetting('hurtFloorEnergy', 0, false);
    api.setSetting('startDelaySec', 1, false);
    api.S.energy = 0; api.S.strength = 0;
    game.player.hp = 20; game.tick(150); await settle(150);
    api.S.energy = 0; api.S.strength = 0; api.S.chargeUntil = 0;
    game.player.hp = 16; game.tick(60); await settle(120);
    check('14.1 延迟期内电量还没加', api.S.energy === 0, api.S.energy);
    game.tick(1200); await settle(200);
    check('14.1 延迟到点后电量一次加上（4×3=12）', Math.abs(api.S.energy - 12) < 0.001, api.S.energy);
    api.setSetting('startDelaySec', 0, false);

    /* 14.2 低于血量就停 */
    api.setSetting('stopBelowHp', 10, false);
    api.S.energy = 0; api.S.strength = 0;
    game.player.hp = 20; game.tick(150); await settle(150);
    game.player.hp = 8; game.tick(300); await settle(200);
    check('14.2 血量低于停止线时不加电', api.S.energy === 0 && api.S.strength === 0,
        JSON.stringify([api.S.lastHp, api.S.energy, api.S.strength]));
    game.player.hp = 20; game.tick(150); await settle(150);
    game.player.hp = 18; game.tick(120); await settle(150);
    check('14.2 血回来之后恢复加电', api.S.energy > 0, api.S.energy);
    api.setSetting('stopBelowHp', 0, false);

    /* 14.3 最低输出电量 */
    api.setSetting('minOutputEnergy', 5, false);
    api.S.energy = 3;
    game.tick(150); await settle(150);
    check('14.3 电量低于最低输出线时清零', api.S.energy === 0, api.S.energy);
    api.setSetting('minOutputEnergy', 0, false);

    /* 14.4 每分钟加电上限 */
    api.setSetting('energyPerMinuteCap', 10, false);
    api.S.energy = 0; api.S.strength = 0;
    game.player.hp = 20; game.tick(150); await settle(150);
    game.player.hp = 10; game.tick(120); await settle(150);   // 掉 10 点 → 本该 30
    check('14.4 每分钟上限生效（30 → 10）', api.S.energy === 10, api.S.energy);
    api.setSetting('energyPerMinuteCap', 0, false);

    /* 14.5 复活保护 */
    api.setSetting('respawnGraceSec', 3, false);
    game.player.hp = 20; game.tick(150); await settle(150);
    game.player.hp = 0; game.tick(120); await settle(150);     // 死亡
    api.S.energy = 0; api.S.strength = 0;
    game.player.hp = 20; game.tick(120); await settle(150);    // 复活
    game.player.hp = 16; game.tick(120); await settle(150);    // 保护期内挨打
    check('14.5 复活保护期内不加电', api.S.energy === 0, api.S.energy);
    game.tick(3200);
    game.player.hp = 12; game.tick(120); await settle(150);
    check('14.5 保护期过后恢复加电', api.S.energy > 0, api.S.energy);
    api.setSetting('respawnGraceSec', 0, false);

    /* 14.6 波形快慢 + 右路错帧 */
    api.setSetting('channel', 'AB', false);
    api.setSetting('waveform', 'RHYTHM', false);
    api.setSetting('waveSpeed', 2, false);
    api.setSetting('bWaveShiftFrames', 3, false);
    api.CONFIG().critEnabled = false;
    api.S.energy = 0; api.S.strength = 0;
    game.player.hp = 20; game.tick(200); await settle(300);
    api.S.energy = 0;
    /* 只取「这段设置生效之后新发出的第一包」，别取到之前那段的波形 */
    const t14ABefore = appY.pulseFrames('A').length;
    const t14BBefore = appY.pulseFrames('B').length;
    /* 下一段波形最长可能要等当前这段放完（几秒），所以窗口给足 */
    game.player.hp = 14; game.tick(6000); await settle(400);
    const t14Rhythm = api.WAVEFORM_DATA.RHYTHM.frames;
    const t14ExpectedA = t14Rhythm.map((_, i) => t14Rhythm[Math.floor(i * 2) % t14Rhythm.length]);
    const t14Shift = 3;
    const t14ExpectedB = t14ExpectedA.slice(t14Shift).concat(t14ExpectedA.slice(0, t14Shift));
    const t14GotA = appY.pulseFrames('A')[t14ABefore];
    const t14GotB = appY.pulseFrames('B')[t14BBefore];
    check('14.6 左路波形按速度抽帧',
        !!t14GotA && t14GotA[0] === t14ExpectedA[0] && t14GotA[5] === t14ExpectedA[5],
        JSON.stringify([t14GotA && t14GotA.slice(0, 4), t14ExpectedA.slice(0, 4)]));
    check('14.6 右路波形额外错开 3 帧',
        !!t14GotB && t14GotB[0] === t14ExpectedB[0],
        JSON.stringify([t14GotB && t14GotB[0], t14ExpectedB[0]]));
    api.setSetting('waveSpeed', 1, false);
    api.setSetting('bWaveShiftFrames', 0, false);
    api.setSetting('waveform', 'BUBBLE', false);
    api.setSetting('channel', 'A', false);
    game.player.hp = 20; game.tick(200); await settle(150);

    /* 14.7 提示最小间隔 */
    api.setSetting('notifyHurt', true, false);
    api.setSetting('notifyMinIntervalMs', 5000, false);
    api.setSetting('manualZeroHoldMs', 0, false);
    api.S.energy = 0; api.S.strength = 0;
    game.player.hp = 20; game.tick(150); await settle(150);
    const chatMark = game.log.chat.length;
    game.player.hp = 18; game.tick(60); await settle(120);
    game.player.hp = 16; game.tick(60); await settle(120);
    const hurtMsgs = game.log.chat.slice(chatMark).filter((m) => m.indexOf('掉血') > 0);
    check('14.7 提示最小间隔生效（两次掉血只提示一次）', hurtMsgs.length === 1, JSON.stringify(hurtMsgs));
    api.setSetting('notifyMinIntervalMs', 0, false);
    api.setSetting('notifyHurt', false, false);

    /* 14.8 紧凑面板 + 屏幕状态条 */
    api.setSetting('panelCompact', true, false);
    const t14TextBeforeCompact = game.imguCalls.Text;
    game.sandbox.onImGuiRenderEvent();
    const t14CompactTexts = game.imguCalls.Text - t14TextBeforeCompact;
    api.setSetting('panelCompact', false, false);
    const t14TextBeforeFull = game.imguCalls.Text;
    game.sandbox.onImGuiRenderEvent();
    const t14FullTexts = game.imguCalls.Text - t14TextBeforeFull;
    check('14.8 紧凑面板画的控件更少', t14CompactTexts > 0 && t14CompactTexts < t14FullTexts,
        JSON.stringify([t14CompactTexts, t14FullTexts]));
    api.setSetting('hudEnabled', true, false);
    const t14BeginBefore = game.imguCalls.Begin;
    game.sandbox.onImGuiRenderEvent();
    check('14.8 屏幕状态条会额外开一个窗口', game.imguCalls.Begin > t14BeginBefore, game.imguCalls.Begin);
    api.setSetting('hudEnabled', false, false);

    /* ---------------- 收尾 ---------------- */
    api.onLeaveGameEvent();
    check('退出世界后归零', api.S.energy === 0 && api.S.strength === 0);

    try { appX.close(); } catch (e) { /* 忽略 */ }
    try { appY.close(); } catch (e) { /* 忽略 */ }
    game.openSockets.forEach((ws) => {
        try { ws.close(); } catch (e) { /* 忽略 */ }
    });
    await relay.close();

    console.log('\n================ 结果 ================');
    const total = RESULTS.length;
    const pass = total - failed;
    console.log(`通过 ${pass}/${total}${failed ? `，失败 ${failed}` : ''}`);
    if (failed) {
        console.log('\n失败项：');
        RESULTS.filter((r) => !r.ok).forEach((r) => console.log(' - ' + r.name + '  → ' + r.extra));
    }
    console.log(failed ? 'HARNESS FAILED' : 'HARNESS OK');
    process.exit(failed ? 1 : 0);
}

main().catch((err) => {
    console.error('测试脚手架异常：', err);
    process.exit(3);
});
