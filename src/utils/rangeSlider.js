// Two native range inputs stacked on one track make a min–max slider. The inputs keep
// keyboard and screen-reader support; pointer input (mouse, pen, touch) is handled on the
// wrapper so the handle nearest the finger moves, even when both handles overlap.

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

// Value under a pointer at `x` px from the track's left edge. Native range thumbs travel
// from thumb/2 to width - thumb/2, so the usable span is width - thumb.
export function valueAtPosition(x, width, thumb, { min = 0, max = 1, step = 0.01 } = {}) {
  const span = Math.max(1, width - thumb),
    fraction = clamp((x - thumb / 2) / span, 0, 1),
    raw = min + fraction * (max - min),
    steps = Math.round((raw - min) / step);
  return clamp(Number((min + steps * step).toFixed(10)), min, max);
}

// Which handle a press at `value` grabs: the nearer one. When both handles sit on the same
// value, the press side decides; a press right on them returns null so the first move
// (left or right) can decide instead.
export function pickHandle(value, low, high, tolerance = 0) {
  if (low !== high) return Math.abs(value - low) <= Math.abs(value - high) ? 'low' : 'high';
  if (value < low - tolerance) return 'low';
  if (value > high + tolerance) return 'high';
  return null;
}

export function mountRangeSlider(wrapper, onChange) {
  const [low, high] = wrapper.querySelectorAll('input[type="range"]'),
    limits = { min: Number(low.min), max: Number(low.max), step: Number(low.step) || 0.01 },
    percent = (v) => Math.round(v * 100) + '%';

  const paint = () => {
    const span = limits.max - limits.min;
    wrapper.style.setProperty('--low', (Number(low.value) - limits.min) / span);
    wrapper.style.setProperty('--high', (Number(high.value) - limits.min) / span);
    low.setAttribute('aria-valuetext', percent(Number(low.value)));
    high.setAttribute('aria-valuetext', percent(Number(high.value)));
  };
  // Keep low <= high whichever handle (or key) moved.
  low.addEventListener('input', () => {
    if (Number(low.value) > Number(high.value)) low.value = high.value;
    paint();
    onChange();
  });
  high.addEventListener('input', () => {
    if (Number(high.value) < Number(low.value)) high.value = low.value;
    paint();
    onChange();
  });

  let active = null,
    pending = null;
  const geometry = () => {
    const rect = low.getBoundingClientRect(),
      thumb = parseFloat(getComputedStyle(wrapper).getPropertyValue('--thumb')) || 20;
    return { rect, thumb };
  };
  const valueAt = (event) => {
    const { rect, thumb } = geometry();
    return valueAtPosition(event.clientX - rect.left, rect.width, thumb, limits);
  };
  const move = (input, value) => {
    if (Number(input.value) === value) return;
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };

  wrapper.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || low.disabled) return;
    const value = valueAt(event),
      { rect, thumb } = geometry(),
      tolerance = ((thumb / 2) * (limits.max - limits.min)) / Math.max(1, rect.width - thumb);
    const handle = pickHandle(value, Number(low.value), Number(high.value), tolerance);
    active = handle === 'low' ? low : handle === 'high' ? high : null;
    pending = active ? null : value;
    wrapper.setPointerCapture(event.pointerId);
    event.preventDefault();
    (active || high).focus({ preventScroll: true });
    if (active) move(active, value);
  });
  wrapper.addEventListener('pointermove', (event) => {
    if (!wrapper.hasPointerCapture(event.pointerId)) return;
    const value = valueAt(event);
    if (!active) {
      if (value === pending) return;
      active = value < pending ? low : high;
      active.focus({ preventScroll: true });
    }
    move(active, value);
  });
  const release = () => {
    active = null;
    pending = null;
  };
  wrapper.addEventListener('pointerup', release);
  wrapper.addEventListener('pointercancel', release);

  paint();
  return { paint };
}
