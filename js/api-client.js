// =====================================================
// LEDGER API CLIENT - Connects heatmap to backend
// =====================================================

class LedgerAPI {
    constructor(baseURL = (window.LEDGER_API_BASE_URL || '/api')) {
        this.baseURL = baseURL;
        this.cache = new Map();
        this.pendingRequests = new Map();
    }
    
    async fetchPressureData(params = {}) {
        const cacheKey = `pressure_${JSON.stringify(params)}`;
        
        // Check cache (30 seconds)
        if (this.cache.has(cacheKey)) {
            const cached = this.cache.get(cacheKey);
            if (Date.now() - cached.timestamp < 30000) {
                return cached.data;
            }
        }
        
        // Prevent duplicate requests
        if (this.pendingRequests.has(cacheKey)) {
            return this.pendingRequests.get(cacheKey);
        }
        
        const request = this._makeRequest('/pressure/live', params);
        this.pendingRequests.set(cacheKey, request);
        
        try {
            const data = await request;
            this.cache.set(cacheKey, {
                data,
                timestamp: Date.now()
            });
            return data;
        } finally {
            this.pendingRequests.delete(cacheKey);
        }
    }
    
    async fetchAlerts(params = {}) {
        const cacheKey = `alerts_${JSON.stringify(params)}`;
        
        // Check cache (15 seconds)
        if (this.cache.has(cacheKey)) {
            const cached = this.cache.get(cacheKey);
            if (Date.now() - cached.timestamp < 15000) {
                return cached.data;
            }
        }
        
        const request = this._makeRequest('/alerts/active', params);
        this.pendingRequests.set(cacheKey, request);
        
        try {
            const data = await request;
            this.cache.set(cacheKey, {
                data,
                timestamp: Date.now()
            });
            return data;
        } finally {
            this.pendingRequests.delete(cacheKey);
        }
    }
    
    async _makeRequest(endpoint, params) {
        const url = new URL(`${this.baseURL}${endpoint}`, window.location.origin);
        
        Object.keys(params).forEach(key => 
            url.searchParams.append(key, params[key])
        );
        
        const response = await fetch(url, {
            headers: {
                'Content-Type': 'application/json',
                'X-Client-Version': '1.0.0',
                'X-Client-Type': 'heatmap'
            }
        });
        
        if (!response.ok) {
            throw new Error(`API error: ${response.status}`);
        }
        
        return response.json();
    }
}

window.ledgerAPI = new LedgerAPI();
