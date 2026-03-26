// =====================================================
// THE LEDGER - LIVE PRESSURE HEATMAP ENGINE
// Nigeria Food Industry Intelligence
// =====================================================

class LedgerHeatmap {
    constructor(config = {}) {
        // Map configuration
        this.mapboxToken = config.mapboxToken || window.LEDGER_MAPBOX_TOKEN || '';
        this.container = config.container || 'liveHeatmap';
        this.center = config.center || [8.6753, 9.0820]; // Nigeria center
        this.zoom = config.zoom || 6;
        
        // State management
        this.map = null;
        this.heatmapLayer = null;
        this.markers = [];
        this.alerts = [];
        this.pressureData = [];
        this.activeFilters = {
            cities: [],
            pressureLevels: ['critical', 'high', 'medium', 'low'],
            categories: ['diesel', 'harassment', 'spoilage', 'staff', 'leakage']
        };
        
        // Data sources
        this.apiBase = config.apiBase || window.LEDGER_API_BASE_URL || '/api';
        this.dataEndpoints = {
            pressure: `${this.apiBase}/pressure/live`,
            alerts: `${this.apiBase}/alerts/active`,
            diesel: `${this.apiBase}/diesel/current`,
            worker: `${this.apiBase}/worker/hotspots`,
            customer: `${this.apiBase}/customer/complaints`
        };
        
        // UI bindings
        this.legendElement = config.legendElement || '.heatmap-legend';
        this.timestampElement = config.timestampElement || '.heatmap-timestamp';
        
        // Callbacks
        this.onCityClick = config.onCityClick || null;
        this.onAlertClick = config.onAlertClick || null;
        
        // Initialize
        this.init();
    }
    
    // =====================================================
    // 1. INITIALIZATION
    // =====================================================
    
    async init() {
        console.log('🗺️ Initializing LEDGER Heatmap...');
        
        // Load Mapbox
        await this.loadMapbox();
        
        // Initialize map
        this.initializeMap();
        
        // Add controls
        this.addControls();
        
        // Load initial data
        await this.loadInitialData();
        
        // Start real-time updates
        this.startRealtimeUpdates();
        
        // Bind events
        this.bindEvents();
        
        console.log('✅ Heatmap initialized');
    }
    
    loadMapbox() {
        return new Promise((resolve, reject) => {
            if (window.mapboxgl) {
                resolve();
                return;
            }
            
            const script = document.createElement('script');
            script.src = 'https://api.mapbox.com/mapbox-gl-js/v2.15.0/mapbox-gl.js';
            script.onload = resolve;
            script.onerror = reject;
            document.head.appendChild(script);
            
            // Also load CSS
            const link = document.createElement('link');
            link.rel = 'stylesheet';
            link.href = 'https://api.mapbox.com/mapbox-gl-js/v2.15.0/mapbox-gl.css';
            document.head.appendChild(link);
        });
    }
    
    initializeMap() {
        mapboxgl.accessToken = this.mapboxToken;
        
        this.map = new mapboxgl.Map({
            container: this.container,
            style: 'mapbox://styles/mapbox/light-v11',
            center: this.center,
            zoom: this.zoom,
            minZoom: 5,
            maxZoom: 12,
            attributionControl: true
        });
        
        // Add navigation controls
        this.map.addControl(new mapboxgl.NavigationControl(), 'top-right');
        this.map.addControl(new mapboxgl.FullscreenControl(), 'top-right');
        
        // Wait for map to load
        this.map.on('load', () => {
            this.onMapLoaded();
        });
        
        // Handle errors
        this.map.on('error', (e) => {
            console.error('Mapbox error:', e);
            this.showError('Failed to load map. Please refresh.');
        });
    }
    
    // =====================================================
    // 2. MAP STYLING & LAYERS
    // =====================================================
    
    onMapLoaded() {
        // Add custom Nigeria boundary
        this.addNigeriaBoundary();
        
        // Initialize heatmap layer
        this.createHeatmapLayer();
        
        // Add city markers
        this.addCityMarkers();
        
        // Add LGA boundaries (Local Government Areas)
        this.addLGABoundaries();
        
        // Ensure data is rendered if loaded before map
        this.updateHeatmapData();
        
        // Hide loading state
        this.hideLoading();
    }
    
    addNigeriaBoundary() {
        // Add Nigeria outline
        this.map.addSource('nigeria-boundary', {
            type: 'geojson',
            data: {
                type: 'Feature',
                properties: {},
                geometry: {
                    type: 'Polygon',
                    coordinates: [[
                        [2.6917, 4.2405],  // South West
                        [14.5772, 4.2405], // South East
                        [14.5772, 13.8920], // North East
                        [2.6917, 13.8920], // North West
                        [2.6917, 4.2405]   // Close
                    ]]
                }
            }
        });
        
        this.map.addLayer({
            id: 'nigeria-boundary',
            type: 'line',
            source: 'nigeria-boundary',
            layout: {},
            paint: {
                'line-color': '#374151',
                'line-width': 2,
                'line-dasharray': [2, 2]
            }
        });
    }
    
    createHeatmapLayer() {
        // Add heatmap source
        this.map.addSource('pressure-points', {
            type: 'geojson',
            data: {
                type: 'FeatureCollection',
                features: []
            }
        });
        
        // Add heatmap layer
        this.map.addLayer({
            id: 'pressure-heatmap',
            type: 'heatmap',
            source: 'pressure-points',
            maxzoom: 12,
            paint: {
                // Weight by pressure intensity
                'heatmap-weight': [
                    'interpolate',
                    ['linear'],
                    ['get', 'intensity'],
                    0, 0,
                    100, 1
                ],
                // Color gradient based on severity
                'heatmap-color': [
                    'interpolate',
                    ['linear'],
                    ['heatmap-density'],
                    0, 'rgba(0, 0, 0, 0)',
                    0.2, 'rgba(16, 185, 129, 0.4)',  // green - low
                    0.4, 'rgba(245, 158, 11, 0.6)', // yellow - medium
                    0.6, 'rgba(239, 68, 68, 0.8)',  // red - high
                    0.8, 'rgba(127, 29, 29, 0.9)'   // dark red - critical
                ],
                // Radius based on zoom
                'heatmap-radius': [
                    'interpolate',
                    ['linear'],
                    ['zoom'],
                    0, 2,
                    6, 20,
                    12, 40
                ],
                // Opacity
                'heatmap-opacity': 0.8
            }
        });
        
        // Add point layer for click interaction
        this.map.addLayer({
            id: 'pressure-points-click',
            type: 'circle',
            source: 'pressure-points',
            paint: {
                'circle-radius': [
                    'interpolate',
                    ['linear'],
                    ['get', 'intensity'],
                    0, 5,
                    100, 15
                ],
                'circle-color': [
                    'match',
                    ['get', 'severity'],
                    'critical', '#7f1d1d',
                    'high', '#ef4444',
                    'medium', '#f59e0b',
                    'low', '#10b981',
                    '#6b7280'
                ],
                'circle-opacity': 0.6,
                'circle-stroke-width': 1,
                'circle-stroke-color': 'white'
            },
            filter: ['==', '$type', 'Point']
        });
        
        // Add click handler
        this.map.on('click', 'pressure-points-click', (e) => {
            const feature = e.features[0];
            this.handlePressurePointClick(feature);
        });
        
        // Change cursor on hover
        this.map.on('mouseenter', 'pressure-points-click', () => {
            this.map.getCanvas().style.cursor = 'pointer';
        });
        
        this.map.on('mouseleave', 'pressure-points-click', () => {
            this.map.getCanvas().style.cursor = '';
        });
    }
    
    addCityMarkers() {
        // Major Nigerian cities with coordinates
        const cities = [
            { name: 'Lagos', lga: 'Eti-Osa', coords: [3.3792, 6.5244], population: 'major' },
            { name: 'Abuja', lga: 'Municipal', coords: [7.4951, 9.0579], population: 'major' },
            { name: 'Port Harcourt', lga: 'Port Harcourt', coords: [7.0493, 4.8156], population: 'major' },
            { name: 'Kano', lga: 'Kano Municipal', coords: [8.5167, 12.0000], population: 'major' },
            { name: 'Ibadan', lga: 'Ibadan North', coords: [3.8964, 7.3776], population: 'major' },
            { name: 'Benin City', lga: 'Egor', coords: [5.6037, 6.3350], population: 'major' },
            { name: 'Enugu', lga: 'Enugu East', coords: [7.4951, 6.4413], population: 'major' },
            { name: 'Kaduna', lga: 'Kaduna North', coords: [7.4388, 10.5264], population: 'major' },
            { name: 'Aba', lga: 'Aba North', coords: [7.3667, 5.1167], population: 'major' },
            { name: 'Jos', lga: 'Jos North', coords: [8.9000, 9.9333], population: 'major' },
            { name: 'Maiduguri', lga: 'Maiduguri', coords: [13.1600, 11.8469], population: 'major' },
            { name: 'Calabar', lga: 'Calabar Municipal', coords: [8.3167, 4.9500], population: 'major' },
            { name: 'Warri', lga: 'Warri South', coords: [5.7500, 5.5167], population: 'secondary' },
            { name: 'Onitsha', lga: 'Onitsha North', coords: [6.7833, 6.1667], population: 'secondary' },
            { name: 'Abeokuta', lga: 'Abeokuta South', coords: [3.3500, 7.1500], population: 'secondary' },
            { name: 'Owerri', lga: 'Owerri Municipal', coords: [7.0333, 5.4833], population: 'secondary' },
            { name: 'Akure', lga: 'Akure South', coords: [5.1833, 7.2500], population: 'secondary' },
            { name: 'Osogbo', lga: 'Osogbo', coords: [4.5667, 7.7667], population: 'secondary' },
            { name: 'Ilorin', lga: 'Ilorin South', coords: [4.5500, 8.5000], population: 'secondary' },
            { name: 'Bauchi', lga: 'Bauchi', coords: [9.8333, 10.3167], population: 'secondary' }
        ];
        
        // Add city labels
        this.map.addSource('cities', {
            type: 'geojson',
            data: {
                type: 'FeatureCollection',
                features: cities.map(city => ({
                    type: 'Feature',
                    geometry: {
                        type: 'Point',
                        coordinates: city.coords
                    },
                    properties: {
                        name: city.name,
                        lga: city.lga,
                        population: city.population,
                        type: 'city'
                    }
                }))
            }
        });
        
        // Add city labels
        this.map.addLayer({
            id: 'city-labels',
            type: 'symbol',
            source: 'cities',
            layout: {
                'text-field': ['get', 'name'],
                'text-font': ['Inter Bold', 'Arial Unicode MS Bold'],
                'text-size': [
                    'match',
                    ['get', 'population'],
                    'major', 14,
                    'secondary', 12,
                    10
                ],
                'text-offset': [0, 1.5],
                'text-anchor': 'top'
            },
            paint: {
                'text-color': '#374151',
                'text-halo-color': 'white',
                'text-halo-width': 2
            }
        });
    }
    
    addLGABoundaries() {
        // Simplified LGA boundaries for MVP
        // In production, load from official GeoJSON source
        this.map.addSource('lga-boundaries', {
            type: 'geojson',
            data: '/assets/data/nigeria_lga_simplified.geojson'  // You'll need to provide this
        });
        
        this.map.addLayer({
            id: 'lga-boundaries',
            type: 'line',
            source: 'lga-boundaries',
            paint: {
                'line-color': '#e5e7eb',
                'line-width': 0.5,
                'line-opacity': 0.5
            },
            layout: {
                visibility: 'none'  // Hidden by default, can be toggled
            }
        });
    }
    
    // =====================================================
    // 3. DATA LOADING & PROCESSING
    // =====================================================
    
    async loadInitialData() {
        try {
            // Show loading state
            this.showLoading();
            
            // Load pressure data from multiple sources
            const [pressureData, alertData, dieselData] = await Promise.all([
                this.fetchPressureData(),
                this.fetchAlertData(),
                this.fetchDieselData()
            ]);
            
            // Process and merge data
            this.pressureData = this.processPressureData(pressureData);
            this.alerts = this.processAlertData(alertData);
            
            // Update heatmap
            this.updateHeatmapData();
            
            // Add alert markers
            this.addAlertMarkers();
            
            // Update timestamp
            this.updateTimestamp();
            
        } catch (error) {
            console.error('Failed to load heatmap data:', error);
            this.loadFallbackData(); // Use sample data if API fails
        } finally {
            this.hideLoading();
        }
    }
    
    async fetchPressureData() {
        // Try API first
        try {
            const response = await fetch(this.dataEndpoints.pressure, {
                headers: {
                    'Cache-Control': 'no-cache',
                    'X-Requested-With': 'XMLHttpRequest'
                }
            });
            
            if (!response.ok) throw new Error('API failed');
            return await response.json();
        } catch (error) {
            console.warn('Using fallback pressure data:', error);
            return this.getFallbackPressureData();
        }
    }
    
    async fetchAlertData() {
        try {
            const response = await fetch(this.dataEndpoints.alerts);
            if (!response.ok) throw new Error('API failed');
            return await response.json();
        } catch (error) {
            console.warn('Using fallback alert data');
            return this.getFallbackAlertData();
        }
    }
    
    async fetchDieselData() {
        try {
            const response = await fetch(this.dataEndpoints.diesel);
            if (!response.ok) throw new Error('API failed');
            return await response.json();
        } catch (error) {
            console.warn('Using fallback diesel data');
            return this.getFallbackDieselData();
        }
    }
    
    processPressureData(data) {
        const features = [];
        
        // Process city-level pressure
        if (data.cities) {
            data.cities.forEach(city => {
                features.push({
                    type: 'Feature',
                    geometry: {
                        type: 'Point',
                        coordinates: this.getCityCoordinates(city.name)
                    },
                    properties: {
                        type: 'pressure',
                        city: city.name,
                        lga: city.lga,
                        intensity: city.pressure_score || 50,
                        severity: this.getSeverityLevel(city.pressure_score),
                        diesel_price: city.diesel_price,
                        staff_shortage: city.staff_shortage,
                        spoilage_rate: city.spoilage_rate,
                        leakage_rate: city.leakage_rate,
                        harassment_reports: city.harassment_reports,
                        sample_size: city.sample_size,
                        timestamp: new Date().toISOString()
                    }
                });
            });
        }
        
        // Process LGA-level hotspots
        if (data.hotspots) {
            data.hotspots.forEach(hotspot => {
                features.push({
                    type: 'Feature',
                    geometry: {
                        type: 'Point',
                        coordinates: hotspot.coordinates
                    },
                    properties: {
                        type: 'hotspot',
                        ...hotspot
                    }
                });
            });
        }
        
        return features;
    }
    
    processAlertData(data) {
        if (!data.alerts) return [];
        
        return data.alerts.map(alert => ({
            id: alert.id,
            type: alert.type,
            severity: alert.severity,
            city: alert.city,
            lga: alert.lga,
            coordinates: this.getCityCoordinates(alert.city),
            message: alert.message,
            count: alert.trigger_count,
            timestamp: alert.created_at
        }));
    }
    
    updateHeatmapData() {
        const source = this.map.getSource('pressure-points');
        if (!source) return;
        
        source.setData({
            type: 'FeatureCollection',
            features: this.pressureData
        });
    }
    
    addAlertMarkers() {
        // Remove existing markers
        this.markers.forEach(marker => marker.remove());
        this.markers = [];
        
        // Add new markers for critical alerts
        this.alerts
            .filter(alert => alert.severity === 'critical' || alert.severity === 'high')
            .forEach(alert => {
                const marker = this.createAlertMarker(alert);
                marker.addTo(this.map);
                this.markers.push(marker);
            });
    }
    
    createAlertMarker(alert) {
        // Create custom marker element
        const el = document.createElement('div');
        el.className = `alert-marker alert-${alert.severity}`;
        el.innerHTML = `
            <div class="alert-pulse"></div>
            <div class="alert-icon">
                ${this.getAlertIcon(alert.type)}
            </div>
            <div class="alert-badge">${alert.count || '!'}</div>
        `;
        
        // Create popup
        const popup = new mapboxgl.Popup({ offset: 25 }).setHTML(`
            <div class="alert-popup">
                <div class="alert-popup-header ${alert.severity}">
                    <span>${this.getAlertIcon(alert.type)} ${alert.type.toUpperCase()} ALERT</span>
                    <span class="alert-time">${this.formatTime(alert.timestamp)}</span>
                </div>
                <div class="alert-popup-body">
                    <p>${alert.message}</p>
                    <div class="alert-meta">
                        <span><i class="fas fa-map-marker-alt"></i> ${alert.lga}, ${alert.city}</span>
                        <span><i class="fas fa-exclamation-triangle"></i> ${alert.count} reports</span>
                    </div>
                    <button class="alert-action-btn" onclick="window.location.href='/dashboard?alert=${alert.id}'">
                        View Details →
                    </button>
                </div>
            </div>
        `);
        
        return new mapboxgl.Marker(el)
            .setLngLat(alert.coordinates)
            .setPopup(popup);
    }
    
    // =====================================================
    // 4. REAL-TIME UPDATES
    // =====================================================
    
    startRealtimeUpdates() {
        // Update heatmap every 30 seconds
        setInterval(() => {
            this.refreshData();
        }, 30000);
        
        // Listen for real-time alerts via SSE/WebSocket
        this.setupRealtimeChannel();
    }
    
    async refreshData() {
        try {
            const [pressureData, alertData] = await Promise.all([
                this.fetchPressureData(),
                this.fetchAlertData()
            ]);
            
            this.pressureData = this.processPressureData(pressureData);
            this.alerts = this.processAlertData(alertData);
            
            this.updateHeatmapData();
            this.addAlertMarkers();
            this.updateTimestamp();
            
            // Trigger custom event for dashboard
            window.dispatchEvent(new CustomEvent('heatmap:updated', {
                detail: { timestamp: new Date(), alertCount: this.alerts.length }
            }));
            
        } catch (error) {
            console.error('Refresh failed:', error);
        }
    }
    
    setupRealtimeChannel() {
        // Use Server-Sent Events for real-time
        if (window.EventSource) {
            const source = new EventSource(`${this.apiBase}/alerts/stream`);
            
            source.addEventListener('alert', (e) => {
                const alert = JSON.parse(e.data);
                this.handleNewAlert(alert);
            });
            
            source.addEventListener('pressure', (e) => {
                const pressure = JSON.parse(e.data);
                this.handlePressureUpdate(pressure);
            });
            
            source.onerror = () => {
                console.warn('SSE connection failed, falling back to polling');
                source.close();
            };
        }
    }
    
    handleNewAlert(alert) {
        // Add to alerts array
        this.alerts.unshift(alert);
        
        // Keep only last 50 alerts
        if (this.alerts.length > 50) {
            this.alerts.pop();
        }
        
        // Add marker
        const marker = this.createAlertMarker(alert);
        marker.addTo(this.map);
        this.markers.push(marker);
        
        // Show notification if page is visible
        if (!document.hidden && Notification.permission === 'granted') {
            new Notification('🔴 New Industry Alert', {
                body: alert.message,
                icon: '/assets/icons/alert-icon.png',
                tag: 'ledger-alert'
            });
        }
        
        // Update alert counter
        this.updateAlertCounter();
    }
    
    // =====================================================
    // 5. INTERACTION HANDLERS
    // =====================================================
    
    handlePressurePointClick(feature) {
        const props = feature.properties;
        
        // Create detailed popup
        const popup = new mapboxgl.Popup()
            .setLngLat(feature.geometry.coordinates)
            .setHTML(this.generatePressurePopup(props))
            .addTo(this.map);
        
        // Callback if provided
        if (this.onCityClick) {
            this.onCityClick(props);
        }
    }
    
    generatePressurePopup(props) {
        const severityColor = {
            critical: '#7f1d1d',
            high: '#ef4444',
            medium: '#f59e0b',
            low: '#10b981'
        };
        
        return `
            <div class="pressure-popup">
                <div class="pressure-popup-header" style="border-left-color: ${severityColor[props.severity] || '#6b7280'}">
                    <h3>${props.city || 'Area'} ${props.lga ? `- ${props.lga}` : ''}</h3>
                    <span class="pressure-badge ${props.severity}">${props.severity.toUpperCase()} PRESSURE</span>
                </div>
                
                <div class="pressure-popup-metrics">
                    ${props.diesel_price ? `
                    <div class="metric-item">
                        <span class="metric-label">⛽ Diesel</span>
                        <span class="metric-value">₦${props.diesel_price}/L</span>
                    </div>` : ''}
                    
                    ${props.staff_shortage ? `
                    <div class="metric-item">
                        <span class="metric-label">👥 Staff Shortage</span>
                        <span class="metric-value">${props.staff_shortage}%</span>
                    </div>` : ''}
                    
                    ${props.spoilage_rate ? `
                    <div class="metric-item">
                        <span class="metric-label">🥬 Spoilage</span>
                        <span class="metric-value">${props.spoilage_rate}%</span>
                    </div>` : ''}
                    
                    ${props.leakage_rate ? `
                    <div class="metric-item">
                        <span class="metric-label">💰 Leakage</span>
                        <span class="metric-value">${props.leakage_rate}%</span>
                    </div>` : ''}
                    
                    ${props.harassment_reports ? `
                    <div class="metric-item">
                        <span class="metric-label">🛡️ Harassment</span>
                        <span class="metric-value">${props.harassment_reports} reports</span>
                    </div>` : ''}
                </div>
                
                <div class="pressure-popup-footer">
                    <span class="sample-size">Based on ${props.sample_size || 0} reports</span>
                    <span class="timestamp">Updated ${this.formatTime(props.timestamp)}</span>
                </div>
                
                <div class="pressure-popup-actions">
                    <a href="/dashboard?city=${props.city || ''}&lga=${props.lga || ''}" class="popup-btn">
                        View Dashboard →
                    </a>
                    <button onclick="window.heatmap.subscribeToAlerts('${props.city || ''}', '${props.lga || ''}')" class="popup-btn-outline">
                        <i class="fas fa-bell"></i> Get Alerts
                    </button>
                </div>
            </div>
        `;
    }
    
    // =====================================================
    // 6. CONTROLS & UI
    // =====================================================
    
    addControls() {
        // Add custom controls
        this.addFilterControl();
        this.addLegend();
        this.addLayersControl();
    }
    
    addFilterControl() {
        // Create filter control container
        const filterControl = document.createElement('div');
        filterControl.className = 'map-filter-control mapboxgl-ctrl';
        filterControl.innerHTML = `
            <div class="filter-header">
                <i class="fas fa-filter"></i>
                <span>Filter Pressure</span>
                <button class="filter-toggle">▼</button>
            </div>
            <div class="filter-content">
                <div class="filter-section">
                    <h4>Severity</h4>
                    <label><input type="checkbox" value="critical" checked> Critical</label>
                    <label><input type="checkbox" value="high" checked> High</label>
                    <label><input type="checkbox" value="medium" checked> Medium</label>
                    <label><input type="checkbox" value="low" checked> Low</label>
                </div>
                <div class="filter-section">
                    <h4>Categories</h4>
                    <label><input type="checkbox" value="diesel" checked> ⛽ Diesel</label>
                    <label><input type="checkbox" value="harassment" checked> 🛡️ Harassment</label>
                    <label><input type="checkbox" value="spoilage" checked> 🥬 Spoilage</label>
                    <label><input type="checkbox" value="staff" checked> 👥 Staff</label>
                    <label><input type="checkbox" value="leakage" checked> 💰 Leakage</label>
                </div>
                <button class="apply-filters-btn">Apply Filters</button>
            </div>
        `;
        
        // Add to map
        this.map.addControl({
            onAdd: () => filterControl,
            onRemove: () => filterControl.remove()
        }, 'top-left');
        
        // Bind filter events
        filterControl.querySelector('.filter-toggle').addEventListener('click', () => {
            filterControl.classList.toggle('expanded');
        });
        
        filterControl.querySelector('.apply-filters-btn').addEventListener('click', () => {
            this.applyFilters(filterControl);
        });
    }
    
    addLegend() {
        const legend = document.querySelector(this.legendElement);
        if (!legend) return;
        
        legend.innerHTML = `
            <div class="legend-item">
                <span class="dot critical"></span>
                <span>Critical (5+ reports/80+ pressure)</span>
            </div>
            <div class="legend-item">
                <span class="dot high"></span>
                <span>High (3-4 reports/60-80 pressure)</span>
            </div>
            <div class="legend-item">
                <span class="dot medium"></span>
                <span>Medium (1-2 reports/40-60 pressure)</span>
            </div>
            <div class="legend-item">
                <span class="dot low"></span>
                <span>Low (0 reports/0-40 pressure)</span>
            </div>
            <div class="legend-item">
                <span class="alert-icon">🔴</span>
                <span>Active Alert</span>
            </div>
        `;
    }
    
    addLayersControl() {
        const layersControl = document.createElement('div');
        layersControl.className = 'layers-control mapboxgl-ctrl';
        layersControl.innerHTML = `
            <button class="layers-btn" title="Map Layers">
                <i class="fas fa-layers"></i>
            </button>
            <div class="layers-menu">
                <label>
                    <input type="radio" name="basemap" value="streets" checked> Streets
                </label>
                <label>
                    <input type="radio" name="basemap" value="light"> Light
                </label>
                <label>
                    <input type="radio" name="basemap" value="satellite"> Satellite
                </label>
                <hr>
                <label>
                    <input type="checkbox" id="showLGA" checked> Show LGA boundaries
                </label>
                <label>
                    <input type="checkbox" id="showHeatmap" checked> Show heatmap
                </label>
                <label>
                    <input type="checkbox" id="showMarkers" checked> Show markers
                </label>
            </div>
        `;
        
        this.map.addControl({
            onAdd: () => layersControl,
            onRemove: () => layersControl.remove()
        }, 'top-right');
        
        // Bind layer controls
        layersControl.querySelector('.layers-btn').addEventListener('click', () => {
            layersControl.classList.toggle('expanded');
        });
        
        layersControl.querySelectorAll('input[name="basemap"]').forEach(radio => {
            radio.addEventListener('change', (e) => {
                const style = e.target.value;
                this.map.setStyle(`mapbox://styles/mapbox/${style}-v11`);
            });
        });
        
        layersControl.querySelector('#showLGA').addEventListener('change', (e) => {
            this.map.setLayoutProperty('lga-boundaries', 'visibility', 
                e.target.checked ? 'visible' : 'none');
        });
        
        layersControl.querySelector('#showHeatmap').addEventListener('change', (e) => {
            this.map.setLayoutProperty('pressure-heatmap', 'visibility',
                e.target.checked ? 'visible' : 'none');
        });
        
        layersControl.querySelector('#showMarkers').addEventListener('change', (e) => {
            this.map.setLayoutProperty('pressure-points-click', 'visibility',
                e.target.checked ? 'visible' : 'none');
        });
    }
    
    // =====================================================
    // 7. UTILITY FUNCTIONS
    // =====================================================
    
    getCityCoordinates(cityName) {
        // City coordinate lookup
        const coordinates = {
            'Lagos': [3.3792, 6.5244],
            'Abuja': [7.4951, 9.0579],
            'Port Harcourt': [7.0493, 4.8156],
            'Kano': [8.5167, 12.0000],
            'Ibadan': [3.8964, 7.3776],
            'Benin': [5.6037, 6.3350],
            'Enugu': [7.4951, 6.4413],
            'Kaduna': [7.4388, 10.5264],
            'Aba': [7.3667, 5.1167],
            'Jos': [8.9000, 9.9333],
            'Maiduguri': [13.1600, 11.8469],
            'Calabar': [8.3167, 4.9500],
            'Warri': [5.7500, 5.5167],
            'Onitsha': [6.7833, 6.1667],
            'Abeokuta': [3.3500, 7.1500],
            'Owerri': [7.0333, 5.4833],
            'Akure': [5.1833, 7.2500],
            'Osogbo': [4.5667, 7.7667],
            'Ilorin': [4.5500, 8.5000],
            'Bauchi': [9.8333, 10.3167]
        };
        
        return coordinates[cityName] || [8.6753, 9.0820]; // Default to center
    }
    
    getSeverityLevel(score) {
        if (!score) return 'unknown';
        if (score >= 80) return 'critical';
        if (score >= 60) return 'high';
        if (score >= 40) return 'medium';
        return 'low';
    }
    
    getAlertIcon(type) {
        const icons = {
            'harassment': '🛡️',
            'diesel_spike': '⛽',
            'supplier_failure': '📦',
            'spoilage_outbreak': '🥬',
            'wage_theft': '💰',
            'customer_sentiment': '😞'
        };
        return icons[type] || '🔔';
    }
    
    formatTime(timestamp) {
        if (!timestamp) return 'Just now';
        
        const date = new Date(timestamp);
        const now = new Date();
        const diff = Math.floor((now - date) / 1000 / 60); // minutes
        
        if (diff < 1) return 'Just now';
        if (diff < 60) return `${diff}m ago`;
        if (diff < 1440) return `${Math.floor(diff / 60)}h ago`;
        return date.toLocaleDateString('en-NG', { 
            month: 'short', 
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        });
    }
    
    updateTimestamp() {
        const el = document.querySelector(this.timestampElement);
        if (el) {
            el.innerHTML = `
                <i class="fas fa-map-marker-alt"></i> 
                Showing Nigeria's food industry pressure
                <span class="refresh-note">— Updated ${this.formatTime(new Date())}</span>
            `;
        }
    }
    
    updateAlertCounter() {
        const counter = document.querySelector('.alert-counter');
        if (counter) {
            counter.textContent = this.alerts.length;
        }
    }
    
    // =====================================================
    // 8. FALLBACK DATA (DEMO MODE)
    // =====================================================
    
    getFallbackPressureData() {
        return {
            cities: [
                { name: 'Lagos', lga: 'Surulere', pressure_score: 78, diesel_price: 872, staff_shortage: 45, spoilage_rate: 28, leakage_rate: 32, harassment_reports: 12, sample_size: 234 },
                { name: 'Lagos', lga: 'Victoria Island', pressure_score: 82, diesel_price: 890, staff_shortage: 52, spoilage_rate: 31, leakage_rate: 38, harassment_reports: 8, sample_size: 156 },
                { name: 'Lagos', lga: 'Yaba', pressure_score: 71, diesel_price: 865, staff_shortage: 41, spoilage_rate: 26, leakage_rate: 29, harassment_reports: 6, sample_size: 189 },
                { name: 'Abuja', lga: 'Wuse', pressure_score: 52, diesel_price: 845, staff_shortage: 23, spoilage_rate: 15, leakage_rate: 18, harassment_reports: 4, sample_size: 145 },
                { name: 'Abuja', lga: 'Garki', pressure_score: 48, diesel_price: 838, staff_shortage: 21, spoilage_rate: 14, leakage_rate: 16, harassment_reports: 2, sample_size: 112 },
                { name: 'Port Harcourt', lga: 'GRA', pressure_score: 89, diesel_price: 910, staff_shortage: 51, spoilage_rate: 37, leakage_rate: 44, harassment_reports: 15, sample_size: 98 },
                { name: 'Port Harcourt', lga: 'Rumuokwuta', pressure_score: 84, diesel_price: 905, staff_shortage: 48, spoilage_rate: 35, leakage_rate: 41, harassment_reports: 11, sample_size: 76 },
                { name: 'Ibadan', lga: 'Bodija', pressure_score: 58, diesel_price: 798, staff_shortage: 27, spoilage_rate: 19, leakage_rate: 22, harassment_reports: 5, sample_size: 134 },
                { name: 'Kano', lga: 'Sabon Gari', pressure_score: 31, diesel_price: 720, staff_shortage: 12, spoilage_rate: 11, leakage_rate: 9, harassment_reports: 2, sample_size: 87 },
                { name: 'Benin', lga: 'Egor', pressure_score: 71, diesel_price: 835, staff_shortage: 38, spoilage_rate: 24, leakage_rate: 29, harassment_reports: 7, sample_size: 63 }
            ],
            hotspots: [
                { coordinates: [3.3792, 6.5244], intensity: 92, severity: 'critical', type: 'diesel_spike' },
                { coordinates: [7.0493, 4.8156], intensity: 95, severity: 'critical', type: 'harassment' },
                { coordinates: [7.4951, 9.0579], intensity: 58, severity: 'medium', type: 'staff' }
            ]
        };
    }
    
    getFallbackAlertData() {
        return {
            alerts: [
                {
                    id: 'alert_1',
                    type: 'harassment',
                    severity: 'critical',
                    city: 'Lagos',
                    lga: 'Surulere',
                    message: '🔴 3 harassment reports in Surulere in last 1hr. Owners alerted.',
                    trigger_count: 3,
                    created_at: new Date(Date.now() - 2 * 60000).toISOString()
                },
                {
                    id: 'alert_2',
                    type: 'diesel_spike',
                    severity: 'high',
                    city: 'Port Harcourt',
                    lga: 'GRA',
                    message: '🟡 Diesel now ₦910/L in Port Harcourt. 15% spike this week.',
                    trigger_count: 1,
                    created_at: new Date(Date.now() - 15 * 60000).toISOString()
                },
                {
                    id: 'alert_3',
                    type: 'supplier_failure',
                    severity: 'high',
                    city: 'Ibadan',
                    lga: 'Bodija',
                    message: '🟠 8 owners report tomato supplier failure. Shortage expected.',
                    trigger_count: 8,
                    created_at: new Date(Date.now() - 45 * 60000).toISOString()
                }
            ]
        };
    }
    
    getFallbackDieselData() {
        return {
            national_avg: 872,
            cities: [
                { name: 'Lagos', price: 872 },
                { name: 'Abuja', price: 845 },
                { name: 'Port Harcourt', price: 910 },
                { name: 'Kano', price: 720 },
                { name: 'Ibadan', price: 798 },
                { name: 'Benin', price: 835 }
            ]
        };
    }
    
    loadFallbackData() {
        console.warn('Loading fallback heatmap data');
        
        const fallbackPressure = this.getFallbackPressureData();
        const fallbackAlerts = this.getFallbackAlertData();
        
        this.pressureData = this.processPressureData(fallbackPressure);
        this.alerts = this.processAlertData(fallbackAlerts);
        
        this.updateHeatmapData();
        this.addAlertMarkers();
        this.updateTimestamp();
        
        // Show demo mode indicator
        this.showDemoMode();
    }
    
    // =====================================================
    // 9. UI STATE MANAGEMENT
    // =====================================================
    
    showLoading() {
        const container = document.getElementById(this.container);
        if (container) {
            container.classList.add('loading');
            const loader = document.createElement('div');
            loader.className = 'heatmap-loader';
            loader.innerHTML = '<div class="spinner"></div><span>Loading industry pressure data...</span>';
            container.appendChild(loader);
        }
    }
    
    hideLoading() {
        const container = document.getElementById(this.container);
        if (container) {
            container.classList.remove('loading');
            const loader = container.querySelector('.heatmap-loader');
            if (loader) loader.remove();
        }
    }
    
    showError(message) {
        const container = document.getElementById(this.container);
        if (container) {
            const error = document.createElement('div');
            error.className = 'heatmap-error';
            error.innerHTML = `
                <i class="fas fa-exclamation-triangle"></i>
                <span>${message}</span>
                <button onclick="window.heatmap.refreshData()">Retry</button>
            `;
            container.appendChild(error);
            
            setTimeout(() => error.remove(), 5000);
        }
    }
    
    showDemoMode() {
        const container = document.getElementById(this.container);
        if (container) {
            const demo = document.createElement('div');
            demo.className = 'heatmap-demo';
            demo.innerHTML = `
                <i class="fas fa-flask"></i>
                <span>DEMO MODE - Showing sample data</span>
                <button onclick="window.heatmap.refreshData()">Connect Live</button>
            `;
            container.appendChild(demo);
        }
    }
    
    // =====================================================
    // 10. PUBLIC API
    // =====================================================
    
    async zoomToCity(cityName) {
        const coords = this.getCityCoordinates(cityName);
        this.map.flyTo({
            center: coords,
            zoom: 10,
            essential: true,
            duration: 2000
        });
    }
    
    async subscribeToAlerts(city, lga) {
        // Implementation for alert subscription
        console.log(`Subscribing to alerts for ${city} - ${lga}`);
        
        // Show subscription modal or redirect
        window.location.href = `/dashboard?subscribe=true&city=${encodeURIComponent(city)}&lga=${encodeURIComponent(lga)}`;
    }
    
    applyFilters(filterControl) {
        const severityChecks = filterControl.querySelectorAll('input[type="checkbox"][value="critical"], input[value="high"], input[value="medium"], input[value="low"]');
        const categoryChecks = filterControl.querySelectorAll('.filter-section:last-child input[type="checkbox"]');
        
        this.activeFilters.pressureLevels = [];
        this.activeFilters.categories = [];
        
        severityChecks.forEach(check => {
            if (check.checked) this.activeFilters.pressureLevels.push(check.value);
        });
        
        categoryChecks.forEach(check => {
            if (check.checked) this.activeFilters.categories.push(check.value);
        });
        
        // Update heatmap visibility based on filters
        // Implementation depends on data structure
        console.log('Filters applied:', this.activeFilters);
        
        // Close filter panel
        filterControl.classList.remove('expanded');
    }
    
    destroy() {
        // Clean up resources
        if (this.map) {
            this.map.remove();
        }
        
        // Remove event listeners
        window.removeEventListener('heatmap:updated', null);
    }
}

// =====================================================
// 11. GLOBAL INSTANCE & INITIALIZATION
// =====================================================

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    // Check if heatmap container exists
    if (document.getElementById('liveHeatmap')) {
        window.heatmap = new LedgerHeatmap({
            container: 'liveHeatmap',
            center: [8.6753, 9.0820],
            zoom: 6,
            legendElement: '.heatmap-legend',
            timestampElement: '.heatmap-timestamp',
            onCityClick: (cityData) => {
                console.log('City clicked:', cityData);
                // Track analytics
                if (typeof gtag !== 'undefined') {
                    gtag('event', 'heatmap_click', {
                        event_category: 'engagement',
                        event_label: cityData.city,
                        value: cityData.intensity
                    });
                }
            }
        });
    }
});

// Export for module usage
if (typeof module !== 'undefined' && module.exports) {
    module.exports = LedgerHeatmap;
}
