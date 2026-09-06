// 共用拖曳協定模組（Pointer Events 原生實作，無框架、無第三方相依）

export const DRAG_THRESHOLD_PX = 4;

let dragging = false;
let pendingDrag = null;
let currentPayload = null;
let currentActiveTarget = null;
let ghostEl = null;
const dropTargets = [];

/**
 * 取得目前是否正在拖曳
 */
export function isDragging() {
  return dragging;
}

/**
 * 清除所有進行中或殘留的拖曳狀態與監聽器
 */
function cleanup() {
  if (currentActiveTarget) {
    currentActiveTarget.el.removeAttribute('data-drop-active');
  }

  if (typeof document !== 'undefined') {
    const activeElements = document.querySelectorAll('[data-drop-active]');
    for (const el of activeElements) {
      el.removeAttribute('data-drop-active');
    }
    document.removeEventListener('pointermove', onPointerMove);
    document.removeEventListener('pointerup', onPointerUp);
    document.removeEventListener('keydown', onKeyDown);
  }

  if (ghostEl) {
    ghostEl.remove();
    ghostEl = null;
  }

  if (
    pendingDrag &&
    pendingDrag.sourceEl &&
    typeof pendingDrag.sourceEl.releasePointerCapture === 'function' &&
    pendingDrag.pointerId !== undefined
  ) {
    try {
      pendingDrag.sourceEl.releasePointerCapture(pendingDrag.pointerId);
    } catch {}
  }

  dragging = false;
  pendingDrag = null;
  currentPayload = null;
  currentActiveTarget = null;
}

/**
 * 建立幽靈元素並附加至 document.body
 */
function createGhost(payload, x, y) {
  if (typeof document === 'undefined' || !document.body) {
    return;
  }
  const existing = document.querySelectorAll('[data-dnd-ghost]');
  for (const el of existing) {
    el.remove();
  }

  ghostEl = document.createElement('div');
  ghostEl.setAttribute('data-dnd-ghost', '');
  ghostEl.textContent = payload && payload.label != null ? String(payload.label) : '';
  ghostEl.style.position = 'fixed';
  ghostEl.style.pointerEvents = 'none';
  ghostEl.style.zIndex = '9999';
  ghostEl.style.left = `${x}px`;
  ghostEl.style.top = `${y}px`;
  ghostEl.style.background = 'var(--surface)';
  ghostEl.style.color = 'var(--text)';
  document.body.appendChild(ghostEl);
}

/**
 * 更新幽靈元素位置
 */
function updateGhost(x, y) {
  if (ghostEl) {
    ghostEl.style.left = `${x}px`;
    ghostEl.style.top = `${y}px`;
  }
}

/**
 * 檢查目標是否接受當前 payload
 */
function targetAccepts(target, payload, pos) {
  if (typeof target.handlers.accepts === 'function') {
    return Boolean(target.handlers.accepts(payload, pos));
  }
  return true;
}

/**
 * 根據指標座標尋找命中的目標（走訪所有已註冊目標，多個命中時取最後註冊者）
 */
function findHitTarget(x, y, payload) {
  for (let i = dropTargets.length - 1; i >= 0; i--) {
    const target = dropTargets[i];
    if (!target.el || typeof target.el.getBoundingClientRect !== 'function') {
      continue;
    }
    const rect = target.el.getBoundingClientRect();
    if (!rect || x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) {
      continue;
    }
    // 上層目標不接受這個 payload 時要繼續往下找,不能整個落空
    // (例:拖著「移除把手」放在別張卡片上,該由底下的格線接手)
    if (targetAccepts(target, payload, { x, y })) {
      return target;
    }
  }
  return null;
}

/**
 * 更新目標高亮與事件（onDragOver / onLeave）
 */
function updateDropTarget(x, y) {
  const pos = { x, y };
  const nextTarget = findHitTarget(x, y, currentPayload);

  if (currentActiveTarget !== nextTarget) {
    if (currentActiveTarget) {
      currentActiveTarget.el.removeAttribute('data-drop-active');
      if (typeof currentActiveTarget.handlers.onLeave === 'function') {
        currentActiveTarget.handlers.onLeave();
      }
    }
    currentActiveTarget = nextTarget;
    if (currentActiveTarget) {
      currentActiveTarget.el.setAttribute('data-drop-active', '');
    }
  }

  if (currentActiveTarget && typeof currentActiveTarget.handlers.onDragOver === 'function') {
    currentActiveTarget.handlers.onDragOver(currentPayload, pos);
  }
}

/**
 * 指標移動事件處理
 */
function onPointerMove(e) {
  if (!pendingDrag) {
    return;
  }

  const x = e.clientX ?? 0;
  const y = e.clientY ?? 0;

  if (!dragging) {
    const dx = x - pendingDrag.startX;
    const dy = y - pendingDrag.startY;
    if (Math.hypot(dx, dy) > DRAG_THRESHOLD_PX) {
      dragging = true;
      currentPayload = pendingDrag.payload;
      createGhost(currentPayload, x, y);
    } else {
      return;
    }
  }

  updateGhost(x, y);
  updateDropTarget(x, y);
}

/**
 * 指標放開事件處理
 */
function onPointerUp(e) {
  if (!pendingDrag) {
    return;
  }

  const x = e.clientX ?? 0;
  const y = e.clientY ?? 0;
  const pos = { x, y };

  if (dragging) {
    updateDropTarget(x, y);
    const target = currentActiveTarget;
    const payload = currentPayload;

    cleanup();

    if (target && typeof target.handlers.onDrop === 'function') {
      target.handlers.onDrop(payload, pos);
    }
  } else {
    cleanup();
  }
}

/**
 * 鍵盤事件處理（Escape 取消）
 */
function onKeyDown(e) {
  if (e.key === 'Escape') {
    if (currentActiveTarget && typeof currentActiveTarget.handlers.onLeave === 'function') {
      try {
        currentActiveTarget.handlers.onLeave();
      } catch {}
    }
    cleanup();
  }
}

/**
 * 建立拖曳來源元素
 */
export function createDragSource(el, getPayload) {
  el.addEventListener('pointerdown', (e) => {
    // 只接受主鍵
    if (e.button !== undefined && e.button !== 0) {
      return;
    }

    cleanup();

    const payload = typeof getPayload === 'function' ? getPayload() : null;
    if (!payload) {
      return;
    }

    if (typeof el.setPointerCapture === 'function' && e.pointerId !== undefined) {
      try {
        el.setPointerCapture(e.pointerId);
      } catch {}
    }

    pendingDrag = {
      startX: e.clientX ?? 0,
      startY: e.clientY ?? 0,
      payload,
      sourceEl: el,
      pointerId: e.pointerId
    };

    document.addEventListener('pointermove', onPointerMove);
    document.addEventListener('pointerup', onPointerUp);
    document.addEventListener('keydown', onKeyDown);
  });
}

/**
 * 註冊放置目標元素
 */
export function registerDropTarget(el, handlers = {}) {
  const entry = { el, handlers: handlers || {} };
  dropTargets.push(entry);

  return function unregisterDropTarget() {
    const idx = dropTargets.indexOf(entry);
    if (idx !== -1) {
      dropTargets.splice(idx, 1);
    }
    if (currentActiveTarget === entry) {
      entry.el.removeAttribute('data-drop-active');
      if (typeof entry.handlers.onLeave === 'function') {
        try {
          entry.handlers.onLeave();
        } catch {}
      }
      currentActiveTarget = null;
    }
  };
}

/**
 * 清除所有已註冊的放置目標與進行中狀態
 */
export function resetDnd() {
  cleanup();
  dropTargets.length = 0;
}
