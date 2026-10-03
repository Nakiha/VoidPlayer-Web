import test from 'node:test';
import assert from 'node:assert/strict';
import { Viewport } from '../../src/viewport.ts';
import { installViewportGestures } from '../../src/ui/viewport-gestures.ts';

class ElementStub extends EventTarget {
  style: Record<string, string> = {};
  classList = { contains: () => false };
  hidden = false;
  onclick: ((event: MouseEvent) => void) | null = null;
  setPointerCapture() {}
  setAttribute() {}
  closest() { return null; }
}

class DocumentStub extends EventTarget {
  querySelectorAll() { return []; }
  querySelector() { return null; }
}

test('right-drag batches move work per animation frame and suppresses page menus through release', t => {
  const oldDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const oldRaf = globalThis.requestAnimationFrame;
  const oldCancelRaf = globalThis.cancelAnimationFrame;
  const documentStub = new DocumentStub();
  Object.defineProperty(globalThis, 'document', { configurable: true, value: documentStub });
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
    session: { getState: () => ({ tracks: [{ slot: 'A' }] }) } as never,
    getTrigger: () => 'test',
    applyViewTransform: () => { transformUpdates++; },
    syncSplitGeometry() {},
    syncZoomSelect() {},
    render() {},
  });

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
  pointer('pointermove', 14, 21);
  pointer('pointermove', 25, 25);
  pointer('pointermove', 40, 30);
  assert.equal(transformUpdates, 0, 'pointer bursts wait for the next frame');
  assert.deepEqual([viewport.offsetX, viewport.offsetY], [0, 0]);
  runNextFrame();
  assert.equal(transformUpdates, 1, 'the burst produces one transform update for the frame');
  assert.deepEqual([viewport.offsetX, viewport.offsetY], [30, 10]);

  pointer('pointermove', 43, 31);
  pointer('pointermove', 47, 34);
  pointer('pointerup', 47, 34);
  assert.equal(transformUpdates, 2, 'release flushes the pending movement once');
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
