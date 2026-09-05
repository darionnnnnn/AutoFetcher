// AutoFetcher SVG 圖表繪製模組（純原生 SVG，不依賴外部圖表庫）

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * 建立指定標籤與屬性的 SVG 元素
 */
function createSvgElement(tag, attrs = {}) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [key, val] of Object.entries(attrs)) {
    if (val != null) {
      el.setAttribute(key, String(val));
    }
  }
  return el;
}

/**
 * 建立根 SVG 容器元素
 */
function createSvg(width, height, attrs = {}) {
  return createSvgElement('svg', {
    viewBox: `0 0 ${width} ${height}`,
    ...attrs
  });
}

/**
 * 建立無資料提示的 SVG 容器
 */
function createEmptyChartSvg(width, height) {
  const svg = createSvg(width, height);
  const text = createSvgElement('text', {
    x: String(width / 2),
    y: String(height / 2),
    'text-anchor': 'middle',
    'dominant-baseline': 'middle',
    fill: 'var(--text-muted)'
  });
  text.textContent = '沒有資料';
  svg.appendChild(text);
  return svg;
}

/**
 * 依序列索引取得 CSS 變數圖表色彩（1~8 循環）
 */
function getChartColor(index) {
  return `var(--chart-${(index % 8) + 1})`;
}

/**
 * 線性座標換算
 */
function mapLinear(v, inMin, inMax, outMin, outMax) {
  if (inMax === inMin) return (outMin + outMax) / 2;
  const ratio = (v - inMin) / (inMax - inMin);
  return outMin + ratio * (outMax - outMin);
}

/**
 * Y 座標換算（數值越大 Y 座標越小）
 */
function mapY(v, yMin, yMax, plotTop, plotBottom) {
  return mapLinear(v, yMin, yMax, plotBottom, plotTop);
}

/**
 * X 座標換算
 */
function mapX(index, totalCount, plotLeft, plotRight) {
  if (totalCount <= 1) {
    return (plotLeft + plotRight) / 2;
  }
  return mapLinear(index, 0, totalCount - 1, plotLeft, plotRight);
}

/**
 * 計算 Y 軸繪圖範圍（含 5% 邊距與相同值展開）
 */
function computeYRange(values, yMinOpt, yMaxOpt) {
  const hasYMin = yMinOpt != null && Number.isFinite(Number(yMinOpt));
  const hasYMax = yMaxOpt != null && Number.isFinite(Number(yMaxOpt));

  let min = hasYMin ? Number(yMinOpt) : null;
  let max = hasYMax ? Number(yMaxOpt) : null;

  if (min === null || max === null) {
    if (values.length === 0) {
      min = min ?? 0;
      max = max ?? 100;
    } else {
      let dataMin = Infinity;
      let dataMax = -Infinity;
      for (const v of values) {
        if (v < dataMin) dataMin = v;
        if (v > dataMax) dataMax = v;
      }
      if (min === null && max === null) {
        if (dataMin === dataMax) {
          const delta = dataMin === 0 ? 1 : Math.abs(dataMin) * 0.1;
          min = dataMin - delta;
          max = dataMax + delta;
        } else {
          const span = dataMax - dataMin;
          min = dataMin - span * 0.05;
          max = dataMax + span * 0.05;
        }
      } else if (min === null) {
        const span = max - dataMin;
        min = span > 0 ? dataMin - span * 0.05 : max - 1;
      } else {
        const span = dataMax - min;
        max = span > 0 ? dataMax + span * 0.05 : min + 1;
      }
    }
  }

  if (min === max) {
    min -= 1;
    max += 1;
  } else if (min > max) {
    const tmp = min;
    min = max;
    max = tmp;
  }

  return { min, max };
}

/**
 * 將資料點依 null 斷線切分為連續非 null 區段
 */
function segmentPoints(points) {
  const segments = [];
  let current = [];
  for (let i = 0; i < points.length; i++) {
    const pt = points[i];
    if (pt && pt.v !== null && pt.v !== undefined && Number.isFinite(Number(pt.v))) {
      current.push({ t: pt.t, v: Number(pt.v), originalIndex: i });
    } else {
      if (current.length > 0) {
        segments.push(current);
        current = [];
      }
    }
  }
  if (current.length > 0) {
    segments.push(current);
  }
  return segments;
}

/**
 * 組裝 SVG 路徑 d 屬性字串（每段以 M 開頭，後續以 L 連接）
 */
function buildPathD(segments, getX, getY) {
  const parts = [];
  for (const seg of segments) {
    if (seg.length === 0) continue;
    const first = seg[0];
    parts.push(`M ${getX(first)} ${getY(first)}`);
    for (let i = 1; i < seg.length; i++) {
      const pt = seg[i];
      parts.push(`L ${getX(pt)} ${getY(pt)}`);
    }
  }
  return parts.join(' ');
}

/**
 * 繪製折線圖
 */
export function lineChart(seriesList, opts = {}) {
  const width = opts.width ?? 600;
  const height = opts.height ?? 200;
  const unit = opts.unit;

  if (!Array.isArray(seriesList) || seriesList.length === 0) {
    return createEmptyChartSvg(width, height);
  }

  const distinctT = [];
  const seenT = new Set();
  const allValues = [];

  for (const series of seriesList) {
    for (const pt of (series?.points || [])) {
      if (pt && !seenT.has(pt.t)) {
        seenT.add(pt.t);
        distinctT.push(pt.t);
      }
      if (pt && pt.v !== null && pt.v !== undefined && Number.isFinite(Number(pt.v))) {
        allValues.push(Number(pt.v));
      }
    }
  }

  if (allValues.length === 0) {
    return createEmptyChartSvg(width, height);
  }

  const svg = createSvg(width, height);
  const tIndexMap = new Map(distinctT.map((t, idx) => [t, idx]));

  const padding = { top: 16, right: 16, bottom: 16, left: 16 };
  const plotLeft = padding.left;
  const plotRight = width - padding.right;
  const plotTop = padding.top;
  const plotBottom = height - padding.bottom;

  const yRange = computeYRange(allValues, opts.yMin, opts.yMax);

  const getX = pt => mapX(tIndexMap.get(pt.t) ?? pt.originalIndex, distinctT.length, plotLeft, plotRight);
  const getY = pt => mapY(pt.v, yRange.min, yRange.max, plotTop, plotBottom);

  seriesList.forEach((series, seriesIndex) => {
    const strokeColor = getChartColor(seriesIndex);
    const taskId = series.taskId ?? '';
    const segments = segmentPoints(series.points || []);
    const d = buildPathD(segments, getX, getY);

    if (d) {
      const path = createSvgElement('path', {
        d,
        fill: 'none',
        stroke: strokeColor,
        'stroke-width': '2'
      });
      svg.appendChild(path);
    }

    for (const seg of segments) {
      for (const pt of seg) {
        const cx = getX(pt);
        const cy = getY(pt);
        const circle = createSvgElement('circle', {
          cx: String(cx),
          cy: String(cy),
          r: '3.5',
          fill: strokeColor,
          'data-t': pt.t,
          'data-task-id': taskId
        });
        const title = createSvgElement('title');
        title.textContent = unit ? `${pt.t}: ${pt.v} ${unit}` : `${pt.t}: ${pt.v}`;
        circle.appendChild(title);
        svg.appendChild(circle);
      }
    }
  });

  return svg;
}

/**
 * 繪製長條圖
 */
export function barChart(seriesList, opts = {}) {
  const width = opts.width ?? 600;
  const height = opts.height ?? 200;
  const unit = opts.unit;

  if (!Array.isArray(seriesList) || seriesList.length === 0) {
    return createEmptyChartSvg(width, height);
  }

  const distinctT = [];
  const seenT = new Set();
  const allValues = [];

  for (const series of seriesList) {
    for (const pt of (series?.points || [])) {
      if (pt && !seenT.has(pt.t)) {
        seenT.add(pt.t);
        distinctT.push(pt.t);
      }
      if (pt && pt.v !== null && pt.v !== undefined && Number.isFinite(Number(pt.v))) {
        allValues.push(Number(pt.v));
      }
    }
  }

  if (allValues.length === 0) {
    return createEmptyChartSvg(width, height);
  }

  const svg = createSvg(width, height);
  const tIndexMap = new Map(distinctT.map((t, idx) => [t, idx]));

  const padding = { top: 16, right: 16, bottom: 16, left: 16 };
  const plotLeft = padding.left;
  const plotRight = width - padding.right;
  const plotTop = padding.top;
  const plotBottom = height - padding.bottom;
  const plotWidth = plotRight - plotLeft;

  const yRange = computeYRange(allValues, opts.yMin, opts.yMax);

  const numT = distinctT.length;
  const numSeries = seriesList.length;
  const slotWidth = plotWidth / numT;
  const groupWidth = slotWidth * 0.8;
  const groupOffset = (slotWidth - groupWidth) / 2;
  const barWidth = groupWidth / numSeries;

  seriesList.forEach((series, seriesIndex) => {
    const fillColor = getChartColor(seriesIndex);
    const taskId = series.taskId ?? '';

    for (const pt of (series?.points || [])) {
      if (pt && pt.v !== null && pt.v !== undefined && Number.isFinite(Number(pt.v))) {
        const v = Number(pt.v);
        const tIndex = tIndexMap.get(pt.t);
        if (tIndex === undefined) continue;

        const x = plotLeft + tIndex * slotWidth + groupOffset + seriesIndex * barWidth;
        const y = mapY(v, yRange.min, yRange.max, plotTop, plotBottom);
        const barH = Math.max(0, plotBottom - y);

        const rect = createSvgElement('rect', {
          x: String(x),
          y: String(y),
          width: String(Math.max(1, barWidth)),
          height: String(barH),
          fill: fillColor,
          'data-t': pt.t,
          'data-task-id': taskId
        });

        const title = createSvgElement('title');
        title.textContent = unit ? `${pt.t}: ${v} ${unit}` : `${pt.t}: ${v}`;
        rect.appendChild(title);
        svg.appendChild(rect);
      }
    }
  });

  return svg;
}

/**
 * 繪製儀表圖
 */
export function gauge({ value, min = 0, max = 100, warn, unit } = {}) {
  const width = 200;
  const height = 60;
  const svg = createSvg(width, height);

  const numMin = Number.isFinite(Number(min)) ? Number(min) : 0;
  let numMax = Number.isFinite(Number(max)) ? Number(max) : 100;
  if (numMax <= numMin) {
    numMax = numMin + 1;
  }

  const isValid = value !== null && value !== undefined && typeof value === 'number' && Number.isFinite(value);
  const numWarn = warn !== null && warn !== undefined && Number.isFinite(Number(warn)) ? Number(warn) : null;

  const isOverWarn = isValid && numWarn !== null && value >= numWarn;
  if (isOverWarn) {
    svg.classList.add('over-warn');
  }

  const displayText = isValid ? (unit ? `${value} ${unit}` : `${value}`) : '—';

  const valText = createSvgElement('text', {
    x: String(width / 2),
    y: '22',
    'text-anchor': 'middle',
    'dominant-baseline': 'middle',
    fill: 'var(--text)'
  });
  valText.textContent = displayText;
  if (isOverWarn) {
    valText.classList.add('over-warn');
  }
  svg.appendChild(valText);

  const trackLeft = 16;
  const trackWidth = width - trackLeft * 2;
  const trackY = 32;
  const trackHeight = 8;

  const track = createSvgElement('rect', {
    x: String(trackLeft),
    y: String(trackY),
    width: String(trackWidth),
    height: String(trackHeight),
    rx: '4',
    fill: 'var(--border)'
  });
  svg.appendChild(track);

  if (isValid) {
    const clampedVal = Math.max(numMin, Math.min(numMax, value));
    const fillWidth = mapLinear(clampedVal, numMin, numMax, 0, trackWidth);

    const fillBar = createSvgElement('rect', {
      x: String(trackLeft),
      y: String(trackY),
      width: String(Math.max(0, Math.min(trackWidth, fillWidth))),
      height: String(trackHeight),
      rx: '4',
      fill: 'var(--chart-1)'
    });
    if (isOverWarn) {
      fillBar.classList.add('over-warn');
    }
    svg.appendChild(fillBar);
  }

  if (numWarn !== null) {
    const clampedWarn = Math.max(numMin, Math.min(numMax, numWarn));
    const warnX = mapLinear(clampedWarn, numMin, numMax, trackLeft, trackLeft + trackWidth);

    const warnLine = createSvgElement('line', {
      x1: String(warnX),
      y1: String(trackY - 3),
      x2: String(warnX),
      y2: String(trackY + trackHeight + 3),
      stroke: 'var(--warn)',
      'stroke-width': '2',
      'data-warn': String(warn)
    });
    svg.appendChild(warnLine);
  }

  const minText = createSvgElement('text', {
    x: String(trackLeft),
    y: '52',
    'text-anchor': 'start',
    fill: 'var(--text-muted)',
    'font-size': '10'
  });
  minText.textContent = String(numMin);
  svg.appendChild(minText);

  const maxText = createSvgElement('text', {
    x: String(trackLeft + trackWidth),
    y: '52',
    'text-anchor': 'end',
    fill: 'var(--text-muted)',
    'font-size': '10'
  });
  maxText.textContent = String(numMax);
  svg.appendChild(maxText);

  return svg;
}

/**
 * 繪製迷你走勢圖
 */
export function sparkline(points, opts = {}) {
  const width = opts.width ?? 100;
  const height = opts.height ?? 24;

  const svg = createSvg(width, height);

  if (!Array.isArray(points) || points.length === 0) {
    return svg;
  }

  const allValues = [];
  for (const pt of points) {
    if (pt && pt.v !== null && pt.v !== undefined && Number.isFinite(Number(pt.v))) {
      allValues.push(Number(pt.v));
    }
  }

  if (allValues.length === 0) {
    return svg;
  }

  const padding = { top: 2, right: 2, bottom: 2, left: 2 };
  const plotLeft = padding.left;
  const plotRight = width - padding.right;
  const plotTop = padding.top;
  const plotBottom = height - padding.bottom;

  const yRange = computeYRange(allValues, opts.yMin, opts.yMax);
  const segments = segmentPoints(points);

  const getX = pt => mapX(pt.originalIndex, points.length, plotLeft, plotRight);
  const getY = pt => mapY(pt.v, yRange.min, yRange.max, plotTop, plotBottom);

  const d = buildPathD(segments, getX, getY);
  if (d) {
    const path = createSvgElement('path', {
      d,
      fill: 'none',
      stroke: 'var(--chart-1)',
      'stroke-width': '1.5'
    });
    svg.appendChild(path);
  }

  return svg;
}
