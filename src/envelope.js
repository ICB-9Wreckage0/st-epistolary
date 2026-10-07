// 书信簿 · 信封动画
// 用 CSS 3D 变换搭一个真正的三维信封（正反两面、可翻转的翻盖、装在里面的信纸），
// 再用 Web Animations API 按“镜头”顺序播放：
//   封缄：（竖版信纸先对折一次）信纸入封 → 翻盖合上（回弹）→ 滴火漆 → 印章落下、压实、抬起 → 翻到正面盖邮戳 → 飞走
//   拆信：飞入 → 翻到背面 → 火漆裂开 → 翻盖弹开 → 信纸升起（竖版展开）→ 迎面而来
// 不依赖任何库。点击画面任意处可跳过；系统开启“减少动态效果”时不播放。
//
// 关于层次：几块纸片在同一个三维场景里互相贴着、共用边时，浏览器的自动深度排序并不可靠（会把翻盖画断）。
// 所以场景本身是“平的”（transform-style: flat），每块纸谁在前谁在后由 z-index 固定；
// 翻盖立到正好侧对镜头（90°，看不见）时切换它在信纸前/后，信封翻面到 90° 时切换正反面。

import { paperClasses, renderBody, renderOptions, paperLayer, ensureWearFilters, hashSeed, handClasses, paperStyle } from './render.js';

const WAX = {
    crimson: ['#b3332c', '#8e1b1b', '#5a0e0e'],
    navy: ['#3d5591', '#1f2f5a', '#111b36'],
    forest: ['#3f7a57', '#1f4d34', '#0f2c1d'],
    black: ['#4a4a4a', '#1b1b1b', '#050505'],
    gold: ['#d9b24c', '#a8801f', '#6b500f'],
};

const ENVELOPES = {
    ivory: { paper: '#efe5cf', edge: '#d9ccae', lining: ['#7a2e2e', '#5c1f1f'] },
    kraft: { paper: '#caa877', edge: '#b08d5c', lining: ['#3b4a3a', '#2b372b'] },
    blue: { paper: '#d4dde9', edge: '#b7c3d3', lining: ['#1f2f5a', '#16233f'] },
    white: { paper: '#f6f3ec', edge: '#ddd8cc', lining: ['#5a6472', '#434b56'] },
    airmail: { paper: '#f3f0e8', edge: '#dcd6c8', lining: ['#2f4a8a', '#24396b'] },
};

export const WAX_LABELS = { crimson: '朱红火漆', navy: '藏青火漆', forest: '墨绿火漆', black: '黑色火漆', gold: '金色火漆', chop: '朱印“缄”', none: '不封（胶封）' };

// 封缄方式：火漆、朱印、或者不封
function sealKind(letter) {
    const w = (letter.appearance || {}).wax;
    return w === 'chop' ? 'chop' : w === 'none' ? 'none' : 'wax';
}
export const ENVELOPE_LABELS = { ivory: '象牙白信封', kraft: '牛皮纸信封', blue: '淡蓝信封', white: '白信封', airmail: '航空信封' };

// 把颜色调暗一点（amount 0~1）
function shade(hex, amount) {
    const n = parseInt(String(hex).replace('#', ''), 16);
    const f = c => Math.max(0, Math.round(c * (1 - amount))).toString(16).padStart(2, '0');
    return `#${f((n >> 16) & 255)}${f((n >> 8) & 255)}${f(n & 255)}`;
}

function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// 火漆上的首字：署名优先，否则写信人；去掉标点，取第一个字
function monogram(letter) {
    const src = String(letter.signature || letter.author || '').replace(/[\s.,，。·、'"“”‘’()（）\-]/g, '');
    return src ? Array.from(src)[0].toUpperCase() : '✉';
}

function postmarkDate(date) {
    const m = String(date || '').match(/^(\d{1,4})\D+(\d{1,2})(?:\D+(\d{1,2}))?/);
    if (!m) return date || '';
    return [m[3], m[2], m[1]].filter(Boolean).map((x, i) => (i < 2 ? x.padStart(2, '0') : x)).join('·');
}

// 统一的变换字符串，函数顺序固定，关键帧之间才能平滑插值
function T({ x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, s = 1 } = {}) {
    return `translate3d(${x}, ${y}, ${z}px) rotateX(${rx}deg) rotateY(${ry}deg) rotateZ(${rz}deg) scale(${s})`;
}

function reducedMotion() {
    try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
}

class Stage {
    constructor(letter, renderOpts) {
        this.letter = letter;
        this.skip = false;
        const a = letter.appearance || {};
        let env = ENVELOPES[a.envelope] || ENVELOPES.ivory;
        let wax = WAX[a.wax] || WAX.crimson;
        // 自定义颜色
        if (a.mode?.envelope === 'custom' && a.customColor?.envelope) env = { ...env, paper: a.customColor.envelope, edge: shade(a.customColor.envelope, 0.12) };
        if (a.mode?.wax === 'custom' && a.customColor?.wax) wax = [a.customColor.wax, shade(a.customColor.wax, 0.3), shade(a.customColor.wax, 0.6)];
        const portrait = a.orientation !== 'landscape';
        const body = renderBody(letter.body || '', renderOpts || renderOptions(letter, null));
        const layer = paperLayer(letter, hashSeed((letter.id || '') + (letter.author || '')));
        const inkStyle = esc(paperStyle(letter));
        const sheet = extra => `<div class="epi-env-sheet ${esc(paperClasses(letter))}${extra || ''}" style="${inkStyle}">${layer}<div class="epi-env-letter-text epi-paper-body">${body}</div></div>`;
        ensureWearFilters();
        const to = (letter.recipients || []).join('、');

        const el = document.createElement('div');
        el.className = `epi-env-stage env-${a.envelope || 'ivory'}`;
        el.style.setProperty('--env-paper', env.paper);
        el.style.setProperty('--env-edge', env.edge);
        el.style.setProperty('--env-lining-a', env.lining[0]);
        el.style.setProperty('--env-lining-b', env.lining[1]);
        el.style.setProperty('--wax-hi', wax[0]);
        el.style.setProperty('--wax', wax[1]);
        el.style.setProperty('--wax-lo', wax[2]);
        el.innerHTML = `
            <div class="epi-env-backdrop"></div>
            <div class="epi-env-camera">
                <div class="epi-env-scene">
                    
                    <!-- 背面（有翻盖的一面） -->
                    <div class="epi-env-back epi-env-grain"></div>
                    <!-- 信纸：竖版由上下两半组成，下半张可以沿中线折上来；横版只有一整张 -->
                    <div class="epi-env-letter orient-${portrait ? 'portrait' : 'landscape'}">
                        <div class="epi-env-half epi-env-half-top">${sheet()}</div>
                        ${portrait ? `<div class="epi-env-half epi-env-half-bot">
                            <div class="epi-env-fold-front">${sheet(' epi-env-sheet-lower')}</div>
                            <div class="epi-env-fold-back ${esc(paperClasses(letter))}">${layer}</div>
                        </div>` : ''}
                    </div>
                    <div class="epi-env-pocket epi-env-grain"><div class="epi-env-sheen"></div></div>
                    <div class="epi-env-flap">
                        <div class="epi-env-flap-out epi-env-grain"><div class="epi-env-sheen"></div></div>
                        <div class="epi-env-flap-in"></div>
                    </div>

                    <!-- 火漆与印章 -->
                    <div class="epi-env-seal-shadow"></div>
                    <div class="epi-env-seal">
                        ${sealKind(letter) === 'chop'
                            ? '<div class="epi-env-chop"><span>缄</span></div>'
                            : `<div class="epi-env-wax"><div class="epi-env-imprint"><span>${esc(monogram(letter))}</span></div><div class="epi-env-wax-sheen"></div></div>`}
                    </div>
                    <div class="epi-env-seal-half epi-env-seal-l"><div class="epi-env-wax"><div class="epi-env-imprint" style="opacity:1"><span>${esc(monogram(letter))}</span></div></div></div>
                    <div class="epi-env-seal-half epi-env-seal-r"><div class="epi-env-wax"><div class="epi-env-imprint" style="opacity:1"><span>${esc(monogram(letter))}</span></div></div></div>
                    <div class="epi-env-stamp-shadow"></div>
                    <div class="epi-env-stamp"><div class="epi-env-stamp-face"></div></div>

                    <!-- 正面（写地址的一面） -->
                    <div class="epi-env-face epi-env-grain">
                        <div class="epi-env-sheen"></div>
                        <div class="epi-env-from ${esc(handClasses(letter))}" style="${inkStyle}">${esc(letter.author || '')}${letter.placeFrom ? `<br>${esc(letter.placeFrom)}` : ''}</div>
                        <div class="epi-env-address ${esc(handClasses(letter))}" style="${inkStyle}">
                            <div class="epi-env-to">${esc(to)}</div>
                            ${letter.placeTo ? `<div class="epi-env-place">${esc(letter.placeTo)}</div>` : ''}
                        </div>
                        <div class="epi-env-postage"><div class="epi-env-postage-inner"><span class="epi-env-postage-glyph">✦</span><span class="epi-env-postage-value">10</span></div></div>
                        <div class="epi-env-postmark">
                            <div class="epi-env-postmark-ring"><span>${esc((letter.placeFrom || '').toUpperCase().slice(0, 14))}</span><b>${esc(postmarkDate(letter.writtenAt))}</b></div>
                            <div class="epi-env-postmark-waves"></div>
                        </div>
                    </div>
                </div>
            </div>
            <div class="epi-env-hint">点击跳过</div>`;
        this.el = el;
        this.q = sel => el.querySelector(sel);
        el.addEventListener('click', () => this.finishNow());
    }

    mount() { document.body.appendChild(this.el); }

    side(which) {
        this.el.classList.toggle('side-front', which === 'front');
        this.el.classList.toggle('side-back', which !== 'front');
    }

    flapBehind(on) {
        this.q('.epi-env-flap').classList.toggle('behind', on);
    }

    get portrait() { return !!this.q('.epi-env-letter.orient-portrait'); }

    // 信封宽度（像素），竖版信纸的位移按它来算
    get W() { return this.q('.epi-env-camera').offsetWidth; }

    // 镜头拉远/推近：竖版信纸在信封前面展开时比信封高，矮屏幕上要拉远一点才放得下。
    // 用独立的 scale 属性，不和“一震”用的 transform 打架
    zoom(fitSheet, ms = 450) {
        const cam = this.q('.epi-env-camera');
        const from = cam.style.scale || '1';
        let to = 1;
        if (fitSheet) {
            const sheetH = this.W * 1.16;
            to = Math.min(1, (window.innerHeight * 0.86) / sheetH);
        }
        cam.style.scale = String(to);
        return this.play(cam, [{ scale: from }, { scale: String(to) }], ms, 'cubic-bezier(.4,0,.2,1)');
    }

    // 信纸临时放到最前面（在信封前面对折、展开时）
    raise(on) { this.q('.epi-env-letter').classList.toggle('raised', on); }

    // 下半张信纸对折上来（true）或展开（false）。和翻盖一样，转到侧对镜头时换面
    async fold(toFolded, ms = 700) {
        const bot = '.epi-env-half-bot';
        if (toFolded) {
            await this.play(bot, [{ transform: 'rotateX(0deg)' }, { transform: 'rotateX(90deg)' }], ms * 0.45, 'cubic-bezier(.45,0,.9,.55)');
            this.q(bot).classList.add('folded');
            await this.play(bot, [
                { transform: 'rotateX(90deg)' },
                { transform: 'rotateX(184deg)', offset: 0.7 },
                { transform: 'rotateX(180deg)' },
            ], ms * 0.55, 'cubic-bezier(.15,.6,.35,1)');
        } else {
            await this.play(bot, [{ transform: 'rotateX(180deg)' }, { transform: 'rotateX(90deg)' }], ms * 0.45, 'cubic-bezier(.45,0,.9,.55)');
            this.q(bot).classList.remove('folded');
            await this.play(bot, [
                { transform: 'rotateX(90deg)' },
                { transform: 'rotateX(-5deg)', offset: 0.7 },
                { transform: 'rotateX(0deg)' },
            ], ms * 0.55, 'cubic-bezier(.15,.6,.35,1)');
        }
    }

    // 整个信封翻面：到一半（侧对镜头）时换面
    async flip(fromSide, toSide, ms = 800) {
        const fromRy = fromSide === 'front' ? 180 : 0;
        const toRy = toSide === 'front' ? 180 : 0;
        const midRy = (fromRy + toRy) / 2;
        const p = this.play('.epi-env-scene', [
            { transform: T({ ...REST, ry: fromRy }) },
            { transform: T({ rx: 10, ry: midRy, z: 80, s: 1.02 }), offset: 0.5 },
            { transform: T({ ...REST, ry: toRy }) },
        ], ms, 'cubic-bezier(.55,.05,.35,1)');
        await this.wait(ms / 2);
        this.side(toSide);
        await p;
    }
    unmount() { this.el.remove(); }

    finishNow() {
        this.skip = true;
        this.el.getAnimations({ subtree: true }).forEach(an => { try { an.finish(); } catch { /* 无限循环的动画不能 finish */ } });
    }

    // 测试用：在控制台设置 epistolary.slowMo = 4 可以四倍慢放
    d(ms) { return this.skip ? 1 : ms * (globalThis.epistolary?.slowMo || 1); }

    // 播放一段；返回 Promise
    play(sel, keyframes, ms, easing = 'ease', delay = 0) {
        const el = typeof sel === 'string' ? this.q(sel) : sel;
        const an = el.animate(keyframes, { duration: this.d(ms), easing, delay: this.skip ? 0 : this.d(delay), fill: 'forwards' });
        return an.finished.catch(() => {});
    }

    wait(ms) {
        return new Promise(r => setTimeout(r, this.d(ms)));
    }

    // 摄像机轻微一震：用于印章压下、邮戳盖下
    thump(power = 1) {
        return this.play('.epi-env-camera', [
            { transform: 'translateY(0)' },
            { transform: `translateY(${4 * power}px)`, offset: 0.3 },
            { transform: `translateY(${-1 * power}px)`, offset: 0.65 },
            { transform: 'translateY(0)' },
        ], 280, 'ease-out');
    }
}

// 桌面上的姿态：略微前倾，像低头看桌上的信封
const REST = { rx: 16 };

function setInitial(stage, { face }) {
    const q = stage.q;
    stage.side(face);
    q('.epi-env-scene').style.transform = T({ ...REST, ry: face === 'front' ? 180 : 0 });
    q('.epi-env-flap').style.transform = 'rotateX(180deg)';
    stage.flapBehind(true);
    q('.epi-env-letter').style.transform = stage.portrait ? 'translate3d(0, 0, 1px)' : 'translate3d(0, -92%, 1px)';
    q('.epi-env-letter').style.opacity = '0';
    q('.epi-env-seal').style.opacity = '0';
    q('.epi-env-seal-shadow').style.opacity = '0';
    q('.epi-env-stamp').style.opacity = '0';
    q('.epi-env-stamp-shadow').style.opacity = '0';
    q('.epi-env-postmark').style.opacity = '0';
    q('.epi-env-seal-l').style.opacity = '0';
    q('.epi-env-seal-r').style.opacity = '0';
}

/**
 * 封缄动画
 * @param {object} letter 信件
 * @param {object} opts { flyOut: 是否飞走（寄出）; 否则原地淡出（只存档） }
 */
export async function playSeal(letter, { flyOut = true, render } = {}) {
    if (reducedMotion()) return;
    const st = new Stage(letter, render);
    setInitial(st, { face: 'back' });
    st.mount();
    const q = st.q;
    const ease = { out: 'cubic-bezier(.2,.8,.2,1)', inOut: 'cubic-bezier(.55,.05,.35,1)', in: 'cubic-bezier(.55,0,.85,.4)' };

    try {
        // 1 登场
        st.play('.epi-env-backdrop', [{ opacity: 0 }, { opacity: 1 }], 300);
        // 注意：透明度只能做在 camera 上。3D 场景本身一旦有透明度，浏览器会把它压成平面，翻面就失效了
        st.play('.epi-env-camera', [{ opacity: 0 }, { opacity: 1 }], 380, 'ease-out');
        await st.play('.epi-env-scene', [
            { transform: T({ ...REST, y: '60px', s: 0.92 }) },
            { transform: T(REST) },
        ], 480, ease.out);

        // 2 信纸入封
        if (st.portrait) {
            // 竖版：信纸先在信封前面展开出现，下半张沿中线折上来，拿起来，从上方插进信封
            const W = st.W;
            const px = (y, z = 1, rz = 0) => `translate3d(0, ${y}px, ${z}px) rotateZ(${rz}deg)`;
            st.raise(true);
            st.zoom(true, 380);
            await st.play('.epi-env-letter', [
                { transform: px(-0.3 * W + 30, 1, 1), opacity: 0 },
                { transform: px(-0.3 * W, 1, 0), opacity: 1 },
            ], 380, 'ease-out');
            await st.wait(220);
            await st.fold(true, 700);
            await st.wait(120);
            await st.play('.epi-env-letter', [
                { transform: px(-0.3 * W, 1, 0) },
                { transform: px(-0.66 * W, 1, -1.5) },
            ], 420, ease.inOut);
            st.raise(false);
            st.zoom(false, 600);
            await st.play('.epi-env-letter', [
                { transform: px(-0.66 * W, 1, -1.5) },
                { transform: px(-0.3 * W, 1, 0.8), offset: 0.55 },
                { transform: px(0, 1, 0) },
            ], 700, ease.inOut);
        } else {
            // 横版：平放着从上方滑进去，带一点左右晃
            await st.play('.epi-env-letter', [
                { transform: 'translate3d(0, -92%, 1px) rotateZ(0deg)', opacity: 0 },
                { transform: 'translate3d(0, -92%, 1px) rotateZ(-1.5deg)', opacity: 1 },
            ], 260, 'ease-out');
            await st.play('.epi-env-letter', [
                { transform: 'translate3d(0, -92%, 1px) rotateZ(-1.5deg)', opacity: 1 },
                { transform: 'translate3d(0, -30%, 1px) rotateZ(0.8deg)', opacity: 1, offset: 0.55 },
                { transform: 'translate3d(0, 4%, 1px) rotateZ(0deg)', opacity: 1 },
            ], 760, ease.inOut);
        }

        // 3 翻盖合上：从上方翻过来，压平后轻轻弹起再落下
        // 翻盖合上：先立起来（此时在信纸后面），立到侧对镜头时换到信纸前面，再压下来，弹起一点再落下
        await st.play('.epi-env-flap', [
            { transform: 'rotateX(180deg)' },
            { transform: 'rotateX(90deg)' },
        ], 280, 'cubic-bezier(.5,0,.9,.6)');
        st.flapBehind(false);
        await st.play('.epi-env-flap', [
            { transform: 'rotateX(90deg)' },
            { transform: 'rotateX(0deg)', offset: 0.55 },
            { transform: 'rotateX(10deg)', offset: 0.75 },
            { transform: 'rotateX(0deg)' },
        ], 460, 'cubic-bezier(.2,.6,.35,1)');
        await st.thump(0.5);

        const kind = sealKind(letter);
        if (kind === 'chop') {
            // 朱印：一方红色的“缄”字印压下去，盖在翻盖和信封的接缝上
            q('.epi-env-seal').style.opacity = '1';
            await st.play('.epi-env-chop', [
                { transform: 'scale(1.8) rotate(-8deg)', opacity: 0 },
                { transform: 'scale(0.94) rotate(-3deg)', opacity: 0.95, offset: 0.7 },
                { transform: 'scale(1) rotate(-3deg)', opacity: 0.9 },
            ], 260, 'cubic-bezier(.55,0,.85,.4)');
            await st.thump(0.8);
            await st.wait(500);
        } else if (kind === 'none') {
            // 胶封：用手指沿着翻盖压一下
            await st.wait(300);
        } else {
        // 4 滴火漆：一团熔融的蜡鼓起来
        const seal = q('.epi-env-seal');
        seal.style.opacity = '1';
        q('.epi-env-seal-shadow').style.opacity = '1';
        await st.play('.epi-env-wax', [
            { transform: 'scale(0.15)', filter: 'brightness(1.35)' },
            { transform: 'scale(1.06)', filter: 'brightness(1.2)', offset: 0.7 },
            { transform: 'scale(1)', filter: 'brightness(1.15)' },
        ], 420, ease.out);

        // 5 印章从上方落下（沿 z 轴，越近桌面越小，影子越实）
        q('.epi-env-stamp').style.opacity = '1';
        q('.epi-env-stamp-shadow').style.opacity = '1';
        st.play('.epi-env-stamp-shadow', [
            { transform: 'translate(-50%, -50%) translateZ(3.6px) scale(1.8)', opacity: 0.05, filter: 'blur(14px)' },
            { transform: 'translate(-50%, -50%) translateZ(3.6px) scale(1)', opacity: 0.5, filter: 'blur(3px)' },
        ], 480, ease.in);
        await st.play('.epi-env-stamp', [
            { transform: 'translate(-50%, -50%) translateZ(340px) rotateZ(-8deg)', opacity: 0 },
            { transform: 'translate(-50%, -50%) translateZ(250px) rotateZ(-6deg)', opacity: 1, offset: 0.2 },
            { transform: 'translate(-50%, -50%) translateZ(8px) rotateZ(0deg)', opacity: 1 },
        ], 480, ease.in);

        // 6 接触：印章压扁一点，火漆向四周摊开，整个画面一震
        st.play('.epi-env-stamp', [
            { transform: 'translate(-50%, -50%) translateZ(8px) scale(1)' },
            { transform: 'translate(-50%, -50%) translateZ(4px) scale(1.04, 0.96)' },
        ], 90, 'ease-out');
        st.play('.epi-env-wax', [
            { transform: 'scale(1)', filter: 'brightness(1.15)' },
            { transform: 'scale(1.2)', filter: 'brightness(1)' },
        ], 120, 'ease-out');
        await st.thump(1);
        await st.wait(160);

        // 7 抬起：先被蜡粘住一下，再弹起离开；印痕显出来，蜡回弹到最终大小
        st.play('.epi-env-wax', [
            { transform: 'scale(1.2)' },
            { transform: 'scale(1.2, 1.24)', offset: 0.15 },
            { transform: 'scale(1.08)', offset: 0.45 },
            { transform: 'scale(1.13)', offset: 0.7 },
            { transform: 'scale(1.1)' },
        ], 620, 'ease-out');
        st.play('.epi-env-imprint', [{ opacity: 0 }, { opacity: 1 }], 260, 'ease-out', 80);
        st.play('.epi-env-stamp-shadow', [
            { transform: 'translate(-50%, -50%) translateZ(3.6px) scale(1)', opacity: 0.5, filter: 'blur(3px)' },
            { transform: 'translate(-50%, -50%) translateZ(3.6px) scale(2)', opacity: 0, filter: 'blur(16px)' },
        ], 520, ease.out, 60);
        await st.play('.epi-env-stamp', [
            { transform: 'translate(-50%, -50%) translateZ(4px) scale(1.04, 0.96)', opacity: 1 },
            { transform: 'translate(-50%, -50%) translateZ(14px) scale(1)', opacity: 1, offset: 0.15 },
            { transform: 'translate(-50%, -50%) translateZ(360px) rotateZ(6deg)', opacity: 0 },
        ], 560, 'cubic-bezier(.3,.7,.3,1)');
        st.play('.epi-env-wax-sheen', [
            { transform: 'translateX(-120%)', opacity: 0 },
            { transform: 'translateX(0%)', opacity: 1, offset: 0.5 },
            { transform: 'translateX(120%)', opacity: 0 },
        ], 700, 'ease-in-out');
        await st.wait(420);

        }

        // 8 翻到正面
        await st.flip('back', 'front', 820);

        // 9 盖邮戳
        await st.wait(160);
        q('.epi-env-postmark').style.opacity = '1';
        st.play('.epi-env-postmark', [
            { transform: 'rotate(-14deg) scale(1.7)', opacity: 0 },
            { transform: 'rotate(-14deg) scale(0.95)', opacity: 0.85, offset: 0.7 },
            { transform: 'rotate(-14deg) scale(1)', opacity: 0.8 },
        ], 240, ease.in);
        await st.wait(180);
        await st.thump(0.6);
        await st.wait(520);

        // 10 离场：寄出就飞走，只存档就原地淡出
        if (flyOut) {
            st.play('.epi-env-backdrop', [{ opacity: 1 }, { opacity: 0 }], 700, 'ease-in', 250);
            await st.play('.epi-env-scene', [
                { transform: T({ ...REST, ry: 180 }) },
                { transform: T({ rx: 8, ry: 180, rz: 4, y: '30px', s: 1.03 }), offset: 0.22 },
                { transform: T({ rx: 38, ry: 180, rz: -14, x: '6vw', y: '-120vh', s: 0.55 }) },
            ], 950, 'cubic-bezier(.5,0,.75,.35)');
        } else {
            st.play('.epi-env-backdrop', [{ opacity: 1 }, { opacity: 0 }], 450, 'ease-in');
            st.play('.epi-env-camera', [{ opacity: 1 }, { opacity: 0 }], 450, 'ease-in');
            await st.play('.epi-env-scene', [
                { transform: T({ ...REST, ry: 180 }) },
                { transform: T({ ...REST, ry: 180, y: '20px', s: 0.96 }) },
            ], 450, 'ease-in');
        }
    } finally {
        st.unmount();
    }
}

/**
 * 拆信动画。结束时信纸迎面放大、淡出，接着显示真正的阅读视图或写信页。
 */
export async function playOpen(letter, { render } = {}) {
    if (reducedMotion()) return;
    const st = new Stage(letter, render);
    setInitial(st, { face: 'front' });
    const q = st.q;
    // 拆信时，信是封好的：翻盖合上、火漆完整、邮戳已盖、信纸在里面
    q('.epi-env-flap').style.transform = 'rotateX(0deg)';
    st.flapBehind(false);
    q('.epi-env-letter').style.transform = st.portrait ? 'translate3d(0, 0, 1px)' : 'translate3d(0, 4%, 1px)';
    q('.epi-env-letter').style.opacity = '1';
    if (st.portrait) {
        q('.epi-env-half-bot').style.transform = 'rotateX(180deg)';
        q('.epi-env-half-bot').classList.add('folded');
    }
    if (sealKind(letter) === 'wax') {
        q('.epi-env-seal').style.opacity = '1';
        q('.epi-env-seal-shadow').style.opacity = '1';
        q('.epi-env-wax').style.transform = 'scale(1.1)';
        q('.epi-env-imprint').style.opacity = '1';
    } else if (sealKind(letter) === 'chop') {
        q('.epi-env-seal').style.opacity = '1';
        q('.epi-env-chop').style.opacity = '0.9';
        q('.epi-env-chop').style.transform = 'rotate(-3deg)';
    }
    q('.epi-env-postmark').style.opacity = '0.8';
    q('.epi-env-postmark').style.transform = 'rotate(-14deg)';
    st.mount();
    const ease = { out: 'cubic-bezier(.2,.8,.2,1)', inOut: 'cubic-bezier(.55,.05,.35,1)' };

    try {
        // 1 飞入：从右下方沿弧线飞来，途中转一下，落在桌面上
        st.play('.epi-env-backdrop', [{ opacity: 0 }, { opacity: 1 }], 400);
        await st.play('.epi-env-scene', [
            { transform: T({ rx: 40, ry: 180, rz: 28, x: '55vw', y: '65vh', s: 0.6 }) },
            { transform: T({ rx: 22, ry: 180, rz: -10, x: '16vw', y: '-8vh', s: 0.9 }), offset: 0.55 },
            { transform: T({ ...REST, ry: 180 }) },
        ], 1000, ease.out);
        await st.thump(0.4);

        // 2 看一眼地址和邮戳
        await st.wait(650);

        // 3 翻到背面
        await st.flip('front', 'back', 800);
        await st.wait(220);

        if (sealKind(letter) === 'chop') {
            // 朱印不会裂开：拆信时沿着接缝撕开，印也跟着淡出去
            await st.play('.epi-env-seal', [{ opacity: 1 }, { opacity: 0 }], 260, 'ease-in');
        } else if (sealKind(letter) === 'wax') {
        // 4 火漆裂开：先抖一下，再裂成两半掉下去
        await st.play('.epi-env-seal', [
            { transform: 'translate(-50%, -50%) translateZ(4px) rotateZ(0deg)' },
            { transform: 'translate(-50%, -50%) translateZ(4px) rotateZ(-4deg)', offset: 0.3 },
            { transform: 'translate(-50%, -50%) translateZ(4px) rotateZ(3deg)', offset: 0.65 },
            { transform: 'translate(-50%, -50%) translateZ(4px) rotateZ(0deg)' },
        ], 220, 'ease-in-out');
        q('.epi-env-seal').style.opacity = '0';
        q('.epi-env-seal-shadow').style.opacity = '0';
        q('.epi-env-seal-l').style.opacity = '1';
        q('.epi-env-seal-r').style.opacity = '1';
        st.play('.epi-env-seal-l', [
            { transform: 'translate(-50%, -50%) translateZ(4px) translate(0, 0) rotateZ(0deg)', opacity: 1 },
            { transform: 'translate(-50%, -50%) translateZ(30px) translate(-14px, -6px) rotateZ(-10deg)', opacity: 1, offset: 0.25 },
            { transform: 'translate(-50%, -50%) translateZ(4px) translate(-46px, 120px) rotateZ(-48deg)', opacity: 0 },
        ], 700, 'cubic-bezier(.4,0,.9,.5)');
        st.play('.epi-env-seal-r', [
            { transform: 'translate(-50%, -50%) translateZ(4px) translate(0, 0) rotateZ(0deg)', opacity: 1 },
            { transform: 'translate(-50%, -50%) translateZ(34px) translate(16px, -8px) rotateZ(12deg)', opacity: 1, offset: 0.25 },
            { transform: 'translate(-50%, -50%) translateZ(4px) translate(54px, 130px) rotateZ(56deg)', opacity: 0 },
        ], 760, 'cubic-bezier(.4,0,.9,.5)');
        await st.wait(260);

        }

        // 5 翻盖弹开：翻过头一点再弹回来（纸的折痕感）
        // 翻盖弹开：先加速立起来（在信纸前面），立到侧对镜头时换到信纸后面，
        // 继续翻过头一点再弹回平放（纸的折痕感）
        await st.play('.epi-env-flap', [
            { transform: 'rotateX(0deg)' },
            { transform: 'rotateX(90deg)' },
        ], 300, 'cubic-bezier(.5,0,.9,.6)');
        st.flapBehind(true);
        await st.play('.epi-env-flap', [
            { transform: 'rotateX(90deg)' },
            { transform: 'rotateX(197deg)', offset: 0.45 },
            { transform: 'rotateX(174deg)', offset: 0.72 },
            { transform: 'rotateX(183deg)', offset: 0.88 },
            { transform: 'rotateX(180deg)' },
        ], 620, 'cubic-bezier(.1,.5,.35,1)');

        if (st.portrait) {
            // 6 竖版：折着的信纸抽出来，拿到面前，展开，迎面而来
            const W = st.W;
            const px = (y, z = 1, rz = 0, sc = 1) => `translate3d(0, ${y}px, ${z}px) rotateZ(${rz}deg) scale(${sc})`;
            await st.play('.epi-env-letter', [
                { transform: px(0) },
                { transform: px(-0.66 * W, 1, -1) },
            ], 720, ease.out);
            st.raise(true);
            st.zoom(true, 460);
            await st.play('.epi-env-letter', [
                { transform: px(-0.66 * W, 1, -1) },
                { transform: px(-0.3 * W, 1, 0) },
            ], 460, ease.inOut);
            await st.wait(100);
            await st.fold(false, 760);
            await st.wait(260);
            const fade = ['.epi-env-back', '.epi-env-pocket', '.epi-env-flap'];
            fade.forEach(s => st.play(s, [{ opacity: 1 }, { opacity: 0 }], 420, 'ease-in'));
            st.play('.epi-env-backdrop', [{ opacity: 1 }, { opacity: 0 }], 600, 'ease-in', 200);
            await st.play('.epi-env-letter', [
                { transform: px(-0.3 * W, 1, 0, 1), opacity: 1 },
                { transform: px(-0.28 * W, 200, 0, 1.15), opacity: 1, offset: 0.7 },
                { transform: px(-0.27 * W, 320, 0, 1.22), opacity: 0 },
            ], 700, 'cubic-bezier(.4,0,.2,1)');
            return;
        }

        // 6 信纸升起
        await st.play('.epi-env-letter', [
            { transform: 'translate3d(0, 4%, 1px) rotateZ(0deg)' },
            { transform: 'translate3d(0, -78%, 1px) rotateZ(-1deg)' },
        ], 720, ease.out);
        await st.wait(160);

        // 7 信纸迎面而来，信封落下淡出
        const fade = ['.epi-env-back', '.epi-env-pocket', '.epi-env-flap'];
        fade.forEach(s => st.play(s, [{ opacity: 1 }, { opacity: 0 }], 420, 'ease-in'));
        st.play('.epi-env-backdrop', [{ opacity: 1 }, { opacity: 0 }], 600, 'ease-in', 200);
        await st.play('.epi-env-letter', [
            { transform: 'translate3d(0, -78%, 1px) rotateZ(-1deg) scale(1)', opacity: 1 },
            { transform: 'translate3d(0, -40%, 260px) rotateZ(0deg) scale(1.25)', opacity: 1, offset: 0.7 },
            { transform: 'translate3d(0, -30%, 380px) rotateZ(0deg) scale(1.35)', opacity: 0 },
        ], 700, 'cubic-bezier(.4,0,.2,1)');
    } finally {
        st.unmount();
    }
}
