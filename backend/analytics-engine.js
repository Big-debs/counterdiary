// =====================================================
// THE LEDGER - ANALYTICS ENGINE
// Production-grade intelligence layer
// =====================================================

const { Pool } = require('pg');
const Redis = require('ioredis');
const natural = require('natural');
const sentiment = require('sentiment');
const tf = require('@tensorflow/tfjs-node');
const cron = require('node-cron');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

// Database connection pool
const pgPool = new Pool({
    host: process.env.DB_HOST,
    port: 5432,
    database: 'ledger',
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
});

// Redis for real-time caching
const redis = new Redis({
    host: process.env.REDIS_HOST,
    port: 6379,
    password: process.env.REDIS_PASSWORD,
    retryStrategy: (times) => Math.min(times * 50, 2000)
});

// =====================================================
// 1. SENTIMENT ANALYSIS ENGINE
// =====================================================

class SentimentAnalyzer {
    constructor() {
        this.analyzer = new sentiment();
        this.classifier = new natural.BayesClassifier();
        this.nigerianLexicon = this.loadNigerianLexicon();
    }
    
    loadNigerianLexicon() {
        // Nigerian Pidgin & local terms
        return {
            'wahala': -2,      // problem
            'taya': -1,        // tired
            'chop': 0,         // eat (neutral)
            'sabi': 1,         // know (positive)
            'japa': -1,        // flee (negative context)
            'korokoro': 1,     // exactly/precise (positive)
            'ajebutter': 1,    // posh (neutral/positive)
            'aboki': 0,        // neutral
            'mama put': 1,     // positive
            'bukka': 1,       // positive
            'keke': 0,        // neutral
            'okada': 0,       // neutral
            'danfo': 0,       // neutral
            'agbero': -2,     // very negative
            'area boys': -2,  // very negative
            'KAI': -1,        // negative
            'LASTMA': -1,     // negative
            'NAFDAC': 0,      // neutral
            'generator': -1,  // negative
            'diesel': -1,     // negative
            'PHCN': -2,       // very negative
            'NEPA': -2,       // very negative
        };
    }
    
    analyze(text) {
        if (!text || text.trim().length === 0) {
            return { score: 0, comparative: 0, label: 'neutral' };
        }
        
        // Base sentiment analysis
        const baseResult = this.analyzer.analyze(text);
        
        // Add Nigerian lexicon
        let nigerianScore = 0;
        const words = text.toLowerCase().split(/\s+/);
        
        words.forEach(word => {
            if (this.nigerianLexicon[word]) {
                nigerianScore += this.nigerianLexicon[word];
            }
        });
        
        // Combined score (-5 to 5 range)
        const totalScore = baseResult.score + nigerianScore;
        const normalizedScore = Math.max(-1, Math.min(1, totalScore / 10));
        
        // Determine label
        let label = 'neutral';
        if (normalizedScore > 0.2) label = 'positive';
        if (normalizedScore > 0.5) label = 'very_positive';
        if (normalizedScore < -0.2) label = 'negative';
        if (normalizedScore < -0.5) label = 'very_negative';
        
        return {
            score: normalizedScore,
            comparative: baseResult.comparative,
            label: label,
            words: baseResult.words,
            nigerian_terms: words.filter(w => this.nigerianLexicon[w])
        };
    }
    
    async batchAnalyze(records, textField) {
        const results = [];
        for (const record of records) {
            if (record[textField]) {
                const sentiment = this.analyze(record[textField]);
                results.push({
                    id: record.id,
                    sentiment_score: sentiment.score,
                    sentiment_label: sentiment.label
                });
            }
        }
        return results;
    }
}

// =====================================================
// 2. PATTERN DETECTION ENGINE
// =====================================================

class PatternDetector {
    constructor() {
        this.anomalyThresholds = {
            diesel_price: { zscore: 2.5, weeklyIncrease: 15 },
            harassment: { count: 3, timeframe: 60 }, // 3 reports in 60 minutes
            spoilage: { increase: 0.5, baseline: 7 }, // 50% increase from 7-day avg
            wage_theft: { increase: 0.3 } // 30% increase
        };
    }
    
    async detectAnomalies(metric, city, lga) {
        const client = await pgPool.connect();
        
        try {
            switch(metric) {
                case 'diesel_price':
                    return await this.detectDieselAnomaly(client, city, lga);
                case 'harassment':
                    return await this.detectHarassmentPattern(client, city, lga);
                case 'spoilage':
                    return await this.detectSpoilageOutbreak(client, city, lga);
                case 'wage_theft':
                    return await this.detectWageTheftPattern(client, city, lga);
                default:
                    return null;
            }
        } finally {
            client.release();
        }
    }
    
    async detectDieselAnomaly(client, city, lga) {
        // Get last 30 days of diesel prices
        const prices = await client.query(`
            SELECT 
                DATE(entry_date) as date,
                AVG(diesel_price) as avg_price,
                STDDEV(diesel_price) as price_stddev
            FROM diary_entries
            WHERE city = $1 
                AND lga = $2
                AND diesel_price > 0
                AND created_at > NOW() - INTERVAL '30 days'
            GROUP BY DATE(entry_date)
            ORDER BY date DESC
        `, [city, lga]);
        
        if (prices.rows.length < 7) return null;
        
        const recent = prices.rows[0];
        const historical = prices.rows.slice(1, 8);
        
        const historicalAvg = historical.reduce((sum, row) => 
            sum + parseFloat(row.avg_price), 0) / historical.length;
        
        const historicalStd = historical.reduce((sum, row) => 
            sum + Math.pow(parseFloat(row.avg_price) - historicalAvg, 2), 0);
        const stdDev = Math.sqrt(historicalStd / historical.length);
        
        const currentPrice = parseFloat(recent.avg_price);
        const zScore = (currentPrice - historicalAvg) / (stdDev || 1);
        const weeklyIncrease = ((currentPrice - historicalAvg) / historicalAvg) * 100;
        
        return {
            metric: 'diesel_price',
            city,
            lga,
            current_price: currentPrice,
            historical_avg: historicalAvg,
            z_score: zScore,
            weekly_increase_pct: weeklyIncrease,
            is_anomaly: zScore > this.anomalyThresholds.diesel_price.zscore,
            severity: this.calculateSeverity(zScore, weeklyIncrease)
        };
    }
    
    async detectHarassmentPattern(client, city, lga) {
        // Get harassment reports in last hour
        const reports = await client.query(`
            SELECT COUNT(*) as report_count,
                   ARRAY_AGG(DISTINCT harassment_type) as types,
                   ARRAY_AGG(DISTINCT owner_id) as owners
            FROM diary_entries
            WHERE city = $1
                AND lga = $2
                AND harassment_reported = TRUE
                AND created_at > NOW() - INTERVAL '1 hour'
        `, [city, lga]);
        
        const count = parseInt(reports.rows[0].report_count);
        
        return {
            metric: 'harassment',
            city,
            lga,
            report_count: count,
            is_anomaly: count >= this.anomalyThresholds.harassment.count,
            severity: count >= 5 ? 'critical' : count >= 3 ? 'high' : 'medium',
            types: reports.rows[0].types || []
        };
    }
    
    calculateSeverity(zScore, increasePct) {
        if (zScore > 4 || increasePct > 30) return 'critical';
        if (zScore > 3 || increasePct > 20) return 'high';
        if (zScore > 2.5 || increasePct > 15) return 'medium';
        return 'low';
    }
}

// =====================================================
// 3. PREDICTIVE ANALYTICS ENGINE
// =====================================================

class PredictiveEngine {
    constructor() {
        this.models = {};
        this.loadModels();
    }
    
    async loadModels() {
        // Load pre-trained TensorFlow models
        try {
            this.models.diesel = await tf.loadLayersModel(
                'file://./models/diesel-price-prediction/model.json'
            );
            this.models.stress = await tf.loadLayersModel(
                'file://./models/stress-index/model.json'
            );
        } catch (error) {
            console.log('Models not found, using statistical forecasting');
        }
    }
    
    async forecastDieselPrice(city, days = 7) {
        const client = await pgPool.connect();
        
        try {
            // Get historical data
            const historical = await client.query(`
                SELECT 
                    DATE(entry_date) as date,
                    AVG(diesel_price) as price
                FROM diary_entries
                WHERE city = $1
                    AND diesel_price > 0
                    AND created_at > NOW() - INTERVAL '90 days'
                GROUP BY DATE(entry_date)
                ORDER BY date
            `, [city]);
            
            if (historical.rows.length < 30) {
                return this.simpleMovingAverage(historical.rows, days);
            }
            
            // Use Holt-Winters exponential smoothing
            const prices = historical.rows.map(r => parseFloat(r.price));
            const forecast = this.holtWinters(prices, days);
            
            return {
                city,
                forecast_days: days,
                predictions: forecast,
                confidence_interval: this.calculateConfidenceInterval(prices, forecast),
                methodology: 'holt_winters'
            };
            
        } finally {
            client.release();
        }
    }
    
    holtWinters(data, forecastPeriods) {
        // Alpha: level smoothing, Beta: trend smoothing, Gamma: seasonal smoothing
        const alpha = 0.3, beta = 0.1, gamma = 0.1;
        const seasonLength = 7; // Weekly seasonality
        
        let level = data[0];
        let trend = data[1] - data[0];
        let seasonal = [];
        
        // Initialize seasonal indices
        for (let i = 0; i < seasonLength; i++) {
            seasonal[i] = data[i] / level;
        }
        
        // Smooth
        for (let i = 1; i < data.length; i++) {
            const lastLevel = level;
            const seasonIndex = i % seasonLength;
            
            level = alpha * (data[i] / seasonal[seasonIndex]) + (1 - alpha) * (level + trend);
            trend = beta * (level - lastLevel) + (1 - beta) * trend;
            seasonal[seasonIndex] = gamma * (data[i] / level) + (1 - gamma) * seasonal[seasonIndex];
        }
        
        // Forecast
        const forecast = [];
        for (let i = 1; i <= forecastPeriods; i++) {
            const seasonIndex = (data.length + i - 1) % seasonLength;
            forecast.push((level + i * trend) * seasonal[seasonIndex]);
        }
        
        return forecast;
    }
    
    async predictStaffShortage(city, days = 7) {
        // Similar implementation for staff shortage prediction
        // ...
    }
}

// =====================================================
// 4. ALERT ENGINE (Real-time)
// =====================================================

class AlertEngine {
    constructor() {
        this.patternDetector = new PatternDetector();
        this.redis = redis;
    }
    
    async processNewEntry(entry) {
        // Check for immediate alerts
        if (entry.harassment_reported) {
            await this.checkHarassmentThreshold(entry);
        }
        
        if (entry.diesel_price > 0) {
            await this.checkDieselSpike(entry);
        }
        
        // Cache for trend analysis
        await this.cacheEntry(entry);
    }
    
    async checkHarassmentThreshold(entry) {
        const client = await pgPool.connect();
        
        try {
            // Count recent harassment reports in area
            const result = await client.query(`
                SELECT COUNT(*) as count
                FROM diary_entries
                WHERE city = $1
                    AND lga = $2
                    AND harassment_reported = TRUE
                    AND created_at > NOW() - INTERVAL '1 hour'
            `, [entry.city, entry.lga]);
            
            const count = parseInt(result.rows[0].count);
            
            if (count >= 3) {
                // Create alert
                const alert = {
                    id: `alert_${Date.now()}`,
                    type: 'harassment',
                    severity: count >= 5 ? 'critical' : 'high',
                    city: entry.city,
                    lga: entry.lga,
                    count: count,
                    timestamp: new Date(),
                    message: `🔴 ${count} harassment reports in ${entry.lga}, ${entry.city} in last hour`
                };
                
                // Store in database
                await client.query(`
                    INSERT INTO alert_history (
                        alert_type, severity, city, lga,
                        trigger_count, message, created_at
                    ) VALUES ($1, $2, $3, $4, $5, $6, NOW())
                `, ['harassment', alert.severity, entry.city, entry.lga, count, alert.message]);
                
                // Publish to Redis for real-time
                await this.redis.publish('alerts', JSON.stringify(alert));
                
                // Trigger SMS for subscribed users
                await this.sendSMSAlerts(alert);
                
                return alert;
            }
        } finally {
            client.release();
        }
    }
    
    async checkDieselSpike(entry) {
        const client = await pgPool.connect();
        
        try {
            // Get average price for last 7 days
            const historical = await client.query(`
                SELECT AVG(diesel_price) as avg_price
                FROM diary_entries
                WHERE city = $1
                    AND lga = $2
                    AND diesel_price > 0
                    AND created_at > NOW() - INTERVAL '7 days'
                    AND created_at < NOW() - INTERVAL '24 hours'
            `, [entry.city, entry.lga]);
            
            if (historical.rows.length === 0) return;
            
            const avgPrice = parseFloat(historical.rows[0].avg_price);
            const currentPrice = parseFloat(entry.diesel_price);
            const increase = ((currentPrice - avgPrice) / avgPrice) * 100;
            
            if (increase >= 15) {
                const alert = {
                    id: `diesel_${Date.now()}`,
                    type: 'diesel_spike',
                    severity: increase >= 25 ? 'critical' : 'high',
                    city: entry.city,
                    lga: entry.lga,
                    current_price: currentPrice,
                    previous_avg: avgPrice,
                    increase_pct: increase,
                    timestamp: new Date(),
                    message: `🟡 Diesel spike in ${entry.lga}! ₦${currentPrice}/L (${increase.toFixed(1)}% increase WoW)`
                };
                
                await client.query(`
                    INSERT INTO alert_history (
                        alert_type, severity, city, lga,
                        trigger_count, message, threshold_value, actual_value, created_at
                    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
                `, ['diesel_spike', alert.severity, entry.city, entry.lga, 
                    1, alert.message, avgPrice, currentPrice]);
                
                await this.redis.publish('alerts', JSON.stringify(alert));
                await this.sendSMSAlerts(alert);
                
                return alert;
            }
        } finally {
            client.release();
        }
    }
    
    async sendSMSAlerts(alert) {
        // Get subscribers in this area
        const client = await pgPool.connect();
        
        try {
            const subscribers = await client.query(`
                SELECT phone_hash, phone_last_four
                FROM sms_subscriptions
                WHERE city = $1
                    AND lga = $2
                    AND is_active = TRUE
                    AND (
                        (alert_type = 'harassment' AND alert_raids = TRUE)
                        OR (alert_type = 'diesel_spike' AND alert_diesel = TRUE)
                    )
            `, [alert.city, alert.lga]);
            
            // Queue SMS jobs
            for (const sub of subscribers.rows) {
                await this.redis.lpush('sms_queue', JSON.stringify({
                    phone_hash: sub.phone_hash,
                    phone_last_four: sub.phone_last_four,
                    message: alert.message,
                    alert_id: alert.id
                }));
            }
            
            // Update alert with sent count
            await client.query(`
                UPDATE alert_history
                SET sms_sent_count = $1
                WHERE alert_id = $2
            `, [subscribers.rowCount, alert.id]);
            
        } finally {
            client.release();
        }
    }

    async cacheEntry(entry) {
        const cacheKey = `entry:${entry.city}:${entry.lga}:${Date.now()}`;
        const cacheValue = {
            city: entry.city,
            lga: entry.lga,
            diesel_price: entry.diesel_price || 0,
            staff_absent: entry.staff_absent || 0,
            spoilage_amount: entry.spoilage_amount || 0,
            leakage_amount: entry.leakage_amount || 0,
            harassment_reported: !!entry.harassment_reported,
            created_at: new Date().toISOString()
        };

        await this.redis.setex(cacheKey, 60 * 60 * 24, JSON.stringify(cacheValue));
    }
}

// =====================================================
// 5. REPORT GENERATOR
// =====================================================

class ReportGenerator {
    async generateWeeklyReport(weekDate) {
        const client = await pgPool.connect();
        
        try {
            const weekStart = new Date(weekDate);
            weekStart.setHours(0, 0, 0, 0);
            const weekEnd = new Date(weekStart);
            weekEnd.setDate(weekEnd.getDate() + 7);
            
            // 1. Gather all metrics
            const [
                dieselStats,
                ownerStats,
                workerStats,
                customerStats,
                harassmentStats,
                topInsights
            ] = await Promise.all([
                this.getDieselStats(client, weekStart, weekEnd),
                this.getOwnerStats(client, weekStart, weekEnd),
                this.getWorkerStats(client, weekStart, weekEnd),
                this.getCustomerStats(client, weekStart, weekEnd),
                this.getHarassmentStats(client, weekStart, weekEnd),
                this.generateInsights(client, weekStart, weekEnd)
            ]);
            
            // 2. Compile report
            const report = {
                week: weekStart.toISOString().split('T')[0],
                generated_at: new Date(),
                summary: {
                    diesel: dieselStats,
                    owners: ownerStats,
                    workers: workerStats,
                    customers: customerStats,
                    harassment: harassmentStats
                },
                insights: topInsights,
                recommendations: this.generateRecommendations(dieselStats, workerStats, customerStats),
                data_quality: await this.assessDataQuality(client, weekStart, weekEnd)
            };
            
            // 3. Store in database
            const result = await client.query(`
                INSERT INTO weekly_reports (
                    report_week, 
                    national_diesel_avg,
                    national_stress_index,
                    total_diary_entries,
                    total_worker_reports,
                    total_customer_feedback,
                    key_findings,
                    recommendations,
                    created_at
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
                RETURNING report_id
            `, [
                weekStart,
                dieselStats.national_avg,
                this.calculateNationalStressIndex(dieselStats, workerStats, customerStats),
                ownerStats.total_entries,
                workerStats.total_reports,
                customerStats.total_feedback,
                JSON.stringify(topInsights.slice(0, 5)),
                JSON.stringify(report.recommendations)
            ]);
            
            return {
                report_id: result.rows[0].report_id,
                ...report
            };
            
        } finally {
            client.release();
        }
    }
    
    async getDieselStats(client, weekStart, weekEnd) {
        const result = await client.query(`
            SELECT 
                AVG(diesel_price) as national_avg,
                PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY diesel_price) as median_price,
                MIN(diesel_price) as min_price,
                MAX(diesel_price) as max_price,
                STDDEV(diesel_price) as price_volatility,
                COUNT(DISTINCT city) as cities_tracked,
                COUNT(*) as sample_size
            FROM diary_entries
            WHERE diesel_price > 0
                AND created_at BETWEEN $1 AND $2
        `, [weekStart, weekEnd]);
        
        // Get city breakdown
        const byCity = await client.query(`
            SELECT 
                city,
                AVG(diesel_price) as avg_price,
                COUNT(*) as reports
            FROM diary_entries
            WHERE diesel_price > 0
                AND created_at BETWEEN $1 AND $2
            GROUP BY city
            ORDER BY avg_price DESC
        `, [weekStart, weekEnd]);
        
        return {
            ...result.rows[0],
            by_city: byCity.rows
        };
    }
    
    generateRecommendations(dieselStats, workerStats, customerStats) {
        const recommendations = [];
        
        if (dieselStats.national_avg > 850) {
            recommendations.push({
                category: 'energy',
                priority: 'high',
                title: 'Consider solar hybrid solutions',
                description: 'With diesel averaging ₦' + 
                    Math.round(dieselStats.national_avg) + 
                    '/L, restaurants spending >₦100k/month on diesel should evaluate solar ROI.'
            });
        }
        
        if (workerStats.wage_theft_rate > 0.3) {
            recommendations.push({
                category: 'labour',
                priority: 'critical',
                title: 'Wage theft crisis - implement digital payroll',
                description: workerStats.wage_theft_rate_pct + 
                    '% of workers report wage theft. Digital payment systems can reduce leakage and improve retention.'
            });
        }
        
        if (customerStats.portion_complaint_rate > 0.4) {
            recommendations.push({
                category: 'customer',
                priority: 'high',
                title: 'Portion size sensitivity detected',
                description: customerStats.portion_complaint_rate_pct + 
                    '% of customers report smaller portions. Consider transparency messaging about cost increases.'
            });
        }
        
        return recommendations;
    }
}

// =====================================================
// 6. API SERVER (Express)
// =====================================================

const express = require('express');
const registerAccessRoutes = require('./routes/access-routes');
const registerPublicRoutes = require('./routes/public-routes');
const app = express();
const sentimentAnalyzer = new SentimentAnalyzer();
const patternDetector = new PatternDetector();
const predictiveEngine = new PredictiveEngine();
const alertEngine = new AlertEngine();
const reportGenerator = new ReportGenerator();

const JWT_SECRET = process.env.JWT_SECRET || 'ledger_dev_jwt_secret_change_me';
const ACCESS_TOKEN_TTL = process.env.ACCESS_TOKEN_TTL || '15m';
const REFRESH_TOKEN_TTL_DAYS = Number(process.env.REFRESH_TOKEN_TTL_DAYS || 30);
const ADMIN_BOOTSTRAP_KEY = process.env.ADMIN_BOOTSTRAP_KEY || '';
const QR_SIGNING_SECRET = process.env.QR_SIGNING_SECRET || 'ledger_dev_qr_signing_secret_change_me';

function hashToken(value) {
    return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function generateRefreshToken() {
    return crypto.randomBytes(48).toString('hex');
}

function signAccessToken(user, roles) {
    return jwt.sign(
        { sub: user.user_id, email: user.email, roles },
        JWT_SECRET,
        { expiresIn: ACCESS_TOKEN_TTL }
    );
}

function hashPassword(password) {
    const salt = crypto.randomBytes(16).toString('hex');
    const derivedKey = crypto.scryptSync(password, salt, 64).toString('hex');
    return `${salt}:${derivedKey}`;
}

function verifyPassword(password, passwordHash) {
    const [salt, storedKey] = String(passwordHash || '').split(':');
    if (!salt || !storedKey) return false;
    const derivedKey = crypto.scryptSync(password, salt, 64);
    const storedBuffer = Buffer.from(storedKey, 'hex');
    if (storedBuffer.length !== derivedKey.length) return false;
    return crypto.timingSafeEqual(storedBuffer, derivedKey);
}

function signQrToken(token) {
    return crypto.createHmac('sha256', QR_SIGNING_SECRET).update(token).digest('hex');
}

function encodeQrPayload(payload) {
    return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

function decodeQrPayload(token) {
    try {
        const raw = Buffer.from(String(token), 'base64url').toString('utf8');
        return JSON.parse(raw);
    } catch (_error) {
        return null;
    }
}

function verifyQrToken(token, signature) {
    if (!token || !signature) return null;
    const expected = signQrToken(token);
    const sigBuf = Buffer.from(String(signature), 'utf8');
    const expBuf = Buffer.from(expected, 'utf8');
    if (sigBuf.length !== expBuf.length) return null;
    if (!crypto.timingSafeEqual(sigBuf, expBuf)) return null;

    const payload = decodeQrPayload(token);
    if (!payload || !payload.restaurant_id || !payload.campaign_id || !payload.exp) return null;
    if (Number(payload.exp) <= Date.now()) return null;
    return payload;
}

app.set('trust proxy', 1);
app.use(express.json({ limit: '256kb' }));
app.use(express.urlencoded({ extended: true }));

// CORS for frontend
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', process.env.FRONTEND_URL || '*');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
    res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    if (req.method === 'OPTIONS') {
        return res.sendStatus(204);
    }
    next();
});

const CITY_COORDINATES = {
    'Lagos': [3.3792, 6.5244],
    'Abuja': [7.4951, 9.0579],
    'Port Harcourt': [7.0493, 4.8156],
    'Kano': [8.5167, 12.0000],
    'Ibadan': [3.8964, 7.3776],
    'Benin': [5.6037, 6.3350],
    'Enugu': [7.4951, 6.4413],
    'Kaduna': [7.4388, 10.5264],
    'Aba': [7.3667, 5.1167],
    'Jos': [8.9000, 9.9333]
};

function getCityCoordinates(cityName) {
    return CITY_COORDINATES[cityName] || [8.6753, 9.0820];
}

function getSeverityFromScore(score) {
    if (score >= 80) return 'critical';
    if (score >= 60) return 'high';
    if (score >= 40) return 'medium';
    return 'low';
}

function toBoolean(value) {
    return value === true || value === 'true' || value === 1 || value === '1';
}

function toNumber(value, { min = 0, max = Number.MAX_SAFE_INTEGER, defaultValue = 0 } = {}) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return defaultValue;
    return Math.min(max, Math.max(min, parsed));
}

function toSafeString(value, maxLength) {
    if (typeof value !== 'string') return '';
    return value.trim().slice(0, maxLength);
}

const diaryWriteLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 45,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many diary submissions. Please retry in a few minutes.' }
});

const smsInboundLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
    message: 'Rate limit exceeded'
});

const smsSubscribeLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many SMS subscription attempts. Please retry later.' }
});

const workerReportLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 40,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many worker submissions. Please retry later.' }
});

const customerFeedbackLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 50,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many customer submissions. Please retry later.' }
});

const confessionLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 25,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many confession submissions. Please retry later.' }
});

const newsletterLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many newsletter requests. Please retry later.' }
});

const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many authentication attempts. Please retry later.' }
});

function validateDiaryPayload(req, res, next) {
    const payload = req.body || {};

    const anonymousToken = toSafeString(
        payload.anonymous_token || payload.anonymous_id,
        64
    );
    const city = toSafeString(payload.city, 100);
    const lga = toSafeString(payload.lga, 100);

    if (!anonymousToken) {
        return res.status(400).json({ error: 'anonymous_token is required' });
    }
    if (!city) {
        return res.status(400).json({ error: 'city is required' });
    }
    if (!lga) {
        return res.status(400).json({ error: 'lga is required' });
    }

    req.body = {
        anonymous_token: anonymousToken,
        city,
        lga,
        diesel_price: toNumber(payload.diesel_price, { min: 0, max: 10000, defaultValue: 0 }),
        staff_absent: Math.floor(toNumber(payload.staff_absent, { min: 0, max: 1000, defaultValue: 0 })),
        spoilage_amount: toNumber(payload.spoilage_amount, { min: 0, max: 100000000, defaultValue: 0 }),
        leakage_amount: toNumber(payload.leakage_amount, { min: 0, max: 100000000, defaultValue: 0 }),
        supplier_failure: toBoolean(payload.supplier_failure),
        harassment_reported: toBoolean(payload.harassment_reported),
        price_changed: toBoolean(payload.price_changed),
        portion_reduced: toBoolean(payload.portion_reduced),
        took_loss: toBoolean(payload.took_loss),
        vent_text: toSafeString(payload.vent_text, 2000)
    };

    next();
}

function normalizeNigerianPhone(rawPhone) {
    const digits = String(rawPhone || '').replace(/\D/g, '');
    if (/^0[789][01]\d{8}$/.test(digits)) {
        return `234${digits.slice(1)}`;
    }
    if (/^234[789][01]\d{8}$/.test(digits)) {
        return digits;
    }
    return null;
}

function validateSmsSubscriptionPayload(req, res, next) {
    const payload = req.body || {};
    const normalizedPhone = normalizeNigerianPhone(payload.phone);
    const city = toSafeString(payload.city, 100);
    const lga = toSafeString(payload.lga, 100);

    if (!normalizedPhone) {
        return res.status(400).json({ error: 'Valid Nigerian phone number is required' });
    }
    if (!city || !lga) {
        return res.status(400).json({ error: 'city and lga are required' });
    }

    const alerts = payload.alerts || {};

    req.body = {
        phone: normalizedPhone,
        phone_last_four: normalizedPhone.slice(-4),
        city,
        lga,
        alert_diesel: toBoolean(alerts.diesel),
        alert_raids: toBoolean(alerts.raids),
        alert_supplier: toBoolean(alerts.supplier),
        alert_spoilage: toBoolean(alerts.spoilage),
        alert_customer: toBoolean(alerts.customer)
    };

    next();
}

function validateWorkerReportPayload(req, res, next) {
    const payload = req.body || {};
    const city = toSafeString(payload.city, 100);
    const payment = toSafeString(payload.payment, 32) || 'not_specified';
    const status = toSafeString(payload.status, 32) || 'not_specified';
    const whisper = toSafeString(payload.whisper, 2000);

    if (!city) {
        return res.status(400).json({ error: 'city is required' });
    }

    req.body = { city, payment, status, whisper };
    next();
}

function validateCustomerFeedbackPayload(req, res, next) {
    const payload = req.body || {};
    const restaurantId = toSafeString(payload.restaurant_id, 64);
    const restaurantCity = toSafeString(payload.restaurant_city, 100) ||
        toSafeString(payload.restaurant_location, 100) ||
        'Unknown';
    const restaurantLga = toSafeString(payload.restaurant_lga, 100);
    const portionRating = toSafeString(payload.portion_rating, 20);
    const commentText = toSafeString(payload.comment, 2000);
    const priceMatched = toBoolean(payload.price_match);
    const willReturn = toBoolean(payload.will_return);
    const qrToken = toSafeString(payload.qr_token || payload.token || '', 2000);
    const qrSignature = toSafeString(payload.qr_signature || payload.sig || '', 256);

    if ((!restaurantId && !qrToken) || !portionRating) {
        return res.status(400).json({ error: 'portion_rating and either restaurant_id or qr_token are required' });
    }

    const scoreMap = {
        too_small: 1,
        small: 2,
        just_right: 3,
        large: 4,
        too_large: 5
    };

    req.body = {
        restaurant_id: restaurantId,
        restaurant_city: restaurantCity,
        restaurant_lga: restaurantLga,
        qr_token: qrToken,
        qr_signature: qrSignature,
        portion_rating: portionRating,
        portion_score: scoreMap[portionRating] || 3,
        price_matched: priceMatched,
        will_return: willReturn,
        comment_text: commentText
    };
    next();
}

function validateConfessionPayload(req, res, next) {
    const payload = req.body || {};
    const role = toSafeString(payload.role, 20);
    const city = toSafeString(payload.city, 100);
    const lga = toSafeString(payload.lga, 100);
    const text = toSafeString(payload.text, 2000);

    if (!role || !city || !text) {
        return res.status(400).json({ error: 'role, city, and text are required' });
    }

    req.body = { role, city, lga, text };
    next();
}

function validateNewsletterPayload(req, res, next) {
    const payload = req.body || {};
    const email = toSafeString(payload.email, 254).toLowerCase();
    const source = toSafeString(payload.source, 64) || 'public_pulse';

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res.status(400).json({ error: 'Valid email is required' });
    }

    req.body = { email, source };
    next();
}

function validateVerificationRequestPayload(req, res, next) {
    const payload = req.body || {};
    const businessName = toSafeString(payload.business_name || '', 180);
    const city = toSafeString(payload.city || '', 100);
    const lga = toSafeString(payload.lga || '', 100);
    const notes = toSafeString(payload.notes || '', 2000);
    const documents = Array.isArray(payload.documents) ? payload.documents : [];

    const normalizedDocs = documents
        .slice(0, 5)
        .map((doc) => ({
            document_type: toSafeString(doc?.document_type || '', 80),
            document_ref: toSafeString(doc?.document_ref || '', 500),
            metadata: doc?.metadata && typeof doc.metadata === 'object' ? doc.metadata : {}
        }))
        .filter((doc) => doc.document_type && doc.document_ref);

    if (!businessName) {
        return res.status(400).json({ error: 'business_name is required' });
    }
    if (!city || !lga) {
        return res.status(400).json({ error: 'city and lga are required' });
    }

    req.body = {
        business_name: businessName,
        city,
        lga,
        notes,
        documents: normalizedDocs
    };
    next();
}

function validateRestaurantPayload(req, res, next) {
    const payload = req.body || {};
    const name = toSafeString(payload.name || payload.business_name || '', 180);
    const city = toSafeString(payload.city || '', 100);
    const lga = toSafeString(payload.lga || '', 100);

    if (!name || !city || !lga) {
        return res.status(400).json({ error: 'name, city, and lga are required' });
    }

    req.body = { name, city, lga };
    next();
}

function validateQrCampaignPayload(req, res, next) {
    const payload = req.body || {};
    const restaurantId = toSafeString(payload.restaurant_id || '', 80);
    const campaignName = toSafeString(payload.campaign_name || 'Default Campaign', 120);
    const expiresInDays = Math.min(365, Math.max(1, parseInt(payload.expires_in_days, 10) || 90));

    if (!restaurantId) {
        return res.status(400).json({ error: 'restaurant_id is required' });
    }

    req.body = {
        restaurant_id: restaurantId,
        campaign_name: campaignName,
        expires_in_days: expiresInDays
    };
    next();
}

function validateRegisterPayload(req, res, next) {
    const payload = req.body || {};
    const email = toSafeString(payload.email, 254).toLowerCase();
    const password = String(payload.password || '');
    const displayName = toSafeString(payload.display_name || payload.full_name || '', 120);
    const role = toSafeString(payload.role || 'owner', 20).toLowerCase();
    const allowedRoles = ['owner', 'worker', 'customer'];

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res.status(400).json({ error: 'Valid email is required' });
    }
    if (password.length < 8) {
        return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }
    if (!allowedRoles.includes(role)) {
        return res.status(400).json({ error: 'Invalid role' });
    }

    req.body = { email, password, display_name: displayName, role };
    next();
}

function validateLoginPayload(req, res, next) {
    const payload = req.body || {};
    const email = toSafeString(payload.email, 254).toLowerCase();
    const password = String(payload.password || '');

    if (!email || !password) {
        return res.status(400).json({ error: 'email and password are required' });
    }

    req.body = { email, password };
    next();
}

function extractBearerToken(req) {
    const authHeader = req.headers.authorization || '';
    if (!authHeader.startsWith('Bearer ')) return null;
    return authHeader.slice(7).trim();
}

function requireAuth(req, res, next) {
    const token = extractBearerToken(req);
    if (!token) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
        req.auth = jwt.verify(token, JWT_SECRET);
        return next();
    } catch (_error) {
        return res.status(401).json({ error: 'Invalid or expired token' });
    }
}

function requireRole(...roles) {
    return (req, res, next) => {
        const userRoles = req.auth?.roles || [];
        const allowed = roles.some((role) => userRoles.includes(role));
        if (!allowed) {
            return res.status(403).json({ error: 'Forbidden' });
        }
        return next();
    };
}

async function requireVerifiedOwner(req, res, next) {
    try {
        const userId = req.auth?.sub;
        if (!userId) return res.status(401).json({ error: 'Unauthorized' });

        const result = await pgPool.query(`
            SELECT verification_status
            FROM users
            WHERE user_id = $1
            LIMIT 1
        `, [userId]);

        if (result.rowCount === 0) return res.status(401).json({ error: 'Unauthorized' });
        if (result.rows[0].verification_status !== 'verified') {
            return res.status(403).json({ error: 'Verified owner account required' });
        }
        return next();
    } catch (error) {
        console.error('Verified owner guard error:', error);
        return res.status(500).json({ error: 'Authorization check failed' });
    }
}

async function ensureConfessionsTable() {
    await pgPool.query(`
        CREATE TABLE IF NOT EXISTS confessions (
            confession_id BIGSERIAL PRIMARY KEY,
            role VARCHAR(20) NOT NULL,
            city VARCHAR(100) NOT NULL,
            lga VARCHAR(100),
            text TEXT NOT NULL,
            reactions JSONB DEFAULT '{"heart":0,"share":0,"eye":0}'::jsonb,
            created_at TIMESTAMPTZ DEFAULT NOW()
        )
    `);
}

async function ensureNewsletterTable() {
    await pgPool.query(`
        CREATE TABLE IF NOT EXISTS newsletter_subscriptions (
            subscription_id BIGSERIAL PRIMARY KEY,
            email VARCHAR(254) UNIQUE NOT NULL,
            source VARCHAR(64) DEFAULT 'public_pulse',
            is_active BOOLEAN DEFAULT TRUE,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            updated_at TIMESTAMPTZ DEFAULT NOW()
        )
    `);
}

async function ensureAuthTables() {
    await pgPool.query(`
        CREATE TABLE IF NOT EXISTS users (
            user_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            email VARCHAR(254) UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            display_name VARCHAR(120),
            is_active BOOLEAN DEFAULT TRUE,
            email_verified BOOLEAN DEFAULT FALSE,
            verification_status VARCHAR(20) DEFAULT 'unverified',
            last_login_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            updated_at TIMESTAMPTZ DEFAULT NOW()
        )
    `);

    await pgPool.query(`
        CREATE TABLE IF NOT EXISTS roles (
            role_id SERIAL PRIMARY KEY,
            role_name VARCHAR(30) UNIQUE NOT NULL
        )
    `);

    await pgPool.query(`
        CREATE TABLE IF NOT EXISTS user_roles (
            user_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
            role_id INTEGER REFERENCES roles(role_id) ON DELETE CASCADE,
            assigned_at TIMESTAMPTZ DEFAULT NOW(),
            assigned_by UUID REFERENCES users(user_id),
            PRIMARY KEY (user_id, role_id)
        )
    `);

    await pgPool.query(`
        CREATE TABLE IF NOT EXISTS auth_sessions (
            session_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
            refresh_token_hash CHAR(64) UNIQUE NOT NULL,
            user_agent TEXT,
            ip_address VARCHAR(64),
            is_revoked BOOLEAN DEFAULT FALSE,
            expires_at TIMESTAMPTZ NOT NULL,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            revoked_at TIMESTAMPTZ
        )
    `);

    await pgPool.query(`
        CREATE TABLE IF NOT EXISTS audit_logs (
            log_id BIGSERIAL PRIMARY KEY,
            actor_user_id UUID REFERENCES users(user_id),
            action VARCHAR(80) NOT NULL,
            target_type VARCHAR(80),
            target_id VARCHAR(120),
            metadata JSONB DEFAULT '{}'::jsonb,
            created_at TIMESTAMPTZ DEFAULT NOW()
        )
    `);

    await pgPool.query(`
        CREATE TABLE IF NOT EXISTS verification_requests (
            verification_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
            entity_type VARCHAR(40) DEFAULT 'user',
            business_name VARCHAR(180) NOT NULL,
            city VARCHAR(100) NOT NULL,
            lga VARCHAR(100) NOT NULL,
            notes TEXT,
            status VARCHAR(20) DEFAULT 'pending',
            metadata JSONB DEFAULT '{}'::jsonb,
            submitted_at TIMESTAMPTZ DEFAULT NOW(),
            decided_at TIMESTAMPTZ,
            decided_by UUID REFERENCES users(user_id),
            rejection_reason TEXT,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            updated_at TIMESTAMPTZ DEFAULT NOW()
        )
    `);

    await pgPool.query(`
        CREATE TABLE IF NOT EXISTS verification_documents (
            document_id BIGSERIAL PRIMARY KEY,
            verification_id UUID REFERENCES verification_requests(verification_id) ON DELETE CASCADE,
            document_type VARCHAR(80) NOT NULL,
            document_ref TEXT NOT NULL,
            metadata JSONB DEFAULT '{}'::jsonb,
            created_at TIMESTAMPTZ DEFAULT NOW()
        )
    `);

    await pgPool.query(`
        CREATE TABLE IF NOT EXISTS restaurants (
            restaurant_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            name VARCHAR(180) NOT NULL,
            city VARCHAR(100) NOT NULL,
            lga VARCHAR(100) NOT NULL,
            verification_status VARCHAR(20) DEFAULT 'pending',
            owner_user_id UUID REFERENCES users(user_id),
            verified_at TIMESTAMPTZ,
            verified_by UUID REFERENCES users(user_id),
            created_at TIMESTAMPTZ DEFAULT NOW(),
            updated_at TIMESTAMPTZ DEFAULT NOW()
        )
    `);

    await pgPool.query(`
        CREATE TABLE IF NOT EXISTS restaurant_members (
            restaurant_id UUID REFERENCES restaurants(restaurant_id) ON DELETE CASCADE,
            user_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
            role VARCHAR(30) DEFAULT 'owner',
            created_at TIMESTAMPTZ DEFAULT NOW(),
            PRIMARY KEY (restaurant_id, user_id)
        )
    `);

    await pgPool.query(`
        CREATE TABLE IF NOT EXISTS qr_campaigns (
            campaign_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            restaurant_id UUID REFERENCES restaurants(restaurant_id) ON DELETE CASCADE,
            campaign_name VARCHAR(120) NOT NULL,
            is_active BOOLEAN DEFAULT TRUE,
            created_by UUID REFERENCES users(user_id),
            created_at TIMESTAMPTZ DEFAULT NOW(),
            expires_at TIMESTAMPTZ
        )
    `);

    await pgPool.query(`
        INSERT INTO roles (role_name) VALUES
            ('superadmin'), ('admin'), ('owner'), ('worker'), ('customer')
        ON CONFLICT (role_name) DO NOTHING
    `);
}

async function getUserRoles(userId) {
    const rolesResult = await pgPool.query(`
        SELECT r.role_name
        FROM user_roles ur
        JOIN roles r ON r.role_id = ur.role_id
        WHERE ur.user_id = $1
        ORDER BY r.role_name ASC
    `, [userId]);
    return rolesResult.rows.map((row) => row.role_name);
}

async function createSessionTokens(user, roles, req) {
    const accessToken = signAccessToken(user, roles);
    const refreshToken = generateRefreshToken();
    const refreshTokenHash = hashToken(refreshToken);
    const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);

    await pgPool.query(`
        INSERT INTO auth_sessions (
            user_id, refresh_token_hash, user_agent, ip_address, expires_at
        ) VALUES ($1, $2, $3, $4, $5)
    `, [
        user.user_id,
        refreshTokenHash,
        toSafeString(req.headers['user-agent'] || '', 500),
        toSafeString(req.ip || '', 64),
        expiresAt
    ]);

    return { access_token: accessToken, refresh_token: refreshToken, expires_at: expiresAt.toISOString() };
}

// =====================================================
// API ENDPOINTS
// =====================================================

registerAccessRoutes(app, {
    pgPool,
    authLimiter,
    requireAuth,
    requireRole,
    requireVerifiedOwner,
    validateRegisterPayload,
    validateLoginPayload,
    validateRestaurantPayload,
    validateQrCampaignPayload,
    validateVerificationRequestPayload,
    toSafeString,
    hashPassword,
    verifyPassword,
    getUserRoles,
    createSessionTokens,
    hashToken,
    encodeQrPayload,
    signQrToken,
    verifyQrToken,
    ADMIN_BOOTSTRAP_KEY
});

registerPublicRoutes(app, {
    pgPool,
    redis,
    predictiveEngine,
    alertEngine,
    sentimentAnalyzer,
    ensureConfessionsTable,
    ensureNewsletterTable,
    diaryWriteLimiter,
    smsSubscribeLimiter,
    workerReportLimiter,
    customerFeedbackLimiter,
    confessionLimiter,
    newsletterLimiter,
    validateDiaryPayload,
    validateSmsSubscriptionPayload,
    validateWorkerReportPayload,
    validateCustomerFeedbackPayload,
    validateConfessionPayload,
    validateNewsletterPayload,
    verifyQrToken,
    getCityCoordinates,
    getSeverityFromScore
});




// 7. SMS webhook (Twilio)
app.post('/api/sms/inbound', smsInboundLimiter, async (req, res) => {
    try {
        const { From, Body } = req.body;
        
        // Handle unsubscribe
        if (Body.toLowerCase().includes('stop') || 
            Body.toLowerCase().includes('unsubscribe')) {
            
            await pgPool.query(`
                UPDATE sms_subscriptions
                SET is_active = FALSE,
                    unsubscribed_at = NOW(),
                    unsubscribe_reason = 'user_sms'
                WHERE phone_hash = crypt($1, phone_hash)
            `, [From]);
            
            // Twilio XML response
            res.set('Content-Type', 'text/xml');
            return res.send(`
                <Response>
                    <Message>✅ You have unsubscribed from LEDGER alerts. Reply START to resubscribe.</Message>
                </Response>
            `);
        }
        
        // Handle help
        if (Body.toLowerCase().includes('help')) {
            res.set('Content-Type', 'text/xml');
            return res.send(`
                <Response>
                    <Message>🆘 EMERGENCY: Contact NEMA 080-3222-8209 or Police 112. For LEDGER support: support@counterdiary.ng</Message>
                </Response>
            `);
        }
        
        // Default response
        res.set('Content-Type', 'text/xml');
        res.send(`
            <Response>
                <Message>📊 LEDGER: Reply STOP to unsubscribe, HELP for emergencies. Visit counterdiary.ng for live industry data.</Message>
            </Response>
        `);
        
    } catch (error) {
        console.error('SMS webhook error:', error);
        res.status(500).send('Error');
    }
});

// Start server
ensureAuthTables()
    .then(() => Promise.all([ensureConfessionsTable(), ensureNewsletterTable()]))
    .catch((error) => {
        console.error('Auth/newsletter bootstrap warning:', error);
    });

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 LEDGER Intelligence Engine running on port ${PORT}`);
});

// Schedule recurring jobs
cron.schedule('*/5 * * * *', async () => {
    // Update city pressure index every 5 minutes
    await pgPool.query('SELECT update_city_pressure();');
    console.log('✅ City pressure index updated');
});

cron.schedule('0 * * * *', async () => {
    // Check for anomalies every hour
    console.log('🔍 Running anomaly detection...');
    // ...
});

cron.schedule('0 0 * * 1', async () => {
    // Generate weekly report every Monday
    const lastMonday = new Date();
    lastMonday.setDate(lastMonday.getDate() - lastMonday.getDay() + 1);
    await reportGenerator.generateWeeklyReport(lastMonday);
    console.log('📊 Weekly report generated');
});

module.exports = {
    SentimentAnalyzer,
    PatternDetector,
    PredictiveEngine,
    AlertEngine,
    ReportGenerator
};
