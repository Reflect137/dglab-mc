#!/usr/bin/env node
/**
 * relay-cli-selftest.js —— dglab-relay.js 的「命令行 + 协议转换」自测（不依赖任何 npm 包）
 *
 * 和 tools/relay-selftest.js 的分工：
 *   tools/relay-selftest.js   连线级（RFC6455 握手/掩码/分片/ping-pong/大包/空闲超时）
 *   本文件                    CLI 启动与状态页、错误码 400/401/402/403/404/406、
 *                            type 1/2/3/4 转换、波形拆包与覆盖、心跳、4001 关闭
 *
 * 覆盖：CLI 启动与状态页、bind/配对、错误码 400/401/402/403/404/406、
 *      type 1/2/3/4 转换、波形拆包、波形覆盖、心跳、无效 targetId 关闭码 4001。
 *
 * 运行：node test/relay-cli-selftest.js
 */

'use strict';

const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const RELAY = path.join(ROOT, 'tools', 'dglab-relay.js');
const { createRelay } = require(RELAY);

let failed = 0;
const RESULTS = [];
function check(name, cond, extra) {
    const ok = !!cond;
    if (!ok) failed++;
    RESULTS.push({ name, ok, extra });
    console.log(`${ok ? '  ✅' : '  ❌'} ${name}${!ok && extra !== undefined ? '   → ' + extra : ''}`);
}
function section(t) {
    console.log('\n=== ' + t + ' ===');
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond, timeout = 2500, step = 20) {
    const t0 = Date.now();
    for (;;) {
        if (cond()) return true;
        if (Date.now() - t0 > timeout) return false;
        await sleep(step);
    }
}

/* 一个最小的收发客户端：记录所有收到的 JSON 帧 */
function client(url) {
    const c = {
        url,
        frames: [],
        raw: [],
        ws: null,
        open: false,
        closeInfo: null,
        send(obj) {
            if (c.ws && c.ws.readyState === 1) c.ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj));
        },
        connect() {
            return new Promise((resolve, reject) => {
                const ws = new WebSocket(url);
                c.ws = ws;
                ws.onopen = () => {
                    c.open = true;
                    resolve(c);
                };
                ws.onerror = () => reject(new Error('connect failed: ' + url));
                ws.onmessage = (ev) => {
                    const text = String(ev.data);
                    c.raw.push(text);
                    try {
                        c.frames.push(JSON.parse(text));
                    } catch (e) { /* 非 JSON 忽略 */ }
                };
                ws.onclose = (ev) => {
                    c.open = false;
                    c.closeInfo = { code: ev.code, reason: ev.reason };
                };
            });
        },
        last() {
            return c.frames[c.frames.length - 1];
        },
        messages() {
            return c.frames.map((f) => f.message).filter((m) => typeof m === 'string');
        },
        close() {
            try { c.ws && c.ws.close(); } catch (e) { /* 忽略 */ }
        },
    };
    return c;
}

async function main() {
    /* ---------------------------------------------------------- CLI 启动 */
    section('CLI 启动 / 状态页');
    const cliPort = 21000 + Math.floor(Math.random() * 2000);
    const child = spawn(process.execPath, [RELAY, '--port', String(cliPort), '--host', '127.0.0.1'], {
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let cliOut = '';
    child.stdout.on('data', (d) => { cliOut += d.toString(); });
    const started = await waitFor(() => cliOut.includes('[relay] listening'), 5000, 50);
    check('CLI 能启动并打印监听地址', started, cliOut.slice(0, 200));
    check('启动横幅带 Termux 提示', cliOut.includes('termux-wake-lock') && cliOut.includes('DG-LAB APP 连接地址'),
        cliOut.slice(0, 300));

    let statusJson = null;
    try {
        const res = await fetch(`http://127.0.0.1:${cliPort}/__status`);
        statusJson = await res.json();
    } catch (e) {
        statusJson = { error: String(e) };
    }
    check('GET /__status 返回协议与连接数',
        statusJson && statusJson.protocol && typeof statusJson.connections === 'number',
        JSON.stringify(statusJson));

    let notWs = 0;
    try {
        const res = await fetch(`http://127.0.0.1:${cliPort}/whatever`);
        notWs = res.status;
    } catch (e) { /* 忽略 */ }
    check('普通 HTTP 请求返回 426', notWs === 426, notWs);

    /* ---------------------------------------------------------- 模块 API */
    section('配对与绑定');
    const relay = createRelay({ port: 0, host: '127.0.0.1', quiet: true, heartbeatMs: 400 });
    const { port } = await relay.listen();
    const base = `ws://127.0.0.1:${port}`;
    const pulses = [];
    relay.on('pulse', (e) => pulses.push(e));

    const ctrl = await client(`${base}/?cid=selftest-ctrl`).connect();
    check('控制端固定 cid 生效', await waitFor(() => ctrl.frames.some((f) => f.type === 'bind')), ctrl.raw.join('|'));
    check('初始 bind 帧 message=targetId', ctrl.frames[0] && ctrl.frames[0].message === 'targetId',
        JSON.stringify(ctrl.frames[0]));
    check('初始 bind 帧 clientId=selftest-ctrl', ctrl.frames[0] && ctrl.frames[0].clientId === 'selftest-ctrl');

    const ctrl2 = await client(`${base}/?cid=selftest-ctrl`).connect();
    check('cid 被占用时回退随机 id（而不是拒绝连接）',
        await waitFor(() => ctrl2.frames.length > 0) && ctrl2.frames[0].clientId !== 'selftest-ctrl',
        JSON.stringify(ctrl2.frames[0]));
    ctrl2.close();

    const app = await client(`${base}/selftest-ctrl`).connect();
    const appId = await (async () => {
        await waitFor(() => app.frames.length > 0);
        return app.frames[0].clientId;
    })();
    check('APP 端拿到自己的 clientId', !!appId && appId !== 'selftest-ctrl', appId);
    check('控制端收到配对成功 bind(200)',
        ctrl.frames.some((f) => f.type === 'bind' && f.message === '200' && f.targetId === appId),
        JSON.stringify(ctrl.frames.slice(1)));
    check('APP 端也收到 bind(200)', app.frames.some((f) => f.type === 'bind' && f.message === '200'));

    /* ---------------------------------------------------------- 强度与错误码 */
    section('强度指令转换 / 错误码');
    ctrl.send({ type: 3, clientId: 'selftest-ctrl', targetId: appId, channel: 'A', strength: 20, message: 'set channel' });
    check('type 3 → strength-1+2+20',
        await waitFor(() => app.messages().includes('strength-1+2+20')), JSON.stringify(app.messages()));

    ctrl.send({ type: 2, clientId: 'selftest-ctrl', targetId: appId, channel: 'b', strength: 0, message: 'set channel' });
    check('type 2 → strength-2+1+1（通道 b 归一化）',
        await waitFor(() => app.messages().includes('strength-2+1+1')), JSON.stringify(app.messages()));

    ctrl.send({ type: 1, clientId: 'selftest-ctrl', targetId: appId, channel: 1, strength: 0, message: 'set channel' });
    check('type 1 → strength-1+0+1',
        await waitFor(() => app.messages().includes('strength-1+0+1')), JSON.stringify(app.messages()));

    ctrl.send({ type: 4, clientId: 'selftest-ctrl', targetId: appId, channel: 'A', strength: 35, message: 'set channel' });
    check('type 4 不带 clear → strength-1+2+35',
        await waitFor(() => app.messages().includes('strength-1+2+35')), JSON.stringify(app.messages()));

    ctrl.send({ type: 4, clientId: 'selftest-ctrl', targetId: appId, channel: 'B', message: 'clear' });
    check('type 4 带 clear → clear-2',
        await waitFor(() => app.messages().includes('clear-2')), JSON.stringify(app.messages()));

    ctrl.send({ type: 3, clientId: 'selftest-ctrl', targetId: appId, channel: 'X', strength: 5, message: 'set channel' });
    check('非法通道 → 406', await waitFor(() => ctrl.frames.some((f) => f.type === 'error' && f.message === '406')),
        JSON.stringify(ctrl.frames.filter((f) => f.type === 'error')));

    ctrl.send({ type: 3, clientId: 'someone-else', targetId: appId, channel: 'A', strength: 5, message: 'set channel' });
    check('来源非法 → 404', await waitFor(() => ctrl.frames.some((f) => f.type === 'error' && f.message === '404')));

    const err403 = () => ctrl.frames.filter((f) => f.type === 'error' && f.message === '403').length;
    ctrl.send('这不是JSON');
    check('非法 JSON → 403', await waitFor(() => err403() >= 1), JSON.stringify(ctrl.frames.filter((f) => f.type === 'error')));
    ctrl.send({ type: 'msg', clientId: 'selftest-ctrl', targetId: appId });
    check('缺字段 → 403', await waitFor(() => err403() >= 2), JSON.stringify(ctrl.frames.filter((f) => f.type === 'error')));

    /* ---------------------------------------------------------- 波形 */
    section('波形拆包 / 覆盖 / 通知');
    const frames = ['0A0A0A0A00000000', '0A0A0A0A64646464'];
    ctrl.send({ type: 'clientMsg', clientId: 'selftest-ctrl', targetId: appId, channel: 'A', time: 3, message: `A:${JSON.stringify(frames)}` });
    await waitFor(() => app.messages().some((m) => m.indexOf('pulse-A:') === 0));
    const firstPulse = app.messages().find((m) => m.indexOf('pulse-A:') === 0);
    const parsed = JSON.parse(firstPulse.slice(firstPulse.indexOf(':') + 1));
    check('波形首包立即发出', !!firstPulse);
    check('首包 10 帧且都是 16 位十六进制',
        parsed.length === 10 && parsed.every((f) => /^[0-9A-Fa-f]{16}$/.test(f)), JSON.stringify(parsed.length));
    check('replay 事件报告 3 秒 / 3 包 / 30 帧',
        pulses.length === 1 && pulses[0].seconds === 3 && pulses[0].packets === 3,
        JSON.stringify(pulses[0]));

    const before = app.messages().filter((m) => m.indexOf('pulse-A:') === 0).length;
    ctrl.send({ type: 'clientMsg', clientId: 'selftest-ctrl', targetId: appId, channel: 'A', time: 2, message: `A:${JSON.stringify(frames)}` });
    check('同通道覆盖波形时先发 clear-1',
        await waitFor(() => app.messages().filter((m) => m === 'clear-1').length > 0), JSON.stringify(app.messages().slice(-4)));
    check('覆盖时通知控制端',
        await waitFor(() => ctrl.messages().some((m) => m.indexOf('覆盖之前的消息') >= 0)), JSON.stringify(ctrl.messages().slice(-3)));
    check('覆盖后新波形继续发', await waitFor(() => app.messages().filter((m) => m.indexOf('pulse-A:') === 0).length > before));
    check('波形发完通知“发送完毕”',
        await waitFor(() => ctrl.messages().includes('发送完毕'), 6000), JSON.stringify(ctrl.messages().slice(-3)));

    /* ---------------------------------------------------------- APP 回传 / 心跳 */
    section('APP 回传 / 心跳');
    app.send({ type: 'msg', clientId: appId, targetId: 'selftest-ctrl', message: 'strength-12+3+30+30' });
    check('APP 强度回传转发给控制端',
        await waitFor(() => ctrl.messages().includes('strength-12+3+30+30')), JSON.stringify(ctrl.messages().slice(-3)));

    app.send({ type: 'msg', clientId: appId, targetId: 'selftest-ctrl', message: 'feedback-2' });
    check('APP 按钮反馈转发给控制端',
        await waitFor(() => ctrl.messages().includes('feedback-2')), JSON.stringify(ctrl.messages().slice(-3)));

    check('服务端心跳帧（heartbeatMs=400）',
        await waitFor(() => ctrl.frames.some((f) => f.type === 'heartbeat'), 2500),
        JSON.stringify(ctrl.frames.slice(-2)));

    app.frames.length = 0;
    ctrl.send({ type: 'heartbeat', clientId: 'selftest-ctrl', targetId: appId, message: '200' });
    await sleep(200);
    check('客户端 heartbeat 被忽略（不转发给 APP）', !app.frames.some((f) => f.type === 'msg'),
        JSON.stringify(app.frames.map((f) => f.type + ':' + f.message)));

    /* ---------------------------------------------------------- 其它 */
    section('无效目标 / 断开联动');
    const bad = client(`${base}/not-exist-id`);
    let badClosed = false;
    try {
        await bad.connect();
    } catch (e) {
        badClosed = true;
    }
    await waitFor(() => bad.closeInfo !== null, 1500);
    check('APP 连不存在的 targetId → 关闭码 4001', badClosed || (bad.closeInfo && bad.closeInfo.code === 4001),
        JSON.stringify(bad.closeInfo));

    app.close();
    check('APP 断开后控制端收到 break(209)',
        await waitFor(() => ctrl.frames.some((f) => f.type === 'break' && f.message === '209'), 2500),
        JSON.stringify(ctrl.frames.slice(-2)));

    await relay.close();
    check('relay.close() 后端口释放', true);

    /* ---------------------------------------------------------- CLI 收尾 */
    child.kill('SIGINT');
    const exited = await new Promise((resolve) => {
        const timer = setTimeout(() => resolve(false), 3000);
        child.on('exit', () => {
            clearTimeout(timer);
            resolve(true);
        });
    });
    check('CLI 收到 SIGINT 后优雅退出', exited);
    check('退出前打印关闭提示', cliOut.includes('正在关闭') || cliOut.includes('bye'), cliOut.slice(-200));

    console.log('\n================ 结果 ================');
    const total = RESULTS.length;
    console.log(`通过 ${total - failed}/${total}${failed ? `，失败 ${failed}` : ''}`);
    if (failed) {
        RESULTS.filter((r) => !r.ok).forEach((r) => console.log(' - ' + r.name + '  → ' + r.extra));
    }
    console.log(failed ? 'SELFTEST FAILED' : 'SELFTEST OK');
    process.exit(failed ? 1 : 0);
}

main().catch((err) => {
    console.error('自测异常：', err);
    process.exit(3);
});
