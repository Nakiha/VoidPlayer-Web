import test from 'node:test';
import assert from 'node:assert/strict';
import { Viewport } from '../../shared/presentation/viewport.ts';
import { installViewportGestures } from '../../src/ui/viewport-gestures.ts';

class ElementStub extends EventTarget {
  style: Record<string, string> = {};
  classList = { contains: () => false };
  hidden = false;
  onclick: ((event: MouseEvent) => void) | null = null;
  captured = new Set<number>();
  setPointerCapture(id: number) { this.captured.add(id); }
  hasPointerCapture(id: number) { return this.captured.has(id); }
  releasePointerCapture(id: number) { this.captured.delete(id); }
  setAttribute() {}
  closest() { return null; }
}

class DocumentStub extends EventTarget {
  documentElement = { classList: { add() {}, remove() {} } };
  querySelectorAll() { return []; }
  querySelector() { return null; }
}

test('right-drag starts immediately, batches later moves and suppresses page menus through release', t => {
  const { documentStub, frames, viewport, elements, updates } = gestureFixture(t);
  const stage = elements.get('stage-A')!;
  function pointer(type: string, x: number, y: number) {
    const event = Object.assign(new Event(type, { cancelable: true }), {
      pointerId: 1, button: 2, clientX: x, clientY: y,
    });
    stage.dispatchEvent(event);
    return event;
  }
  function runNextFrame() {
    const entry = frames.entries().next().value as [number, FrameRequestCallback] | undefined;
    assert.ok(entry, 'a pan frame was scheduled');
    frames.delete(entry[0]);
    entry[1](16);
  }

  const menuBeforePan = new Event('contextmenu', { cancelable: true });
  documentStub.dispatchEvent(menuBeforePan);
  assert.equal(menuBeforePan.defaultPrevented, false, 'unrelated page context menus remain available');

  pointer('pointerdown', 10, 20);
  assert.equal(stage.hasPointerCapture(1), true, 'the viewport owns the drag without an overlay');
  pointer('pointermove', 10, 20);
  assert.equal(updates(), 0, 'zero movement does not start the drag');
  assert.equal(frames.size, 0);
  pointer('pointermove', 14, 21);
  assert.equal(updates(), 1, 'the first movement updates without waiting for a frame');
  assert.equal(frames.size, 0);
  pointer('pointermove', 25, 25);
  pointer('pointermove', 40, 30);
  assert.equal(updates(), 1, 'subsequent bursts wait for the next frame');
  assert.deepEqual([viewport.offsetX, viewport.offsetY], [4, 1]);
  runNextFrame();
  assert.equal(updates(), 2, 'the burst produces one transform update for the frame');
  assert.deepEqual([viewport.offsetX, viewport.offsetY], [30, 10]);

  pointer('pointermove', 43, 31);
  pointer('pointermove', 47, 34);
  pointer('pointerup', 47, 34);
  assert.equal(stage.hasPointerCapture(1), false, 'release returns pointer ownership');
  assert.equal(updates(), 3, 'release flushes the pending movement once');
  assert.deepEqual([viewport.offsetX, viewport.offsetY], [37, 14]);

  // In a browser this event bubbles from the sidebar to document; dispatching
  // on the stub document exercises the document-level capture guard.
  const menuOnSidebar = new Event('contextmenu', { cancelable: true });
  documentStub.dispatchEvent(menuOnSidebar);
  assert.equal(menuOnSidebar.defaultPrevented, true, 'a menu after pointerup is still suppressed');
  const nextMenu = new Event('contextmenu', { cancelable: true });
  documentStub.dispatchEvent(nextMenu);
  assert.equal(nextMenu.defaultPrevented, false, 'suppression ends after consuming the drag menu');

  pointer('pointerdown', 10, 20);
  pointer('pointermove', 11, 21);
  pointer('pointerup', 11, 21);
  documentStub.dispatchEvent(new Event('pointerdown'));
  const menuAfterNewInteraction = new Event('contextmenu', { cancelable: true });
  documentStub.dispatchEvent(menuAfterNewInteraction);
  assert.equal(menuAfterNewInteraction.defaultPrevented, false, 'an unrelated interaction clears an unused guard');
});

function gestureFixture(t: test.TestContext, annotationActive = () => false, cancelAnnotationGesture = () => {}) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const oldDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const oldRaf = globalThis.requestAnimationFrame;
  const oldCancelRaf = globalThis.cancelAnimationFrame;
  const documentStub = new DocumentStub();
  Object.defineProperty(globalThis, 'document', { configurable: true, value: documentStub });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: new EventTarget() });
  let nextFrame = 1;
  const frames = new Map<number, FrameRequestCallback>();
  globalThis.requestAnimationFrame = callback => {
    const id = nextFrame++;
    frames.set(id, callback);
    return id;
  };
  globalThis.cancelAnimationFrame = id => { frames.delete(id); };
  t.after(() => {
    globalThis.requestAnimationFrame = oldRaf;
    globalThis.cancelAnimationFrame = oldCancelRaf;
    if (oldDocument) Object.defineProperty(globalThis, 'document', oldDocument);
    else Reflect.deleteProperty(globalThis, 'document');
    if (oldWindow) Object.defineProperty(globalThis, 'window', oldWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  });

  const elements = new Map<string, ElementStub>();
  for (const slot of ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']) elements.set(`stage-${slot}`, new ElementStub());
  elements.set('divider', new ElementStub());
  elements.set('arrangement', new ElementStub());
  const screens = new ElementStub();
  const viewport = new Viewport();
  let transformUpdates = 0;
  installViewportGestures({
    $: <T extends Element = HTMLElement>(id: string) => elements.get(id) as unknown as T,
    screens: screens as unknown as HTMLElement,
    viewport,
    session: { trackCount: 1 } as never,
    zoomAnchor: (_target, x, y) => ({ x, y }),
    getTrigger: () => 'test',
    wheelBehavior: () => 'auto',
    applyViewTransform: () => { transformUpdates++; },
    syncSplitGeometry() {},
    syncZoomSelect() {},
    render() {},
    annotationActive, cancelAnnotationGesture,
  });

  return { documentStub, frames, viewport, elements, screens, updates: () => transformUpdates };
}

test('touch pan and pinch preserve the midpoint anchor and rebase after a finger lifts', t => {
  const { viewport, screens, elements } = gestureFixture(t);
  const send = touchSender(screens, elements.get('stage-A')!);
  send('pointerdown', 1, 10, 20);
  send('pointermove', 1, 30, 50);
  send('pointerup', 1, 30, 50);
  assert.deepEqual([viewport.offsetX, viewport.offsetY], [20, 30]);
  viewport.reset();
  send('pointerdown', 1, 100, 100);
  send('pointerdown', 2, 200, 100);
  send('pointermove', 2, 300, 100);
  send('pointerup', 2, 300, 100);
  assert.equal(viewport.zoom, 2);
  assert.deepEqual([viewport.offsetX, viewport.offsetY], [-100, -100]);
  send('pointermove', 1, 110, 120);
  send('pointercancel', 1, 110, 120);
  assert.deepEqual([viewport.offsetX, viewport.offsetY], [-90, -80]);
  send('pointerdown', 3, 50, 50);
  send('pointerup', 3, 50, 50);
  assert.deepEqual([viewport.offsetX, viewport.offsetY], [-90, -80], 'a new contact does not jump');
});

test('annotation single touch is delegated, pinch cancels the stroke and reserves remaining contacts', t => {
  let cancelled = 0;
  const { viewport, screens, elements } = gestureFixture(t, () => true, () => { cancelled++; });
  const send = touchSender(screens, elements.get('stage-A')!);
  assert.equal(send('pointerdown', 1, 100, 100).defaultPrevented, false);
  assert.equal(send('pointermove', 1, 120, 100).defaultPrevented, false);
  assert.equal(viewport.offsetX, 0);
  assert.equal(send('pointerdown', 2, 220, 100).defaultPrevented, true);
  assert.equal(cancelled, 1);
  send('pointermove', 2, 320, 100);
  send('pointerup', 2, 320, 100);
  const before = viewport.snapshot();
  assert.equal(send('pointermove', 1, 150, 130).defaultPrevented, true);
  assert.deepEqual(viewport.snapshot(), before, 'remaining contact cannot draw or pan');
  send('lostpointercapture', 1, 150, 130);
  assert.equal(send('pointerdown', 3, 100, 100).defaultPrevented, false, 'the next gesture can annotate');
  send('pointercancel', 3, 100, 100);
});

function touchSender(screens: ElementStub, stage: ElementStub) {
  stage.closest = ((selector: string) => selector === '.frame-stage' ? stage : null) as typeof stage.closest;
  return (type: string, pointerId: number, clientX: number, clientY: number) => {
    const event = Object.assign(new Event(type, { cancelable: true }), { pointerId, pointerType: 'touch', clientX, clientY, button: 0 });
    Object.defineProperty(event, 'target', { value: stage });
    screens.dispatchEvent(event);
    return event;
  };
}

test('two-finger translation does not accumulate zoom drift at either zoom limit', t => {
  const { viewport, screens, elements } = gestureFixture(t);
  const send = touchSender(screens, elements.get('stage-A')!);
  for (const zoom of [1, 500]) {
    viewport.apply({ zoom, offsetX: 30, offsetY: 40 });
    send('pointerdown', 1, 100, 100);
    send('pointerdown', 2, 200, 100);
    send('pointermove', 1, 110, 120);
    send('pointermove', 2, 210, 120);
    send('pointerup', 1, 110, 120);
    send('pointerup', 2, 210, 120);
    assert.equal(viewport.zoom, zoom, 'separate pointer events must preserve the pair scale');
    assert.deepEqual([viewport.offsetX, viewport.offsetY], [40, 60]);
  }
});
