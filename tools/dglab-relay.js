#!/usr/bin/env node
'use strict';

/* dglab-relay.js —— DG-LAB WebSocket V3 中继（纯 Node，零依赖）
 * 用法：node dglab-relay.js [--port 9999] [--host 0.0.0.0] [--verbose] [--quiet] [--log 文件]
 * GET / 和 /__status 返回状态 JSON；控制端可用 ?cid=<id> 固定 clientId。
 * 协议对齐上游 v3-server.ts，自己写了最小 RFC6455 服务端。
 * 模块接口：const { createRelay } = require('./dglab-relay.js') */

const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { EventEmitter } = require('node:events');
const nodePath = require('node:path');

/* 版本号取自 package.json */
function readVersion() {
    try {
        const pkg = JSON.parse(fs.readFileSync(nodePath.join(__dirname, '..', 'package.json'), 'utf8'));
        return pkg.version || '?';
    } catch {
        return '?';
    }
}

// ---------------------------------------------------------------- 常量

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const OPCODE = {
    CONTINUATION: 0x0,
    TEXT: 0x1,
    BINARY: 0x2,
    CLOSE: 0x8,
    PING: 0x9,
    PONG: 0xa,
};

const STATE = {
    CONNECTING: 0,
    OPEN: 1,
    CLOSING: 2,
    CLOSED: 3,
};

// 单帧上限 / 单条消息（分片拼接后）上限
const MAX_PAYLOAD = 8 * 1024 * 1024;
const MAX_MESSAGE = 16 * 1024 * 1024;

// 一条 clientMsg 允许的最长秒数 / 最多包数（防止一条报文就把进程打死）
const MAX_PULSE_SECONDS = 3600;
const MAX_PACKETS = 4000;

// 事件数组的字节预算（只按条数封顶挡不住 2MB 的大报文）
const MAX_EVENT_BYTES = 4 * 1024 * 1024;

// 发送侧积压上限：对端只连不读时丢弃新消息，而不是无限吃内存
const MAX_WRITE_BUFFER = 4 * 1024 * 1024;

// 控制端静默多久算「僵尸」（脚本每 30 秒有心跳，正常不会触发）
const STALE_CONTROLLER_MS = 150000;

// 日志里单条 message 最多留多少字符
const MAX_LOG_MESSAGE = 4096;

const MAX_EVENTS = 20000;

const DEFAULT_PORT = 9999;
/* 默认只绑本机：中继没鉴权，绑 0.0.0.0 等于同网络谁都能控制设备 */
const DEFAULT_HOST = '127.0.0.1';

// 与参考实现一致的环境变量默认值
const HEARTBEAT_MS = envNumber('HEARTBEAT_INTERVAL', 60_000);
const IDLE_TIMEOUT_MS = envNumber('IDLE_TIMEOUT', 5 * 60_000);
const DEFAULT_PUNISHMENT_TIME = envNumber('DEFAULT_PUNISHMENT_TIME', 1); // 每秒发包数
const DEFAULT_PUNISHMENT_DURATION = envNumber('DEFAULT_PUNISHMENT_DURATION', 5); // 默认波形秒数
const PULSE_REPLACE_DELAY_MS = 150;
const CLOSE_INVALID_TARGET_ID = 4001;

const CID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

const STATUS_PROTOCOL = 'DG-LAB WebSocket V3 (node)';

// 日志等级
const LOG_WEIGHT = { debug: 10, info: 20, warn: 30, error: 40 };

function envNumber(name, fallback) {
    const raw = process.env[name];
    if (raw === undefined || raw === '') return fallback;
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? value : fallback;
}

// ---------------------------------------------------------------- 工具函数（对齐参考实现）

/** 通道归一化：1/'1'/'A'/'a' → A(1)，2/'2'/'B'/'b' → B(2)，其余 undefined */
function normalizeChannel(value, fallback) {
    const normalized = value ?? fallback;
    if (normalized === 1 || normalized === '1' || normalized === 'A') {
        return { letter: 'A', number: 1 };
    }
    if (normalized === 2 || normalized === '2' || normalized === 'B') {
        return { letter: 'B', number: 2 };
    }
    if (normalized === 'a') return { letter: 'A', number: 1 };
    if (normalized === 'b') return { letter: 'B', number: 2 };
    return undefined;
}

function normalizeNumber(value, fallback) {
    const parsed = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.trunc(parsed);
}

function normalizePositiveInteger(value, fallback) {
    const parsed = normalizeNumber(value, fallback);
    return parsed > 0 ? parsed : fallback;
}

function normalizeSendsPerSecond(value) {
    const normalized = Math.trunc(value);
    if (!Number.isFinite(normalized) || normalized < 1) return 1;
    return Math.min(normalized, 10);
}

function numericType(type) {
    if (typeof type === 'number') return type;
    if (typeof type === 'string' && /^\d+$/.test(type)) return Number(type);
    return undefined;
}

function isAppReportMessage(message) {
    return message.startsWith('feedback') || message.startsWith('strength');
}

function timerKey(clientId, channel) {
    return `${clientId}:${channel}`;
}

function isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(value, key) {
    return Object.prototype.hasOwnProperty.call(value, key);
}

function isProtocolType(value) {
    return (typeof value === 'string' && value.length > 0) || typeof value === 'number';
}

/** 解析标准波形：`A:[<16位十六进制帧>...]`（与参考实现 parsePulseMessage 一致） */
function parsePulseMessage(message) {
    const separatorIndex = message.indexOf(':');
    if (separatorIndex <= 0) return undefined;

    let parsed;
    try {
        parsed = JSON.parse(message.slice(separatorIndex + 1));
    } catch {
        return undefined;
    }

    if (
        !Array.isArray(parsed) ||
        parsed.length === 0 ||
        !parsed.every((item) => typeof item === 'string' && /^[0-9a-fA-F]{16}$/.test(item))
    ) {
        return undefined;
    }

    return { frames: parsed.map((item) => item.toUpperCase()) };
}

function fitFramesToLength(frames, totalFrames) {
    const firstFrame = frames[0];
    if (firstFrame === undefined) return [];
    return Array.from({ length: totalFrames }, (_, index) => frames[index % frames.length] ?? firstFrame);
}

function splitFrames(frames, packetCount) {
    return Array.from({ length: packetCount }, (_, index) => {
        const start = Math.floor((index * frames.length) / packetCount);
        const end = Math.floor(((index + 1) * frames.length) / packetCount);
        return frames.slice(start, end);
    }).filter((chunk) => chunk.length > 0);
}

/** 安全 JSON 化：循环引用 / 超深嵌套 / 超大对象都不能把进程弄死 */
function safeStringify(value, maxLen = 4096) {
    let text;
    try {
        text = JSON.stringify(value);
    } catch (err) {
        try {
            text = JSON.stringify({ _unserializable: String(err && err.message ? err.message : err) });
        } catch {
            text = '"[unserializable]"';
        }
    }
    if (typeof text !== 'string') text = String(text);
    const limit = maxLen > 0 ? maxLen : 4096;
    if (text.length > limit) text = `${text.slice(0, limit)}…[截断，共 ${text.length} 字符]`;
    return text;
}

function truncatePayload(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return data;
    const out = {};
    for (const k of Object.keys(data)) {
        const v = data[k];
        if (typeof v === 'string' && v.length > MAX_LOG_MESSAGE) {
            out[k] = `${v.slice(0, MAX_LOG_MESSAGE)}…[截断]`;
            out[`${k}Length`] = v.length;
        } else {
            out[k] = v;
        }
    }
    return out;
}

function estimateEventSize(evt) {
    if (!evt || typeof evt !== 'object') return 64;
    const msg = evt.data && typeof evt.data === 'object' ? evt.data.message : undefined;
    if (typeof msg === 'string') return 160 + msg.length;
    if (evt.frames && Array.isArray(evt.frames)) return 200 + evt.frames.length * 20;
    return 256;
}

/** 合法的 WebSocket 关闭码（RFC6455 §7.4.1） */
function isValidCloseCode(code) {
    if (!Number.isInteger(code)) return false;
    if (code < 1000 || code > 4999) return false;
    if (code === 1004 || code === 1005 || code === 1006 || code === 1015) return false;
    if (code >= 1016 && code <= 2999) return false;
    return true;
}

/** 把一次 clientMsg 变成待发送的 pulse 包序列（与参考实现 buildPulseSequence 一致） */
function buildPulseSequence(data, channel, time, sendsPerSecond) {
    /* 无论调用方传了什么，秒数 / 包数都必须钳在上限内（否则 Array.from 会抛 RangeError 或 OOM） */
    const safeSeconds = Math.min(Math.max(1, Math.floor(time)), MAX_PULSE_SECONDS);
    const packetCount = Math.min(Math.max(1, safeSeconds * sendsPerSecond), MAX_PACKETS);
    const baseMessage = { type: 'msg', clientId: data.clientId, targetId: data.targetId };
    const parsed = parsePulseMessage(data.message);

    if (!parsed) {
        // 无法解析为标准波形数组时按原始内容透传重复发送
        return {
            messages: Array.from({ length: packetCount }, () => ({
                ...baseMessage,
                message: `pulse-${data.message}`,
            })),
            packetCount,
            parsed: false,
            frames: [],
            totalFrames: undefined,
        };
    }

    const totalFrames = Math.min(Math.max(1, safeSeconds * 10), MAX_PACKETS * 10);
    const fittedFrames = fitFramesToLength(parsed.frames, totalFrames);
    const chunks = splitFrames(fittedFrames, packetCount);
    const messages = chunks.map((frames) => ({
        ...baseMessage,
        message: `pulse-${channel}:${JSON.stringify(frames)}`,
    }));

    return {
        messages,
        packetCount: messages.length,
        parsed: true,
        frames: fittedFrames,
        totalFrames,
    };
}

// ---------------------------------------------------------------- RFC6455 帧编解码

function encodeFrame(opcode, payload) {
    const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
    const len = body.length;
    let header;

    if (len < 126) {
        header = Buffer.allocUnsafe(2);
        header[0] = 0x80 | opcode;
        header[1] = len;
    } else if (len < 65536) {
        header = Buffer.allocUnsafe(4);
        header[0] = 0x80 | opcode;
        header[1] = 126;
        header.writeUInt16BE(len, 2);
    } else {
        header = Buffer.allocUnsafe(10);
        header[0] = 0x80 | opcode;
        header[1] = 127;
        header.writeBigUInt64BE(BigInt(len), 2);
    }

    return Buffer.concat([header, body]);
}

/** 计算 Sec-WebSocket-Accept */
function websocketAccept(key) {
    return crypto.createHash('sha1').update(String(key) + WS_GUID).digest('base64');
}

// ---------------------------------------------------------------- WebSocket 连接

/**
 * 一条已完成握手的 WebSocket 连接。
 * handlers: { onMessage(conn, text), onClose(conn, code, reason) }
 */
class WsConnection {
    constructor(socket, handlers = {}) {
        this.socket = socket;
        this.handlers = handlers;
        this.readyState = STATE.OPEN;
        this.clientId = undefined;
        this.role = undefined;
        this.closedCode = 1006;
        this.closedReason = '';

        this._buffer = Buffer.alloc(0);
        this._fragments = [];
        this._fragmentLength = 0;
        this._fragmentOpcode = 0;
        this._closeSent = false;
        this._closeTimer = null;
        this._closeNotified = false;
        this.lastSeenAt = Date.now();   // 僵尸连接判定用（收到任何数据都会刷新）

        try {
            socket.setNoDelay(true);
        } catch {
            /* ignore */
        }
        // 打开 TCP keepalive：对端「人不见了」（切网/睡死，没有 FIN）时，
        // 靠内核探测把死连接清掉，否则这条连接会一直占着 clientId 和配对关系
        try {
            socket.setKeepAlive(true, 30000);
        } catch {
            /* ignore */
        }

        socket.on('data', (chunk) => {
            this.lastSeenAt = Date.now();   // 僵尸连接判定用
            try {
                this._onData(chunk);
            } catch (err) {
                /* 解析异常不能让进程死掉，断开这条连接即可 */
                try {
                    if (this.handlers && typeof this.handlers.onError === 'function') {
                        this.handlers.onError(this, err);
                    }
                } catch {
                    /* ignore */
                }
                this._fail(1011, 'internal_error');
            }
        });
        // 必须先挂 error 监听，否则客户端异常断开会变成未捕获异常
        socket.on('error', () => {
            /* 统一走 close 流程 */
        });
        // 对端只发 FIN（半关闭）也要清理，否则连接一直挂在表里，
        // ?cid= 会被僵尸连接占住，重连就变成随机 id
        socket.on('end', () => {
            if (this.readyState === STATE.CLOSED) return;
            /* 只有在「还没收到过关闭帧（仍是 1006）」时才把原因写成半关闭，
             * 否则会把正常的 close(1000) 也标成 peer_closed_write_side */
            if (!this.closedReason && this.closedCode === 1006) {
                this.closedReason = 'peer_closed_write_side';
            }
            this.destroy();
        });
        socket.on('close', () => this._notifyClose());
    }

    // ------------------------------------------------------------ 收

    _onData(chunk) {
        if (this.readyState === STATE.CLOSED) return;
        this._buffer = this._buffer.length === 0 ? chunk : Buffer.concat([this._buffer, chunk]);
        this._drain();
    }

    _drain() {
        for (;;) {
            if (this.readyState === STATE.CLOSED) return;
            const buf = this._buffer;
            if (buf.length < 2) return;

            const b0 = buf[0];
            const b1 = buf[1];
            const fin = (b0 & 0x80) !== 0;
            const rsv = b0 & 0x70;
            const opcode = b0 & 0x0f;
            const masked = (b1 & 0x80) !== 0;
            let len = b1 & 0x7f;
            let offset = 2;

            if (rsv !== 0) {
                this._fail(1002, 'rsv_not_zero');
                return;
            }

            if (len === 126) {
                if (buf.length < offset + 2) return;
                len = buf.readUInt16BE(offset);
                offset += 2;
            } else if (len === 127) {
                if (buf.length < offset + 8) return;
                const big = buf.readBigUInt64BE(offset);
                offset += 8;
                if (big > BigInt(MAX_PAYLOAD)) {
                    this._fail(1009, 'payload_too_large');
                    return;
                }
                len = Number(big);
            }

            let maskKey = null;
            if (masked) {
                if (buf.length < offset + 4) return;
                maskKey = buf.subarray(offset, offset + 4);
                offset += 4;
            }
            // 有意宽容：RFC 要求未掩码帧断开，但这样会误杀手写的调试客户端

            if (len > MAX_PAYLOAD) {
                this._fail(1009, 'payload_too_large');
                return;
            }
            if (buf.length < offset + len) return; // 数据尚未收全

            const payload = Buffer.allocUnsafe(len);
            if (maskKey) {
                for (let i = 0; i < len; i += 1) {
                    payload[i] = buf[offset + i] ^ maskKey[i & 3];
                }
            } else {
                buf.copy(payload, 0, offset, offset + len);
            }

            this._buffer = buf.subarray(offset + len);
            this._handleFrame(fin, opcode, payload);
        }
    }

    _handleFrame(fin, opcode, payload) {
        // 控制帧：不可分片、载荷 ≤ 125
        if (opcode === OPCODE.CLOSE || opcode === OPCODE.PING || opcode === OPCODE.PONG) {
            if (!fin) {
                this._fail(1002, 'fragmented_control_frame');
                return;
            }
            if (payload.length > 125) {
                this._fail(1002, 'control_frame_too_large');
                return;
            }

            if (opcode === OPCODE.PING) {
                this._writeFrame(OPCODE.PONG, payload);
                return;
            }
            if (opcode === OPCODE.PONG) return;

            this._handleCloseFrame(payload);
            return;
        }

        // 分片 continuation
        if (opcode === OPCODE.CONTINUATION) {
            if (this._fragmentOpcode === 0) {
                this._fail(1002, 'unexpected_continuation');
                return;
            }
            this._fragmentLength += payload.length;
            if (this._fragmentLength > MAX_MESSAGE) {
                this._fail(1009, 'message_too_large');
                return;
            }
            this._fragments.push(payload);
            if (!fin) return;
            const full = Buffer.concat(this._fragments, this._fragmentLength);
            const op = this._fragmentOpcode;
            this._fragments = [];
            this._fragmentLength = 0;
            this._fragmentOpcode = 0;
            this._deliver(op, full);
            return;
        }

        if (opcode === OPCODE.TEXT || opcode === OPCODE.BINARY) {
            if (this._fragmentOpcode !== 0) {
                this._fail(1002, 'fragment_in_progress');
                return;
            }
            if (!fin) {
                this._fragmentOpcode = opcode;
                this._fragments = [payload];
                this._fragmentLength = payload.length;
                return;
            }
            this._deliver(opcode, payload);
            return;
        }

        this._fail(1002, 'bad_opcode');
    }

    _deliver(opcode, payload) {
        if (this.readyState !== STATE.OPEN) return;
        // 文本与二进制统一按 UTF-8 字符串交给上层（与参考实现 rawMessage.toString() 一致）
        const text = payload.toString('utf8');
        if (typeof this.handlers.onMessage === 'function') {
            this.handlers.onMessage(this, text);
        }
    }

    _handleCloseFrame(payload) {
        /* 先把对端给的关闭码取出来校验（非法码不能原样回显，RFC6455 §5.5.1） */
        let peerCode = 1005;
        if (payload && payload.length >= 2) {
            peerCode = payload.readUInt16BE(0);
            if (!isValidCloseCode(peerCode)) {
                this.closedCode = 1002;
                this.closedReason = 'invalid_close_code';
                this._sendCloseFrame(1002, 'invalid_close_code');
                this.destroy();
                return;
            }
        }
        if (payload.length === 1) {
            this._fail(1002, 'invalid_close_frame');
            return;
        }
        let code = 1005;
        let reason = '';
        if (payload.length >= 2) {
            code = payload.readUInt16BE(0);
            reason = payload.subarray(2).toString('utf8');
        }
        this.closedCode = code === 1005 ? 1000 : code;
        this.closedReason = reason;

        // 回执对端 close（除非我们已主动发过）
        if (!this._closeSent) this._sendCloseFrame(this.closedCode, reason);
        this.readyState = STATE.CLOSING;
        try {
            this.socket.end(); // 先冲刷已排队数据再 FIN
        } catch {
            /* ignore */
        }
        this._armCloseTimer();
    }

    // ------------------------------------------------------------ 发

    _writeFrame(opcode, payload) {
        if (this.socket.destroyed || !this.socket.writable) return false;
        try {
            this.socket.write(encodeFrame(opcode, payload));
            return true;
        } catch {
            return false;
        }
    }

    sendText(text) {
        if (this.readyState !== STATE.OPEN || this._closeSent) return false;
        return this._writeFrame(OPCODE.TEXT, Buffer.from(text, 'utf8'));
    }

    ping(payload) {
        return this._writeFrame(OPCODE.PING, payload ? Buffer.from(payload) : Buffer.alloc(0));
    }

    _sendCloseFrame(code, reason) {
        if (this._closeSent) return;
        this._closeSent = true;
        const reasonBuf = Buffer.from(String(reason || ''), 'utf8');
        const payload = Buffer.allocUnsafe(2 + Math.min(reasonBuf.length, 123));
        payload.writeUInt16BE(code, 0);
        reasonBuf.copy(payload, 2, 0, payload.length - 2);
        this.readyState = STATE.CLOSING;
        this._writeFrame(OPCODE.CLOSE, payload);
    }

    /** 发送 close 帧并等待对端 FIN（带兜底定时器），随后触发 onClose */
    close(code = 1000, reason = '') {
        if (this.readyState === STATE.CLOSED) return;
        if (!this._closeSent) this._sendCloseFrame(code, reason);
        try {
            this.socket.end();
        } catch {
            /* ignore */
        }
        this._armCloseTimer();
    }

    _armCloseTimer() {
        if (this._closeTimer || this.readyState === STATE.CLOSED) return;
        this._closeTimer = setTimeout(() => {
            this._closeTimer = null;
            this.destroy();
        }, 1000);
        if (typeof this._closeTimer.unref === 'function') this._closeTimer.unref();
    }

    destroy() {
        if (this._closeTimer) {
            clearTimeout(this._closeTimer);
            this._closeTimer = null;
        }
        try {
            this.socket.destroy();
        } catch {
            /* ignore */
        }
        this.readyState = STATE.CLOSED;
        this._notifyClose();
    }

    _fail(code, reason) {
        this.closedCode = code;
        this.closedReason = reason;
        this._sendCloseFrame(code, reason);
        this.destroy();
    }

    _notifyClose() {
        if (this._closeNotified) return;
        this._closeNotified = true;
        if (this._closeTimer) {
            clearTimeout(this._closeTimer);
            this._closeTimer = null;
        }
        this.readyState = STATE.CLOSED;
        if (typeof this.handlers.onClose === 'function') {
            this.handlers.onClose(this, this.closedCode, this.closedReason);
        }
    }
}

// ---------------------------------------------------------------- 中继服务

class Relay extends EventEmitter {
    constructor(options = {}) {
        super();
        const opts = options || {};

        this.host = opts.host ?? DEFAULT_HOST;
        this.port = opts.port ?? DEFAULT_PORT;
        this.verbose = !!opts.verbose;
        this.quiet = !!opts.quiet;   // 不打启动提示
        this.logFile = opts.logFile ?? null;

        this.heartbeatMs = opts.heartbeatMs ?? HEARTBEAT_MS;
        this.idleTimeoutMs = opts.idleTimeoutMs ?? IDLE_TIMEOUT_MS;
        this.staleMs = opts.staleMs ?? envNumber('STALE_TIMEOUT', STALE_CONTROLLER_MS);
        this.sendsPerSecond = opts.sendsPerSecond ?? DEFAULT_PUNISHMENT_TIME;
        this.defaultDuration = opts.defaultDuration ?? DEFAULT_PUNISHMENT_DURATION;

        /** 事件流（供外部订阅/排查） */
        this.events = [];

        // clientId -> { clientId, conn, createdAt, idleTimer, role }
        this.connections = new Map();
        // 控制端 -> APP 端 / APP 端 -> 控制端
        this.webToApp = new Map();
        this.appToWeb = new Map();
        // `${clientId}:${通道}` -> 波形定时任务
        this.pulseTimers = new Map();
        // `${clientId}:${通道}` -> 覆盖波形前 150ms 的延时启动定时器
        this.pendingStarts = new Map();

        this._server = null;
        this._heartbeatTimer = null;
        this._logStream = null;
        this._startedAt = Date.now();
        this._pulseCount = 0;
        this._eventsBytes = 0;
        this._closing = false;
    }

    // ------------------------------------------------------------ 生命周期

    /** 启动监听；port 为 0 时返回系统分配的真实端口 */
    async listen() {
        if (this._server) return { port: this.port };

        const server = http.createServer((req, res) => this._handleRequest(req, res));
        server.on('upgrade', (req, socket, head) => this._handleUpgrade(req, socket, head));
        server.on('clientError', (err, socket) => {
            try {
                if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
                else socket.destroy();
            } catch {
                /* ignore */
            }
        });
        server.on('error', (err) => {
            this._log('error', `HTTP 服务错误：${err && err.message ? err.message : err}`);
        });

        await new Promise((resolve, reject) => {
            const onError = (err) => {
                server.removeListener('listening', onListening);
                reject(err);
            };
            const onListening = () => {
                server.removeListener('error', onError);
                resolve();
            };
            server.once('error', onError);
            server.once('listening', onListening);
            server.listen(this.port, this.host);
        });

        const address = server.address();
        if (address && typeof address === 'object') this.port = address.port;

        this._server = server;
        this._closing = false;
        this._startedAt = Date.now();
        this.startHeartbeat();

        if (!this.quiet) {
            if (this.verbose) {
                /* --verbose：把地址全打出来 */
                console.log(`[relay] listening ws://${this.host}:${this.port}`);
                console.log(`[relay] 手机内直连地址        : ws://127.0.0.1:${this.port}`);
                console.log(`[relay] 控制端(游戏脚本)连接 : ws://127.0.0.1:${this.port}/?cid=mc-coyote`);
                console.log(`[relay] DG-LAB APP 连接地址  : ws://127.0.0.1:${this.port}/mc-coyote`);
                console.log(`[relay] 状态页: 浏览器打开 http://127.0.0.1:${this.port}/__status`);
            } else {
                console.log('');
                console.log(`=== DG-LAB 中继已启动（端口 ${this.port}）===`);
                console.log('');
                console.log('  1) 把 dglab-hp.js 放进游戏的脚本目录，进游戏执行脚本');
                console.log('  2) 打开 DG-LAB APP → Socket 控制 → 服务器地址填：');
                console.log(`       ws://127.0.0.1:${this.port}/mc-coyote`);
                console.log('');
                console.log('  Ctrl+C 停止。要看详细地址和协议日志，启动时加 --verbose');
                console.log('');
            }
            if (this.host === '0.0.0.0' || this.host === '::') {
                console.log('[relay] 注意：正在监听所有网卡，同网络的设备都能连（无密码）');
            }
        }
        if (this.verbose) this._log('info', `服务启动 port=${this.port} heartbeat=${this.heartbeatMs}ms idle=${this.idleTimeoutMs}ms`);

        return { port: this.port };
    }

    /** 关闭所有连接、清理所有定时器并停止监听 */
    async close() {
        this._closing = true;

        if (this._heartbeatTimer) {
            clearInterval(this._heartbeatTimer);
            this._heartbeatTimer = null;
        }
        for (const task of this.pulseTimers.values()) {
            if (task.timer) clearInterval(task.timer);
        }
        this.pulseTimers.clear();
        for (const timer of this.pendingStarts.values()) clearTimeout(timer);
        this.pendingStarts.clear();

        // 先统一切断所有 socket（伙伴连接此时已全部 CLOSED，不会再互相发 break）
        for (const entry of this.connections.values()) {
            if (entry.idleTimer) {
                clearTimeout(entry.idleTimer);
                entry.idleTimer = null;
            }
            entry.conn.destroy();
        }
        this.connections.clear();
        this.webToApp.clear();
        this.appToWeb.clear();

        const server = this._server;
        this._server = null;
        if (server) {
            await new Promise((resolve) => {
                let done = false;
                const finish = () => {
                    if (done) return;
                    done = true;
                    resolve();
                };
                try {
                    server.close(finish);
                    if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
                    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
                } catch {
                    finish();
                }
                const bail = setTimeout(finish, 1000);
                if (typeof bail.unref === 'function') bail.unref();
            });
        }

        await this._closeLogStream();
        return true;
    }

    // ------------------------------------------------------------ 心跳 / 空闲

    startHeartbeat() {
        if (this._heartbeatTimer) return;
        this._heartbeatTimer = setInterval(() => {
            this._log('debug', `发送心跳，当前连接数：${this.connections.size}, 配对数：${this.webToApp.size}`);
            for (const [clientId, entry] of this.connections) {
                if (entry.conn.readyState !== STATE.OPEN) continue;
                this._send(entry.conn, {
                    type: 'heartbeat',
                    clientId,
                    targetId: this._pairedId(clientId) ?? '',
                    message: '200',
                });
            }
        }, this.heartbeatMs);
        this._log('debug', `心跳启动 interval=${this.heartbeatMs}ms`);
    }

    // ------------------------------------------------------------ HTTP

    _parseUrl(req) {
        try {
            return new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
        } catch {
            return new URL('http://localhost/');
        }
    }

    _statusPayload() {
        return {
            protocol: STATUS_PROTOCOL,
            uptime: Math.floor((Date.now() - this._startedAt) / 1000),
            connections: this.connections.size,
            pairs: [...this.webToApp.entries()].map(([controllerId, appId]) => [controllerId, appId]),
            pulses: this._pulseCount,
        };
    }

    /** 普通 HTTP 请求：GET / 与 GET /__status 返回状态 JSON，其余 426（与参考实现一致） */
    _handleRequest(req, res) {
        const url = this._parseUrl(req);
        const isStatus =
            (req.method === 'GET' || req.method === 'HEAD') &&
            (url.pathname === '/' || url.pathname === '/__status');

        if (isStatus) {
            const body = JSON.stringify(this._statusPayload());
            res.writeHead(200, {
                'content-type': 'application/json; charset=utf-8',
                'access-control-allow-origin': '*',
                'content-length': Buffer.byteLength(body),
            });
            res.end(req.method === 'HEAD' ? undefined : body);
            return;
        }

        const payload = JSON.stringify({
            ok: false,
            error: 'websocket_required',
            protocol: 'DG-LAB WebSocket V3',
        });
        res.writeHead(426, {
            'content-type': 'application/json; charset=utf-8',
            'access-control-allow-origin': '*',
            'content-length': Buffer.byteLength(payload),
        });
        res.end(req.method === 'HEAD' ? undefined : payload);
    }

    _writeSocketResponse(socket, status, payload, extraHeaders) {
        try {
            const body = JSON.stringify(payload);
            const lines = [
                `HTTP/1.1 ${status} ${status === 426 ? 'Upgrade Required' : 'Bad Request'}`,
                'content-type: application/json; charset=utf-8',
                'access-control-allow-origin: *',
                `content-length: ${Buffer.byteLength(body)}`,
                'connection: close',
            ];
            for (const [key, value] of Object.entries(extraHeaders || {})) {
                lines.push(`${key}: ${value}`);
            }
            socket.write(`${lines.join('\r\n')}\r\n\r\n${body}`);
        } catch {
            /* ignore */
        }
        try {
            socket.destroy();
        } catch {
            /* ignore */
        }
    }

    _handleUpgrade(req, socket, head) {
        const upgradeHeader = String(req.headers.upgrade || '').toLowerCase();
        const key = req.headers['sec-websocket-key'];
        const version = req.headers['sec-websocket-version'];

        if (upgradeHeader !== 'websocket' || !key) {
            this._writeSocketResponse(socket, 426, {
                ok: false,
                error: 'websocket_required',
                protocol: 'DG-LAB WebSocket V3',
            });
            return;
        }
        // RFC6455 §4.2.1：Key 必须是 16 字节的 base64
        let keyOk = false;
        try {
            keyOk = typeof key === 'string' && Buffer.from(String(key).trim(), 'base64').length === 16;
        } catch {
            keyOk = false;
        }
        if (!keyOk) {
            this._writeSocketResponse(socket, 400, {
                ok: false,
                error: 'invalid_websocket_key',
                protocol: 'DG-LAB WebSocket V3',
            });
            return;
        }
        if (String(version) !== '13') {
            this._writeSocketResponse(
                socket,
                426,
                {
                    ok: false,
                    error: 'unsupported_websocket_version',
                    protocol: 'DG-LAB WebSocket V3',
                },
                { 'sec-websocket-version': '13' },
            );
            return;
        }

        const url = this._parseUrl(req);
        // 与参考实现一致：?targetId= / ?tid= / 路径末段，空值回落到「无 targetId」
        const rawTargetId =
            url.searchParams.get('targetId') || url.searchParams.get('tid') || url.pathname.slice(1).trim() || null;
        const hasTargetId = rawTargetId !== null;
        const targetId = hasTargetId ? rawTargetId.trim() : '';

        // —— 扩展：控制端 ?cid= 固定 clientId（APP 端忽略）——
        let requestedId = null;
        if (!hasTargetId) {
            const cid = url.searchParams.get('cid');
            if (cid !== null && CID_PATTERN.test(cid.trim())) requestedId = cid.trim();
            else if (cid !== null) {
                this._log('warn', `忽略非法 cid=${JSON.stringify(cid)}（需匹配 ${CID_PATTERN.source}）`);
            }
        }

        let response;
        try {
            response =
                'HTTP/1.1 101 Switching Protocols\r\n' +
                'Upgrade: websocket\r\n' +
                'Connection: Upgrade\r\n' +
                `Sec-WebSocket-Accept: ${websocketAccept(key)}\r\n\r\n`;
        } catch {
            this._writeSocketResponse(socket, 426, {
                ok: false,
                error: 'websocket_required',
                protocol: 'DG-LAB WebSocket V3',
            });
            return;
        }

        socket.write(response);

        const conn = new WsConnection(socket, {
            onMessage: (c, text) => this._onMessage(c, text),
            onClose: (c, code, reason) => this._onConnectionClosed(c, code, reason),
        });

        this._onOpen(conn, { targetId, hasTargetId, requestedId });

        if (head && head.length > 0) conn._onData(head);
    }

    // ------------------------------------------------------------ 连接建立

    _onOpen(conn, info) {
        const { targetId, hasTargetId, requestedId } = info;

        // 僵尸回收：被占用的 ?cid 如果原连接已经静默很久（进程被冻结/睡死），直接回收
        if (!hasTargetId && requestedId && this.connections.has(requestedId)) {
            const holder = this.connections.get(requestedId);
            if (this._isStaleController(holder)) {
                this._log(
                    'warn',
                    `cid=${requestedId} 的原连接已静默 ${Math.round((Date.now() - this._lastSeenOf(holder)) / 1000)}s，判定为僵尸并回收`,
                );
                try {
                    holder.conn.destroy();
                } catch {
                    /* ignore */
                }
            }
        }
        // APP 端要接入的控制端如果是僵尸，也顺手回收，免得 APP 连上僵尸
        if (hasTargetId) {
            const targetEntry = this.connections.get(targetId);
            if (this._isStaleController(targetEntry)) {
                this._log('warn', `targetId=${targetId} 的控制端已静默过久，判定为僵尸并回收`);
                try {
                    targetEntry.conn.destroy();
                } catch {
                    /* ignore */
                }
            }
        }

        // clientId 分配：APP 端始终随机；控制端优先使用 ?cid=（被占用则回退随机 uuid）
        let clientId;
        if (!hasTargetId && requestedId && !this.connections.has(requestedId)) {
            clientId = requestedId;
        } else {
            clientId = crypto.randomUUID();
            if (!hasTargetId && requestedId) {
                this._log('warn', `cid=${requestedId} 已被占用，回退随机 clientId=${clientId}`);
            }
        }

        conn.clientId = clientId;
        conn.role = hasTargetId ? 'app' : 'controller';

        if (hasTargetId && !this._isAvailableTarget(targetId)) {
            this._log('warn', `拒绝连接：无效 targetId=${targetId}`);
            this._recordConnectionEvent('open', clientId, conn.role);
            this._closeInvalidTarget(conn, clientId, targetId);
            return;
        }

        const entry = {
            clientId,
            conn,
            createdAt: Date.now(),
            idleTimer: null,
            role: conn.role,
        };
        this.connections.set(clientId, entry);
        this._startIdleTimer(clientId);
        this._recordConnectionEvent('open', clientId, conn.role);

        this._send(conn, { type: 'bind', clientId, targetId: '', message: 'targetId' });

        // 携带 targetId 的连接作为 APP 端直接加入指定控制端
        if (hasTargetId) {
            const result = this._pair(targetId, clientId);
            if (!result.ok) {
                this._log('warn', `拒绝连接：targetId=${targetId} appId=${clientId} code=${result.code}`);
                this._cancelIdleTimer(clientId);
                this.connections.delete(clientId);
                this._closeInvalidTarget(conn, clientId, targetId);
                return;
            }

            const bindMessage = {
                type: 'bind',
                clientId: targetId,
                targetId: clientId,
                message: result.code,
            };
            this._sendToClient(targetId, bindMessage);
            this._send(conn, bindMessage);
        }

        this._log(
            'info',
            `新 WebSocket 连接：${clientId}${targetId ? `，目标：${targetId}` : ''}，当前连接数：${this.connections.size}`,
        );
    }

    _onConnectionClosed(conn, code, reason) {
        const clientId = conn.clientId;
        if (!clientId) return;

        const entry = this.connections.get(clientId);
        const role = entry ? entry.role : conn.role || 'unknown';

        if (entry) {
            this._cancelIdleTimer(clientId);
            this.connections.delete(clientId);
        }

        const pairedId = this._pairedId(clientId);
        const webId = this._webIdFor(clientId);
        const appId = webId ? this.webToApp.get(webId) : undefined;
        if (webId) this._clearClientTimers(webId);
        this._unpair(clientId);

        // 任一端断开时通知并关闭另一端，避免保留失效配对
        if (pairedId) {
            this._log('info', `[${clientId}] 断开，关联配对：${pairedId}`);
            const paired = this.connections.get(pairedId);
            if (paired && paired.conn.readyState === STATE.OPEN) {
                this._send(paired.conn, {
                    type: 'break',
                    clientId: webId ?? pairedId,
                    targetId: appId ?? clientId,
                    message: '209',
                });
                paired.conn.close(1000, 'partner_disconnected');
                this._log('debug', `已通知并关闭配对连接：${pairedId}`);
            }
        }

        this._recordConnectionEvent('close', clientId, role, { code, reason });

        this._log(
            'info',
            `[断开] ${clientId}，code=${code}，reason=${reason || '-'}，剩余连接数：${this.connections.size}`,
        );
    }

    // ------------------------------------------------------------ 消息处理（逐条对齐参考实现）

    _onMessage(conn, rawMessage) {
        /* 任何解析/处理异常都不允许冒到事件循环（常驻进程被一条畸形报文打死） */
        try {
            this._onMessageInner(conn, rawMessage);
        } catch (err) {
            this._log('error', `处理消息异常（已忽略）：${err && err.stack ? err.stack : err}`);
        }
    }

    _onMessageInner(conn, rawMessage) {
        const senderId = conn.clientId ?? '-';
        const preview = safeJsonParse(rawMessage);
        this._record('in', senderId, preview.ok ? preview.value : rawMessage);

        const parsed = this._parseProtocolMessage(rawMessage);
        if (!parsed.ok) {
            this._log('warn', `消息格式错误 [${senderId}]: code=${parsed.code}`);
            this._sendError(conn, '', '', parsed.code);
            return;
        }

        const data = parsed.data;
        if (!this._validateSource(data, conn)) {
            this._log('warn', `非法消息来源 [${senderId}]: clientId=${data.clientId} targetId=${data.targetId}`);
            this._sendError(conn, data.clientId, data.targetId, '404');
            return;
        }

        // 按 V3 消息类型分流，未特殊处理的消息直接转发给配对端
        const routeType = numericType(data.type);
        if (data.type === 'bind') {
            this._handleBind(conn, data);
            return;
        }
        if (isAppReportMessage(data.message)) {
            this._forwardMessage(conn, data);
            return;
        }
        if (routeType === 1 || routeType === 2 || routeType === 3) {
            this._handleStrengthAdjust(conn, data, routeType);
            return;
        }
        if (routeType === 4) {
            this._handleCustomStrength(conn, data);
            return;
        }
        if (data.type === 'clientMsg') {
            this._handleClientMessage(conn, data);
            return;
        }
        if (data.type === 'heartbeat') {
            return;
        }
        this._forwardMessage(conn, data);
    }

    _parseProtocolMessage(rawMessage) {
        let parsed;
        try {
            parsed = JSON.parse(rawMessage);
        } catch {
            return { ok: false, code: '403' };
        }

        if (!isPlainObject(parsed)) return { ok: false, code: '403' };
        if (!hasOwn(parsed, 'type') || !hasOwn(parsed, 'clientId')) return { ok: false, code: '403' };
        if (!hasOwn(parsed, 'targetId') || !hasOwn(parsed, 'message')) return { ok: false, code: '403' };
        if (
            !isProtocolType(parsed.type) ||
            typeof parsed.clientId !== 'string' ||
            typeof parsed.targetId !== 'string' ||
            typeof parsed.message !== 'string'
        ) {
            return { ok: false, code: '403' };
        }
        if (parsed.clientId.length === 0 || parsed.targetId.length === 0) {
            return { ok: false, code: '403' };
        }

        return { ok: true, data: parsed };
    }

    _validateSource(data, conn) {
        const senderId = conn.clientId;
        return senderId === data.clientId || senderId === data.targetId;
    }

    _handleBind(conn, data) {
        const webId = data.clientId;
        const appId = data.targetId;
        const result = this._pair(webId, appId);
        this._log('debug', `绑定请求 [${conn.clientId ?? '-'}]: web=${webId} app=${appId} code=${result.code}`);

        const response = { type: 'bind', clientId: webId, targetId: appId, message: result.code };

        if (!result.ok) {
            this._log('warn', `绑定失败：${webId} ↔ ${appId}，code=${result.code}`);
            this._send(conn, response);
            return;
        }

        this._sendToClient(webId, response);
        if (appId !== webId) this._sendToClient(appId, response);
    }

    _handleStrengthAdjust(conn, data, routeType) {
        if (!this._isWebSender(conn, data)) {
            this._log(
                'warn',
                `强度调整来源非法：sender=${conn.clientId ?? '-'} clientId=${data.clientId} targetId=${data.targetId}`,
            );
            this._sendError(conn, data.clientId, data.targetId, '404');
            return;
        }
        if (!this._isPaired(data.clientId, data.targetId)) {
            this._log('warn', `强度调整配对无效：clientId=${data.clientId} targetId=${data.targetId}`);
            this._sendError(conn, data.clientId, data.targetId, '402');
            return;
        }

        const channel = normalizeChannel(data.channel, 1);
        if (!channel) {
            this._log('warn', `强度调整通道无效：clientId=${data.clientId} channel=${String(data.channel)}`);
            this._sendError(conn, data.clientId, data.targetId, '406');
            return;
        }

        // V3 APP 使用 0/1/2 表示减小、增大和指定强度
        const sendType = routeType - 1;
        const strength = routeType === 3 ? normalizeNumber(data.strength, 0) : 1;
        const strengthMessage = `strength-${channel.number}+${sendType}+${strength}`;
        const sent = this._sendToClient(data.targetId, {
            type: 'msg',
            clientId: data.clientId,
            targetId: data.targetId,
            message: strengthMessage,
        });

        if (!sent) {
            this._log('warn', `强度调整目标不存在：targetId=${data.targetId}`);
            this._sendError(conn, data.clientId, data.targetId, '404');
            return;
        }

        this._log('debug', `强度调整：${strengthMessage}`);
    }

    _handleCustomStrength(conn, data) {
        if (!this._isWebSender(conn, data)) {
            this._log(
                'warn',
                `指定强度来源非法：sender=${conn.clientId ?? '-'} clientId=${data.clientId} targetId=${data.targetId}`,
            );
            this._sendError(conn, data.clientId, data.targetId, '404');
            return;
        }
        if (!this._isPaired(data.clientId, data.targetId)) {
            this._log('warn', `指定强度配对无效：clientId=${data.clientId} targetId=${data.targetId}`);
            this._sendError(conn, data.clientId, data.targetId, '402');
            return;
        }

        const channel = normalizeChannel(data.channel, 1);
        if (!channel) {
            this._log('warn', `指定强度通道无效：clientId=${data.clientId} channel=${String(data.channel)}`);
            this._sendError(conn, data.clientId, data.targetId, '406');
            return;
        }

        if (data.message.includes('clear')) {
            const clearMessage = `clear-${channel.number}`;
            const sent = this._sendToClient(data.targetId, {
                type: 'msg',
                clientId: data.clientId,
                targetId: data.targetId,
                message: clearMessage,
            });
            if (!sent) {
                this._log('warn', `清除通道目标不存在：targetId=${data.targetId}`);
                this._sendError(conn, data.clientId, data.targetId, '404');
                return;
            }

            this._clearTimer(data.clientId, channel.letter);
            this._notifyDone(conn, data.clientId, data.targetId);
            this._log('debug', `清除通道：${clearMessage}`);
            return;
        }

        const strength = normalizeNumber(data.strength, 0);
        const strengthMessage = `strength-${channel.number}+2+${strength}`;
        const sent = this._sendToClient(data.targetId, {
            type: 'msg',
            clientId: data.clientId,
            targetId: data.targetId,
            message: strengthMessage,
        });
        if (!sent) {
            this._log('warn', `指定强度目标不存在：targetId=${data.targetId}`);
            this._sendError(conn, data.clientId, data.targetId, '404');
            return;
        }
        this._log('debug', `指定强度：${strengthMessage}`);
    }

    _handleClientMessage(conn, data) {
        if (!this._isWebSender(conn, data)) {
            this._log(
                'warn',
                `波形消息来源非法：sender=${conn.clientId ?? '-'} clientId=${data.clientId} targetId=${data.targetId}`,
            );
            this._sendError(conn, data.clientId, data.targetId, '404');
            return;
        }
        if (!this._isPaired(data.clientId, data.targetId)) {
            this._log('warn', `波形消息配对无效：clientId=${data.clientId} targetId=${data.targetId}`);
            this._sendError(conn, data.clientId, data.targetId, '402');
            return;
        }

        // 波形消息不允许通道回退，缺通道即 406
        const channel = normalizeChannel(data.channel);
        if (!channel) {
            this._log('warn', `波形消息缺少通道：clientId=${data.clientId} targetId=${data.targetId}`);
            this._sendError(conn, data.clientId, data.targetId, '406');
            return;
        }

        const target = this.connections.get(data.targetId);
        if (!target || target.conn.readyState !== STATE.OPEN) {
            this._log('warn', `波形消息目标不存在：targetId=${data.targetId}`);
            this._sendError(conn, data.clientId, data.targetId, '404');
            return;
        }

        let time = normalizePositiveInteger(data.time, this.defaultDuration);
        if (time > MAX_PULSE_SECONDS) {
            this._log('warn', `波形时长 ${time}s 超过上限，按 ${MAX_PULSE_SECONDS}s 处理`);
            time = MAX_PULSE_SECONDS;
        }
        const sendsPerSecond = normalizeSendsPerSecond(this.sendsPerSecond);
        const intervalMs = 1000 / sendsPerSecond;
        const sequence = buildPulseSequence(data, channel.letter, time, sendsPerSecond);

        this._pulseCount += 1;
        const evt = {
            ts: Date.now(),
            type: 'pulse',
            controllerId: data.clientId,
            appId: data.targetId,
            channel: channel.letter,
            /* 只留前 40 帧做样本：整个 frames 数组可能有几万条，事件数组会被撑爆 */
            frames: Array.isArray(sequence.frames) ? sequence.frames.slice(0, 40) : [],
            frameCount: Array.isArray(sequence.frames) ? sequence.frames.length : 0,
            seconds: time,
            packets: sequence.packetCount,
            parsed: sequence.parsed,
        };
        this._pushEvent(evt);
        this.emit('pulse', evt);

        this._queuePulse(data.clientId, data.targetId, channel, target.conn, sequence.messages, intervalMs, conn);
        this._log(
            'info',
            `[${data.clientId}] 波形消息已发送：通道${channel.letter}, 包数${sequence.packetCount}, 时长${time}s${
                sequence.parsed && sequence.totalFrames ? `, 总帧数${sequence.totalFrames}` : ', 原始格式透传'
            }`,
        );
    }

    _forwardMessage(conn, data) {
        if (!this._isPaired(data.clientId, data.targetId)) {
            this._log(
                'warn',
                `转发消息配对无效：clientId=${data.clientId} targetId=${data.targetId} type=${String(data.type)}`,
            );
            this._sendError(conn, data.clientId, data.targetId, '402');
            return;
        }

        const senderId = conn.clientId;
        const recipientId = senderId === data.clientId ? data.targetId : data.clientId;
        const shouldSwapIds = data.type === 'msg' && senderId !== undefined && this.appToWeb.has(senderId);
        const sent = this._sendToClient(recipientId, {
            type: data.type,
            clientId: shouldSwapIds ? senderId : data.clientId,
            targetId: shouldSwapIds ? recipientId : data.targetId,
            message: data.message,
        });

        if (!sent) {
            this._log('warn', `转发消息目标不存在：sender=${senderId ?? '-'} recipient=${recipientId}`);
            this._sendError(conn, data.clientId, data.targetId, '404');
            return;
        }

        const messageKind = data.message.startsWith('feedback')
            ? 'feedback'
            : data.message.startsWith('strength')
              ? 'strength'
              : '普通消息';
        this._log(
            'debug',
            `转发${messageKind}：sender=${senderId ?? '-'} recipient=${recipientId} type=${String(data.type)} message=${data.message}`,
        );
    }

    // ------------------------------------------------------------ 波形定时队列

    _queuePulse(clientId, targetId, channel, targetConn, messages, intervalMs, sourceConn) {
        const key = timerKey(clientId, channel.letter);
        const oldTask = this.pulseTimers.get(key);
        const pendingStart = this.pendingStarts.get(key);
        /* 关键：判定必须同时看「正在发的」和「等 150ms 要启动的」，
         * 否则第三条波形会在延迟启动窗口里插入，留下永远清不掉的孤儿 interval */
        if (oldTask || pendingStart) {
            this._log('info', `[${key}] 清除现有定时器，准备发送新消息`);
            this._clearTimer(clientId, channel.letter);
            this._send(targetConn, {
                type: 'msg',
                clientId,
                targetId,
                message: `clear-${channel.number}`,
            });
            this._send(sourceConn, {
                type: 'notify',
                clientId,
                targetId,
                message: `当前通道${channel.letter}有正在发送的消息，覆盖之前的消息`,
            });

            const timer = setTimeout(() => {
                this.pendingStarts.delete(key);
                this._startPulse(clientId, targetId, channel.letter, targetConn, messages, intervalMs, sourceConn);
            }, PULSE_REPLACE_DELAY_MS);
            if (typeof timer.unref === 'function') timer.unref();
            this.pendingStarts.set(key, timer);
            return;
        }

        this._startPulse(clientId, targetId, channel.letter, targetConn, messages, intervalMs, sourceConn);
    }

    _startPulse(clientId, targetId, channel, targetConn, messages, intervalMs, sourceConn) {
        const key = timerKey(clientId, channel);
        /* 落表前先掐掉同 key 的旧 interval，避免被覆盖后成为清不掉的孤儿 */
        const stale = this.pulseTimers.get(key);
        if (stale) {
            if (stale.timer) clearInterval(stale.timer);
            this.pulseTimers.delete(key);
            this._log('warn', `[${key}] 启动新波形时清理了旧的定时任务`);
        }
        const firstMessage = messages[0];
        if (!firstMessage) {
            this._log('warn', `[${key}] 波形消息为空，停止发送`);
            this._notifyDone(sourceConn, clientId, targetId);
            return;
        }

        const task = {
            clientId,
            targetId,
            channel,
            messages,
            targetConn,
            sourceConn,
            remaining: messages.length,
            nextIndex: 0,
            timer: null,
        };

        this._sendPulsePacket(task, firstMessage);
        task.remaining -= 1;
        task.nextIndex += 1;
        this._log('info', `[${key}] 消息发送中，剩余次数：${task.remaining}`);

        if (task.remaining <= 0) {
            this._log('info', `[${key}] 消息已发送完成（仅 1 条）`);
            this._notifyDone(sourceConn, clientId, targetId);
            return;
        }

        task.timer = setInterval(() => {
            /* 每个退出分支都必须自己 clearInterval：只靠 _clearTimer 可能清到别的任务 */
            const stopSelf = () => {
                if (task.timer) {
                    clearInterval(task.timer);
                    task.timer = null;
                }
                this._clearTimer(clientId, channel);
            };
            if (targetConn.readyState !== STATE.OPEN) {
                this._log('warn', `[${key}] 目标连接已断开，停止发送`);
                stopSelf();
                return;
            }

            const message = task.messages[task.nextIndex];
            if (!message) {
                this._log('warn', `[${key}] 波形消息序列已耗尽，停止发送`);
                stopSelf();
                this._notifyDone(sourceConn, clientId, targetId);
                return;
            }

            this._sendPulsePacket(task, message);
            task.remaining -= 1;
            task.nextIndex += 1;
            if (task.remaining <= 0) {
                this._log('info', `[${key}] 消息发送完毕`);
                stopSelf();
                this._notifyDone(sourceConn, clientId, targetId);
            }
        }, intervalMs);

        this.pulseTimers.set(key, task);
    }

    _sendPulsePacket(task, message) {
        const key = timerKey(task.clientId, task.channel);
        const packetIndex = task.nextIndex + 1;
        const packetCount = task.messages.length;
        if (this._send(task.targetConn, message)) {
            this._log('info', `[${key}] 实际发出包体 ${packetIndex}/${packetCount}: ${JSON.stringify(message)}`);
        }
    }

    _clearTimer(clientId, channel) {
        const key = timerKey(clientId, channel);
        const pending = this.pendingStarts.get(key);
        if (pending) {
            clearTimeout(pending);
            this.pendingStarts.delete(key);
        }

        const task = this.pulseTimers.get(key);
        if (!task) return;

        if (task.timer) clearInterval(task.timer);
        this.pulseTimers.delete(key);
        this._log('debug', `[${key}] 定时器已清除`);
    }

    _clearClientTimers(clientId) {
        let cleared = 0;
        for (const [key, task] of this.pulseTimers) {
            if (task.clientId !== clientId) continue;
            if (task.timer) clearInterval(task.timer);
            this.pulseTimers.delete(key);
            cleared += 1;
        }
        for (const [key, timer] of this.pendingStarts) {
            if (!key.startsWith(`${clientId}:`)) continue;
            clearTimeout(timer);
            this.pendingStarts.delete(key);
        }
        this._log('info', `[${clientId}] 清除了 ${cleared} 个定时器`);
    }

    _notifyDone(conn, clientId, targetId) {
        this._send(conn, { type: 'notify', clientId, targetId, message: '发送完毕' });
    }

    // ------------------------------------------------------------ 配对表

    _pair(webId, appId) {
        if (webId === appId) return { ok: false, code: '401' };
        if (!this.connections.has(webId) || !this.connections.has(appId)) {
            return { ok: false, code: '401' };
        }
        if (this._isPaired(webId, appId)) {
            this._log('debug', `配对已存在，兼容重复绑定：${webId} ↔ ${appId}`);
            return { ok: true, code: '200' };
        }
        if (this._isBound(webId) || this._isBound(appId)) {
            return { ok: false, code: '400' };
        }

        // 同时保存正向和反向关系，保证两端都能常数时间查询
        this.webToApp.set(webId, appId);
        this.appToWeb.set(appId, webId);
        this._cancelIdleTimer(webId);
        this._cancelIdleTimer(appId);
        this._log('info', `配对成功：${webId} ↔ ${appId}`);
        this._recordPairEvent(webId, appId);

        return { ok: true, code: '200' };
    }

    _unpair(clientId) {
        const appId = this.webToApp.get(clientId);
        if (appId) {
            this.webToApp.delete(clientId);
            this.appToWeb.delete(appId);
            this._log('info', `解除配对：${clientId} ↔ ${appId}`);
            return;
        }

        const webId = this.appToWeb.get(clientId);
        if (webId) {
            this.appToWeb.delete(clientId);
            this.webToApp.delete(webId);
            this._log('info', `解除配对：${webId} ↔ ${clientId}`);
        }
    }

    _isBound(clientId) {
        return this.webToApp.has(clientId) || this.appToWeb.has(clientId);
    }

    _isAvailableTarget(clientId) {
        const entry = this.connections.get(clientId);
        if (!entry || entry.conn.readyState !== STATE.OPEN) return false;
        if (this._isStaleController(entry)) return false;   // 僵尸不算「可接入」
        return !this._isBound(clientId);
    }

    _lastSeenOf(entry) {
        if (!entry) return 0;
        const connSeen = entry.conn && entry.conn.lastSeenAt ? entry.conn.lastSeenAt : 0;
        return Math.max(connSeen, entry.createdAt || 0);
    }

    _isStaleController(entry) {
        if (!entry || entry.role !== 'controller') return false;
        return Date.now() - this._lastSeenOf(entry) > this.staleMs;
    }

    _isPaired(clientId, targetId) {
        return this.webToApp.get(clientId) === targetId || this.appToWeb.get(clientId) === targetId;
    }

    _pairedId(clientId) {
        return this.webToApp.get(clientId) ?? this.appToWeb.get(clientId);
    }

    _webIdFor(clientId) {
        if (this.webToApp.has(clientId)) return clientId;
        return this.appToWeb.get(clientId);
    }

    _isWebSender(conn, data) {
        return conn.clientId === data.clientId;
    }

    // ------------------------------------------------------------ 发送

    _sendToClient(clientId, payload) {
        const entry = this.connections.get(clientId);
        if (!entry || entry.conn.readyState !== STATE.OPEN) return false;
        return this._send(entry.conn, payload);
    }

    _sendError(conn, clientId, targetId, code) {
        this._log('debug', `发送错误响应：clientId=${clientId || '-'} targetId=${targetId || '-'} code=${code}`);
        this._send(conn, { type: 'error', clientId, targetId, message: code });
    }

    _closeInvalidTarget(conn, clientId, targetId) {
        this._sendError(conn, clientId, targetId, String(CLOSE_INVALID_TARGET_ID));
        conn.close(CLOSE_INVALID_TARGET_ID, 'invalid_target_id');
    }

    _send(conn, payload) {
        if (!conn || conn.readyState !== STATE.OPEN) return false;
        /* 背压保护：对端只连不读时不要无限堆积用户态缓冲 */
        try {
            const buffered = conn.socket && typeof conn.socket.writableLength === 'number' ? conn.socket.writableLength : 0;
            if (buffered > MAX_WRITE_BUFFER) {
                this._log('warn', `发送缓冲已积压 ${Math.round(buffered / 1024)}KB，丢弃本次消息`);
                return false;
            }
        } catch {
            /* ignore */
        }
        let text;
        try {
            text = JSON.stringify(payload);
        } catch (err) {
            this._log('error', `序列化消息失败：${err && err.message ? err.message : err}`);
            return false;
        }
        if (!conn.sendText(text)) return false;

        this._record('out', conn.clientId ?? '-', payload);
        return true;
    }

    // ------------------------------------------------------------ 时间轮

    _startIdleTimer(clientId) {
        // 只限制未配对连接，配对成功后会取消计时
        this._cancelIdleTimer(clientId);
        const entry = this.connections.get(clientId);
        if (!entry) return;

        entry.idleTimer = setTimeout(() => {
            this._closeIfUnpaired(clientId);
        }, this.idleTimeoutMs);
        this._log('debug', `未配对超时计时开始：${clientId} timeout=${this.idleTimeoutMs}ms`);
    }

    _cancelIdleTimer(clientId) {
        const entry = this.connections.get(clientId);
        if (!entry || !entry.idleTimer) return;
        clearTimeout(entry.idleTimer);
        entry.idleTimer = null;
    }

    _closeIfUnpaired(clientId) {
        const entry = this.connections.get(clientId);
        if (!entry || entry.conn.readyState !== STATE.OPEN) return;
        if (this._isBound(clientId)) return;

        this._send(entry.conn, { type: 'error', clientId, targetId: '', message: 'idle_timeout' });
        entry.conn.close(1000, 'idle_timeout');
        this._log('warn', `未配对连接超时关闭：${clientId}`);
    }

    // ------------------------------------------------------------ 事件 / 日志

    _pushEvent(evt) {
        this.events.push(evt);
        this._eventsBytes = (this._eventsBytes || 0) + estimateEventSize(evt);
        /* 条数和字节双封顶：大报文会让只按条数封顶的数组吃掉上百 MB */
        while (
            this.events.length > 1 &&
            (this.events.length > MAX_EVENTS || this._eventsBytes > MAX_EVENT_BYTES)
        ) {
            const dropped = this.events.shift();
            this._eventsBytes -= estimateEventSize(dropped);
        }
        if (this._eventsBytes < 0) this._eventsBytes = 0;
    }

    /** open / close 生命周期事件：进事件数组 + 触发同名 emitter 事件 */
    _recordConnectionEvent(type, clientId, role, extra) {
        const evt = { ts: Date.now(), type, clientId, role, ...(extra || {}) };
        this._pushEvent(evt);
        this.emit(type, evt);
        return evt;
    }

    /** 配对成功事件：evt = { controllerId, appId } */
    _recordPairEvent(controllerId, appId) {
        const evt = { ts: Date.now(), type: 'pair', controllerId, appId };
        this._pushEvent(evt);
        this.emit('pair', evt);
        return evt;
    }

    /** 记录一条收/发消息：事件数组 + JSONL 日志 + --verbose 输出 */
    _record(dir, clientId, data) {
        const ts = Date.now();
        const safe = truncatePayload(data);
        const evt = { ts, type: 'message', dir, clientId: clientId ?? '-', data: safe };
        this._pushEvent(evt);
        this.emit('message', evt);

        if (this.logFile) {
            /* safeStringify：深嵌套/循环引用会让 JSON.stringify 抛异常，这里不能裸调 */
            this._writeLogLine(safeStringify({ ts, dir, clientId: evt.clientId, data: safe }, 8192));
        }
        if (this.verbose) {
            const body = typeof safe === 'string' ? safe : safeStringify(safe, 2048);
            this._safeWrite(`[relay] ${dir === 'in' ? '<<' : '>>'} ${evt.clientId} ${body}\n`);
        }
    }

    /** 写 stdout 也要防管道断掉（EPIPE 会让常驻进程直接死） */
    _safeWrite(text) {
        try {
            process.stdout.write(text);
        } catch {
            /* ignore */
        }
    }

    _writeLogLine(line) {
        try {
            if (!this._logStream) {
                this._logStream = fs.createWriteStream(this.logFile, { flags: 'a' });
                this._logStream.on('error', (err) => {
                    this._log('error', `日志写入失败：${err && err.message ? err.message : err}`);
                });
            }
            this._logStream.write(`${line}\n`);
        } catch (err) {
            this._log('error', `日志写入失败：${err && err.message ? err.message : err}`);
        }
    }

    _closeLogStream() {
        const stream = this._logStream;
        this._logStream = null;
        if (!stream) return Promise.resolve();
        return new Promise((resolve) => {
            const bail = setTimeout(resolve, 500);
            if (typeof bail.unref === 'function') bail.unref();
            stream.end(() => {
                clearTimeout(bail);
                resolve();
            });
        });
    }

    _log(level, message) {
        const active = this.verbose ? LOG_WEIGHT.debug : LOG_WEIGHT.info;
        if (LOG_WEIGHT[level] < active) return;
        const line = `${new Date().toISOString()} [${level.toUpperCase()}] [V3] ${message}`;
        if (level === 'debug' || level === 'info') process.stdout.write(`${line}\n`);
        else process.stderr.write(`${line}\n`);
    }
}

function safeJsonParse(text) {
    try {
        return { ok: true, value: JSON.parse(text) };
    } catch {
        return { ok: false };
    }
}

// ---------------------------------------------------------------- 工厂 / CLI

function createRelay(options) {
    return new Relay(options);
}

const USAGE = `用法: node dglab-relay.js [选项]

选项:
  --port <n>    监听端口（默认 ${DEFAULT_PORT}，0 表示随机端口）
  --host <h>    监听地址（默认 ${DEFAULT_HOST}）
  --verbose     打印每条收发消息
  --quiet       不打启动提示（只保留监听那一行）
  --log <file>  把每条收发消息以 JSONL 追加写入文件
  -h, --help    显示本帮助
  --version     打印版本号后退出

HTTP:
  GET /            服务状态 JSON
  GET /__status    服务状态 JSON
  ws://host:port/            控制端（可用 ?cid=<id> 固定 clientId）
  ws://host:port/<targetId>  APP 端（也支持 ?targetId= / ?tid=）`;

function parseArgs(argv) {
    const opts = { port: DEFAULT_PORT, host: DEFAULT_HOST, verbose: false, quiet: false, logFile: null, help: false, version: false };

    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '--port' || arg === '-p') {
            opts.port = Number(argv[i + 1]);
            i += 1;
        } else if (arg.startsWith('--port=')) {
            opts.port = Number(arg.slice('--port='.length));
        } else if (arg === '--host') {
            opts.host = argv[i + 1];
            i += 1;
        } else if (arg.startsWith('--host=')) {
            opts.host = arg.slice('--host='.length);
        } else if (arg === '--verbose' || arg === '-v') {
            opts.verbose = true;
        } else if (arg === '--log') {
            opts.logFile = argv[i + 1];
            i += 1;
        } else if (arg.startsWith('--log=')) {
            opts.logFile = arg.slice('--log='.length);
        } else if (arg === '--help' || arg === '-h') {
            opts.help = true;
        } else if (arg === '--version') {
            opts.version = true;
        } else if (arg === '--quiet' || arg === '-q') {
            opts.quiet = true;
        } else if (arg === '--no-verbose') {
            opts.verbose = false;
        } else {
            throw new Error(`未知参数：${arg}`);
        }
    }

    if (!Number.isInteger(opts.port) || opts.port < 0 || opts.port > 65535) {
        throw new Error(`非法端口：${opts.port}`);
    }
    if (!opts.host) throw new Error('非法监听地址');
    if (opts.logFile === '') throw new Error('--log 需要文件路径');
    if (opts.logFile === undefined) opts.logFile = null;

    return opts;
}

if (require.main === module) {
    let opts;
    try {
        opts = parseArgs(process.argv.slice(2));
    } catch (err) {
        process.stderr.write(`[relay] ${err.message}\n\n${USAGE}\n`);
        process.exit(2);
    }

    if (opts.version) {
        process.stdout.write(`dglab-relay v${readVersion()}\n`);
        process.exit(0);
    }

    if (opts.help) {
        process.stdout.write(`${USAGE}\n`);
        process.exit(0);
    }

    const relay = createRelay(opts);

    relay
        .listen()
        .then(() => {
            /* listen() 内部已打印 listening 行 */
        })
        .catch((err) => {
            process.stderr.write(`[relay] 启动失败: ${err && err.message ? err.message : err}\n`);
            process.exit(1);
        });

    let shuttingDown = false;
    const shutdown = (signal) => {
        if (shuttingDown) return;
        shuttingDown = true;
        process.stdout.write(`[relay] 收到 ${signal}，正在关闭…\n`);
        relay
            .close()
            .then(() => process.exit(0))
            .catch(() => process.exit(0));
    };

    /* 常驻进程的保命措施：
     * 1) 日志管道断掉（`| head`、日志 App 崩了）时写 stdout 会 EPIPE，未处理就是进程级致命；
     * 2) 任何未捕获异常/未处理拒绝都只记录，不退出——中继死了整条链路就断了。 */
    for (const stream of [process.stdout, process.stderr]) {
        try {
            stream.on('error', () => {});
        } catch {
            /* ignore */
        }
    }
    process.on('uncaughtException', (err) => {
        try {
            process.stderr.write(`[relay] 未捕获异常（已忽略，继续运行）：${err && err.stack ? err.stack : err}\n`);
        } catch {
            /* ignore */
        }
    });
    process.on('unhandledRejection', (err) => {
        try {
            process.stderr.write(`[relay] 未处理的 Promise 拒绝（已忽略）：${err && err.stack ? err.stack : err}\n`);
        } catch {
            /* ignore */
        }
    });

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
}

module.exports = {
    createRelay,
    Relay,
    WsConnection,
    encodeFrame,
    websocketAccept,
    normalizeChannel,
    buildPulseSequence,
    parsePulseMessage,
    fitFramesToLength,
    splitFrames,
};
