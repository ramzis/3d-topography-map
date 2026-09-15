// drone-style virtual joystick: a glass base with a knob that follows the
// finger and springs back on release. Reports analog x/y in [-1, 1]
// (screen-space: positive y = down).

export class VirtualStick {
  constructor({ className = '' } = {}) {
    this.x = 0;
    this.y = 0;
    this.onChange = null;

    const el = (this.el = document.createElement('div'));
    el.className =
      'joystick glass fixed z-30 rounded-full touch-none select-none cursor-pointer ' +
      'flex items-center justify-center ' + className;
    el.style.width = el.style.height = '112px';

    const knob = (this.knob = document.createElement('div'));
    knob.className =
      'w-12 h-12 rounded-full border border-white/30 bg-white/25 ' +
      'backdrop-blur-md transition-transform duration-150 will-change-transform';
    el.appendChild(knob);

    let active = false;
    const R = 48; // full deflection distance from the grab point
    const DEAD = 6; // dead zone so a resting thumb doesn't drift

    // relative/floating stick: the axes are the displacement from where the
    // finger grabbed, so speed is proportional to how far the controller is
    // pushed — never how far from the visual center you happened to touch
    let startX = 0, startY = 0;
    const set = (cx, cy) => {
      let dx = cx - startX;
      let dy = cy - startY;
      const len = Math.hypot(dx, dy);
      if (len > R) { dx = (dx / len) * R; dy = (dy / len) * R; }
      let nx = dx / R, ny = dy / R;
      if (Math.hypot(nx, ny) < DEAD / R) { nx = 0; ny = 0; }
      knob.style.transform = `translate(${dx}px, ${dy}px)`;
      this.x = nx;
      this.y = ny;
      this.onChange?.(this.x, this.y);
    };

    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      active = true;
      el.setPointerCapture(e.pointerId);
      startX = e.clientX;
      startY = e.clientY;
      knob.classList.remove('transition-transform'); // raw tracking while held
    });
    el.addEventListener('pointermove', (e) => {
      if (active) set(e.clientX, e.clientY);
    });
    const release = () => {
      if (!active) return;
      active = false;
      this.x = this.y = 0;
      knob.classList.add('transition-transform'); // spring back
      knob.style.transform = 'translate(0px, 0px)';
      this.onChange?.(0, 0);
    };
    el.addEventListener('pointerup', release);
    el.addEventListener('pointercancel', release);
    el.addEventListener('contextmenu', (e) => e.preventDefault());

    document.body.appendChild(el);
  }

  destroy() {
    this.el.remove();
  }
}
