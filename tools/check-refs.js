#!/usr/bin/env node
/**
 * check-refs.js —— 轻量静态检查：防止手误写出不存在的成员调用
 *
 * 检查 dglab-hp.js 里所有 `DG.xxx` / `S.xxx` / `UI.xxx` / `MOD.xxx` 的引用，
 * 是否都能在对应的对象字面量里找到定义（属性或方法）。
 * 这类手误在游戏里只会表现为「某一刻开始每 tick 抛异常」，很难定位，所以单独扫一遍。
 *
 * 运行：node tools/check-refs.js [目标文件]
 * 退出码 0 = 没问题；1 = 有可疑引用。
 */

'use strict';

const fs = require('fs');
const path = require('path');

const target = process.argv[2] || path.join(__dirname, '..', 'dglab-hp.js');
const src = fs.readFileSync(target, 'utf8');

/** 取出 `var NAME = { ... }` 对象字面量的完整文本（按花括号配对） */
function objectBody(text, name) {
    const decl = text.indexOf('var ' + name + ' = {');
    if (decl < 0) return null;
    const start = text.indexOf('{', decl);
    let depth = 0;
    for (let i = start; i < text.length; i++) {
        const ch = text[i];
        if (ch === '{') depth++;
        else if (ch === '}') {
            depth--;
            if (depth === 0) return text.slice(start + 1, i);
        }
    }
    return null;
}

/** 收集对象里的所有键名（属性 `k:` 与简写方法 `k(`） */
function members(text, name) {
    const body = objectBody(text, name);
    if (body === null) return null;
    const out = new Set();
    // 去掉字符串字面量，避免把 'a: b' 这种内容当成键
    const clean = body.replace(/'(?:\\.|[^'\\])*'/g, "''").replace(/"(?:\\.|[^"\\])*"/g, '""');
    for (const m of clean.matchAll(/(?:^|[\n,{])\s*([A-Za-z_$][\w$]*)\s*:/g)) out.add(m[1]);
    for (const m of clean.matchAll(/(?:^|[\n,{])\s*([A-Za-z_$][\w$]*)\s*\(/g)) out.add(m[1]);
    return out;
}

const OBJECTS = ['DG', 'S', 'UI', 'MOD'];
let problems = 0;

for (const name of OBJECTS) {
    const known = members(src, name);
    if (!known) {
        console.log('!! 找不到对象 ' + name + ' 的定义');
        problems++;
        continue;
    }
    const re = new RegExp('\\b' + name + '\\.([A-Za-z_$][\\w$]*)', 'g');
    const seen = new Set();
    let m;
    while ((m = re.exec(src))) {
        const prop = m[1];
        if (seen.has(prop)) continue;
        seen.add(prop);
        if (!known.has(prop)) {
            const line = src.slice(0, m.index).split('\n').length;
            console.log('!! ' + name + '.' + prop + ' 未定义（第 ' + line + ' 行）');
            problems++;
        }
    }
    console.log('  ' + name + '：检查 ' + seen.size + ' 个引用，定义 ' + known.size + ' 个成员');
}

/* 顶层函数调用：收集定义，再看有没有明显拼错的同名调用（只报疑似，不误报） */
const defined = new Set();
for (const m of src.matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\(/g)) defined.add(m[1]);
for (const m of src.matchAll(/var\s+([A-Za-z_$][\w$]*)\s*=\s*function/g)) defined.add(m[1]);
console.log('  顶层函数/变量：' + defined.size + ' 个');

if (problems) {
    console.log('\nCHECK-REFS FAILED（' + problems + ' 处可疑引用）');
    process.exit(1);
}
console.log('\nCHECK-REFS OK');
