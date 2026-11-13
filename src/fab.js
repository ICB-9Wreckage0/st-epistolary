// 书信簿 · 悬浮按钮
// 深炭灰的扁平圆形按钮，一道浅香槟金细环，中间一枚单色信封。
// 点一下打开 / 收起书信簿；按住拖动可以挪到屏幕任何地方（位置会记住）。

const SIZE = 58;
const DRAG_THRESHOLD = 5;

// 实心的几何信封：信封身 + 翻盖 V 形折线，统一暖灰金
const ICON = `
<svg class="epi-fab-icon" viewBox="4.4 8.4 23.2 16.2" aria-hidden="true">
    <rect x="5" y="9" width="22" height="15" rx="2.2" fill="#cbb991"/>
    <path d="M5.9 10.4 16 17.6l10.1-7.2" fill="none" stroke="#2a2825" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round" opacity=".72"/>
    <path d="M6.2 22.6 13 16.6M25.8 22.6 19 16.6" fill="none" stroke="#2a2825" stroke-width="1.1" stroke-linecap="round" opacity=".38"/>
</svg>`;

export class Fab {
    // getPos / setPos：读写保存的位置 { right, bottom }（离右下角的距离，窗口大小变了也不会跑出屏幕）
    constructor({ onClick, getPos, setPos, title = '书信簿' }) {
        this.onClick = onClick;
        this.getPos = getPos;
        this.setPos = setPos;
        const el = document.createElement('button');
        el.type = 'button';
        el.className = 'epi-fab';
        el.title = title;
        el.setAttribute('aria-label', title);
        el.innerHTML = `<span class="epi-fab-face">${ICON}</span>`;
        this.el = el;
        document.body.appendChild(el);
        this.place(this.getPos?.() || null);
        this.bindDrag();
        this.onResize = () => this.place(this.current);
        window.addEventListener('resize', this.onResize);
    }

    // 放到 { right, bottom } 处，夹在屏幕里
    place(pos) {
        const vw = window.innerWidth, vh = window.innerHeight;
        const size = this.el.offsetWidth || SIZE;
        const right = Math.min(Math.max(8, pos?.right ?? 24), Math.max(8, vw - size - 8));
        const bottom = Math.min(Math.max(8, pos?.bottom ?? 120), Math.max(8, vh - size - 8));
        this.current = { right, bottom };
        this.el.style.right = `${right}px`;
        this.el.style.bottom = `${bottom}px`;
    }

    bindDrag() {
        let start = null;
        const down = e => {
            if (e.button != null && e.button !== 0) return;
            start = { x: e.clientX, y: e.clientY, right: this.current.right, bottom: this.current.bottom, moved: false };
            this.el.setPointerCapture?.(e.pointerId);
            this.el.classList.add('pressed');
        };
        const move = e => {
            if (!start) return;
            const dx = e.clientX - start.x, dy = e.clientY - start.y;
            if (!start.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
            start.moved = true;
            this.el.classList.add('dragging');
            this.place({ right: start.right - dx, bottom: start.bottom - dy });
            e.preventDefault();
        };
        const up = e => {
            if (!start) return;
            const moved = start.moved;
            start = null;
            this.el.classList.remove('pressed', 'dragging');
            this.el.releasePointerCapture?.(e.pointerId);
            if (moved) this.setPos?.(this.current);
            else this.onClick?.();
        };
        this.el.addEventListener('pointerdown', down);
        this.el.addEventListener('pointermove', move);
        this.el.addEventListener('pointerup', up);
        this.el.addEventListener('pointercancel', () => { start = null; this.el.classList.remove('pressed', 'dragging'); });
        // 键盘：回车 / 空格照常打开
        this.el.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.onClick?.(); } });
        this.el.addEventListener('click', e => e.preventDefault()); // 点击由 pointerup 处理，免得拖完又触发一次
    }

    setVisible(on) { this.el.hidden = !on; }
    setActive(on) { this.el.classList.toggle('active', !!on); }

    destroy() {
        window.removeEventListener('resize', this.onResize);
        this.el.remove();
    }
}
