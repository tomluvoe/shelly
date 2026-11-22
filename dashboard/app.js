'use strict';

const byId = (id) => document.getElementById(id);
const slug = window.location.pathname.split('/')[2] || '';
const metrics = [
  ['temperature', 'Temp.', '°C', 1],
  ['humidity', 'Humidity', '%', 1],
  ['battery', 'Battery', '%', 0],
];
const labels = {
  waiting: 'Waiting for a report',
  awake: 'Sensor awake',
  reported: 'Last known reading',
  missing: 'Device not found in cloud response',
  'no-readings': 'Cloud returned no valid reading',
};
const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const formatTime = (at) => dateTime.format(new Date(at * 1000));
const formatNumber = (value, digits) => value.toLocaleString(undefined, { maximumFractionDigits: digits });
const areaUrl = (area) => `/areas/${area.slug}/`;
const limitNames = ['temperature_min', 'temperature_max', 'humidity_min', 'humidity_max'];
const limitForm = byId('limit-form');

let range = '7d';
let newestHistoryRequest = 0;
let newestOverviewRequest = 0;
let history = null;
let areaData = '';
let editingLimits = false;

function element(tag, text, className = '') {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function readingTime(area) {
  if (area.at === null) return 'No archived readings yet';
  const prefix = area.report_time === null ? 'First seen' : 'Reported';
  return `${prefix} ${formatTime(area.at)}`;
}

function metricValues(area) {
  return metrics.map(([key, name, unit, digits]) => {
    const group = element('div');
    const value = element('dd', area[key] === null ? '—' : formatNumber(area[key], digits));
    if (area[key] !== null) value.append(element('span', ` ${unit}`, 'unit'));
    group.append(element('dt', name), value);
    return group;
  });
}

function areaLink(area) {
  const link = element('a', area.name);
  link.href = areaUrl(area);
  if (area.slug === slug) link.setAttribute('aria-current', 'page');
  return link;
}

function renderAlerts(list, alerts) {
  const items = alerts.map(({ metric, value, direction, limit, at }) => {
    const [name, unit] = metric === 'temperature' ? ['Temperature', '°C'] : ['Humidity', '%'];
    const text = `${name} ${formatNumber(value, 10)} ${unit} is ${direction} ${formatNumber(limit, 10)} ${unit}`;
    const item = element('li', text);
    item.title = `Reading from ${formatTime(at)}`;
    return item;
  });
  list.replaceChildren(...items);
  list.hidden = !items.length;
}

function card(area) {
  const link = element('a', undefined, 'panel card');
  link.href = areaUrl(area);
  const header = element('div', undefined, 'card-head');
  header.append(element('h3', area.name), element('span', labels[area.state], 'card-state'));
  const values = element('dl', undefined, 'card-values');
  values.append(...metricValues(area));
  const alerts = element('ul', undefined, 'active-alerts');
  renderAlerts(alerts, area.alerts);
  link.classList.toggle('alert-active', area.alerts.length > 0);
  link.append(header, values, element('p', readingTime(area), 'card-foot'), alerts);
  return link;
}

function collectorStatus(collector) {
  const status = byId('status');
  const notice = byId('notice');
  const delayed = collector?.checked_at && Date.now() / 1000 - collector.checked_at > collector.interval * 2 + 30;
  status.textContent = 'Waiting for collector';
  status.dataset.state = 'waiting';
  notice.hidden = true;
  byId('demo').hidden = !collector?.demo;
  byId('collector-detail').textContent = 'History is stored locally.';
  if (!collector) return;
  if (delayed || collector.error) {
    status.textContent = delayed ? 'Collection delayed' : 'Cloud check failed';
    status.dataset.state = 'warn';
    notice.textContent = collector.error || 'The collector has not checked in on schedule. Check that its container is running.';
    notice.hidden = false;
  } else if (collector.success_at) {
    status.textContent = collector.demo ? 'Demo running' : 'Cloud check OK';
    status.dataset.state = 'good';
  }
  if (collector.success_at) {
    const check = collector.demo ? 'Last demo update' : 'Last successful cloud check';
    byId('collector-detail').textContent = `${check} ${formatTime(collector.success_at)} · History stored locally`;
  }
}

function renderAreas(areas) {
  const area = areas.find((entry) => entry.slug === slug);
  const nextAreaData = JSON.stringify(areas);
  if (nextAreaData === areaData) return area;
  areaData = nextAreaData;
  const nav = byId('area-nav');
  const home = element('a', 'All areas');
  home.href = '/';
  if (!slug) home.setAttribute('aria-current', 'page');
  const focusedHref = nav.contains(document.activeElement) ? document.activeElement.href : null;
  nav.replaceChildren(home, ...areas.map(areaLink));
  nav.hidden = areas.length === 0;
  if (focusedHref) Array.from(nav.children).find((link) => link.href === focusedHref)?.focus();

  byId('overview').hidden = Boolean(area);
  byId('history').hidden = !area;
  byId('alert-settings').hidden = !area;
  byId('area-state').hidden = !area;
  byId('latest').hidden = !area;
  byId('hero').classList.toggle('alert-active', Boolean(area?.alerts.length));
  renderAlerts(byId('active-alerts'), area?.alerts || []);
  if (area) {
    document.title = `${area.name} · Shelly H&T`;
    byId('page-title').textContent = area.name;
    byId('area-state').textContent = labels[area.state];
    byId('hero-detail').textContent = readingTime(area);
    byId('latest').replaceChildren(...metricValues(area));
    if (!editingLimits) {
      for (const name of limitNames) limitForm.elements[name].value = area.limits[name] ?? '';
    }
  } else {
    byId('page-title').textContent = slug && areas.length ? 'Area not found' : 'Climate dashboard';
    byId('hero-detail').textContent = 'Temperature and humidity from Shelly H&T sensors.';
    const cards = byId('cards');
    const focusedCard = cards.contains(document.activeElement) ? document.activeElement.href : null;
    cards.replaceChildren(...areas.map(card));
    if (focusedCard) Array.from(cards.children).find((link) => link.href === focusedCard)?.focus();
    byId('empty').hidden = areas.length > 0;
    byId('empty').textContent = 'Waiting for sensors. Check the collector logs for details.';
  }
  return area;
}

async function getJSON(url, options) {
  const response = await fetch(url, options);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || 'The dashboard could not load data.');
  return body;
}

async function refresh() {
  const request = ++newestOverviewRequest;
  try {
    const data = await getJSON('/api/areas');
    if (request !== newestOverviewRequest) return;
    collectorStatus(data.collector);
    if (renderAreas(data.areas)) await loadHistory();
  } catch (error) {
    if (request !== newestOverviewRequest) return;
    byId('status').textContent = 'Dashboard unavailable';
    byId('status').dataset.state = 'warn';
    byId('notice').textContent = error.message;
    byId('notice').hidden = false;
    if (!areaData) byId('empty').hidden = true;
  }
}

limitForm.addEventListener('input', () => {
  editingLimits = true;
  byId('limit-result').textContent = '';
});

limitForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const limits = Object.fromEntries(limitNames.map((name) => {
    const input = limitForm.elements[name];
    return [name, input.value === '' ? null : input.valueAsNumber];
  }));
  const fields = byId('limit-fields');
  const result = byId('limit-result');
  fields.disabled = true;
  result.textContent = 'Saving thresholds…';
  try {
    await getJSON(`/api/areas/${slug}/limits`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(limits),
    });
    editingLimits = false;
    result.textContent = 'Thresholds saved.';
    refresh();
  } catch (error) {
    result.textContent = error.message;
  } finally {
    fields.disabled = false;
  }
});

function renderHistory(data) {
  history = data;
  byId('charts').hidden = !data.points.length;
  byId('reading-details').hidden = !data.points.length;
  if (!data.points.length) {
    byId('history-info').textContent = 'No readings in this range.';
    return;
  }

  const count = data.points.reduce((sum, point) => sum + point.count, 0);
  const countLabel = `${formatNumber(count, 0)} ${count === 1 ? 'report' : 'reports'}`;
  const bucketLabel = data.bucket === 0 ? '' : ` · Averaged in ${data.bucket / 3600}h windows`;
  byId('history-info').textContent = `${countLabel}${bucketLabel} · Times shown in your browser’s time zone`;
  const rows = data.points.slice(-25).reverse().map((point) => {
    const row = element('tr');
    const temperature = point.temperature === null ? '—' : `${formatNumber(point.temperature, 1)} °C`;
    const humidity = point.humidity === null ? '—' : `${formatNumber(point.humidity, 1)} %`;
    row.append(...[formatTime(point.at), temperature, humidity, point.count].map((value) => element('td', value)));
    return row;
  });
  byId('readings').replaceChildren(...rows);
  drawCharts();
}

async function loadHistory() {
  const request = ++newestHistoryRequest;
  try {
    const data = await getJSON(`/api/areas/${slug}/history?range=${range}`);
    if (request === newestHistoryRequest) renderHistory(data);
  } catch (error) {
    if (request === newestHistoryRequest) byId('history-info').textContent = error.message;
  }
}

function drawChart(key, data) {
  const canvas = byId(key);
  const bounds = canvas.getBoundingClientRect();
  const width = bounds.width;
  const height = bounds.height;
  if (!width || !height) return;
  const scale = window.devicePixelRatio || 1;
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);
  const colors = getComputedStyle(canvas);
  const line = colors.getPropertyValue('--line').trim();
  const muted = colors.getPropertyValue('--muted').trim();
  const series = colors.getPropertyValue('--series').trim();
  const points = data.points.filter((point) => point[key] !== null);
  ctx.fillStyle = muted;
  ctx.font = '13px system-ui';
  if (!points.length) {
    ctx.textAlign = 'center';
    ctx.fillText('No readings in this range', width / 2, height / 2);
    return;
  }

  const values = points.map((point) => point[key]);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const step = Math.max(1, Math.ceil((max - min) / 4));
  const low = Math.floor(min / step) * step;
  const high = Math.max(Math.ceil(max / step) * step, low + step * 2);
  const left = 42;
  const right = width - 12;
  const top = 12;
  const bottom = height - 31;
  const x = (at) => left + (at - data.start) / (data.end - data.start) * (right - left);
  const y = (value) => bottom - (value - low) / (high - low) * (bottom - top);

  ctx.strokeStyle = line;
  ctx.textAlign = 'right';
  for (let value = low; value <= high; value += step) {
    const row = y(value);
    ctx.beginPath();
    ctx.moveTo(left, row);
    ctx.lineTo(right, row);
    ctx.stroke();
    ctx.fillText(formatNumber(value, 0), left - 8, row + 4);
  }

  const duration = data.end - data.start;
  const options = duration <= 86400 ? { hour: 'numeric', minute: '2-digit' }
    : duration < 180 * 86400 ? { month: 'short', day: 'numeric' } : { month: 'short', year: '2-digit' };
  const axisLabel = new Intl.DateTimeFormat(undefined, options);
  const divisions = width < 360 ? 2 : 4;
  for (let mark = 0; mark <= divisions; mark += 1) {
    const at = data.start + mark * duration / divisions;
    ctx.textAlign = mark === 0 ? 'left' : mark === divisions ? 'right' : 'center';
    ctx.fillText(axisLabel.format(new Date(at * 1000)), x(at), height - 9);
  }

  ctx.strokeStyle = series;
  ctx.fillStyle = series;
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  let previous = null;
  const gap = Math.max(24 * 3600, data.bucket * 2);
  for (const point of data.points) {
    if (point[key] === null) {
      previous = null;
      continue;
    }
    if (previous !== null && point.at - previous <= gap) ctx.lineTo(x(point.at), y(point[key]));
    else ctx.moveTo(x(point.at), y(point[key]));
    previous = point.at;
  }
  ctx.stroke();
  for (const point of points) {
    ctx.beginPath();
    ctx.arc(x(point.at), y(point[key]), points.length < 75 ? 3 : 1.5, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawCharts() {
  if (!history?.points.length) return;
  drawChart('temperature', history);
  drawChart('humidity', history);
}

byId('ranges').addEventListener('click', (event) => {
  const nextRange = event.target.dataset.range;
  if (!nextRange || nextRange === range) return;
  range = nextRange;
  for (const button of byId('ranges').children) button.setAttribute('aria-pressed', button.dataset.range === range);
  history = null;
  byId('charts').hidden = true;
  byId('reading-details').hidden = true;
  byId('history-info').textContent = 'Loading readings…';
  loadHistory();
});
byId('refresh').addEventListener('click', refresh);
window.addEventListener('resize', drawCharts);
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', drawCharts);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
window.setInterval(() => { if (!document.hidden) refresh(); }, 30_000);
refresh();
