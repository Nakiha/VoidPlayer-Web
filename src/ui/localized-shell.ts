import { onLanguageChange } from '../i18n.ts';

const attributes = ['aria-label', 'title', 'placeholder', 'data-tooltip'];
type Binding = { node: Node; index: number; attribute?: string; previous: string };
function nodes(root: Node) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
  const result: Node[] = [];
  while (walker.nextNode()) result.push(walker.currentNode);
  return result;
}
/**
 * Mount a language-independent shell once. On language changes, render an inert
 * template and patch its original text/attribute bindings only. Never replace live
 * elements, input values, media surfaces or event handlers. Dynamic owners refresh
 * their own labels; changed/replaced nodes are deliberately left to those owners.
 * Shell structure must not depend on the locale. There is no observer or frame work.
 */
export function mountLocalizedShell(root: HTMLElement, shell: () => string, signal?: AbortSignal) {
  root.innerHTML = shell();
  const bindings: Binding[] = [];
  nodes(root).forEach((node, index) => {
    if (node.nodeType === Node.TEXT_NODE && node.nodeValue?.trim()) bindings.push({ node, index, previous: node.nodeValue });
    if (node instanceof Element) for (const attribute of attributes) {
      const value = node.getAttribute(attribute);
      if (value) bindings.push({ node, index, attribute, previous: value });
    }
  });
  return onLanguageChange(() => {
    const template = document.createElement('template'); template.innerHTML = shell();
    const translated = nodes(template.content);
    for (const binding of bindings) {
      const { node, index, attribute, previous } = binding;
      const nextNode = translated[index];
      if (!nextNode || nextNode.nodeType !== node.nodeType || nextNode.nodeName !== node.nodeName) throw new Error('Localized shell structure changed');
      const next = attribute ? (nextNode as Element).getAttribute(attribute) : nextNode.nodeValue;
      const current = attribute ? (node as Element).getAttribute(attribute) : node.nodeValue;
      if (next !== null && root.contains(node) && current === previous && next !== current) {
        if (attribute) (node as Element).setAttribute(attribute, next); else node.nodeValue = next;
      }
      binding.previous = next ?? previous;
    }
  }, signal);
}
