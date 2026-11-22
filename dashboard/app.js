'use strict';

const byId = (id) => document.getElementById(id);
const slug = window.location.pathname.split('/')[2] || '';
const SVG = 'http://www.w3.org/2000/svg';
const limitNames = ['temperature_min', 'temperature_max', 'humidity_min', 'humidity_max'];
const limitForm = byId('limit-form');
// States worth pointing out; "awake" and "reported" are a sensor's normal rhythm.
const stateNotes = {
  waiting: 'Waiting for the first report.',
  missing: 'Not found in the Shelly Cloud response.',
  'no-readings': 'Shelly Cloud returned no valid reading.',
};
const rangeText = {
  '24h': 'in the last 24 hours',
  '7d': 'in the last 7 days',
  '30d': 'in the last 30 days',
  '1y': 'in the last year',
  all: 'since recording started',
};
// Temperature colour scale, cold to warm. Used for marks only, never for text.
const TEMP_STOPS = [
  [-10, [53, 82, 201]], [0, [61, 134, 230]], [10, [79, 176, 198]],
  [17, [233, 185, 73]], [22, [239, 138, 60]], [30, [217, 72, 59]],
];
const SPARK_MAX_AGE = 5 * 60_000;

const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const shortDateTime = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const clock = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
const formatTime = (at) => dateTime.format(new Date(at * 1000));
const formatNumber = (value, digits) => value.toLocaleString(undefined, { maximumFractionDigits: digits });
// Temperatures always show one decimal so values line up: 19.0, not 19.
const formatTemp = (value) => value.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const areaUrl = (area) => `/areas/${area.slug}/`;

let range = '7d';
let newestHistoryRequest = 0;
let newestOverviewRequest = 0;
let history = null;
let currentArea = null;
let lastAreas = [];
let editingLimits = false;
const sparks = new Map();
const hover = { temperature: null, humidity: null };
const chartGeometry = {};

function element(tag, text, className = '') {
  const node = document.createElement(tag);
  if (text !== undefined && text !== null) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function withUnit(node, value, digits, unit) {
  if (value === null || value === undefined) {
    node.textContent = '—';
    return node;
  }
  const text = unit.trim() === '°C' ? formatTemp(value) : formatNumber(value, digits);
  node.replaceChildren(text, element('span', unit, 'unit'));
  return node;
}

function tempColor(value) {
  if (value === null || value === undefined) return '';
  const stops = TEMP_STOPS;
  if (value <= stops[0][0]) return `rgb(${stops[0][1]})`;
  for (let index = 1; index < stops.length; index += 1) {
    const [t1, c1] = stops[index];
    const [t0, c0] = stops[index - 1];
    if (value <= t1) {
      const mix = (value - t0) / (t1 - t0);
      return `rgb(${c0.map((channel, i) => Math.round(channel + (c1[i] - channel) * mix)).join(',')})`;
    }
  }
  return `rgb(${stops[stops.length - 1][1]})`;
}

function temperatureScale(values) {
  const known = values.filter((value) => value !== null && value !== undefined);
  const low = Math.min(-10, Math.floor((Math.min(...known, 0) - 2) / 5) * 5);
  const high = Math.max(30, Math.ceil((Math.max(...known, 0) + 2) / 5) * 5);
  const position = (value) => Math.min(100, Math.max(0, (value - low) / (high - low) * 100));
  const stops = [[low], ...TEMP_STOPS.filter(([t]) => t > low && t < high), [high]]
    .map(([t]) => `${tempColor(t)} ${position(t).toFixed(1)}%`);
  return { low, high, position, gradient: `linear-gradient(90deg, ${stops.join(', ')})` };
}

function age(at) {
  const seconds = Math.max(0, Date.now() / 1000 - at);
  if (seconds < 90) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 6 && minutes % 60) return `${hours} h ${minutes % 60} min ago`;
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? 'yesterday' : `${days} days ago`;
}

function readingTime(area) {
  if (area.at === null) return 'No readings archived yet.';
  const prefix = area.report_time === null ? 'First seen' : 'Reported';
  return `${prefix} ${formatTime(area.at)}, ${age(area.at)}.`;
}

function alertText({ metric, value, direction, limit }) {
  const [name, unit] = metric === 'temperature' ? ['Temperature', '°C'] : ['Humidity', '%'];
  return `${name} ${formatNumber(value, 1)} ${unit} is ${direction} the ${formatNumber(limit, 1)} ${unit} limit.`;
}

function renderAlerts(list, alerts) {
  list.replaceChildren(...alerts.map((alert) => {
    const item = element('li', alertText(alert));
    item.title = `Reading from ${formatTime(alert.at)}`;
    return item;
  }));
  list.hidden = alerts.length === 0;
}

function meter(node, value, limits) {
  node.style.setProperty('--value', `${value === null ? 0 : Math.min(100, Math.max(0, value))}%`);
  node.querySelectorAll('.meter-limit').forEach((tick) => tick.remove());
  for (const limit of [limits.humidity_min, limits.humidity_max]) {
    if (limit === null || limit <= 0 || limit >= 100) continue;
    const tick = element('span', undefined, 'meter-limit');
    tick.style.left = `${limit}%`;
    node.append(tick);
  }
}

/* Overview */

function sparkline(points) {
  const values = points.filter((point) => point.temperature !== null);
  if (values.length < 2) return element('p', 'Not enough readings for a 24-hour trend yet.', 'spark-empty');
  const min = Math.min(...values.map((point) => point.temperature));
  const max = Math.max(...values.map((point) => point.temperature));
  const pad = Math.max(0.5, (max - min) * 0.15);
  const start = values[0].at;
  const end = values[values.length - 1].at;
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('class', 'spark');
  svg.setAttribute('viewBox', '0 0 100 40');
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('aria-hidden', 'true');
  const line = document.createElementNS(SVG, 'polyline');
  line.setAttribute('class', 'spark-line');
  line.setAttribute('points', values.map((point) => {
    const x = end === start ? 0 : (point.at - start) / (end - start) * 100;
    const y = 40 - (point.temperature - (min - pad)) / (max - min + pad * 2) * 40;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  }).join(' '));
  svg.append(line);
  return svg;
}

function card(area) {
  const link = element('a', undefined, 'card');
  link.href = areaUrl(area);
  link.style.setProperty('--temp', tempColor(area.temperature));
  link.classList.toggle('alert-active', area.alerts.length > 0);

  const head = element('div', undefined, 'card-head');
  const when = element('span', area.at === null ? 'No readings' : age(area.at), 'card-age');
  if (area.at !== null) when.title = readingTime(area);
  head.append(element('h3', area.name), when);

  const temp = withUnit(element('p', undefined, 'card-temp'), area.temperature, 1, '°C');
  const spark = sparks.get(area.slug);
  const trend = spark?.loaded ? sparkline(spark.points) : element('p', 'Loading 24-hour trend…', 'spark-empty');

  const meta = element('dl', undefined, 'card-meta');
  const humidity = element('div');
  const humidityMeter = element('div', undefined, 'meter');
  humidityMeter.append(element('span', undefined, 'meter-fill'));
  meter(humidityMeter, area.humidity, area.limits);
  humidity.append(element('dt', 'Humidity'), withUnit(element('dd'), area.humidity, 1, ' %'), humidityMeter);
  const battery = element('div', undefined, 'battery-value');
  battery.append(element('dt', 'Battery'), withUnit(element('dd'), area.battery, 0, ' %'));
  meta.append(humidity, battery);

  link.append(head, temp, trend, meta);
  if (stateNotes[area.state]) link.append(element('p', stateNotes[area.state], 'card-state'));
  if (area.alerts.length) {
    const alerts = element('ul', undefined, 'alert-list');
    renderAlerts(alerts, area.alerts);
    link.append(alerts);
  }
  return link;
}

function renderThermo(areas) {
  const section = byId('thermo');
  const withTemp = areas.filter((area) => area.temperature !== null);
  section.hidden = withTemp.length === 0;
  if (!withTemp.length) return;
  const spans = withTemp.map((area) => {
    const values = (sparks.get(area.slug)?.points || []).map((point) => point.temperature).filter((v) => v !== null);
    return values.length > 1 ? [Math.min(...values), Math.max(...values)] : null;
  });
  const scale = temperatureScale([...withTemp.map((area) => area.temperature), ...spans.flat().filter((v) => v !== null && v !== undefined)]);
  section.style.setProperty('--scale-gradient', scale.gradient);

  const step = scale.high - scale.low > 40 ? 10 : 5;
  const ticks = [];
  for (let value = Math.ceil(scale.low / step) * step; value <= scale.high; value += step) {
    if (step === 5 && value % 10 !== 0) continue;
    const tick = element('span', `${value}°`);
    tick.style.left = `${scale.position(value)}%`;
    ticks.push(tick);
  }
  byId('thermo-scale').replaceChildren(...ticks);

  byId('thermo-rows').replaceChildren(...withTemp.map((area, index) => {
    const row = element('li', undefined, 'thermo-row');
    row.style.setProperty('--temp', tempColor(area.temperature));
    const name = element('a', area.name, 'thermo-name');
    name.href = areaUrl(area);
    const track = element('div', undefined, 'thermo-track');
    if (spans[index]) {
      const [low, high] = spans[index];
      const span = element('span', undefined, 'thermo-span');
      span.style.left = `${scale.position(low)}%`;
      span.style.width = `${Math.max(0.8, scale.position(high) - scale.position(low))}%`;
      span.title = `${formatTemp(low)} to ${formatTemp(high)} °C in the last 24 hours`;
      track.append(span);
    }
    const dot = element('span', undefined, 'thermo-dot');
    dot.style.left = `${scale.position(area.temperature)}%`;
    track.append(dot);
    const value = withUnit(element('span', undefined, 'thermo-value'), area.temperature, 1, '°C');
    row.append(name, track, value);
    return row;
  }));
  byId('thermo-legend').hidden = !spans.some(Boolean);
}

function renderOverview(areas) {
  const withTemp = areas.filter((area) => area.temperature !== null);
  let detail = 'Temperature and humidity from your Shelly H&T sensors.';
  if (withTemp.length > 1) {
    const sorted = [...withTemp].sort((a, b) => b.temperature - a.temperature);
    const warm = sorted[0];
    const cold = sorted[sorted.length - 1];
    detail = `${areas.length} rooms. Warmest is ${warm.name} at ${formatTemp(warm.temperature)} °C, `
      + `coldest is ${cold.name} at ${formatTemp(cold.temperature)} °C.`;
  }
  byId('page-detail').textContent = detail;
  renderThermo(areas);

  const alerts = areas.reduce((sum, area) => sum + area.alerts.length, 0);
  const summary = byId('alert-summary');
  summary.textContent = alerts ? `${alerts} ${alerts === 1 ? 'alert' : 'alerts'} active` : 'No alerts';
  summary.dataset.state = alerts ? 'alert' : 'ok';

  const cards = byId('cards');
  const focused = cards.contains(document.activeElement) ? document.activeElement.href : null;
  cards.replaceChildren(...areas.map(card));
  if (focused) Array.from(cards.children).find((link) => link.href === focused)?.focus();
  byId('empty').hidden = areas.length > 0;
  byId('empty').textContent = 'Waiting for sensors. Check the collector logs for details.';
  loadSparks(areas);
}

async function loadSparks(areas) {
  const now = Date.now();
  const stale = areas.filter((area) => {
    const cached = sparks.get(area.slug);
    return !cached || cached.at !== area.at || now - cached.fetchedAt > SPARK_MAX_AGE;
  });
  if (!stale.length) return;
  for (const area of stale) {
    const previous = sparks.get(area.slug) || { points: [], loaded: false };
    sparks.set(area.slug, { ...previous, at: area.at, fetchedAt: now });
  }
  const results = await Promise.allSettled(stale.map((area) => getJSON(`/api/areas/${area.slug}/history?range=24h`)));
  results.forEach((result, index) => {
    const entry = sparks.get(stale[index].slug);
    if (entry?.fetchedAt !== now) return;
    if (result.status === 'fulfilled') Object.assign(entry, { points: result.value.points, loaded: true });
    else entry.loaded = true;
  });
  if (!slug) renderOverview(lastAreas);
}

/* Room page */

function renderArea(area) {
  currentArea = area;
  document.title = `${area.name}, Climate at home`;
  byId('area-title').textContent = area.name;
  byId('area-detail').textContent = [readingTime(area), stateNotes[area.state]].filter(Boolean).join(' ');
  byId('area-alerts').hidden = area.alerts.length === 0;
  renderAlerts(byId('active-alerts'), area.alerts);

  withUnit(byId('area-temperature'), area.temperature, 1, '°C');
  withUnit(byId('area-humidity'), area.humidity, 1, '%');
  withUnit(byId('area-battery'), area.battery, 0, '%');
  meter(byId('area-humidity-meter'), area.humidity, area.limits);
  const fill = byId('area-battery-fill');
  fill.style.setProperty('--value', `${area.battery ?? 0}%`);
  fill.toggleAttribute('data-low', area.battery !== null && area.battery < 20);
  renderAreaScale();

  if (!editingLimits) {
    for (const name of limitNames) limitForm.elements[name].value = area.limits[name] ?? '';
  }
}

function renderAreaScale() {
  const area = currentArea;
  const dot = byId('area-temperature-dot');
  dot.hidden = area?.temperature === null || area?.temperature === undefined;
  if (dot.hidden) return;
  const values = (history?.points || []).map((point) => point.temperature);
  const scale = temperatureScale([area.temperature, ...values]);
  byId('area-scale').style.setProperty('--scale-gradient', scale.gradient);
  dot.style.left = `${scale.position(area.temperature)}%`;
  dot.style.setProperty('--temp', tempColor(area.temperature));
}

function extremes(points, key) {
  let low = null;
  let high = null;
  for (const point of points) {
    if (point[key] === null) continue;
    if (!low || point[key] < low[key]) low = point;
    if (!high || point[key] > high[key]) high = point;
  }
  return low && { low, high };
}

function renderPeriod() {
  const points = history?.points || [];
  const when = rangeText[range];
  const averaged = Boolean(history?.bucket);
  const average = averaged ? ' average' : '';
  const temp = extremes(points, 'temperature');
  const humid = extremes(points, 'humidity');
  byId('period-temperature').textContent = temp
    ? `Low${average} ${formatTemp(temp.low.temperature)} °C (${shortDateTime.format(new Date(temp.low.at * 1000))}), `
      + `high${average} ${formatTemp(temp.high.temperature)} °C (${shortDateTime.format(new Date(temp.high.at * 1000))}) ${when}.`
    : '';
  byId('period-humidity').textContent = humid
    ? `${averaged ? 'Averages between' : 'Between'} ${formatNumber(humid.low.humidity, 0)} and ${formatNumber(humid.high.humidity, 0)} % ${when}.`
    : '';
}

/* Data loading */

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
    status.textContent = `${collector.demo ? 'Demo updated' : 'Checked'} ${clock.format(new Date(collector.success_at * 1000))}`;
    status.dataset.state = 'good';
  }
  if (collector.success_at) {
    const check = collector.demo ? 'Last demo update' : 'Last successful Shelly Cloud check';
    byId('collector-detail').textContent = `${check} ${formatTime(collector.success_at)}. History is stored locally.`;
  }
}

function renderNav(areas) {
  const nav = byId('area-nav');
  const focused = nav.contains(document.activeElement) ? document.activeElement.href : null;
  const home = element('a', 'Overview');
  home.href = '/';
  if (!slug) home.setAttribute('aria-current', 'page');
  nav.replaceChildren(home, ...areas.map((area) => {
    const link = element('a', area.name);
    link.href = areaUrl(area);
    if (area.slug === slug) link.setAttribute('aria-current', 'page');
    return link;
  }));
  nav.hidden = areas.length === 0;
  if (focused) Array.from(nav.children).find((link) => link.href === focused)?.focus();
}

function render(areas) {
  lastAreas = areas;
  const area = areas.find((entry) => entry.slug === slug);
  renderNav(areas);
  byId('overview').hidden = Boolean(slug);
  byId('area').hidden = !slug;
  for (const id of ['area-readout', 'history', 'alert-settings']) byId(id).hidden = !area;
  if (area) renderArea(area);
  else if (slug) {
    byId('area-alerts').hidden = true;
    byId('area-title').textContent = areas.length ? 'Room not found' : 'Loading room…';
    byId('area-detail').textContent = areas.length ? 'Choose a room from the list above.' : '';
  } else renderOverview(areas);
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
  const button = byId('refresh');
  button.setAttribute('aria-busy', 'true');
  try {
    const data = await getJSON('/api/areas');
    if (request !== newestOverviewRequest) return;
    collectorStatus(data.collector);
    if (render(data.areas)) await loadHistory();
  } catch (error) {
    if (request !== newestOverviewRequest) return;
    byId('status').textContent = 'Dashboard unavailable';
    byId('status').dataset.state = 'warn';
    byId('notice').textContent = error.message;
    byId('notice').hidden = false;
    if (!lastAreas.length) byId('empty').hidden = true;
  } finally {
    if (request === newestOverviewRequest) button.removeAttribute('aria-busy');
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
  result.textContent = 'Saving limits…';
  try {
    await getJSON(`/api/areas/${slug}/limits`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(limits),
    });
    editingLimits = false;
    result.textContent = 'Limits saved.';
    refresh();
  } catch (error) {
    result.textContent = error.message;
  } finally {
    fields.disabled = false;
  }
});

/* History */

function renderHistory(data) {
  history = data;
  const has = data.points.length > 0;
  byId('charts').hidden = !has;
  byId('reading-details').hidden = !has;
  renderPeriod();
  renderAreaScale();
  if (!has) {
    byId('history-info').textContent = `No readings ${rangeText[range]}.`;
    return;
  }
  const count = data.points.reduce((sum, point) => sum + point.count, 0);
  const reports = `${formatNumber(count, 0)} ${count === 1 ? 'report' : 'reports'} ${rangeText[range]}`;
  const hours = data.bucket / 3600;
  const bucket = data.bucket === 0 ? '' : `, averaged per ${hours === 1 ? 'hour' : `${hours} hours`}`;
  byId('history-info').textContent = `${reports}${bucket}. Times are in your browser’s time zone.`;
  byId('readings').replaceChildren(...data.points.slice(-25).reverse().map((point) => {
    const row = element('tr');
    const temperature = point.temperature === null ? '—' : `${formatTemp(point.temperature)} °C`;
    const humidity = point.humidity === null ? '—' : `${formatNumber(point.humidity, 1)} %`;
    row.append(...[formatTime(point.at), temperature, humidity, point.count].map((value) => element('td', value)));
    return row;
  }));
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

function niceStep(span) {
  const raw = span / 4;
  const power = 10 ** Math.floor(Math.log10(raw || 1));
  return [1, 2, 2.5, 5, 10].map((m) => m * power).find((step) => step >= raw) || power * 10;
}

function drawChart(key) {
  const canvas = byId(key);
  const tip = byId(`${key}-tip`);
  const bounds = canvas.getBoundingClientRect();
  const width = bounds.width;
  const height = bounds.height;
  if (!width || !height || !history) return;
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  const ctx = canvas.getContext('2d');
  ctx.scale(ratio, ratio);
  const style = getComputedStyle(canvas);
  const css = (name) => style.getPropertyValue(name).trim();
  const font = getComputedStyle(document.body).fontFamily;
  const points = history.points.filter((point) => point[key] !== null);
  ctx.font = `500 12px ${font}`;
  ctx.fillStyle = css('--faint');
  if (!points.length) {
    ctx.textAlign = 'center';
    ctx.fillText(`No ${key} readings ${rangeText[range]}`, width / 2, height / 2);
    chartGeometry[key] = null;
    tip.hidden = true;
    return;
  }

  const unit = key === 'temperature' ? '°C' : '%';
  const limits = currentArea?.limits || {};
  const limitMin = limits[`${key}_min`];
  const limitMax = limits[`${key}_max`];
  const values = points.map((point) => point[key]);
  let min = Math.min(...values);
  let max = Math.max(...values);
  // Bring a limit into view when it is near the data, so it can be seen against the line.
  const reach = Math.max(key === 'temperature' ? 5 : 10, max - min);
  for (const limit of [limitMin, limitMax]) {
    if (limit === null || limit === undefined) continue;
    if (limit >= min - reach && limit <= max + reach) {
      min = Math.min(min, limit);
      max = Math.max(max, limit);
    }
  }
  const least = key === 'temperature' ? 2 : 6;
  if (max - min < least) {
    const mid = (max + min) / 2;
    min = mid - least / 2;
    max = mid + least / 2;
  }
  const step = niceStep(max - min);
  const low = Math.floor(min / step) * step;
  const high = Math.ceil(max / step) * step;
  const left = 40;
  const right = width - 8;
  const top = 10;
  const bottom = height - 28;
  const x = (at) => left + (at - history.start) / (history.end - history.start) * (right - left);
  const y = (value) => bottom - (value - low) / (high - low) * (bottom - top);
  chartGeometry[key] = { x, points };

  // Grid and axis labels.
  ctx.strokeStyle = css('--line');
  ctx.lineWidth = 1;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (let value = low; value <= high + step / 2; value += step) {
    const row = Math.round(y(value)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(left, row);
    ctx.lineTo(right, row);
    ctx.stroke();
    ctx.fillText(formatNumber(value, step < 1 ? 1 : 0), left - 8, row);
  }
  const duration = history.end - history.start;
  const options = duration <= 86400 ? { hour: '2-digit', minute: '2-digit' }
    : duration < 180 * 86400 ? { day: 'numeric', month: 'short' } : { month: 'short', year: 'numeric' };
  const axis = new Intl.DateTimeFormat(undefined, options);
  const divisions = width < 420 ? 2 : 4;
  ctx.textBaseline = 'alphabetic';
  for (let mark = 0; mark <= divisions; mark += 1) {
    const at = history.start + mark * duration / divisions;
    ctx.textAlign = mark === 0 ? 'left' : mark === divisions ? 'right' : 'center';
    ctx.fillText(axis.format(new Date(at * 1000)), x(at), height - 6);
  }

  // Alert limits: shade the out-of-range side and draw a dashed line.
  const alert = css('--alert');
  for (const [limit, above] of [[limitMax, true], [limitMin, false]]) {
    if (limit === null || limit === undefined || limit < low || limit > high) continue;
    const row = y(limit);
    ctx.save();
    ctx.globalAlpha = 0.07;
    ctx.fillStyle = alert;
    if (above) ctx.fillRect(left, top, right - left, row - top);
    else ctx.fillRect(left, row, right - left, bottom - row);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = alert;
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    ctx.moveTo(left, row);
    ctx.lineTo(right, row);
    ctx.stroke();
    ctx.restore();
    ctx.fillStyle = alert;
    ctx.textAlign = 'right';
    ctx.fillText(`Alert ${above ? 'above' : 'below'} ${formatNumber(limit, 1)} ${unit}`, right - 4, above ? row - 6 : row + 16);
  }

  // The series line, broken across long gaps between reports.
  let stroke = css('--humidity');
  if (key === 'temperature') {
    stroke = ctx.createLinearGradient(0, y(low), 0, y(high));
    for (let i = 0; i <= 8; i += 1) stroke.addColorStop(i / 8, tempColor(low + (high - low) * i / 8));
  }
  ctx.strokeStyle = stroke;
  ctx.fillStyle = stroke;
  ctx.lineWidth = 2.25;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.beginPath();
  let previous = null;
  const gap = Math.max(24 * 3600, history.bucket * 2);
  for (const point of history.points) {
    if (point[key] === null) {
      previous = null;
      continue;
    }
    if (previous !== null && point.at - previous <= gap) ctx.lineTo(x(point.at), y(point[key]));
    else ctx.moveTo(x(point.at), y(point[key]));
    previous = point.at;
  }
  ctx.stroke();
  if (points.length < 60) {
    for (const point of points) {
      ctx.beginPath();
      ctx.arc(x(point.at), y(point[key]), 2.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Hover crosshair and value.
  const point = hover[key];
  if (point) {
    const px = x(point.at);
    const py = y(point[key]);
    ctx.strokeStyle = css('--line-strong');
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(Math.round(px) + 0.5, top);
    ctx.lineTo(Math.round(px) + 0.5, bottom);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(px, py, 5, 0, Math.PI * 2);
    ctx.fillStyle = key === 'temperature' ? tempColor(point[key]) : css('--humidity');
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = css('--surface');
    ctx.stroke();
    tip.replaceChildren(element('strong', `${formatNumber(point[key], 1)} ${unit}`), ` ${shortDateTime.format(new Date(point.at * 1000))}`);
    tip.hidden = false;
    const half = tip.offsetWidth / 2;
    tip.style.left = `${Math.min(width - half, Math.max(half, px))}px`;
    tip.style.top = `${Math.max(0, py - tip.offsetHeight - 12)}px`;
  } else {
    tip.hidden = true;
  }
}

function drawCharts() {
  if (!history?.points.length) return;
  drawChart('temperature');
  drawChart('humidity');
}

for (const key of ['temperature', 'humidity']) {
  const canvas = byId(key);
  canvas.addEventListener('pointermove', (event) => {
    const geometry = chartGeometry[key];
    if (!geometry) return;
    const offset = event.clientX - canvas.getBoundingClientRect().left;
    let nearest = null;
    for (const point of geometry.points) {
      if (!nearest || Math.abs(geometry.x(point.at) - offset) < Math.abs(geometry.x(nearest.at) - offset)) nearest = point;
    }
    if (nearest !== hover[key]) {
      hover[key] = nearest;
      drawChart(key);
    }
  });
  canvas.addEventListener('pointerleave', () => {
    hover[key] = null;
    drawChart(key);
  });
}

byId('ranges').addEventListener('click', (event) => {
  const nextRange = event.target.closest('button')?.dataset.range;
  if (!nextRange || nextRange === range) return;
  range = nextRange;
  for (const button of byId('ranges').children) button.setAttribute('aria-pressed', button.dataset.range === range);
  history = null;
  hover.temperature = null;
  hover.humidity = null;
  byId('charts').hidden = true;
  byId('reading-details').hidden = true;
  byId('history-info').textContent = 'Loading readings…';
  loadHistory();
});
byId('overview').hidden = Boolean(slug);
byId('area').hidden = !slug;
byId('refresh').addEventListener('click', refresh);
window.addEventListener('resize', drawCharts);
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', drawCharts);
document.fonts?.ready.then(drawCharts);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
window.setInterval(() => { if (!document.hidden) refresh(); }, 30_000);
refresh();
