#!/usr/bin/env node
/**
 * relay-hardening.js —— 中继「抗打击 / 长期运行」回归测试
 *
 * 对应独立审查报告里的 7 个真 bug + 2 个低危项，每条都在这里钉住：
 *   1. clientMsg 的 time 无上限  → 一条报文打死进程
 *   2. 同通道 3 条波形落在 150ms 覆盖窗口内 → 孤儿 setInterval（永久泄漏 + 波形被掐断）
 *   3. 深嵌套 JSON + --log/--verbose → JSON.stringify 爆栈打死进程
 *   4. stdout 管道断开（EPIPE）→ 常驻进程退出
 *   5. 僵尸连接占住 ?cid= → 真控制端拿不到 id / APP 连到僵尸
 *   6. 对端只连不读 → 发送缓冲无限增长
 *   7. events 只按条数封顶 → 大报文吃掉上百 MB
 *   8. 非法关闭码被原样回显（RFC6455 §5.5.1）
 *   9. Sec-WebSocket-Key 不校验（RFC6455 §4.2.1）
 *
 * 运行：node test/relay-hardening.js
 */

'use strict';

const net = require('node:net');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const RELAY = path.join(ROOT, 'tools', 'dglab-relay.js');
const { createRelay } = require(RELAY);

let failed = 0;
const check = (name, ok, extra) => {
    if (!ok) failed++;
    console.log((ok ? '  ✅ ' : '  ❌ ') + name + (!ok && extra !== undefined ? '   → ' + extra : ''));
};
const section = (t) => console.log('\n=== ' + t + ' ===');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond, timeout = 3000, step = 20) {
    const t0 = Date.now();
    for (;;) {
        if (cond()) return true;
        if (Date.now() - t0 > timeout) return false;
        await sleep(step);
    }
}
async function alive(port) {
    try {
        const res = await fetch(`http://127.0.0.1:${port}/__status`);
        await res.json();
        return true;
    } catch (e) {
        return false;
    }
}

/* 极简客户端：只收 JSON 帧 */
function client(url) {
    const c = { frames: [], ws: null, closeInfo: null };
    c.connect = () => new Promise((resolve, reject) => {
        const ws = new WebSocket(url);
        c.ws = ws;
        ws.onopen = () => resolve(c);
        ws.onerror = () => reject(new Error('connect failed ' + url));
        ws.onmessage = (ev) => {
            try { c.frames.push(JSON.parse(String(ev.data))); } catch (e) { /* 忽略 */ }
        };
        ws.onclose = (ev) => { c.closeInfo = { code: ev.code, reason: ev.reason }; };
    });
    c.msgs = () => c.frames.map((f) => f.message).filter((m) => typeof m === 'string');
    c.send = (o) => { if (c.ws && c.ws.readyState === 1) c.ws.send(JSON.stringify(o)); };
    c.sendRaw = (text) => { if (c.ws && c.ws.readyState === 1) c.ws.send(text); };
    c.close = () => { try { c.ws && c.ws.close(); } catch (e) { /* 忽略 */ } };
    return c;
}

/* 原始 socket 握手 / 帧构造 */
function handshake(pathname, key = 'dGhlIHNhbXBsZSBub25jZQ==') {
    return [
        'GET ' + pathname + ' HTTP/1.1', 'Host: 127.0.0.1', 'Upgrade: websocket', 'Connection: Upgrade',
        'Sec-WebSocket-Key: ' + key, 'Sec-WebSocket-Version: 13', '', '',
    ].join('\r\n');
}
function frame(opcode, payload) {
    const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
    const mask = Buffer.from([1, 2, 3, 4]);
    let header;
    if (data.length < 126) {
        header = Buffer.from([0x80 | opcode, 0x80 | data.length]);
    } else {
        header = Buffer.alloc(4);
        header[0] = 0x80 | opcode; header[1] = 0x80 | 126; header.writeUInt16BE(data.length, 2);
    }
    const out = Buffer.alloc(data.length);
    for (let i = 0; i < data.length; i++) out[i] = data[i] ^ mask[i % 4];
    return Buffer.concat([header, mask, out]);
}

async function main() {
    /* ---------------------------------------------------------- 1 + 2 + 7：进程存活相关的三条 */
    section('#1 time 无上限 / #2 孤儿定时器 / #7 events 字节封顶');
    {
        const relay = createRelay({ port: 0, host: '127.0.0.1', quiet: true });
        const { port } = await relay.listen();
        const ctrl = await client(`ws://127.0.0.1:${port}/?cid=hardening`).connect();
        const app = await client(`ws://127.0.0.1:${port}/hardening`).connect();
        await waitFor(() => ctrl.frames.some((f) => f.message === '200'));

        /* #1：离谱的 time（毫秒当秒传、或者恶意值） */
        ctrl.send({ type: 'clientMsg', clientId: 'hardening', targetId: app.frames[0].clientId, channel: 'A', time: 1e15, message: 'A:["0000000000000000"]' });
        await sleep(300);
        check('#1 收到 time=1e15 后中继仍然活着', await alive(port));
        ctrl.send({ type: 'clientMsg', clientId: 'hardening', targetId: app.frames[0].clientId, channel: 'B', time: 300000, message: 'B:["0000000000000000"]' });
        await sleep(300);
        check('#1 收到 time=300000（毫秒当秒）后仍然活着', await alive(port));
        const pulseEvt = relay.events.filter((e) => e.type === 'pulse').slice(-1)[0];
        check('#1 波形秒数被钳制在上限内（≤3600）', !pulseEvt || pulseEvt.seconds <= 3600,
            JSON.stringify(pulseEvt && pulseEvt.seconds));
        check('#7 pulse 事件不再挂整份 frames', !pulseEvt || (pulseEvt.frames || []).length <= 40,
            JSON.stringify(pulseEvt && (pulseEvt.frames || []).length));

        /* 把 #1 那两条（被钳到 3600s 的）波形清掉，免得干扰后面的定时器计数 */
        ctrl.send({ type: 4, clientId: 'hardening', targetId: app.frames[0].clientId, channel: 'A', message: 'clear' });
        ctrl.send({ type: 4, clientId: 'hardening', targetId: app.frames[0].clientId, channel: 'B', message: 'clear' });
        await sleep(300);

        /* #7：大报文进 events 也要有字节上限 */
        for (let i = 0; i < 60; i++) {
            relay._record('in', 'x', { type: 'msg', clientId: 'x', targetId: 'y', message: 'A'.repeat(100000) });
        }
        check('#7 events 字节预算生效（≤4MB）', relay._eventsBytes <= 4 * 1024 * 1024 + 1024,
            relay._eventsBytes + ' 字节 / ' + relay.events.length + ' 条');
        const lastMsg = relay.events.slice(-1)[0].data.message;
        check('#7 单条 message 被截断保存', lastMsg.length <= 4200, lastMsg.length);

        /* #2：同通道 3 条波形落在 150ms 覆盖窗口内 */
        const appId = app.frames[0].clientId;
        for (let i = 0; i < 3; i++) {
            ctrl.send({
                type: 'clientMsg', clientId: 'hardening', targetId: appId, channel: 'A', time: 3,
                message: 'A:["0A0A0A0A00000000","0A0A0A0A64646464"]',
            });
            await sleep(40);   // 3 条落在 150ms 的覆盖窗口里
        }
        await sleep(600);
        check('#2 A 通道只剩一个定时任务（没有脱离管理的孤儿）', relay.pulseTimers.size <= 1, relay.pulseTimers.size);
        check('#2 没有残留的待启动定时器', relay.pendingStarts.size === 0, relay.pendingStarts.size);
        const doneCount = ctrl.msgs().filter((m) => m === '发送完毕').length;
        check('#2 控制端没有被「发送完毕」刷屏（≤6 条）', doneCount <= 6, doneCount);

        /* 真正要钉住的症状：清掉波形之后不能还有孤儿 interval 继续偷偷发 */
        const appIdForClear = app.frames[0].clientId;
        ctrl.send({ type: 4, clientId: 'hardening', targetId: appIdForClear, channel: 'A', message: 'clear' });
        await sleep(300);
        const pulsesAfterClear = app.msgs().filter((m) => m.indexOf('pulse-A:') === 0).length;
        await sleep(2500);
        const leaked = app.msgs().filter((m) => m.indexOf('pulse-A:') === 0).length - pulsesAfterClear;
        check('#2 清掉之后不再有波形漏出来（孤儿定时器已消除）', leaked === 0, leaked + ' 包');

        /* 覆盖之后再来一条正常波形，必须完整送到（以前会被孤儿任务掐断） */
        const before = app.msgs().filter((m) => m.indexOf('pulse-A:') === 0).length;
        ctrl.send({ type: 'clientMsg', clientId: 'hardening', targetId: appId, channel: 'A', time: 3, message: 'A:["0A0A0A0A00000000","0A0A0A0A64646464"]' });
        await waitFor(() => app.msgs().filter((m) => m.indexOf('pulse-A:') === 0).length >= before + 3, 6000);
        const got = app.msgs().filter((m) => m.indexOf('pulse-A:') === 0).length - before;
        check('#2 覆盖后新波形能完整发完（3 包）', got >= 3, got + ' 包');

        ctrl.close(); app.close();
        await relay.close();
    }

    /* ---------------------------------------------------------- 3：深嵌套 JSON（开了日志才有风险） */
    section('#3 深嵌套 JSON + 开启日志');
    {
        const logFile = '/tmp/dglab-relay-hardening.jsonl';
        try { require('fs').unlinkSync(logFile); } catch (e) { /* 忽略 */ }
        const relay = createRelay({ port: 0, host: '127.0.0.1', quiet: true, logFile });
        const { port } = await relay.listen();
        const c = await client(`ws://127.0.0.1:${port}/?cid=deep`).connect();
        /* 手工拼 6000 层嵌套：用 JSON.stringify 在测试里就会先爆栈 */
        const deepText = '{"type":"msg","clientId":"deep","targetId":"x","message":"m","junk":' +
            '['.repeat(6000) + '1' + ']'.repeat(6000) + '}';
        c.sendRaw(deepText);
        await sleep(400);
        check('#3 深嵌套报文 + --log 时中继仍然活着', await alive(port));
        check('#3 日志文件已写出内容', require('fs').existsSync(logFile) && require('fs').statSync(logFile).size > 0);
        c.close();
        await relay.close();
    }

    /* ---------------------------------------------------------- 4：stdout 管道断掉（子进程） */
    section('#4 stdout 管道断开（EPIPE）');
    {
        const port = 24000 + Math.floor(Math.random() * 1000);
        const child = spawn(process.execPath, [RELAY, '--port', String(port), '--host', '127.0.0.1', '--verbose'], {
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        await waitFor(() => true, 1);
        await sleep(700);
        child.stdout.destroy();          // 模拟 `| head` 之类的下游退出
        child.stdout.on('error', () => {});
        await sleep(200);
        /* 触发一次日志写入（verbose 会写 stdout） */
        try {
            const c = new WebSocket(`ws://127.0.0.1:${port}/?cid=epipe`);
            await new Promise((r) => { c.onopen = r; c.onerror = r; setTimeout(r, 800); });
            try { c.close(); } catch (e) { /* 忽略 */ }
        } catch (e) { /* 忽略 */ }
        await sleep(600);
        const stillThere = await alive(port);
        check('#4 管道断开后中继仍然在服务', stillThere);
        child.kill('SIGKILL');
    }

    /* ---------------------------------------------------------- 5：僵尸 cid 回收 */
    section('#5 僵尸连接占住 ?cid=');
    {
        const relay = createRelay({ port: 0, host: '127.0.0.1', quiet: true, staleMs: 400 });
        const { port } = await relay.listen();
        const ghost = await client(`ws://127.0.0.1:${port}/?cid=ghost`).connect();
        await sleep(600);   // 超过 staleMs，且它一句话都不说
        const real = await client(`ws://127.0.0.1:${port}/?cid=ghost`).connect();
        await waitFor(() => real.frames.length > 0, 2000);
        check('#5 真控制端能拿回被僵尸占用的 cid', real.frames[0] && real.frames[0].clientId === 'ghost',
            JSON.stringify(real.frames[0]));
        check('#5 僵尸连接已被回收', ghost.closeInfo !== null, JSON.stringify(ghost.closeInfo));

        /* APP 连到僵尸 id 时不应配对成功 */
        const ghost2 = await client(`ws://127.0.0.1:${port}/?cid=ghost2`).connect();
        await sleep(600);
        const appBad = new WebSocket(`ws://127.0.0.1:${port}/ghost2`);
        const appBadClose = await new Promise((resolve) => {
            appBad.onclose = (ev) => resolve({ code: ev.code, reason: ev.reason });
            appBad.onerror = () => resolve({ code: -1 });
            setTimeout(() => resolve(null), 2000);
        });
        check('#5 APP 不会和僵尸配对（4001 关闭）', appBadClose && appBadClose.code === 4001,
            JSON.stringify(appBadClose));
        ghost2.close();
        real.close();
        await relay.close();
    }

    /* ---------------------------------------------------------- 6：背压 */
    section('#6 发送侧背压');
    {
        const relay = createRelay({ port: 0, host: '127.0.0.1', quiet: true });
        await relay.listen();
        const fakeConn = { readyState: 1, socket: { writableLength: 8 * 1024 * 1024 }, sendText: () => true, clientId: 'x' };
        const sent = relay._send(fakeConn, { type: 'msg', message: 'hi' });
        check('#6 积压超限时 _send 返回 false（不继续吃内存）', sent === false, String(sent));
        const okConn = { readyState: 1, socket: { writableLength: 0 }, sendText: () => true, clientId: 'x' };
        check('#6 正常情况仍然能发', relay._send(okConn, { type: 'msg', message: 'hi' }) === true);
        await relay.close();
    }

    /* ---------------------------------------------------------- 8 + 9：低危项 */
    section('#8 非法关闭码 / #9 Sec-WebSocket-Key 校验');
    {
        const relay = createRelay({ port: 0, host: '127.0.0.1', quiet: true });
        const { port } = await relay.listen();

        /* 非法关闭码：1006 绝对不能上线回显 */
        const sock = net.connect(port, '127.0.0.1');
        await new Promise((r) => sock.on('connect', r));
        sock.on('error', () => {});
        sock.write(handshake('/?cid=cc'));
        await sleep(200);
        const buf = Buffer.from([0x03, 0xEE]);   // 1006
        sock.write(frame(0x8, buf));
        const reply = await new Promise((resolve) => {
            let data = Buffer.alloc(0);
            sock.on('data', (d) => {
                data = Buffer.concat([data, d]);
                /* 先收到的是 HTTP 101 握手响应，要等关闭帧（0x88）出现 */
                const headEnd = data.indexOf('\r\n\r\n');
                if (headEnd >= 0 && data.slice(headEnd + 4).indexOf(0x88) >= 0) resolve(data);
            });
            setTimeout(() => resolve(data), 1500);
        });
        /* 找服务端回的关闭帧（0x88），看它带的码 */
        let closeCode = null;
        for (let i = 0; i < reply.length - 3; i++) {
            if (reply[i] === 0x88) {
                const len = reply[i + 1] & 0x7f;
                if (len >= 2 && i + 4 < reply.length) closeCode = reply.readUInt16BE(i + 2);
                break;
            }
        }
        check('#8 非法关闭码回执 1002（不是 1006）', closeCode === 1002, 'code=' + closeCode);
        sock.destroy();

        /* 短 Key：必须 400 */
        const sock2 = net.connect(port, '127.0.0.1');
        await new Promise((r) => sock2.on('connect', r));
        sock2.on('error', () => {});
        let text = '';
        sock2.on('data', (d) => { text += d.toString(); });
        sock2.write(handshake('/?cid=kk', 'short'));
        await sleep(500);
        check('#9 非法 Sec-WebSocket-Key 被 400 拒绝', /400/.test(text), JSON.stringify(text.slice(0, 60)));
        sock2.destroy();
        await relay.close();
    }

    console.log('\n================ 结果 ================');
    console.log(failed ? ('加固测试失败 ' + failed + ' 项') : '加固测试全部通过');
    console.log(failed ? 'HARDENING FAILED' : 'HARDENING OK');
    process.exit(failed ? 1 : 0);
}

main().catch((e) => {
    console.error('加固测试脚本自身异常：', e);
    process.exit(3);
});
