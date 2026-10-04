#!/usr/bin/env node
'use strict';

/*
 * relay-selftest.js —— dglab-relay.js 自测
 * =====================================================================
 * 零依赖：使用 Node v24 自带的全局 WebSocket 作为客户端，
 * 另外用 node:net 手写一个原始 WebSocket 客户端，独立验证：
 *   - HTTP Upgrade 握手与 Sec-WebSocket-Accept 计算
 *   - 掩码 / 125 / 126(16位) / 127(64位) 长度分支
 *   - 分片帧（continuation）拼接
 *   - ping / pong / close 帧
 *
 * 全部通过 → 打印 SELFTEST OK 并 exit 0；否则打印具体断言并 exit 1。
 *
 * 说明：波形包前缀与参考实现一致，用的是**通道字母** pulse-A: / pulse-B:
 * （v3-server.ts:976 `pulse-${channel}`，channel 取 channel.letter），
 * 强度指令用的是**通道号** strength-1+...，两者不要混淆。
 *
 * 运行：node tools/relay-selftest.js
 */

const assert = require('node:assert/strict');
const net = require('node:net');
const crypto = require('node:crypto');
const { createRelay } = require('./dglab-relay.js');

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const HOST = '127.0.0.1';

let passes = 0;
let failures = 0;
const cleanup = [];
const failureLines = [];

function log(line) {
    process.stdout.write(`${line}\n`);
}

function fmt(value) {
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}

async function test(name, fn) {
    try {
        await fn();
        passes += 1;
        log(`  \u2713 ${name}`);
    } catch (err) {
        failures += 1;
        const message = err && err.message ? err.message : String(err);
        log(`  \u2717 ${name}`);
        log(`      ${message}`);
        failureLines.push(`${name} :: ${message}`);
    }
}

// ---------------------------------------------------------------- 测试用 WebSocket 客户端

class TestClient {
    constructor(ws) {
        this.ws = ws;
        this.queue = [];
        this.waiters = [];
        this.closeWaiters = [];
        this.closed = null;
        this.opened = false;
        this.received = [];
    }

    static open(url, timeoutMs = 5000) {
        return new Promise((resolve, reject) => {
            const ws = new WebSocket(url);
            const client = new TestClient(ws);
            let settled = false;

            const timer = setTimeout(() => {
                if (settled) return;
                settled = true;
                try {
                    ws.close();
                } catch {
                    /* ignore */
                }
                reject(new Error(`连接超时：${url}`));
            }, timeoutMs);

            ws.addEventListener('message', (ev) => {
                const text = typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8');
                let json = null;
                try {
                    json = JSON.parse(text);
                } catch {
                    json = null;
                }
                const msg = { text, json };
                client.received.push(msg);
                client._push(msg);
            });

            ws.addEventListener('close', (ev) => {
                client.closed = { code: ev.code, reason: ev.reason };
                for (const waiter of client.closeWaiters.splice(0)) {
                    clearTimeout(waiter.timer);
                    waiter.resolve(client.closed);
                }
                if (!settled) {
                    settled = true;
                    clearTimeout(timer);
                    reject(new Error(`握手阶段被关闭：code=${ev.code} url=${url}`));
                }
            });

            ws.addEventListener('error', () => {
                /* 统一由 close / 超时处理 */
            });

            ws.addEventListener(
                'open',
                () => {
                    if (settled) return;
                    settled = true;
                    clearTimeout(timer);
                    client.opened = true;
                    resolve(client);
                },
                { once: true },
            );
        });
    }

    _push(msg) {
        const waiter = this.waiters.shift();
        if (waiter) {
            clearTimeout(waiter.timer);
            waiter.resolve(msg);
            return;
        }
        this.queue.push(msg);
    }

    next(timeoutMs = 4000) {
        if (this.queue.length > 0) return Promise.resolve(this.queue.shift());
        return new Promise((resolve, reject) => {
            const waiter = { resolve, reject, timer: null };
            waiter.timer = setTimeout(() => {
                const index = this.waiters.indexOf(waiter);
                if (index >= 0) this.waiters.splice(index, 1);
                reject(new Error('等待消息超时'));
            }, timeoutMs);
            this.waiters.push(waiter);
        });
    }

    /** 等待第一条满足 predicate 的 JSON 消息（不匹配的消息会被跳过并记录） */
    async waitJson(predicate, label, timeoutMs = 4000) {
        const deadline = Date.now() + timeoutMs;
        const skipped = [];
        for (;;) {
            const remain = deadline - Date.now();
            if (remain <= 0) {
                throw new Error(`等待「${label}」超时；跳过的消息：${fmt(skipped.slice(-5))}`);
            }
            const msg = await this.next(remain);
            if (msg.json && predicate(msg.json, msg)) return msg.json;
            skipped.push(msg.json ?? msg.text);
        }
    }

    waitClose(timeoutMs = 4000) {
        if (this.closed) return Promise.resolve(this.closed);
        return new Promise((resolve, reject) => {
            const waiter = { resolve, reject, timer: null };
            waiter.timer = setTimeout(() => {
                const index = this.closeWaiters.indexOf(waiter);
                if (index >= 0) this.closeWaiters.splice(index, 1);
                reject(new Error('等待连接关闭超时'));
            }, timeoutMs);
            this.closeWaiters.push(waiter);
        });
    }

    send(payload) {
        this.ws.send(typeof payload === 'string' ? payload : JSON.stringify(payload));
    }

    close() {
        try {
            this.ws.close();
        } catch {
            /* ignore */
        }
    }
}

// ---------------------------------------------------------------- 原始 WebSocket 客户端（手写帧）

function encodeClientFrame(opcode, payload, fin = true) {
    const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
    const len = body.length;
    const maskKey = crypto.randomBytes(4);
    let header;

    if (len < 126) {
        header = Buffer.allocUnsafe(2);
        header[0] = (fin ? 0x80 : 0x00) | opcode;
        header[1] = 0x80 | len;
    } else if (len < 65536) {
        header = Buffer.allocUnsafe(4);
        header[0] = (fin ? 0x80 : 0x00) | opcode;
        header[1] = 0x80 | 126;
        header.writeUInt16BE(len, 2);
    } else {
        header = Buffer.allocUnsafe(10);
        header[0] = (fin ? 0x80 : 0x00) | opcode;
        header[1] = 0x80 | 127;
        header.writeBigUInt64BE(BigInt(len), 2);
    }

    const masked = Buffer.allocUnsafe(len);
    for (let i = 0; i < len; i += 1) masked[i] = body[i] ^ maskKey[i & 3];

    return Buffer.concat([header, maskKey, masked]);
}

class RawWsClient {
    constructor(socket) {
        this.socket = socket;
        this.buffer = Buffer.alloc(0);
        this.handshakeDone = false;
        this.handshake = null;
        this.frames = [];
        this.frameWaiters = [];
        this.handshakeWaiter = null;
        this.closed = false;

        socket.on('data', (chunk) => {
            this.buffer = Buffer.concat([this.buffer, chunk]);
            this._drain();
        });
        socket.on('error', () => {
            /* ignore */
        });
        socket.on('close', () => {
            this.closed = true;
        });
    }

    static connect(port, path = '/', timeoutMs = 5000) {
        return new Promise((resolve, reject) => {
            const socket = net.connect(port, HOST);
            const client = new RawWsClient(socket);
            const key = crypto.randomBytes(16).toString('base64');
            const expectedAccept = crypto
                .createHash('sha1')
                .update(key + WS_GUID)
                .digest('base64');

            const timer = setTimeout(() => reject(new Error('原始客户端握手超时')), timeoutMs);
            socket.once('error', (err) => {
                clearTimeout(timer);
                reject(err);
            });
            socket.once('connect', () => {
                socket.write(
                    `GET ${path} HTTP/1.1\r\n` +
                        `Host: ${HOST}:${port}\r\n` +
                        'Upgrade: websocket\r\n' +
                        'Connection: Upgrade\r\n' +
                        `Sec-WebSocket-Key: ${key}\r\n` +
                        'Sec-WebSocket-Version: 13\r\n\r\n',
                );
                client
                    .waitHandshake()
                    .then((head) => {
                        clearTimeout(timer);
                        resolve({ client, head, expectedAccept });
                    })
                    .catch((err) => {
                        clearTimeout(timer);
                        reject(err);
                    });
            });
        });
    }

    waitHandshake(timeoutMs = 5000) {
        if (this.handshakeDone) return Promise.resolve(this.handshake);
        return new Promise((resolve, reject) => {
            this.handshakeWaiter = { resolve, reject };
            const timer = setTimeout(() => reject(new Error('等待握手响应超时')), timeoutMs);
            const original = resolve;
            this.handshakeWaiter.resolve = (value) => {
                clearTimeout(timer);
                original(value);
            };
        });
    }

    _drain() {
        if (!this.handshakeDone) {
            const index = this.buffer.indexOf('\r\n\r\n');
            if (index < 0) return;
            this.handshake = this.buffer.subarray(0, index).toString('utf8');
            this.buffer = this.buffer.subarray(index + 4);
            this.handshakeDone = true;
            if (this.handshakeWaiter) {
                const waiter = this.handshakeWaiter;
                this.handshakeWaiter = null;
                waiter.resolve(this.handshake);
            }
        }

        for (;;) {
            const buf = this.buffer;
            if (buf.length < 2) return;

            const b0 = buf[0];
            const b1 = buf[1];
            const fin = (b0 & 0x80) !== 0;
            const opcode = b0 & 0x0f;
            const masked = (b1 & 0x80) !== 0;
            let len = b1 & 0x7f;
            let offset = 2;
            let lengthBytes = 1;

            if (len === 126) {
                if (buf.length < 4) return;
                len = buf.readUInt16BE(2);
                offset = 4;
                lengthBytes = 2;
            } else if (len === 127) {
                if (buf.length < 10) return;
                len = Number(buf.readBigUInt64BE(2));
                offset = 10;
                lengthBytes = 8;
            }

            let maskKey = null;
            if (masked) {
                if (buf.length < offset + 4) return;
                maskKey = buf.subarray(offset, offset + 4);
                offset += 4;
            }
            if (buf.length < offset + len) return;

            let payload = buf.subarray(offset, offset + len);
            if (maskKey) {
                const unmasked = Buffer.allocUnsafe(len);
                for (let i = 0; i < len; i += 1) unmasked[i] = payload[i] ^ maskKey[i & 3];
                payload = unmasked;
            }
            this.buffer = buf.subarray(offset + len);

            const frame = { fin, opcode, payload, lengthBytes, masked };
            const waiter = this.frameWaiters.shift();
            if (waiter) {
                clearTimeout(waiter.timer);
                waiter.resolve(frame);
            } else {
                this.frames.push(frame);
            }
        }
    }

    waitFrame(opcode, label, timeoutMs = 4000) {
        const index = this.frames.findIndex((frame) => opcode === undefined || frame.opcode === opcode);
        if (index >= 0) return Promise.resolve(this.frames.splice(index, 1)[0]);

        return new Promise((resolve, reject) => {
            const waiter = { resolve, reject, timer: null, opcode };
            waiter.timer = setTimeout(() => {
                const i = this.frameWaiters.indexOf(waiter);
                if (i >= 0) this.frameWaiters.splice(i, 1);
                reject(new Error(`等待帧超时：${label}`));
            }, timeoutMs);
            this.frameWaiters.push(waiter);
        });
    }

    sendFrame(opcode, payload, fin = true) {
        this.socket.write(encodeClientFrame(opcode, payload, fin));
    }

    sendText(text) {
        this.sendFrame(0x1, Buffer.from(text, 'utf8'));
    }

    destroy() {
        this.closed = true;
        try {
            this.socket.destroy();
        } catch {
            /* ignore */
        }
    }
}

// ---------------------------------------------------------------- 主流程

async function main() {
    const relay = createRelay({ port: 0, host: HOST, verbose: false, quiet: true, logFile: null });

    const pulses = [];
    const pairs = [];
    const opens = [];
    const closes = [];
    const messages = [];
    relay.on('pulse', (evt) => pulses.push(evt));
    relay.on('pair', (evt) => pairs.push(evt));
    relay.on('open', (evt) => opens.push(evt));
    relay.on('close', (evt) => closes.push(evt));
    relay.on('message', (evt) => messages.push(evt));

    const listenResult = await relay.listen();
    const PORT = relay.port;
    const BASE = `ws://${HOST}:${PORT}`;
    log(`[selftest] relay 已启动：${BASE}（port=${PORT}）`);

    const open = async (path) => {
        const client = await TestClient.open(`${BASE}${path}`);
        cleanup.push(() => client.close());
        return client;
    };

    // 额外的 relay 实例（把心跳 / 空闲超时调快，用于验证定时逻辑）
    const extraRelays = [];

    let cid = null; // 控制端 clientId
    let appId = null; // APP 端 clientId
    let controller = null;
    let controller2 = null;
    let app = null;
    let rawClient = null;

    // ---------------------------------------------------------- 0
    await test('0. 模块接口：createRelay/listen/port/events/on/close', async () => {
        assert.equal(listenResult.port, relay.port);
        assert.ok(Number.isInteger(relay.port) && relay.port > 0, `relay.port 非法：${fmt(relay.port)}`);
        assert.ok(Array.isArray(relay.events));
        for (const name of ['message', 'pulse', 'pair', 'open', 'close']) {
            assert.equal(typeof relay.on, 'function');
            assert.ok(relay.eventNames().includes(name), `缺少 ${name} 事件监听`);
        }
        assert.equal(typeof createRelay, 'function');

        // 未 listen 的实例：close() 也要能正常 resolve
        const idleRelay = createRelay({ port: 0, host: HOST, verbose: false, quiet: true, logFile: null });
        assert.equal(idleRelay.port, 0);
        await idleRelay.close();
    });

    // ---------------------------------------------------------- 1
    await test('1. 控制端连接 → 收到初始 bind 帧（targetId 为空，message=targetId）', async () => {
        controller = await open('/');
        const bind = await controller.waitJson((j) => j.type === 'bind', '初始 bind');
        assert.equal(bind.targetId, '');
        assert.equal(bind.message, 'targetId');
        assert.equal(typeof bind.clientId, 'string');
        assert.match(bind.clientId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
        cid = bind.clientId;
    });

    // ---------------------------------------------------------- 2
    await test('2. ?cid=gametest 固定 ID 生效（占用时回退随机 uuid 且不报错）', async () => {
        controller2 = await open('/?cid=gametest');
        const bind = await controller2.waitJson((j) => j.type === 'bind', 'gametest bind');
        assert.equal(bind.clientId, 'gametest');
        assert.equal(bind.message, 'targetId');

        const dup = await open('/?cid=gametest');
        const dupBind = await dup.waitJson((j) => j.type === 'bind', '重复 cid bind');
        assert.notEqual(dupBind.clientId, 'gametest');
        assert.match(dupBind.clientId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

        // ?tid= 分支：用重复 cid 连接拿到的随机 id 作为 targetId
        const viaTid = await open(`/?tid=${dupBind.clientId}`);
        const viaTidSelf = await viaTid.waitJson((j) => j.type === 'bind' && j.message === 'targetId', 'APP 初始 bind');
        const viaTidPair = await viaTid.waitJson((j) => j.type === 'bind' && j.message === '200', 'tid 配对 200');
        assert.equal(viaTidPair.clientId, dupBind.clientId);
        assert.equal(viaTidPair.targetId, viaTidSelf.clientId);
        const dupPair = await dup.waitJson((j) => j.type === 'bind' && j.message === '200', '对端 200');
        assert.equal(dupPair.clientId, dupBind.clientId);
        assert.equal(dupPair.targetId, viaTidSelf.clientId);
    });

    // ---------------------------------------------------------- 3
    await test('3. APP 连接 /<controllerId> → 双方都收到 message:"200" 的 bind 帧', async () => {
        app = await open(`/${cid}`);
        const selfBind = await app.waitJson((j) => j.type === 'bind' && j.message === 'targetId', 'APP 初始 bind');
        appId = selfBind.clientId;
        assert.equal(typeof appId, 'string');
        assert.ok(appId.length > 0);

        const appPair = await app.waitJson((j) => j.type === 'bind' && j.message === '200', 'APP 200');
        assert.equal(appPair.clientId, cid);
        assert.equal(appPair.targetId, appId);

        const ctlPair = await controller.waitJson((j) => j.type === 'bind' && j.message === '200', '控制端 200');
        assert.equal(ctlPair.clientId, cid);
        assert.equal(ctlPair.targetId, appId);

        assert.ok(
            pairs.some((p) => p.controllerId === cid && p.appId === appId),
            `relay.on('pair') 未收到配对事件：${fmt(pairs)}`,
        );
    });

    // ---------------------------------------------------------- 4
    await test('4. type:3 → strength-1+2+20；type:2 → strength-1+1+1；通道归一化与 406', async () => {
        controller.send({ type: 3, clientId: cid, targetId: appId, channel: 'A', strength: 20, message: 'set channel' });
        const s1 = await app.waitJson(
            (j) => j.type === 'msg' && j.message === 'strength-1+2+20',
            'strength-1+2+20',
        );
        assert.equal(s1.clientId, cid);
        assert.equal(s1.targetId, appId);

        controller.send({ type: 2, clientId: cid, targetId: appId, channel: 'A', message: 'set channel' });
        await app.waitJson((j) => j.type === 'msg' && j.message === 'strength-1+1+1', 'strength-1+1+1');

        // 字符串 type "1" + 小写通道 b → strength-2+0+1
        controller.send({ type: '1', clientId: cid, targetId: appId, channel: 'b', message: 'set channel' });
        await app.waitJson((j) => j.type === 'msg' && j.message === 'strength-2+0+1', 'strength-2+0+1');

        // 非法通道 → 406
        controller.send({ type: 3, clientId: cid, targetId: appId, channel: 'C', strength: 9, message: 'set channel' });
        const err = await controller.waitJson(
            (j) => j.type === 'error' && j.message === '406',
            '406 通道错误',
        );
        assert.equal(err.clientId, cid);
        assert.equal(err.targetId, appId);
    });

    // ---------------------------------------------------------- 4b
    await test('4b. message 以 strength/feedback 开头时优先透传（参考实现顺序如此）', async () => {
        // 参考实现里 isAppReportMessage 的判断在数字 type 转换之前：
        // message 以 strength 开头 → 原样转发给 APP，不做 type 3 转换
        controller.send({ type: 3, clientId: cid, targetId: appId, channel: 'A', strength: 20, message: 'strength' });
        const forwarded = await app.waitJson(
            (j) => j.type === 3 && j.message === 'strength',
            'type:3 + message:strength 原样转发',
        );
        assert.equal(forwarded.clientId, cid);
        assert.equal(forwarded.targetId, appId);

        // 真实客户端（dglab-kit）用 message:'set channel' → 走强度转换分支
        controller.send({
            type: 3,
            clientId: cid,
            targetId: appId,
            channel: 'A',
            strength: 20,
            message: 'set channel',
        });
        await app.waitJson((j) => j.type === 'msg' && j.message === 'strength-1+2+20', 'set channel → strength-1+2+20');
    });

    // ---------------------------------------------------------- 5
    await test('5. clientMsg（A 通道, time:3, 2 帧波形）→ 3 个 pulse-A 包，共 30 帧合法十六进制', async () => {
        const inputFrames = ['0a0a0a0a0a0a0a0a', 'FFFFFFFFFFFFFFFF'];
        const wave = `A:${JSON.stringify(inputFrames)}`;
        controller.send({
            type: 'clientMsg',
            clientId: cid,
            targetId: appId,
            channel: 'A',
            time: 3,
            message: wave,
        });

        const packets = [];
        for (let i = 0; i < 3; i += 1) {
            const packet = await app.waitJson(
                (j) => j.type === 'msg' && typeof j.message === 'string' && j.message.startsWith('pulse-'),
                `第 ${i + 1} 个 pulse 包`,
                6000,
            );
            packets.push(packet);
        }

        const allFrames = [];
        for (const packet of packets) {
            // 参考实现 v3-server.ts:976 用的是通道字母：pulse-A: / pulse-B:
            assert.ok(packet.message.startsWith('pulse-A:'), `包前缀错误：${packet.message.slice(0, 24)}`);
            const frames = JSON.parse(packet.message.slice('pulse-A:'.length));
            assert.ok(Array.isArray(frames) && frames.length > 0, '包内不是非空数组');
            for (const frame of frames) {
                assert.match(frame, /^[0-9A-F]{16}$/, `非法波形帧：${frame}`);
            }
            assert.ok(packet.message.length > 125, '包体应超过 125 字节以覆盖 126 长度分支');
            allFrames.push(...frames);
        }

        assert.equal(packets.length, 3, '包数应为 time*1=3');
        assert.equal(allFrames.length, 30, '总帧数应为 time*10=30');
        assert.equal(allFrames.filter((f) => f === '0A0A0A0A0A0A0A0A').length, 15);
        assert.equal(allFrames.filter((f) => f === 'FFFFFFFFFFFFFFFF').length, 15);

        const pulseEvt = pulses.find((p) => p.controllerId === cid && p.appId === appId && p.channel === 'A');
        assert.ok(pulseEvt, `relay.on('pulse') 未触发：${fmt(pulses)}`);
        assert.equal(pulseEvt.seconds, 3);
        assert.equal(pulseEvt.packets, 3);
        assert.equal(pulseEvt.frames.length, 30);
        assert.equal(pulseEvt.channel, 'A');

        await controller.waitJson((j) => j.type === 'notify' && j.message === '发送完毕', '发送完毕', 6000);
    });

    // ---------------------------------------------------------- 6
    await test('6. APP 上报 strength-*/feedback-* → 控制端收到（且 clientId/targetId 已交换）', async () => {
        const report = 'strength-1+2+20+30';
        app.send({ type: 'msg', clientId: appId, targetId: cid, message: report });
        const got = await controller.waitJson((j) => j.type === 'msg' && j.message === report, 'strength 上报');
        assert.equal(got.clientId, appId);
        assert.equal(got.targetId, cid);

        app.send({ type: 'msg', clientId: appId, targetId: cid, message: 'feedback-1' });
        const fb = await controller.waitJson((j) => j.type === 'msg' && j.message === 'feedback-1', 'feedback 上报');
        assert.equal(fb.clientId, appId);
        assert.equal(fb.targetId, cid);
    });

    // ---------------------------------------------------------- 7
    await test('7. 普通消息透传（type:msg），含 2KB（126 分支）与 70KB（127 分支）大包', async () => {
        controller.send({ type: 'msg', clientId: cid, targetId: appId, message: 'hello-relay' });
        const plain = await app.waitJson((j) => j.type === 'msg' && j.message === 'hello-relay', '普通透传');
        assert.equal(plain.clientId, cid);
        assert.equal(plain.targetId, appId);

        const big1 = 'X'.repeat(2000);
        controller.send({ type: 'msg', clientId: cid, targetId: appId, message: big1 });
        const got1 = await app.waitJson((j) => j.type === 'msg' && j.message === big1, '2KB 透传');
        assert.equal(got1.message.length, 2000);

        const big2 = 'Y'.repeat(70000);
        controller.send({ type: 'msg', clientId: cid, targetId: appId, message: big2 });
        const got2 = await app.waitJson((j) => j.type === 'msg' && j.message === big2, '70KB 透传');
        assert.equal(got2.message.length, 70000);

        // 心跳消息被忽略，不转发
        controller.send({ type: 'heartbeat', clientId: cid, targetId: appId, message: '200' });
        controller.send({ type: 'msg', clientId: cid, targetId: appId, message: 'after-heartbeat' });
        const after = await app.waitJson((j) => j.type === 'msg' && j.message === 'after-heartbeat', '心跳后透传');
        assert.equal(after.message, 'after-heartbeat', '心跳不应被转发，next 收到的应是 after-heartbeat');
        assert.ok(
            !app.received.some((m) => m.json && m.json.type === 'heartbeat'),
            'APP 不应收到 heartbeat 帧（type=heartbeat 应被忽略）',
        );
    });

    // ---------------------------------------------------------- 8
    await test('8. 无效 targetId 的 APP 连接 → 收到 4001 error 帧并被以 4001 关闭', async () => {
        const bad = await open('/no-such-target-id');
        const err = await bad.waitJson((j) => j.type === 'error', '4001 error');
        assert.equal(err.message, '4001');
        assert.equal(err.targetId, 'no-such-target-id');
        const closed = await bad.waitClose(4000);
        assert.equal(closed.code, 4001);
    });

    // ---------------------------------------------------------- 9
    await test('9. 非法 JSON / 缺字段 → 403；来源非法 → 404；未配对 → 402', async () => {
        const c3 = await open('/');
        const bind = await c3.waitJson((j) => j.type === 'bind', 'c3 bind');
        const c3id = bind.clientId;

        c3.send('这不是 JSON');
        const e403a = await c3.waitJson((j) => j.type === 'error', '403 非法 JSON');
        assert.equal(e403a.message, '403');
        assert.equal(e403a.clientId, '');
        assert.equal(e403a.targetId, '');

        c3.send('[1,2,3]');
        assert.equal((await c3.waitJson((j) => j.type === 'error', '403 数组')).message, '403');

        c3.send({ type: 'msg' });
        assert.equal((await c3.waitJson((j) => j.type === 'error', '403 缺字段')).message, '403');

        c3.send({ type: '', clientId: c3id, targetId: 'x', message: 'm' });
        assert.equal((await c3.waitJson((j) => j.type === 'error', '403 空 type')).message, '403');

        c3.send({ type: 'msg', clientId: c3id, targetId: '', message: 'm' });
        assert.equal((await c3.waitJson((j) => j.type === 'error', '403 空 targetId')).message, '403');

        c3.send({ type: { a: 1 }, clientId: c3id, targetId: 'x', message: 'm' });
        assert.equal((await c3.waitJson((j) => j.type === 'error', '403 type 非法')).message, '403');

        // 来源校验：发送方 clientId 既不等于 clientId 也不等于 targetId → 404
        c3.send({ type: 'msg', clientId: 'someone-else', targetId: 'other', message: 'm' });
        const e404 = await c3.waitJson((j) => j.type === 'error', '404 来源非法');
        assert.equal(e404.message, '404');
        assert.equal(e404.clientId, 'someone-else');
        assert.equal(e404.targetId, 'other');

        // 配对校验：合法消息但未配对 → 402
        c3.send({ type: 'msg', clientId: c3id, targetId: 'nobody', message: 'm' });
        const e402 = await c3.waitJson((j) => j.type === 'error', '402 未配对');
        assert.equal(e402.message, '402');
    });

    // ---------------------------------------------------------- 10
    await test('10. GET /__status 返回合法 JSON 且 connections ≥ 1', async () => {
        const res = await fetch(`http://${HOST}:${PORT}/__status`);
        assert.equal(res.status, 200);
        assert.match(res.headers.get('content-type') || '', /application\/json/);
        const body = await res.json();
        assert.equal(body.protocol, 'DG-LAB WebSocket V3 (node)');
        assert.ok(Number.isInteger(body.uptime) && body.uptime >= 0, `uptime 非法：${fmt(body.uptime)}`);
        assert.ok(body.connections >= 1, `connections 应 ≥ 1，实际 ${body.connections}`);
        assert.ok(Array.isArray(body.pairs));
        assert.ok(
            body.pairs.some((pair) => pair[0] === cid && pair[1] === appId),
            `pairs 未包含当前配对：${fmt(body.pairs)}`,
        );
        assert.ok(Number.isInteger(body.pulses) && body.pulses >= 1, `pulses 非法：${fmt(body.pulses)}`);

        // GET / 同样是状态 JSON（扩展）
        const rootRes = await fetch(`http://${HOST}:${PORT}/`);
        assert.equal(rootRes.status, 200);
        const rootBody = await rootRes.json();
        assert.equal(rootBody.protocol, 'DG-LAB WebSocket V3 (node)');

        // 其它非 Upgrade 请求 → 426（与参考实现一致）
        const notWs = await fetch(`http://${HOST}:${PORT}/whatever`);
        assert.equal(notWs.status, 426);
        const notWsBody = await notWs.json();
        assert.equal(notWsBody.ok, false);
        assert.equal(notWsBody.error, 'websocket_required');
        assert.equal(notWsBody.protocol, 'DG-LAB WebSocket V3');

        const post = await fetch(`http://${HOST}:${PORT}/`, { method: 'POST' });
        assert.equal(post.status, 426);
    });

    // ---------------------------------------------------------- 11
    await test('11. 原始客户端：握手 Accept、分片拼接、ping/pong、close 帧', async () => {
        const { client, head, expectedAccept } = await RawWsClient.connect(PORT, '/');
        rawClient = client;
        cleanup.push(() => client.destroy());

        assert.match(head, /^HTTP\/1\.1 101 /, `握手响应异常：${head.split('\r\n')[0]}`);
        const acceptMatch = /sec-websocket-accept:\s*(\S+)/i.exec(head);
        assert.ok(acceptMatch, '握手响应缺少 Sec-WebSocket-Accept');
        assert.equal(acceptMatch[1], expectedAccept, 'Sec-WebSocket-Accept 计算错误');

        const bindFrame = await client.waitFrame(0x1, '原始客户端 bind');
        assert.equal(bindFrame.fin, true);
        const bind = JSON.parse(bindFrame.payload.toString('utf8'));
        assert.equal(bind.type, 'bind');
        assert.equal(bind.message, 'targetId');
        const rawId = bind.clientId;

        // 分片：text + 2 个 continuation
        const json = JSON.stringify({ type: 'msg', clientId: rawId, targetId: 'nobody', message: 'frag' });
        const parts = [json.slice(0, 6), json.slice(6, 21), json.slice(21)];
        client.sendFrame(0x1, Buffer.from(parts[0], 'utf8'), false);
        client.sendFrame(0x0, Buffer.from(parts[1], 'utf8'), false);
        client.sendFrame(0x0, Buffer.from(parts[2], 'utf8'), true);

        const errFrame = await client.waitFrame(0x1, '分片消息的应答');
        const errBody = JSON.parse(errFrame.payload.toString('utf8'));
        assert.equal(errBody.type, 'error');
        // 分片被正确拼成一条完整消息才会走到配对校验（若拼接失败会变成 403）
        assert.equal(errBody.message, '402', `分片拼接疑似失败：${fmt(errBody)}`);
        assert.equal(errBody.clientId, rawId);

        // ping → pong（载荷回显）
        client.sendFrame(0x9, Buffer.from('ping-payload', 'utf8'));
        const pong = await client.waitFrame(0xa, 'pong');
        assert.equal(pong.payload.toString('utf8'), 'ping-payload');

        // close → 回执 close 帧
        const closePayload = Buffer.allocUnsafe(2);
        closePayload.writeUInt16BE(1000, 0);
        client.sendFrame(0x8, Buffer.concat([closePayload, Buffer.from('bye', 'utf8')]));
        const echo = await client.waitFrame(0x8, 'close 回执');
        assert.equal(echo.payload.readUInt16BE(0), 1000);
    });

    // ---------------------------------------------------------- 12
    await test('12. 波形覆盖：同通道旧定时器被清除 + clear 指令 + notify 提示', async () => {
        const frames = ['0101010101010101', '0202020202020202'];
        // 第一条：time=3（需要 2 秒才发完，期间会被覆盖）
        controller.send({
            type: 'clientMsg',
            clientId: cid,
            targetId: appId,
            channel: 'A',
            time: 3,
            message: `A:${JSON.stringify(frames)}`,
        });
        const firstPacket = await app.waitJson(
            (j) => j.type === 'msg' && typeof j.message === 'string' && j.message.startsWith('pulse-A:'),
            '第一个波形首包',
            5000,
        );
        assert.ok(firstPacket.message.includes('0101010101010101'));

        // 第二条：立刻覆盖同通道
        controller.send({
            type: 'clientMsg',
            clientId: cid,
            targetId: appId,
            channel: 'A',
            time: 1,
            message: `A:${JSON.stringify(['0303030303030303'])}`,
        });

        const clearMsg = await app.waitJson(
            (j) => j.type === 'msg' && j.message === 'clear-1',
            '覆盖时的 clear-1',
            4000,
        );
        assert.equal(clearMsg.clientId, cid);
        const notify = await controller.waitJson(
            (j) => j.type === 'notify' && typeof j.message === 'string' && j.message.includes('覆盖之前的消息'),
            '覆盖提示 notify',
            4000,
        );
        assert.equal(notify.message, '当前通道A有正在发送的消息，覆盖之前的消息');

        const replaced = await app.waitJson(
            (j) => j.type === 'msg' && typeof j.message === 'string' && j.message.includes('0303030303030303'),
            '覆盖后的新波形包',
            4000,
        );
        assert.ok(replaced.message.startsWith('pulse-A:'));
        // 新波形 time=1 只有 1 个包 → 立刻收到「发送完毕」
        await controller.waitJson((j) => j.type === 'notify' && j.message === '发送完毕', '覆盖后发送完毕', 4000);
    });

    // ---------------------------------------------------------- 13
    await test('13. 事件流：relay.events / relay.on 覆盖 open|pair|message|pulse|close', async () => {
        const types = new Set(relay.events.map((evt) => evt.type));
        for (const type of ['open', 'pair', 'message', 'pulse', 'close']) {
            assert.ok(types.has(type), `relay.events 缺少 ${type} 事件`);
        }
        assert.ok(relay.events.every((evt) => typeof evt.ts === 'number' && evt.ts > 0), '事件缺少 ts');
        assert.ok(opens.length >= 1 && pairs.length >= 1 && closes.length >= 1 && pulses.length >= 1);
        assert.ok(messages.some((evt) => evt.dir === 'in'), "缺少 dir='in' 的 message 事件");
        assert.ok(messages.some((evt) => evt.dir === 'out'), "缺少 dir='out' 的 message 事件");
        assert.ok(
            messages.some((evt) => evt.dir === 'in' && evt.data && evt.data.type === 'clientMsg'),
            "dir='in' 事件应携带解析后的 JSON data",
        );
    });

    // ---------------------------------------------------------- 14
    const relay2 = createRelay({ port: 0, host: HOST, quiet: true, heartbeatMs: 250, idleTimeoutMs: 60000 });
    extraRelays.push(relay2);
    await relay2.listen();
    const BASE2 = `ws://${HOST}:${relay2.port}`;
    const open2 = async (path) => {
        const client = await TestClient.open(`${BASE2}${path}`);
        cleanup.push(() => client.close());
        return client;
    };

    await test('14. 服务端心跳帧：clientId 为自己、targetId 为配对端（或空）', async () => {
        const ctl = await open2('/?cid=hb-ctl');
        await ctl.waitJson((j) => j.type === 'bind', 'hb 初始 bind');

        const hb1 = await ctl.waitJson((j) => j.type === 'heartbeat', '未配对心跳', 3000);
        assert.equal(hb1.clientId, 'hb-ctl');
        assert.equal(hb1.targetId, '');
        assert.equal(hb1.message, '200');

        const appC = await open2('/hb-ctl');
        const appSelf = await appC.waitJson(
            (j) => j.type === 'bind' && j.message === 'targetId',
            'hb APP 初始 bind',
        );
        await ctl.waitJson((j) => j.type === 'bind' && j.message === '200', 'hb 配对');

        const hb2 = await ctl.waitJson((j) => j.type === 'heartbeat', '已配对心跳', 3000);
        assert.equal(hb2.clientId, 'hb-ctl');
        assert.equal(hb2.targetId, appSelf.clientId);
    });

    // ---------------------------------------------------------- 15
    await test('15. bind 错误码：401（绑自己 / 目标不存在）、400（已被绑定）、200（重复绑定兼容）', async () => {
        const ctl = await open2('/?cid=bind-a');
        const selfBind = await ctl.waitJson((j) => j.type === 'bind', 'bind-a 初始');
        const cidA = selfBind.clientId;

        ctl.send({ type: 'bind', clientId: cidA, targetId: cidA, message: 'targetId' });
        const e401a = await ctl.waitJson((j) => j.type === 'bind' && j.message === '401', '401 绑自己');
        assert.equal(e401a.targetId, cidA);

        ctl.send({ type: 'bind', clientId: cidA, targetId: 'ghost-target', message: 'targetId' });
        const e401b = await ctl.waitJson((j) => j.type === 'bind' && j.message === '401', '401 目标不存在');
        assert.equal(e401b.targetId, 'ghost-target');

        const appC = await open2('/bind-a');
        const appSelf = await appC.waitJson(
            (j) => j.type === 'bind' && j.message === 'targetId',
            'bind-a APP 初始',
        );
        const cidB = appSelf.clientId;
        await ctl.waitJson((j) => j.type === 'bind' && j.message === '200', '自动配对 200');

        // 同一对重复绑定 → 兼容返回 200
        ctl.send({ type: 'bind', clientId: cidA, targetId: cidB, message: 'targetId' });
        await ctl.waitJson((j) => j.type === 'bind' && j.message === '200', '重复绑定 200');

        // 第三方绑定已被占用的 APP → 400
        const ctl2 = await open2('/?cid=bind-c');
        const ctl2Bind = await ctl2.waitJson((j) => j.type === 'bind', 'bind-c 初始');
        ctl2.send({ type: 'bind', clientId: ctl2Bind.clientId, targetId: cidB, message: 'targetId' });
        const e400 = await ctl2.waitJson((j) => j.type === 'bind' && j.message === '400', '400 已被绑定');
        assert.equal(e400.clientId, ctl2Bind.clientId);
        assert.equal(e400.targetId, cidB);
    });

    // ---------------------------------------------------------- 16
    await test('16. 任一端断开 → 对端收到 break(209) 并被服务端关闭', async () => {
        const ctl = await open2('/?cid=brk-ctl');
        await ctl.waitJson((j) => j.type === 'bind', 'brk 初始 bind');
        const appC = await open2('/brk-ctl');
        const appSelf = await appC.waitJson(
            (j) => j.type === 'bind' && j.message === 'targetId',
            'brk APP 初始 bind',
        );
        await ctl.waitJson((j) => j.type === 'bind' && j.message === '200', 'brk 配对');

        appC.close(); // APP 主动断开
        const brk = await ctl.waitJson((j) => j.type === 'break', 'break 帧', 4000);
        assert.equal(brk.message, '209');
        assert.equal(brk.clientId, 'brk-ctl');
        assert.equal(brk.targetId, appSelf.clientId);

        const closed = await ctl.waitClose(4000);
        assert.equal(closed.code, 1000);
    });

    // ---------------------------------------------------------- 17
    await test('17. 未配对连接空闲超时 → error(idle_timeout) + 正常关闭；已配对不受影响', async () => {
        const relay3 = createRelay({ port: 0, host: HOST, quiet: true, idleTimeoutMs: 400 });
        extraRelays.push(relay3);
        await relay3.listen();

        const idle = await TestClient.open(`ws://${HOST}:${relay3.port}/?cid=idle-ctl`);
        cleanup.push(() => idle.close());
        const idleBind = await idle.waitJson((j) => j.type === 'bind', 'idle 初始 bind');

        const keep = await TestClient.open(`ws://${HOST}:${relay3.port}/?cid=idle-keep`);
        cleanup.push(() => keep.close());
        await keep.waitJson((j) => j.type === 'bind', 'keep 初始 bind');
        const keepApp = await TestClient.open(`ws://${HOST}:${relay3.port}/idle-keep`);
        cleanup.push(() => keepApp.close());
        await keepApp.waitJson((j) => j.type === 'bind' && j.message === 'targetId', 'keep APP 初始 bind');
        await keep.waitJson((j) => j.type === 'bind' && j.message === '200', 'keep 配对');

        const err = await idle.waitJson((j) => j.type === 'error', 'idle_timeout', 4000);
        assert.equal(err.message, 'idle_timeout');
        assert.equal(err.clientId, idleBind.clientId);
        assert.equal(err.targetId, '');
        const closed = await idle.waitClose(4000);
        assert.equal(closed.code, 1000);

        await new Promise((resolve) => setTimeout(resolve, 900));
        assert.equal(keep.closed, null, '已配对连接不应被空闲超时关闭');
        assert.equal(keepApp.closed, null, '已配对连接不应被空闲超时关闭');
    });

    // ---------------------------------------------------------- 清理
    for (const fn of cleanup) {
        try {
            fn();
        } catch {
            /* ignore */
        }
    }
    if (rawClient) rawClient.destroy();
    for (const extraRelay of extraRelays) {
        try {
            await extraRelay.close();
        } catch {
            /* ignore */
        }
    }
    await relay.close();

    log('');
    log(`[selftest] 通过 ${passes} 项，失败 ${failures} 项`);
    if (failures > 0) {
        log('[selftest] 失败明细：');
        for (const line of failureLines) log(`  - ${line}`);
        log('SELFTEST FAILED');
        return 1;
    }
    log('SELFTEST OK');
    return 0;
}

main()
    .then((code) => {
        process.exit(code);
    })
    .catch((err) => {
        log(`[selftest] 运行异常：${err && err.stack ? err.stack : err}`);
        log('SELFTEST FAILED');
        process.exit(1);
    });
