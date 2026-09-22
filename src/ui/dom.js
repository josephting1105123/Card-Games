/** Small DOM helpers. Deliberately tiny: no framework, no build step. */

/**
 * @param {string} tag  'div', or 'div.card.is-open', or 'button#play.primary'
 * @param {object|string|Node|Array} [props] attributes, or children when it is a
 *        string, Node or array
 * @param {...(string|Node|null|undefined)} children
 */
export function el(tag, props, ...children) {
  const [name, ...rest] = tag.split(/(?=[.#])/);
  const node = document.createElement(name || 'div');
  for (const token of rest) {
    if (token.startsWith('.')) node.classList.add(token.slice(1));
    else if (token.startsWith('#')) node.id = token.slice(1);
  }
  if (props && (typeof props === 'string' || props instanceof Node || Array.isArray(props))) {
    children.unshift(props);
  } else if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value == null || value === false) continue;
      if (key === 'class') node.className += ` ${value}`;
      else if (key === 'html') node.innerHTML = value;
      else if (key === 'text') node.textContent = value;
      else if (key === 'dataset') Object.assign(node.dataset, value);
      else if (key === 'style') node.style.cssText += value;
      else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value === true ? '' : String(value));
    }
  }
  append(node, children);
  return node;
}

export function append(node, children) {
  for (const child of children.flat(4)) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

export function $(selector, root = document) {
  return root.querySelector(selector);
}

export function $$(selector, root = document) {
  return [...root.querySelectorAll(selector)];
}

export function button(label, onclick, opts = {}) {
  return el('button.btn', { type: 'button', onclick, ...opts }, label);
}

/** requestAnimationFrame-based delay that also works when the tab is hidden. */
export function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Announce something to screen readers without changing the layout. */
export function announce(message) {
  let live = document.getElementById('cg-live');
  if (!live) {
    live = el('div#cg-live', { 'aria-live': 'polite', class: 'sr-only' });
    document.body.appendChild(live);
  }
  live.textContent = message;
}

/** A labelled numeric/select field for the room settings form. */
export function field(label, control, hint) {
  return el('label.field', el('span.field__label', label), control, hint ? el('span.field__hint', hint) : null);
}

export function numberInput(id, value, { min = 0, max = 1e12, step = 1 } = {}) {
  return el('input.input', { id, type: 'number', value: String(value), min, max, step, inputmode: 'numeric' });
}

export function select(id, options, value) {
  const node = el('select.input', { id });
  for (const option of options) {
    node.append(el('option', { value: option.value, selected: option.value === value }, option.label));
  }
  return node;
}
