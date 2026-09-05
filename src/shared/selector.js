// AutoFetcher 四層選擇器：產生與解析
// 計算元素在同層同標籤兄弟節點中的序號（從 1 起算）
function getTagIndex(element) {
  let index = 1;
  let sibling = element.previousElementSibling;
  const tag = element.tagName.toLowerCase();
  while (sibling) {
    if (sibling.tagName.toLowerCase() === tag) index++;
    sibling = sibling.previousElementSibling;
  }
  return index;
}

// 取得從 html 節點至目標元素的結構路徑節點陣列
function getHierarchy(el) {
  const chain = [];
  let curr = el;
  while (curr && curr.nodeType === 1) {
    chain.unshift({ tag: curr.tagName.toLowerCase(), index: getTagIndex(curr) });
    if (curr.tagName.toLowerCase() === 'html') break;
    curr = curr.parentElement;
  }
  return chain;
}

// 解析並走訪 xpath 路徑
function resolveXPath(doc, xpath) {
  if (!xpath || typeof xpath !== 'string') return null;
  const segments = xpath.split('/').filter(Boolean);
  if (segments.length === 0) return null;

  const parsed = [];
  for (const seg of segments) {
    const match = seg.match(/^([a-zA-Z0-9-]+)\[(\d+)\]$/);
    if (!match) return null;
    parsed.push({ tag: match[1].toLowerCase(), i: parseInt(match[2], 10) });
  }

  let curr = doc.documentElement;
  if (!curr || curr.tagName.toLowerCase() !== parsed[0].tag || parsed[0].i !== 1) return null;

  for (let step = 1; step < parsed.length; step++) {
    const { tag, i } = parsed[step];
    let count = 0;
    let next = null;
    for (const child of curr.children) {
      if (child.tagName.toLowerCase() === tag && ++count === i) {
        next = child;
        break;
      }
    }
    if (!next) return null;
    curr = next;
  }
  return curr;
}

// 判定 id 或類別名稱是否為隨機產生、不可依賴的標記
export function isUnstableToken(token) {
  if (!token || typeof token !== 'string') return false;
  if (/\d{3,}/.test(token)) return true;
  if (/^(css|sc|jsx|emotion|styled)-/i.test(token)) return true;
  return token.length >= 8 && /[a-z]/.test(token) && /[A-Z]/.test(token) && /\d/.test(token);
}

// 產生目標元素的四層定位描述資訊
export function describe(el) {
  // 第 1 層：css
  let css = '';
  if (el.id && !isUnstableToken(el.id)) {
    css = `#${el.id}`;
  } else {
    for (const attr of ['data-testid', 'data-id', 'data-name', 'name']) {
      if (el.hasAttribute && el.hasAttribute(attr)) {
        css = `[${attr}="${el.getAttribute(attr)}"]`;
        break;
      }
    }
  }

  // 第 2 層與第 4 層共用：階層路徑
  const chain = getHierarchy(el);
  const path = chain.map(node => `${node.tag}:nth-of-type(${node.index})`).join(' > ');
  const xpath = '/' + chain.map(node => `${node.tag}[${node.index}]`).join('/');

  // 第 3 層：anchor
  let anchor = null;
  const prev = el.previousElementSibling;
  const text = prev?.textContent?.trim();
  if (text) anchor = { text, hops: 1 };

  return { css, path, anchor, xpath };
}

// 依序嘗試四層定位資訊解析元素
export function resolve(doc, locator) {
  const loc = locator || {};

  // 第 1 層：css
  if (loc.css) {
    try {
      const elements = doc.querySelectorAll(loc.css);
      if (elements.length === 1) return { el: elements[0], layer: 'css' };
    } catch {}
  }
  // 第 2 層：path
  if (loc.path) {
    try {
      const elements = doc.querySelectorAll(loc.path);
      if (elements.length === 1) return { el: elements[0], layer: 'path' };
    } catch {}
  }
  // 第 3 層：anchor
  if (loc.anchor?.text) {
    let matched = null;
    let matchCount = 0;
    for (const node of doc.querySelectorAll('*')) {
      if (node.textContent?.trim() === loc.anchor.text) {
        matched = node;
        matchCount++;
      }
    }
    if (matchCount === 1 && matched) {
      let target = matched;
      const hops = loc.anchor.hops ?? 1;
      for (let i = 0; i < hops && target; i++) {
        target = target.nextElementSibling;
      }
      if (target) return { el: target, layer: 'anchor' };
    }
  }
  // 第 4 層：xpath
  if (loc.xpath && typeof loc.xpath === 'string') {
    const el = resolveXPath(doc, loc.xpath);
    if (el) return { el, layer: 'xpath' };
  }
  // 全部失敗時回傳 not_found 與截斷之 snippet
  const snippet = (doc?.body?.innerHTML || '').slice(0, 500);
  return { error: 'not_found', snippet };
}
