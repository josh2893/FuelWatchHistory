const state = {
  metadata: null,
  series: null,
  fuelType: null,
  startDate: null,
  endDate: null,
  showAvg: true,
  showMin: true,
  showMax: true,
  status: null,
  hoverIndex: null,
  chartGeometry: null,
  dragSelection: {
    active: false,
    startX: null,
    currentX: null,
  },
};

const elements = {
  fuelTypeSelect: document.getElementById('fuelTypeSelect'),
  startDateInput: document.getElementById('startDateInput'),
  endDateInput: document.getElementById('endDateInput'),
  toggleAvg: document.getElementById('toggleAvg'),
  toggleMin: document.getElementById('toggleMin'),
  toggleMax: document.getElementById('toggleMax'),
  coverageText: document.getElementById('coverageText'),
  summaryAverage: document.getElementById('summaryAverage'),
  summaryLow: document.getElementById('summaryLow'),
  summaryHigh: document.getElementById('summaryHigh'),
  summaryDays: document.getElementById('summaryDays'),
  summaryObservations: document.getElementById('summaryObservations'),
  chartTitle: document.getElementById('chartTitle'),
  chartSubtitle: document.getElementById('chartSubtitle'),
  chartCanvas: document.getElementById('chartCanvas'),
  chartTooltip: document.getElementById('chartTooltip'),
  chartEmptyState: document.getElementById('chartEmptyState'),
  statusPill: document.getElementById('statusPill'),
  syncBanner: document.getElementById('syncBanner'),
  syncMessage: document.getElementById('syncMessage'),
  progressFill: document.getElementById('progressFill'),
  progressLabel: document.getElementById('progressLabel'),
  refreshButton: document.getElementById('refreshButton'),
  resetZoomButton: document.getElementById('resetZoomButton'),
  presetButtons: Array.from(document.querySelectorAll('[data-range]')),
};

const COLORS = {
  avg: '#2563eb',
  min: '#0f9a6d',
  max: '#ea580c',
  grid: 'rgba(100, 116, 139, 0.16)',
  text: '#172033',
  muted: '#64748b',
  selection: 'rgba(37, 99, 235, 0.14)',
  selectionBorder: 'rgba(37, 99, 235, 0.8)',
};

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    const message = payload.detail || `Request failed (${response.status})`;
    throw new Error(message);
  }
  return response.json();
}

function formatNumber(value, digits = 1) {
  return Number(value).toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function formatDateLabel(dateString, mode = 'long') {
  const date = new Date(`${dateString}T00:00:00`);
  return date.toLocaleDateString(undefined, {
    day: mode === 'long' ? 'numeric' : undefined,
    month: 'short',
    year: 'numeric',
  });
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function clearDragSelection() {
  state.dragSelection.active = false;
  state.dragSelection.startX = null;
  state.dragSelection.currentX = null;
}

function updateResetZoomButton() {
  if (!state.metadata?.min_date || !state.metadata?.max_date || !state.startDate || !state.endDate) {
    elements.resetZoomButton.disabled = true;
    return;
  }

  elements.resetZoomButton.disabled = state.startDate === state.metadata.min_date && state.endDate === state.metadata.max_date;
}

function setPreset(range) {
  if (!state.metadata?.min_date || !state.metadata?.max_date) return;
  const end = new Date(`${state.metadata.max_date}T00:00:00`);
  let start = new Date(end);

  if (range === '1y') {
    start.setFullYear(end.getFullYear() - 1);
  } else if (range === '5y') {
    start.setFullYear(end.getFullYear() - 5);
  } else if (range === '10y') {
    start.setFullYear(end.getFullYear() - 10);
  } else {
    start = new Date(`${state.metadata.min_date}T00:00:00`);
  }

  const minBound = new Date(`${state.metadata.min_date}T00:00:00`);
  if (start < minBound) start = minBound;

  state.startDate = start.toISOString().slice(0, 10);
  state.endDate = end.toISOString().slice(0, 10);
  elements.startDateInput.value = state.startDate;
  elements.endDateInput.value = state.endDate;

  elements.presetButtons.forEach((button) => {
    button.classList.toggle('active', button.dataset.range === range);
  });

  updateResetZoomButton();
  loadSeries();
}

function applyCoverageText() {
  const coverage = state.metadata?.fuel_type_coverage?.find(
    (item) => item.fuel_type === state.fuelType,
  );

  if (!coverage) {
    elements.coverageText.textContent = 'No coverage details available yet.';
    return;
  }

  elements.coverageText.textContent = `${coverage.fuel_type} is available from ${coverage.first_date} to ${coverage.last_date} across ${Number(coverage.day_count).toLocaleString()} daily records.`;
}

function populateFuelTypes() {
  const select = elements.fuelTypeSelect;
  select.innerHTML = '';

  for (const fuelType of state.metadata.fuel_types) {
    const option = document.createElement('option');
    option.value = fuelType;
    option.textContent = fuelType;
    select.appendChild(option);
  }

  const preferred = ['ULP', 'PULP', 'Diesel', '98 RON'];
  const firstPreferred = preferred.find((item) => state.metadata.fuel_types.includes(item));
  state.fuelType = state.fuelType || firstPreferred || state.metadata.fuel_types[0] || null;
  select.value = state.fuelType;
  applyCoverageText();
}

function updateSummary(summary) {
  if (!summary) {
    elements.summaryAverage.textContent = '—';
    elements.summaryLow.textContent = '—';
    elements.summaryHigh.textContent = '—';
    elements.summaryDays.textContent = '—';
    elements.summaryObservations.textContent = '—';
    return;
  }

  elements.summaryAverage.textContent = formatNumber(summary.range_average);
  elements.summaryLow.textContent = formatNumber(summary.range_low);
  elements.summaryHigh.textContent = formatNumber(summary.range_high);
  elements.summaryDays.textContent = Number(summary.days).toLocaleString();
  elements.summaryObservations.textContent = `${Number(summary.observations).toLocaleString()} observations`;
}

function updateStatus(status) {
  state.status = status;
  if (status.running) {
    const prefix = status.sync_mode === 'incremental' ? 'Checking updates' : 'Syncing';
    elements.statusPill.textContent = `${prefix} ${status.current_month || ''}`.trim();
    elements.syncBanner.classList.remove('hidden');
    elements.syncMessage.textContent = `${status.message}. Checked ${status.checked_months} of ${status.total_months} months.`;
    elements.progressFill.style.width = `${status.progress_pct || 0}%`;
    elements.progressLabel.textContent = `${status.progress_pct || 0}%`;
  } else {
    const completed = status.last_completed_sync ? new Date(status.last_completed_sync).toLocaleString() : 'Not yet synced';
    if (status.next_auto_sync_at) {
      const nextRun = new Date(status.next_auto_sync_at).toLocaleString();
      elements.statusPill.textContent = `Ready · ${completed} · Next auto update ${nextRun}`;
    } else {
      elements.statusPill.textContent = `Ready · ${completed}`;
    }
    elements.syncBanner.classList.add('hidden');
  }
}

function setChartTitle() {
  if (!state.fuelType) return;
  elements.chartTitle.textContent = `${state.fuelType} price history`;
  elements.chartSubtitle.textContent = `${state.startDate || '…'} to ${state.endDate || '…'} · Western Australia statewide daily summary`;
}

function resizeCanvas() {
  const canvas = elements.chartCanvas;
  const container = canvas.parentElement;
  const ratio = window.devicePixelRatio || 1;
  const width = container.clientWidth;
  const height = canvas.clientHeight;
  canvas.width = Math.floor(width * ratio);
  canvas.height = Math.floor(height * ratio);
}

function drawSelectionOverlay(ctx, width, height) {
  if (!state.dragSelection.active || state.dragSelection.startX == null || state.dragSelection.currentX == null || !state.chartGeometry) {
    return;
  }

  const { padding, plotWidth } = state.chartGeometry;
  const leftBound = padding.left;
  const rightBound = padding.left + plotWidth;
  const startX = clamp(Math.min(state.dragSelection.startX, state.dragSelection.currentX), leftBound, rightBound);
  const endX = clamp(Math.max(state.dragSelection.startX, state.dragSelection.currentX), leftBound, rightBound);

  ctx.fillStyle = COLORS.selection;
  ctx.fillRect(startX, padding.top, Math.max(0, endX - startX), height - padding.top - padding.bottom);
  ctx.strokeStyle = COLORS.selectionBorder;
  ctx.lineWidth = 1.5;
  ctx.strokeRect(startX, padding.top, Math.max(0, endX - startX), height - padding.top - padding.bottom);
}

function drawChart() {
  resizeCanvas();
  const canvas = elements.chartCanvas;
  const ctx = canvas.getContext('2d');
  const ratio = window.devicePixelRatio || 1;
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  const width = canvas.width / ratio;
  const height = canvas.height / ratio;
  ctx.clearRect(0, 0, width, height);

  const points = state.series?.points || [];
  const metrics = [
    state.showAvg ? { key: 'avg_price', color: COLORS.avg } : null,
    state.showMin ? { key: 'min_price', color: COLORS.min } : null,
    state.showMax ? { key: 'max_price', color: COLORS.max } : null,
  ].filter(Boolean);

  if (!points.length || !metrics.length) {
    state.chartGeometry = null;
    elements.chartEmptyState.classList.remove('hidden');
    elements.chartEmptyState.textContent = metrics.length
      ? 'No data is available for this combination yet.'
      : 'Select at least one line to display.';
    return;
  }

  elements.chartEmptyState.classList.add('hidden');

  const padding = { top: 28, right: 24, bottom: 46, left: 72 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const xStart = new Date(`${state.startDate}T00:00:00`).getTime();
  const xEnd = new Date(`${state.endDate}T00:00:00`).getTime();
  const allValues = points.flatMap((point) => metrics.map((metric) => Number(point[metric.key])));
  const yMin = Math.min(...allValues);
  const yMax = Math.max(...allValues);
  const yPadding = Math.max((yMax - yMin) * 0.08, 4);
  const domainMin = yMin - yPadding;
  const domainMax = yMax + yPadding;

  const scaleX = (timestamp) => padding.left + ((timestamp - xStart) / (xEnd - xStart || 1)) * plotWidth;
  const scaleY = (value) => padding.top + (1 - (value - domainMin) / (domainMax - domainMin || 1)) * plotHeight;

  state.chartGeometry = {
    padding,
    plotWidth,
    plotHeight,
    width,
    height,
    xStart,
    xEnd,
    scaleX,
  };

  ctx.strokeStyle = COLORS.grid;
  ctx.lineWidth = 1;
  ctx.fillStyle = COLORS.muted;
  ctx.font = '12px Inter, Segoe UI, sans-serif';

  const horizontalTicks = 5;
  for (let index = 0; index <= horizontalTicks; index += 1) {
    const value = domainMin + ((domainMax - domainMin) / horizontalTicks) * index;
    const y = scaleY(value);
    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(width - padding.right, y);
    ctx.stroke();
    ctx.fillText(formatNumber(value), 12, y + 4);
  }

  const tickCount = 6;
  for (let index = 0; index <= tickCount; index += 1) {
    const ratioValue = index / tickCount;
    const timestamp = xStart + (xEnd - xStart) * ratioValue;
    const x = padding.left + plotWidth * ratioValue;
    ctx.beginPath();
    ctx.moveTo(x, padding.top);
    ctx.lineTo(x, height - padding.bottom);
    ctx.stroke();

    const labelDate = new Date(timestamp);
    const spanDays = (xEnd - xStart) / 86400000;
    const label = labelDate.toLocaleDateString(undefined, spanDays > 720
      ? { year: 'numeric' }
      : spanDays > 90
      ? { month: 'short', year: 'numeric' }
      : { day: 'numeric', month: 'short', year: 'numeric' });
    ctx.fillText(label, x - 24, height - 16);
  }

  for (const metric of metrics) {
    ctx.beginPath();
    ctx.lineWidth = metric.key === 'avg_price' ? 2.4 : 1.6;
    ctx.strokeStyle = metric.color;
    let lastTimestamp = null;

    points.forEach((point, index) => {
      const timestamp = new Date(`${point.date}T00:00:00`).getTime();
      const x = scaleX(timestamp);
      const y = scaleY(Number(point[metric.key]));
      const gapInDays = lastTimestamp ? (timestamp - lastTimestamp) / 86400000 : 0;

      if (index === 0 || gapInDays > 3) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
      lastTimestamp = timestamp;
    });
    ctx.stroke();
  }

  if (typeof state.hoverIndex === 'number' && points[state.hoverIndex] && !state.dragSelection.active) {
    const point = points[state.hoverIndex];
    const timestamp = new Date(`${point.date}T00:00:00`).getTime();
    const x = scaleX(timestamp);
    ctx.strokeStyle = 'rgba(15, 23, 42, 0.22)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, padding.top);
    ctx.lineTo(x, height - padding.bottom);
    ctx.stroke();

    metrics.forEach((metric) => {
      const y = scaleY(Number(point[metric.key]));
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(x, y, 4.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = metric.color;
      ctx.lineWidth = 2;
      ctx.stroke();
    });
  }

  drawSelectionOverlay(ctx, width, height);
}

function getNearestPointIndexFromClientX(clientX) {
  const points = state.series?.points || [];
  if (!points.length || !state.chartGeometry) return null;

  const rect = elements.chartCanvas.getBoundingClientRect();
  const x = clientX - rect.left;
  const { padding, plotWidth, xStart, xEnd } = state.chartGeometry;
  const boundedX = clamp(x, padding.left, padding.left + plotWidth);
  const ratioValue = (boundedX - padding.left) / (plotWidth || 1);
  const timestamp = xStart + ((xEnd - xStart) * ratioValue);

  let nearestIndex = 0;
  let smallestGap = Infinity;
  points.forEach((point, index) => {
    const pointTime = new Date(`${point.date}T00:00:00`).getTime();
    const gap = Math.abs(pointTime - timestamp);
    if (gap < smallestGap) {
      smallestGap = gap;
      nearestIndex = index;
    }
  });

  return nearestIndex;
}

function updateTooltip(event) {
  const points = state.series?.points || [];
  if (!points.length || state.dragSelection.active) return;

  const nearestIndex = getNearestPointIndexFromClientX(event.clientX);
  if (nearestIndex == null) return;

  state.hoverIndex = nearestIndex;
  drawChart();

  const rect = elements.chartCanvas.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const point = points[nearestIndex];
  const tooltipLines = [];
  if (state.showAvg) tooltipLines.push(`<div class="tooltip-line"><span>Average</span><strong>${formatNumber(point.avg_price)}</strong></div>`);
  if (state.showMin) tooltipLines.push(`<div class="tooltip-line"><span>Low</span><strong>${formatNumber(point.min_price)}</strong></div>`);
  if (state.showMax) tooltipLines.push(`<div class="tooltip-line"><span>High</span><strong>${formatNumber(point.max_price)}</strong></div>`);

  elements.chartTooltip.innerHTML = `
    <strong>${formatDateLabel(point.date)}</strong>
    ${tooltipLines.join('')}
  `;

  const tooltipX = Math.min(x + 18, rect.width - 190);
  const tooltipY = Math.max(14, event.clientY - rect.top - 60);
  elements.chartTooltip.style.left = `${tooltipX}px`;
  elements.chartTooltip.style.top = `${tooltipY}px`;
  elements.chartTooltip.classList.remove('hidden');
}

function applyDraggedZoom() {
  if (!state.dragSelection.active) return;

  const startIndex = getNearestPointIndexFromClientX(state.dragSelection.startX + elements.chartCanvas.getBoundingClientRect().left);
  const endIndex = getNearestPointIndexFromClientX(state.dragSelection.currentX + elements.chartCanvas.getBoundingClientRect().left);
  clearDragSelection();

  if (startIndex == null || endIndex == null || !state.series?.points?.length) {
    drawChart();
    return;
  }

  const points = state.series.points;
  const [fromIndex, toIndex] = [startIndex, endIndex].sort((a, b) => a - b);
  if (toIndex - fromIndex < 2) {
    drawChart();
    return;
  }

  state.startDate = points[fromIndex].date;
  state.endDate = points[toIndex].date;
  elements.startDateInput.value = state.startDate;
  elements.endDateInput.value = state.endDate;
  elements.presetButtons.forEach((button) => button.classList.remove('active'));
  updateResetZoomButton();
  elements.chartTooltip.classList.add('hidden');
  state.hoverIndex = null;
  loadSeries();
}

async function loadMetadata() {
  const metadata = await fetchJson('/api/metadata');
  state.metadata = metadata;

  if (!metadata.rows || !metadata.fuel_types.length || !metadata.min_date || !metadata.max_date) {
    elements.coverageText.textContent = 'Archive is still syncing. Fuel types will appear here once enough data has been processed.';
    elements.chartSubtitle.textContent = 'Waiting for the first processed records…';
    updateResetZoomButton();
    return false;
  }

  populateFuelTypes();

  if (!state.startDate || !state.endDate) {
    state.startDate = metadata.min_date;
    state.endDate = metadata.max_date;
    elements.startDateInput.value = state.startDate;
    elements.endDateInput.value = state.endDate;
    elements.startDateInput.min = metadata.min_date;
    elements.startDateInput.max = metadata.max_date;
    elements.endDateInput.min = metadata.min_date;
    elements.endDateInput.max = metadata.max_date;
    setPreset('5y');
    return true;
  }

  elements.startDateInput.min = metadata.min_date;
  elements.startDateInput.max = metadata.max_date;
  elements.endDateInput.min = metadata.min_date;
  elements.endDateInput.max = metadata.max_date;
  applyCoverageText();
  updateResetZoomButton();
  return true;
}

async function loadSeries() {
  if (!state.fuelType || !state.startDate || !state.endDate) return;
  setChartTitle();
  updateResetZoomButton();
  elements.chartSubtitle.textContent = 'Loading series…';
  state.series = null;
  drawChart();

  const params = new URLSearchParams({
    fuel_type: state.fuelType,
    start_date: state.startDate,
    end_date: state.endDate,
  });

  try {
    const payload = await fetchJson(`/api/series?${params.toString()}`);
    state.series = payload;
    state.hoverIndex = null;
    updateSummary(payload.summary);
    setChartTitle();
    updateResetZoomButton();
    drawChart();
  } catch (error) {
    state.series = { points: [] };
    updateSummary(null);
    elements.chartSubtitle.textContent = error.message;
    drawChart();
  }
}

async function pollStatus() {
  try {
    const status = await fetchJson('/api/status');
    updateStatus(status);
    if (!state.metadata?.rows || status.running) {
      const ready = await loadMetadata().catch(() => false);
      if (ready && state.fuelType && (!state.series || !state.series.points?.length)) {
        await loadSeries();
      }
    }
  } catch (error) {
    elements.statusPill.textContent = 'Status unavailable';
  }
}

function bindEvents() {
  elements.fuelTypeSelect.addEventListener('change', (event) => {
    state.fuelType = event.target.value;
    applyCoverageText();
    loadSeries();
  });

  elements.startDateInput.addEventListener('change', (event) => {
    state.startDate = event.target.value;
    elements.presetButtons.forEach((button) => button.classList.remove('active'));
    updateResetZoomButton();
    loadSeries();
  });

  elements.endDateInput.addEventListener('change', (event) => {
    state.endDate = event.target.value;
    elements.presetButtons.forEach((button) => button.classList.remove('active'));
    updateResetZoomButton();
    loadSeries();
  });

  elements.toggleAvg.addEventListener('change', (event) => {
    state.showAvg = event.target.checked;
    drawChart();
  });
  elements.toggleMin.addEventListener('change', (event) => {
    state.showMin = event.target.checked;
    drawChart();
  });
  elements.toggleMax.addEventListener('change', (event) => {
    state.showMax = event.target.checked;
    drawChart();
  });

  elements.presetButtons.forEach((button) => {
    button.addEventListener('click', () => setPreset(button.dataset.range));
  });

  elements.refreshButton.addEventListener('click', async () => {
    elements.refreshButton.disabled = true;
    try {
      await fetchJson('/api/sync', { method: 'POST' });
      await pollStatus();
    } catch (error) {
      elements.statusPill.textContent = error.message;
    } finally {
      elements.refreshButton.disabled = false;
    }
  });

  elements.resetZoomButton.addEventListener('click', () => {
    setPreset('all');
  });

  window.addEventListener('resize', drawChart);
  elements.chartCanvas.addEventListener('mousemove', (event) => {
    if (state.dragSelection.active) {
      const rect = elements.chartCanvas.getBoundingClientRect();
      state.dragSelection.currentX = event.clientX - rect.left;
      elements.chartTooltip.classList.add('hidden');
      drawChart();
      return;
    }
    updateTooltip(event);
  });

  elements.chartCanvas.addEventListener('mousedown', (event) => {
    if (event.button !== 0 || !state.series?.points?.length || !state.chartGeometry) return;
    const rect = elements.chartCanvas.getBoundingClientRect();
    state.dragSelection.active = true;
    state.dragSelection.startX = event.clientX - rect.left;
    state.dragSelection.currentX = event.clientX - rect.left;
    state.hoverIndex = null;
    elements.chartTooltip.classList.add('hidden');
    drawChart();
  });

  window.addEventListener('mouseup', () => {
    if (!state.dragSelection.active) return;
    applyDraggedZoom();
  });

  elements.chartCanvas.addEventListener('mouseleave', () => {
    if (state.dragSelection.active) return;
    state.hoverIndex = null;
    elements.chartTooltip.classList.add('hidden');
    drawChart();
  });

  elements.chartCanvas.addEventListener('dblclick', () => {
    if (!state.metadata?.min_date || !state.metadata?.max_date) return;
    setPreset('all');
  });
}

async function init() {
  bindEvents();
  await pollStatus();
  const ready = await loadMetadata();
  if (ready && state.metadata?.fuel_types?.length) {
    await loadSeries();
  }
  setInterval(pollStatus, 5000);
}

init().catch((error) => {
  elements.statusPill.textContent = error.message;
});
