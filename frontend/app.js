/**
 * Stock Pulse — Dashboard Application
 *
 * Fetches stock data from the API Gateway, renders cards with sparklines,
 * and provides a detail view with 7-day price/range charts.
 */

// ── Configuration ───────────────────────────────────────────
// Replace with your API Gateway URL after deployment
const API_BASE_URL = window.STOCK_PULSE_API_URL || '';
const REFRESH_INTERVAL_MS = 60_000; // 60 seconds
const SYMBOLS_ORDER = ['AAPL', 'GOOGL', 'MSFT', 'AMZN', 'TSLA'];

// ── State ───────────────────────────────────────────────────
let stocksData = [];
let refreshTimer = null;
let priceChartInstance = null;
let rangeChartInstance = null;

// ── DOM Elements ────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const loadingOverlay = $('loadingOverlay');
const errorBanner = $('errorBanner');
const errorText = $('errorText');
const cardsGrid = $('cardsGrid');
const detailPanel = $('detailPanel');
const lastUpdated = $('lastUpdated');
const refreshBtn = $('refreshBtn');
const trackedCount = $('trackedCount');
const bullishCount = $('bullishCount');
const bearishCount = $('bearishCount');
const marketStatus = $('marketStatus');

// ── Utility Functions ───────────────────────────────────────

function formatPrice(price) {
    if (price == null) return '—';
    return '$' + Number(price).toLocaleString('en-US', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    });
}

function formatChange(change, percent) {
    const sign = change >= 0 ? '+' : '';
    return `${sign}${Number(change).toFixed(2)} (${sign}${Number(percent).toFixed(2)}%)`;
}

function formatTime(isoString) {
    if (!isoString) return '--:--:--';
    const d = new Date(isoString);
    return d.toLocaleTimeString('en-US', { hour12: true, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function formatDateTime(timestamp) {
    const d = new Date(timestamp * 1000);
    return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function getChangeClass(value) {
    if (value > 0) return 'positive';
    if (value < 0) return 'negative';
    return 'zero';
}

// ── API Functions ───────────────────────────────────────────

async function fetchLatestStocks() {
    const resp = await fetch(`${API_BASE_URL}/stocks`);
    if (!resp.ok) throw new Error(`API error: ${resp.status}`);
    return resp.json();
}

async function fetchSymbolHistory(symbol) {
    const resp = await fetch(`${API_BASE_URL}/stocks/${symbol}/history`);
    if (!resp.ok) throw new Error(`API error: ${resp.status}`);
    return resp.json();
}

async function fetchSymbolRecent(symbol) {
    const resp = await fetch(`${API_BASE_URL}/stocks/${symbol}`);
    if (!resp.ok) throw new Error(`API error: ${resp.status}`);
    return resp.json();
}

// ── Demo Data (for local development / preview) ─────────────

function generateDemoData() {
    const symbols = SYMBOLS_ORDER;
    const basePrices = { AAPL: 189.84, GOOGL: 174.13, MSFT: 411.22, AMZN: 186.43, TSLA: 196.37 };
    const now = Date.now() / 1000;

    return {
        stocks: symbols.map((symbol) => {
            const base = basePrices[symbol];
            const change = (Math.random() - 0.45) * base * 0.03;
            const changePct = (change / base) * 100;
            const open = base - (Math.random() - 0.5) * 2;
            const high = Math.max(base, open) + Math.random() * 3;
            const low = Math.min(base, open) - Math.random() * 3;

            return {
                symbol,
                current_price: base + change,
                change: change,
                change_percent: changePct,
                open,
                high,
                low,
                previous_close: base,
                intraday_range: high - low,
                signal: changePct > 0.5 ? 'bullish' : changePct < -0.5 ? 'bearish' : 'neutral',
                market_open: true,
                day_of_week: 'Monday',
                ingestion_time: new Date().toISOString(),
            };
        }),
        count: symbols.length,
        timestamp: new Date().toISOString(),
    };
}

function generateDemoHistory(symbol) {
    const basePrice = { AAPL: 189.84, GOOGL: 174.13, MSFT: 411.22, AMZN: 186.43, TSLA: 196.37 }[symbol] || 150;
    const now = Math.floor(Date.now() / 1000);
    const data = [];

    // 7 days * 12 data points per hour (5-min intervals during market hours ~7h)
    for (let d = 6; d >= 0; d--) {
        const dayStart = now - d * 86400;
        for (let h = 0; h < 84; h++) { // ~84 five-min intervals in 7h
            const ts = dayStart - 86400 + 34200 + h * 300; // 9:30 AM start
            const noise = (Math.random() - 0.5) * basePrice * 0.01;
            const trend = Math.sin(d * 0.5 + h * 0.05) * basePrice * 0.015;
            const price = basePrice + trend + noise;
            const high = price + Math.random() * 2;
            const low = price - Math.random() * 2;

            data.push({
                sk: ts,
                symbol,
                current_price: price,
                high,
                low,
                open: price - noise * 0.5,
                intraday_range: high - low,
                change_percent: ((noise + trend) / basePrice) * 100,
                signal: noise > 0 ? 'bullish' : 'bearish',
                ingestion_time: new Date(ts * 1000).toISOString(),
            });
        }
    }

    return { symbol, data, count: data.length, period: '7d' };
}

// ── Render Functions ────────────────────────────────────────

function renderStockCard(stock) {
    const changeClass = getChangeClass(stock.change);
    const signalClass = stock.signal || 'neutral';

    return `
        <div class="stock-card ${signalClass}" onclick="showDetail('${stock.symbol}')" data-symbol="${stock.symbol}">
            <div class="card-top">
                <span class="card-symbol">${stock.symbol}</span>
                <span class="card-signal">${stock.signal || 'neutral'}</span>
            </div>
            <div class="card-price">${formatPrice(stock.current_price)}</div>
            <div class="card-change">
                <span class="change-value ${changeClass}">${stock.change >= 0 ? '+' : ''}${Number(stock.change).toFixed(2)}</span>
                <span class="change-badge ${changeClass}">${stock.change_percent >= 0 ? '+' : ''}${Number(stock.change_percent).toFixed(2)}%</span>
            </div>
            <canvas class="card-sparkline" id="spark-${stock.symbol}"></canvas>
            <div class="card-meta">
                <div class="meta-item">
                    <span class="meta-label">Open</span>
                    <span class="meta-value">${formatPrice(stock.open)}</span>
                </div>
                <div class="meta-item">
                    <span class="meta-label">High</span>
                    <span class="meta-value">${formatPrice(stock.high)}</span>
                </div>
                <div class="meta-item">
                    <span class="meta-label">Low</span>
                    <span class="meta-value">${formatPrice(stock.low)}</span>
                </div>
                <div class="meta-item">
                    <span class="meta-label">Prev Close</span>
                    <span class="meta-value">${formatPrice(stock.previous_close)}</span>
                </div>
            </div>
        </div>
    `;
}

function renderCards(stocks) {
    // Sort by SYMBOLS_ORDER
    const sorted = [...stocks].sort(
        (a, b) => SYMBOLS_ORDER.indexOf(a.symbol) - SYMBOLS_ORDER.indexOf(b.symbol)
    );

    cardsGrid.innerHTML = sorted.map(renderStockCard).join('');

    // Render sparklines after DOM update
    sorted.forEach((stock) => renderSparkline(stock));
}

function renderSparkline(stock) {
    const canvas = document.getElementById(`spark-${stock.symbol}`);
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    const isPositive = stock.change >= 0;

    // Generate mini data from what we have (or fake for demo)
    const points = [];
    const base = stock.current_price;
    for (let i = 0; i < 20; i++) {
        const noise = (Math.random() - 0.5) * base * 0.008;
        const trend = isPositive
            ? (i / 20) * stock.change * 0.8
            : (i / 20) * stock.change * 0.8;
        points.push(base - stock.change + trend + noise);
    }
    points.push(stock.current_price);

    const color = isPositive ? '#34d399' : '#f87171';
    const gradient = ctx.createLinearGradient(0, 0, 0, 60);
    gradient.addColorStop(0, isPositive ? 'rgba(52,211,153,0.15)' : 'rgba(248,113,113,0.15)');
    gradient.addColorStop(1, 'rgba(0,0,0,0)');

    new Chart(ctx, {
        type: 'line',
        data: {
            labels: points.map((_, i) => i),
            datasets: [{
                data: points,
                borderColor: color,
                borderWidth: 2,
                backgroundColor: gradient,
                fill: true,
                pointRadius: 0,
                tension: 0.4,
            }],
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: false }, tooltip: { enabled: false } },
            scales: {
                x: { display: false },
                y: { display: false },
            },
            animation: { duration: 800 },
        },
    });
}

function updateSummaryBar(stocks) {
    const bullish = stocks.filter((s) => s.signal === 'bullish').length;
    const bearish = stocks.filter((s) => s.signal === 'bearish').length;
    const marketOpen = stocks.some((s) => s.market_open);

    trackedCount.textContent = stocks.length;
    bullishCount.textContent = bullish;
    bearishCount.textContent = bearish;
    marketStatus.textContent = marketOpen ? '🟢 Open' : '🔴 Closed';
    marketStatus.style.color = marketOpen ? 'var(--green)' : 'var(--red)';
}

// ── Detail View ─────────────────────────────────────────────

async function showDetail(symbol) {
    cardsGrid.style.display = 'none';
    detailPanel.style.display = 'block';

    const stock = stocksData.find((s) => s.symbol === symbol);
    if (!stock) return;

    // Update header
    $('detailSymbol').textContent = symbol;
    $('detailPrice').textContent = formatPrice(stock.current_price);

    const detailChange = $('detailChange');
    detailChange.textContent = formatChange(stock.change, stock.change_percent);
    detailChange.className = `detail-change ${getChangeClass(stock.change)}`;

    const detailSignal = $('detailSignal');
    detailSignal.textContent = stock.signal;
    detailSignal.className = `detail-signal ${stock.signal}`;

    // Render metrics
    const metricsHTML = [
        { label: 'Open', value: formatPrice(stock.open) },
        { label: 'High', value: formatPrice(stock.high) },
        { label: 'Low', value: formatPrice(stock.low) },
        { label: 'Prev Close', value: formatPrice(stock.previous_close) },
        { label: 'Intraday Range', value: `$${Number(stock.intraday_range).toFixed(2)}` },
        { label: 'Day', value: stock.day_of_week || '—' },
    ]
        .map(
            (m) => `
        <div class="metric-card">
            <div class="metric-label">${m.label}</div>
            <div class="metric-value">${m.value}</div>
        </div>
    `
        )
        .join('');
    $('detailMetrics').innerHTML = metricsHTML;

    // Fetch and render charts
    try {
        let historyData;
        if (API_BASE_URL) {
            const resp = await fetchSymbolHistory(symbol);
            historyData = resp;
        } else {
            historyData = generateDemoHistory(symbol);
        }
        renderDetailCharts(historyData);
    } catch (err) {
        console.error('Failed to fetch history:', err);
        // Use demo data as fallback
        renderDetailCharts(generateDemoHistory(symbol));
    }
}

function renderDetailCharts(historyData) {
    const rawData = historyData.data || [];
    if (rawData.length === 0) return;

    // Destroy existing charts
    if (priceChartInstance) priceChartInstance.destroy();
    if (rangeChartInstance) rangeChartInstance.destroy();

    // Downsample to max 50 points for clean, readable charts
    const maxPoints = 50;
    const sampleStep = Math.max(1, Math.floor(rawData.length / maxPoints));
    const data = rawData.filter((_, i) => i % sampleStep === 0);

    const labels = data.map((d) => {
        const dt = new Date(d.sk * 1000);
        return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    });
    const prices = data.map((d) => d.current_price);
    const ranges = data.map((d) => d.intraday_range);

    // Show only every Nth label to avoid overlap
    const labelStep = Math.max(1, Math.floor(labels.length / 8));
    const displayLabels = labels.map((l, i) => (i % labelStep === 0 ? l : ''));

    // Price Chart
    const priceCtx = $('priceChart').getContext('2d');
    const isUp = prices[prices.length - 1] >= prices[0];
    const lineColor = isUp ? '#34d399' : '#f87171';
    const priceGradient = priceCtx.createLinearGradient(0, 0, 0, 200);
    priceGradient.addColorStop(0, isUp ? 'rgba(52,211,153,0.12)' : 'rgba(248,113,113,0.12)');
    priceGradient.addColorStop(1, 'rgba(0,0,0,0)');

    priceChartInstance = new Chart(priceCtx, {
        type: 'line',
        data: {
            labels: displayLabels,
            datasets: [{
                label: 'Price',
                data: prices,
                borderColor: lineColor,
                borderWidth: 2,
                backgroundColor: priceGradient,
                fill: true,
                pointRadius: 0,
                pointHoverRadius: 3,
                tension: 0.3,
            }],
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: { display: false },
                tooltip: {
                    backgroundColor: 'rgba(20,20,35,0.95)',
                    borderColor: 'rgba(255,255,255,0.1)',
                    borderWidth: 1,
                    titleColor: '#f0f0f5',
                    bodyColor: '#8888a0',
                    padding: 10,
                    displayColors: false,
                    callbacks: {
                        label: (ctx) => `Price: ${formatPrice(ctx.raw)}`,
                    },
                },
            },
            scales: {
                x: {
                    ticks: { color: '#55556a', font: { size: 9, family: 'Inter' }, maxRotation: 0 },
                    grid: { color: 'rgba(255,255,255,0.03)' },
                },
                y: {
                    ticks: {
                        color: '#55556a',
                        font: { size: 9, family: 'JetBrains Mono' },
                        callback: (v) => '$' + v.toFixed(0),
                        maxTicksLimit: 5,
                    },
                    grid: { color: 'rgba(255,255,255,0.03)' },
                },
            },
            animation: { duration: 600 },
        },
    });

    // Range Chart
    const rangeCtx = $('rangeChart').getContext('2d');
    rangeChartInstance = new Chart(rangeCtx, {
        type: 'bar',
        data: {
            labels: displayLabels,
            datasets: [{
                label: 'Range',
                data: ranges,
                backgroundColor: 'rgba(129,140,248,0.3)',
                borderColor: 'rgba(129,140,248,0.6)',
                borderWidth: 1,
                borderRadius: 2,
            }],
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: {
                    backgroundColor: 'rgba(20,20,35,0.95)',
                    borderColor: 'rgba(255,255,255,0.1)',
                    borderWidth: 1,
                    titleColor: '#f0f0f5',
                    bodyColor: '#8888a0',
                    padding: 10,
                    displayColors: false,
                    callbacks: {
                        label: (ctx) => `Range: $${Number(ctx.raw).toFixed(2)}`,
                    },
                },
            },
            scales: {
                x: {
                    ticks: { display: false },
                    grid: { display: false },
                },
                y: {
                    ticks: {
                        color: '#55556a',
                        font: { size: 9, family: 'JetBrains Mono' },
                        callback: (v) => '$' + v.toFixed(1),
                        maxTicksLimit: 4,
                    },
                    grid: { color: 'rgba(255,255,255,0.03)' },
                },
            },
            animation: { duration: 600 },
        },
    });
}

function hideDetail() {
    detailPanel.style.display = 'none';
    cardsGrid.style.display = 'grid';
}

// ── Data Loading ────────────────────────────────────────────

async function loadData() {
    try {
        refreshBtn.classList.add('spinning');

        let result;
        if (API_BASE_URL) {
            result = await fetchLatestStocks();
        } else {
            // Demo mode — no API configured
            result = generateDemoData();
            console.log('📊 Running in demo mode (no API_BASE_URL configured)');
        }

        stocksData = result.stocks || [];

        // Hide loading, render data
        loadingOverlay.style.display = 'none';
        errorBanner.style.display = 'none';

        renderCards(stocksData);
        updateSummaryBar(stocksData);

        lastUpdated.textContent = formatTime(result.timestamp || new Date().toISOString());
    } catch (err) {
        console.error('Failed to load data:', err);
        loadingOverlay.style.display = 'none';

        // Show error but keep existing data if available
        errorText.textContent = `Failed to fetch data: ${err.message}`;
        errorBanner.style.display = 'flex';

        if (stocksData.length === 0) {
            // First load failed — show demo data
            const demo = generateDemoData();
            stocksData = demo.stocks;
            renderCards(stocksData);
            updateSummaryBar(stocksData);
            lastUpdated.textContent = formatTime(new Date().toISOString());
        }
    } finally {
        refreshBtn.classList.remove('spinning');
    }
}

// ── Event Listeners ─────────────────────────────────────────

refreshBtn.addEventListener('click', loadData);

$('backBtn').addEventListener('click', hideDetail);

$('errorDismiss').addEventListener('click', () => {
    errorBanner.style.display = 'none';
});

// Keyboard shortcut: Escape to go back
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && detailPanel.style.display !== 'none') {
        hideDetail();
    }
});

// ── Initialization ──────────────────────────────────────────

(async function init() {
    await loadData();

    // Auto-refresh
    refreshTimer = setInterval(loadData, REFRESH_INTERVAL_MS);
})();
