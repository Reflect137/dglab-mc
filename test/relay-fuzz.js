#!/usr/bin/env node
/**
 * relay-fuzz.js —— 拿畸形/恶意 WebSocket 数据轰中继，确认它不会崩、不会卡死
 *
 * 中继是要在手机上常驻几天的进程，任何未捕获异常都会让整条链路断掉，
 * 所以这里用原始 TCP 直接发不合法的帧，检查：
 *   1. 每种攻击后中继仍然活着（GET /__status 正常返回）；
 *   2. 正常客户端仍然能连上、配对、下发强度；
 *   3. 没有残留连接/定时器堆积。
 *
 * 运行：node test/relay-fuzz.js
 */

'use strict';

const net = require('node:net');
const path = require('path');
const { createRelay } = require(path.join(__dirname, '..', 'tools', 'dglab-relay.js'));

let failed = 0;
const check = (name, ok, extra) => {
    if (!ok) failed++;
    console.log((ok ? '  ✅ ' : '  ❌ ') + name + (!ok && extra !== undefined ? '   → ' + extra : ''));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 手工构造一个 WebSocket 握手请求 */
function handshake(pathname, extraHeaders = '') {
    return [
        'GET ' + pathname + ' HTTP/1.1',
        'Host: 127.0.0.1',
        'Upgrade: websocket',
        'Connection: Upgrade',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Version: 13',
        extraHeaders,
        '', '',
    ].join('\r\n');
}

/* 手工构造一个客户端→服务端（带掩码）的帧 */
function clientFrame(opcode, payload, opts = {}) {
    const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
    const mask = Buffer.from([0x11, 0x22, 0x33, 0x44]);
    const fin = opts.fin === undefined ? 1 : opts.fin;
    const rsv = opts.rsv || 0;
    const masked = opts.unmasked ? 0 : 1;
    let header;
    if (data.length < 126) {
        header = Buffer.from([(fin << 7) | (rsv << 4) | opcode, (masked << 7) | data.length]);
    } else if (data.length < 65536) {
        header = Buffer.alloc(4);
        header[0] = (fin << 7) | (rsv << 4) | opcode;
        header[1] = (masked << 7) | 126;
        header.writeUInt16BE(data.length, 2);
    } else {
        header = Buffer.alloc(10);
        header[0] = (fin << 7) | (rsv << 4) | opcode;
        header[1] = (masked << 7) | 127;
        header.writeUInt32BE(0, 2);
        header.writeUInt32BE(data.length, 6);
    }
    if (!masked) return Buffer.concat([header, data]);
    const out = Buffer.alloc(data.length);
    for (let i = 0; i < data.length; i++) out[i] = data[i] ^ mask[i % 4];
    return Buffer.concat([header, mask, out]);
}

async function alive(port) {
    try {
        const res = await fetch(`http://127.0.0.1:${port}/__status`);
        const j = await res.json();
        return typeof j.connections === 'number';
    } catch (e) {
        return false;
    }
}

async function main() {
    const relay = createRelay({ port: 0, host: '127.0.0.1', quiet: true });
    const { port } = await relay.listen();
    const crashes = [];
    process.on('uncaughtException', (e) => crashes.push(String(e && e.message)));
    console.log('[fuzz] 中继 ws://127.0.0.1:' + port);

    const attacks = [
        ['纯垃圾字节', () => Buffer.from('GET / HTTP/1.1\r\nHost: x\r\n\r\n\x00\x01\x02\x03乱码')],
        ['握手缺 Sec-WebSocket-Key', () => Buffer.from('GET / HTTP/1.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n')],
        ['握手版本号为 8', () => Buffer.from(handshake('/').replace('Version: 13', 'Version: 8'))],
        ['超长 URL', () => Buffer.from(handshake('/' + 'a'.repeat(9000)))],
        ['声明 2^31 长度的帧', () => {
            const h = Buffer.alloc(10);
            h[0] = 0x81; h[1] = 0x80 | 127;
            h.writeUInt32BE(0x7fffffff, 2); h.writeUInt32BE(0xffffffff, 6);
            return Buffer.concat([h, Buffer.from([1, 2, 3, 4])]);
        }],
        ['RSV 位全开', (sock) => { sock.write(handshake('/')); return null; }],
        ['未掩码的客户端帧（协议要求掩码）', null],
        ['分片消息中间插 ping', null],
        ['分片只发一半就断', null],
        ['关闭帧带非法状态码', null],
        ['零长度帧', null],
        ['超大文本帧（1MB）', null],
        ['半截握手后断开', () => Buffer.from('GET / HTTP/1.1\r\nHost: 127')],
    ];

    for (const [name, make] of attacks) {
        const sock = net.connect(port, '127.0.0.1');
        await new Promise((r) => sock.on('connect', r));
        sock.on('error', () => {});

        if (name === 'RSV 位全开') {
            sock.write(handshake('/'));
            await sleep(120);
            sock.write(clientFrame(0x1, 'hello', { rsv: 7 }));
        } else if (name === '未掩码的客户端帧（协议要求掩码）') {
            sock.write(handshake('/'));
            await sleep(120);
            sock.write(clientFrame(0x1, 'hello', { unmasked: true }));
        } else if (name === '分片消息中间插 ping') {
            sock.write(handshake('/'));
            await sleep(120);
            sock.write(clientFrame(0x1, 'abc', { fin: 0 }));   // 分片 1
            sock.write(clientFrame(0x9, 'ping'));              // 控制帧插中间
            sock.write(clientFrame(0x0, 'def', { fin: 1 }));   // 分片 2
        } else if (name === '分片只发一半就断') {
            sock.write(handshake('/'));
            await sleep(120);
            sock.write(clientFrame(0x1, 'abc', { fin: 0 }));
        } else if (name === '关闭帧带非法状态码') {
            sock.write(handshake('/'));
            await sleep(120);
            sock.write(clientFrame(0x8, Buffer.from([0x00, 0x01])));
        } else if (name === '零长度帧') {
            sock.write(handshake('/'));
            await sleep(120);
            sock.write(clientFrame(0x1, ''));
        } else if (name === '超大文本帧（1MB）') {
            sock.write(handshake('/'));
            await sleep(120);
            sock.write(clientFrame(0x1, 'x'.repeat(1024 * 1024)));
        } else {
            const buf = make ? make(sock) : null;
            if (buf) sock.write(buf);
        }
        await sleep(150);
        sock.destroy();
        await sleep(80);
        const ok = await alive(port);
        check('攻击「' + name + '」后中继仍然活着', ok);
    }

    check('没有触发未捕获异常', crashes.length === 0, JSON.stringify(crashes.slice(0, 3)));

    /* 攻击之后，正常客户端还能不能干活 */
    console.log('\n=== 攻击后功能自检 ===');
    const ctrl = new WebSocket(`ws://127.0.0.1:${port}/?cid=fuzzctrl`);
    const ctrlFrames = [];
    ctrl.onmessage = (e) => ctrlFrames.push(JSON.parse(String(e.data)));
    await sleep(300);
    const gotBind = ctrlFrames.some((f) => f.type === 'bind' && f.clientId === 'fuzzctrl');
    check('攻击后控制端仍能正常握手', gotBind, JSON.stringify(ctrlFrames.slice(0, 2)));

    const app = new WebSocket(`ws://127.0.0.1:${port}/fuzzctrl`);
    const appMsgs = [];
    app.onmessage = (e) => appMsgs.push(JSON.parse(String(e.data)));
    await sleep(400);
    const paired = ctrlFrames.some((f) => f.type === 'bind' && f.message === '200');
    check('攻击后仍能正常配对', paired);
    const appId = (ctrlFrames.find((f) => f.type === 'bind' && f.message === '200') || {}).targetId;
    ctrl.send(JSON.stringify({ type: 3, clientId: 'fuzzctrl', targetId: appId, channel: 'A', strength: 5, message: 'set channel' }));
    await sleep(300);
    check('攻击后强度转换仍正常',
        appMsgs.some((m) => m.message === 'strength-1+2+5'),
        JSON.stringify(appMsgs.slice(-2)));

    /* 连接数应当回到合理值（没有因为畸形连接堆积） */
    let status = null;
    try {
        status = await (await fetch(`http://127.0.0.1:${port}/__status`)).json();
    } catch (e) { /* 忽略 */ }
    check('连接数没有堆积（≤ 2 个在线）', status && status.connections <= 2, JSON.stringify(status));

    ctrl.close(); app.close();
    await relay.close();

    console.log('\n================ 结果 ================');
    console.log(failed ? ('FUZZ 失败 ' + failed + ' 项') : 'FUZZ 全部通过');
    console.log(failed ? 'FUZZ FAILED' : 'FUZZ OK');
    process.exit(failed ? 1 : 0);
}

main().catch((e) => {
    console.error('fuzz 脚本自身异常：', e);
    process.exit(3);
});
