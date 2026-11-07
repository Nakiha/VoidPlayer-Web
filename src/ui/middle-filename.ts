// Keep the full text in the row for tooltips, selection and accessible names.
// Only the painted label changes when the column or the font changes size.
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const observer = new ResizeObserver(entries => {
  const labels = new Set<MiddleFilename>();
  for (const {target} of entries) {
    const label = target instanceof MiddleFilename ? target : (target.getRootNode() as ShadowRoot).host;
    if (label instanceof MiddleFilename) labels.add(label);
  }
  // Measure the whole batch before writing, including during a divider drag.
  const fitted = Array.from(labels, label => [label, label.abbreviate()] as const);
  for (const [label, display] of fitted) label.display(display);
});

function fitCount(limit: number, fits: (n: number) => boolean) {
  let low = 0, high = limit;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (fits(mid)) low = mid; else high = mid - 1;
  }
  return low;
}

class MiddleFilename extends HTMLElement {
  private original: HTMLSpanElement;
  private marker: HTMLSpanElement;

  constructor() {
    super();
    const root = this.attachShadow({mode:'open'});
    root.innerHTML = `<style>
      span { grid-area: 1 / 1; justify-self: start; width: max-content; white-space: pre; }
      :host([data-display]) .original, .marker { visibility: hidden; }
      .marker::before { content: '…'; }
    </style><span class="original"><slot></slot></span><span class="marker" aria-hidden="true"></span>`;
    this.original = root.querySelector('.original')!;
    this.marker = root.querySelector('.marker')!;
    // A replacement name can have exactly the same width as the old one.
    root.querySelector('slot')!.addEventListener('slotchange', () => {
      if (this.isConnected) this.display(this.abbreviate());
    });
  }
  connectedCallback() {
    observer.observe(this);
    observer.observe(this.original);
  }
  disconnectedCallback() {
    observer.unobserve(this);
    observer.unobserve(this.original);
  }
  display(value: string | undefined) {
    if (this.dataset.display === value) return;
    if (value === undefined) this.removeAttribute('data-display');
    else this.dataset.display = value;
  }
  abbreviate() {
    const width = this.getBoundingClientRect().width;
    if (!width || this.original.getBoundingClientRect().width <= width) return;
    const node = this.firstChild;
    if (!(node instanceof Text) || !node.length) return;
    const name = node.data;
    const ends = [0, ...Array.from(segmenter.segment(name), part => part.index + part.segment.length)];
    const count = ends.length - 1;
    const budget = width - this.marker.getBoundingClientRect().width;
    const range = document.createRange();
    const measure = (from: number, to: number) => {
      range.setStart(node, ends[from]);
      range.setEnd(node, ends[to]);
      return range.getBoundingClientRect().width;
    };
    // First divide the space by rendered width, then give spare pixels to the
    // tail. Reserve the extension whenever it fits beside the first grapheme.
    const dot = name.lastIndexOf('.');
    const dotIndex = ends.indexOf(dot);
    const extension = dotIndex > 0 && dot < name.length - 1 ? measure(dotIndex, count) : 0;
    const headBudget = Math.max(measure(0, 1), Math.min(budget / 2, budget - extension));
    const head = fitCount(count - 1, n => measure(0, n) <= Math.min(budget, headBudget));
    const headWidth = measure(0, head);
    const tail = fitCount(count - head - 1, n => measure(count - n, count) <= budget - headWidth);
    return name.slice(0, ends[head]) + '…' + name.slice(ends[count - tail]);
  }
}
customElements.define('middle-filename', MiddleFilename);

export function createMiddleFilename(name: string) {
  const label = document.createElement('middle-filename');
  label.className = 'filename';
  label.textContent = name;
  return label;
}
