// Отрисовка без фреймворка: страница каждый раз строится заново функцией h(),
// а morph() переносит отличия в живой DOM. Живые узлы не пересоздаются —
// открытый список режимов, прокрутка, плавные переходы цвета у плиток
// переживают обновление состояния дома.

import { ICONS } from './icons.js';

/** h('div.card.on', {data-act: 'x'}, ...children). Атрибуты — строки; false/null пропускаются. */
export function h(tag, attrs, ...children) {
  if (attrs == null || typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs)) {
    children.unshift(attrs);
    attrs = {};
  }
  const [name, ...classes] = tag.split('.');
  const el = document.createElement(name || 'div');
  const cls = classes.concat(attrs.class ? String(attrs.class).split(' ') : []).filter(Boolean);
  if (cls.length) el.className = cls.join(' ');
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'class' || value == null || value === false) continue;
    el.setAttribute(key, value === true ? '' : String(value));
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const child of children) {
    if (child == null || child === false) continue;
    if (Array.isArray(child)) append(el, child);
    else el.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

/** Значок из icons.js; неизвестный — пустой, а не падение страницы. */
export function icon(name, cls = '') {
  const span = document.createElement('span');
  span.className = ('ic ' + cls).trim();
  span.setAttribute('data-icon', name);
  span.innerHTML = ICONS[name] || '';
  return span;
}

/** Переносит new в old: те же узлы остаются, меняются атрибуты, текст и дети. */
export function morph(oldEl, newEl) {
  if (oldEl.nodeType !== newEl.nodeType || oldEl.nodeName !== newEl.nodeName || keyOf(oldEl) !== keyOf(newEl)) {
    oldEl.replaceWith(newEl);
    return newEl;
  }
  if (oldEl.nodeType === Node.TEXT_NODE) {
    if (oldEl.nodeValue !== newEl.nodeValue) oldEl.nodeValue = newEl.nodeValue;
    return oldEl;
  }
  if (oldEl.nodeType !== Node.ELEMENT_NODE) return oldEl;
  // Значок с тем же именем не трогаем: SVG внутри одинаковый.
  if (oldEl.hasAttribute('data-icon') && oldEl.getAttribute('data-icon') === newEl.getAttribute('data-icon')) {
    syncAttrs(oldEl, newEl);
    return oldEl;
  }
  syncAttrs(oldEl, newEl);
  if (oldEl.nodeName === 'SELECT') {
    // Список, который сейчас открыт пальцем, не перестраиваем — iPad его закроет.
    if (document.activeElement !== oldEl) {
      oldEl.innerHTML = newEl.innerHTML;
      oldEl.value = newEl.getAttribute('data-value') ?? '';
    }
    return oldEl;
  }
  morphChildren(oldEl, newEl);
  return oldEl;
}

function keyOf(el) {
  return el.nodeType === Node.ELEMENT_NODE ? el.getAttribute('data-key') : null;
}

function syncAttrs(oldEl, newEl) {
  for (const { name } of [...oldEl.attributes]) {
    if (!newEl.hasAttribute(name)) oldEl.removeAttribute(name);
  }
  for (const { name, value } of [...newEl.attributes]) {
    if (oldEl.getAttribute(name) !== value) oldEl.setAttribute(name, value);
  }
  if ('disabled' in oldEl) oldEl.disabled = newEl.hasAttribute('disabled');
}

function morphChildren(oldEl, newEl) {
  const fresh = [...newEl.childNodes];
  const keyed = new Map();
  for (const child of oldEl.childNodes) {
    const key = keyOf(child);
    if (key != null) keyed.set(key, child);
  }
  let cursor = oldEl.firstChild;
  for (const next of fresh) {
    const key = keyOf(next);
    let match = null;
    if (key != null) {
      match = keyed.get(key) || null;
      keyed.delete(key);
    } else if (cursor && keyOf(cursor) == null) {
      match = cursor;
    }
    if (match) {
      if (match !== cursor) oldEl.insertBefore(match, cursor);
      else cursor = cursor.nextSibling;
      morph(match, next);
    } else {
      oldEl.insertBefore(next, cursor);
    }
  }
  while (cursor) {
    const after = cursor.nextSibling;
    cursor.remove();
    cursor = after;
  }
}
