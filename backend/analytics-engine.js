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

// 0. Auth register
app.post('/api/auth/register', authLimiter, validateRegisterPayload, async (req, res) => {
    const client = await pgPool.connect();
    try {
        const { email, password, display_name, role } = req.body;
        const existing = await client.query(`SELECT user_id FROM users WHERE email = $1`, [email]);
        if (existing.rowCount > 0) {
            return res.status(409).json({ error: 'Email already registered' });
        }

        const passwordHash = hashPassword(password);
        await client.query('BEGIN');

        const userResult = await client.query(`
            INSERT INTO users (email, password_hash, display_name, is_active, created_at, updated_at)
            VALUES ($1, $2, $3, TRUE, NOW(), NOW())
            RETURNING user_id, email, display_name, verification_status, created_at
        `, [email, passwordHash, display_name || null]);
        const user = userResult.rows[0];

        await client.query(`
            INSERT INTO user_roles (user_id, role_id)
            SELECT $1, role_id FROM roles WHERE role_name = $2
            ON CONFLICT DO NOTHING
        `, [user.user_id, role]);

        await client.query(`
            INSERT INTO audit_logs (actor_user_id, action, target_type, target_id, metadata)
            VALUES ($1, 'auth.register', 'user', $2, $3::jsonb)
        `, [user.user_id, user.user_id, JSON.stringify({ role })]);

        await client.query('COMMIT');

        const roles = await getUserRoles(user.user_id);
        const tokens = await createSessionTokens(user, roles, req);

        return res.status(201).json({
            success: true,
            user: {
                user_id: user.user_id,
                email: user.email,
                display_name: user.display_name,
                verification_status: user.verification_status,
                roles
            },
            ...tokens
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Auth register error:', error);
        return res.status(500).json({ error: 'Failed to register user' });
    } finally {
        client.release();
    }
});

// 0b. Auth login
app.post('/api/auth/login', authLimiter, validateLoginPayload, async (req, res) => {
    try {
        const { email, password } = req.body;
        const userResult = await pgPool.query(`
            SELECT user_id, email, password_hash, display_name, is_active, verification_status
            FROM users
            WHERE email = $1
            LIMIT 1
        `, [email]);

        if (userResult.rowCount === 0) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        const user = userResult.rows[0];
        if (!user.is_active) {
            return res.status(403).json({ error: 'Account is disabled' });
        }

        const passwordOk = verifyPassword(password, user.password_hash);
        if (!passwordOk) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        const roles = await getUserRoles(user.user_id);
        const tokens = await createSessionTokens(user, roles, req);

        await pgPool.query(`
            UPDATE users
            SET last_login_at = NOW(), updated_at = NOW()
            WHERE user_id = $1
        `, [user.user_id]);

        return res.json({
            success: true,
            user: {
                user_id: user.user_id,
                email: user.email,
                display_name: user.display_name,
                verification_status: user.verification_status,
                roles
            },
            ...tokens
        });
    } catch (error) {
        console.error('Auth login error:', error);
        return res.status(500).json({ error: 'Failed to login' });
    }
});

// 0c. Auth refresh
app.post('/api/auth/refresh', authLimiter, async (req, res) => {
    try {
        const refreshToken = toSafeString(req.body?.refresh_token || '', 500);
        if (!refreshToken) {
            return res.status(400).json({ error: 'refresh_token is required' });
        }

        const refreshTokenHash = hashToken(refreshToken);
        const sessionResult = await pgPool.query(`
            SELECT s.session_id, s.user_id, s.expires_at, s.is_revoked,
                   u.email, u.display_name, u.is_active, u.verification_status
            FROM auth_sessions s
            JOIN users u ON u.user_id = s.user_id
            WHERE s.refresh_token_hash = $1
            LIMIT 1
        `, [refreshTokenHash]);

        if (sessionResult.rowCount === 0) {
            return res.status(401).json({ error: 'Invalid refresh token' });
        }

        const session = sessionResult.rows[0];
        if (session.is_revoked || new Date(session.expires_at) <= new Date()) {
            return res.status(401).json({ error: 'Refresh token expired or revoked' });
        }
        if (!session.is_active) {
            return res.status(403).json({ error: 'Account is disabled' });
        }

        await pgPool.query(`
            UPDATE auth_sessions
            SET is_revoked = TRUE, revoked_at = NOW()
            WHERE session_id = $1
        `, [session.session_id]);

        const roles = await getUserRoles(session.user_id);
        const tokens = await createSessionTokens(session, roles, req);

        return res.json({
            success: true,
            user: {
                user_id: session.user_id,
                email: session.email,
                display_name: session.display_name,
                verification_status: session.verification_status,
                roles
            },
            ...tokens
        });
    } catch (error) {
        console.error('Auth refresh error:', error);
        return res.status(500).json({ error: 'Failed to refresh session' });
    }
});

// 0d. Auth logout
app.post('/api/auth/logout', async (req, res) => {
    try {
        const refreshToken = toSafeString(req.body?.refresh_token || '', 500);
        if (refreshToken) {
            await pgPool.query(`
                UPDATE auth_sessions
                SET is_revoked = TRUE, revoked_at = NOW()
                WHERE refresh_token_hash = $1
            `, [hashToken(refreshToken)]);
        }
        return res.json({ success: true });
    } catch (error) {
        console.error('Auth logout error:', error);
        return res.status(500).json({ error: 'Failed to logout' });
    }
});

// 0e. Current user
app.get('/api/auth/me', requireAuth, async (req, res) => {
    try {
        const userResult = await pgPool.query(`
            SELECT user_id, email, display_name, is_active, verification_status
            FROM users
            WHERE user_id = $1
            LIMIT 1
        `, [req.auth.sub]);

        if (userResult.rowCount === 0 || !userResult.rows[0].is_active) {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        const user = userResult.rows[0];
        const roles = await getUserRoles(user.user_id);

        return res.json({
            user: {
                user_id: user.user_id,
                email: user.email,
                display_name: user.display_name,
                verification_status: user.verification_status,
                roles
            }
        });
    } catch (error) {
        console.error('Auth me error:', error);
        return res.status(500).json({ error: 'Failed to fetch user profile' });
    }
});

// 0f. Superadmin/admin user listing
app.get('/api/admin/users', requireAuth, requireRole('admin', 'superadmin'), async (req, res) => {
    try {
        const result = await pgPool.query(`
            SELECT
                u.user_id,
                u.email,
                u.display_name,
                u.is_active,
                u.verification_status,
                u.created_at,
                u.last_login_at,
                COALESCE(ARRAY_AGG(r.role_name) FILTER (WHERE r.role_name IS NOT NULL), '{}') AS roles
            FROM users u
            LEFT JOIN user_roles ur ON ur.user_id = u.user_id
            LEFT JOIN roles r ON r.role_id = ur.role_id
            GROUP BY u.user_id
            ORDER BY u.created_at DESC
            LIMIT 200
        `);
        return res.json({ users: result.rows });
    } catch (error) {
        console.error('Admin users list error:', error);
        return res.status(500).json({ error: 'Failed to list users' });
    }
});

// 0f-7. Create restaurant (owner)
app.post('/api/restaurants', requireAuth, requireRole('owner', 'admin', 'superadmin'), validateRestaurantPayload, async (req, res) => {
    const client = await pgPool.connect();
    try {
        const userId = req.auth.sub;
        const { name, city, lga } = req.body;
        await client.query('BEGIN');

        const restaurantResult = await client.query(`
            INSERT INTO restaurants (
                name, city, lga, verification_status, owner_user_id, created_at, updated_at
            ) VALUES (
                $1, $2, $3, 'pending', $4, NOW(), NOW()
            )
            RETURNING restaurant_id, name, city, lga, verification_status, created_at
        `, [name, city, lga, userId]);
        const restaurant = restaurantResult.rows[0];

        await client.query(`
            INSERT INTO restaurant_members (restaurant_id, user_id, role)
            VALUES ($1, $2, 'owner')
            ON CONFLICT DO NOTHING
        `, [restaurant.restaurant_id, userId]);

        await client.query(`
            INSERT INTO audit_logs (actor_user_id, action, target_type, target_id, metadata)
            VALUES ($1, 'restaurant.create', 'restaurant', $2, $3::jsonb)
        `, [userId, String(restaurant.restaurant_id), JSON.stringify({ name, city, lga })]);

        await client.query('COMMIT');
        return res.status(201).json({ success: true, restaurant });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Create restaurant error:', error);
        return res.status(500).json({ error: 'Failed to create restaurant' });
    } finally {
        client.release();
    }
});

// 0f-8. List current user's restaurants
app.get('/api/restaurants/me', requireAuth, async (req, res) => {
    try {
        const result = await pgPool.query(`
            SELECT
                r.restaurant_id,
                r.name,
                r.city,
                r.lga,
                r.verification_status,
                r.created_at,
                rm.role AS membership_role,
                (
                    SELECT COUNT(*)
                    FROM qr_campaigns qc
                    WHERE qc.restaurant_id = r.restaurant_id
                ) AS campaign_count
            FROM restaurant_members rm
            JOIN restaurants r ON r.restaurant_id = rm.restaurant_id
            WHERE rm.user_id = $1
            ORDER BY r.created_at DESC
        `, [req.auth.sub]);
        return res.json({ restaurants: result.rows });
    } catch (error) {
        console.error('Restaurants me error:', error);
        return res.status(500).json({ error: 'Failed to fetch restaurants' });
    }
});

// 0f-9. Admin verify restaurant
app.post('/api/admin/restaurants/:id/verify', requireAuth, requireRole('admin', 'superadmin'), async (req, res) => {
    try {
        const restaurantId = toSafeString(req.params.id || '', 80);
        if (!restaurantId) return res.status(400).json({ error: 'restaurant id is required' });

        const result = await pgPool.query(`
            UPDATE restaurants
            SET verification_status = 'verified',
                verified_at = NOW(),
                verified_by = $2,
                updated_at = NOW()
            WHERE restaurant_id = $1
            RETURNING restaurant_id, name, city, lga, verification_status, verified_at
        `, [restaurantId, req.auth.sub]);

        if (result.rowCount === 0) return res.status(404).json({ error: 'Restaurant not found' });
        return res.json({ success: true, restaurant: result.rows[0] });
    } catch (error) {
        console.error('Verify restaurant error:', error);
        return res.status(500).json({ error: 'Failed to verify restaurant' });
    }
});

// 0f-10. Create QR campaign (verified owner)
app.post('/api/qr/campaigns', requireAuth, requireRole('owner', 'admin', 'superadmin'), requireVerifiedOwner, validateQrCampaignPayload, async (req, res) => {
    const client = await pgPool.connect();
    try {
        const userId = req.auth.sub;
        const { restaurant_id: restaurantId, campaign_name: campaignName, expires_in_days: expiresInDays } = req.body;

        const accessResult = await client.query(`
            SELECT r.restaurant_id, r.name, r.city, r.lga, r.verification_status, rm.role
            FROM restaurants r
            JOIN restaurant_members rm ON rm.restaurant_id = r.restaurant_id
            WHERE r.restaurant_id = $1 AND rm.user_id = $2
            LIMIT 1
        `, [restaurantId, userId]);

        if (accessResult.rowCount === 0) {
            return res.status(403).json({ error: 'No access to this restaurant' });
        }

        const restaurant = accessResult.rows[0];
        if (restaurant.verification_status !== 'verified') {
            return res.status(403).json({ error: 'Restaurant must be verified before QR campaign creation' });
        }

        const expiresAt = new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000);
        const campaignResult = await client.query(`
            INSERT INTO qr_campaigns (
                restaurant_id, campaign_name, is_active, created_by, created_at, expires_at
            ) VALUES ($1, $2, TRUE, $3, NOW(), $4)
            RETURNING campaign_id, restaurant_id, campaign_name, created_at, expires_at
        `, [restaurantId, campaignName, userId, expiresAt]);
        const campaign = campaignResult.rows[0];

        const tokenPayload = {
            restaurant_id: String(restaurant.restaurant_id),
            campaign_id: String(campaign.campaign_id),
            exp: expiresAt.getTime()
        };
        const token = encodeQrPayload(tokenPayload);
        const signature = signQrToken(token);
        const publicUrl = `/customer.html?token=${encodeURIComponent(token)}&sig=${encodeURIComponent(signature)}`;

        await client.query(`
            INSERT INTO audit_logs (actor_user_id, action, target_type, target_id, metadata)
            VALUES ($1, 'qr_campaign.create', 'qr_campaign', $2, $3::jsonb)
        `, [userId, String(campaign.campaign_id), JSON.stringify({ restaurant_id: restaurantId, campaign_name: campaignName })]);

        return res.status(201).json({
            success: true,
            campaign,
            qr: {
                token,
                signature,
                public_url: publicUrl
            },
            restaurant: {
                restaurant_id: restaurant.restaurant_id,
                name: restaurant.name,
                city: restaurant.city,
                lga: restaurant.lga
            }
        });
    } catch (error) {
        console.error('Create QR campaign error:', error);
        return res.status(500).json({ error: 'Failed to create QR campaign' });
    } finally {
        client.release();
    }
});

// 0f-11. Resolve QR token
app.get('/api/qr/resolve', async (req, res) => {
    try {
        const token = toSafeString(req.query?.token || '', 2000);
        const signature = toSafeString(req.query?.sig || req.query?.signature || '', 256);
        const payload = verifyQrToken(token, signature);
        if (!payload) {
            return res.status(400).json({ error: 'Invalid or expired QR token' });
        }

        const result = await pgPool.query(`
            SELECT
                qc.campaign_id,
                qc.is_active,
                qc.expires_at,
                r.restaurant_id,
                r.name,
                r.city,
                r.lga,
                r.verification_status
            FROM qr_campaigns qc
            JOIN restaurants r ON r.restaurant_id = qc.restaurant_id
            WHERE qc.campaign_id = $1
              AND qc.restaurant_id = $2
            LIMIT 1
        `, [payload.campaign_id, payload.restaurant_id]);

        if (result.rowCount === 0) return res.status(404).json({ error: 'QR campaign not found' });
        const row = result.rows[0];
        if (!row.is_active) return res.status(400).json({ error: 'QR campaign is inactive' });
        if (new Date(row.expires_at) <= new Date()) return res.status(400).json({ error: 'QR campaign expired' });

        return res.json({
            campaign_id: row.campaign_id,
            restaurant: {
                restaurant_id: row.restaurant_id,
                name: row.name,
                city: row.city,
                lga: row.lga,
                verification_status: row.verification_status
            }
        });
    } catch (error) {
        console.error('Resolve QR token error:', error);
        return res.status(500).json({ error: 'Failed to resolve QR token' });
    }
});

// 0f-2. Submit verification request (authenticated users)
app.post('/api/verification/request', requireAuth, validateVerificationRequestPayload, async (req, res) => {
    const client = await pgPool.connect();
    try {
        await client.query('BEGIN');
        const userId = req.auth.sub;
        const payload = req.body;

        const existingPending = await client.query(`
            SELECT verification_id
            FROM verification_requests
            WHERE user_id = $1 AND status = 'pending'
            LIMIT 1
        `, [userId]);
        if (existingPending.rowCount > 0) {
            await client.query('ROLLBACK');
            return res.status(409).json({ error: 'A verification request is already pending review' });
        }

        const requestResult = await client.query(`
            INSERT INTO verification_requests (
                user_id, entity_type, business_name, city, lga, notes, status, metadata, submitted_at, created_at, updated_at
            ) VALUES (
                $1, 'user', $2, $3, $4, $5, 'pending', $6::jsonb, NOW(), NOW(), NOW()
            )
            RETURNING verification_id, status, submitted_at
        `, [
            userId,
            payload.business_name,
            payload.city,
            payload.lga,
            payload.notes || null,
            JSON.stringify({})
        ]);

        const verification = requestResult.rows[0];

        for (const doc of payload.documents) {
            await client.query(`
                INSERT INTO verification_documents (
                    verification_id, document_type, document_ref, metadata
                ) VALUES ($1, $2, $3, $4::jsonb)
            `, [
                verification.verification_id,
                doc.document_type,
                doc.document_ref,
                JSON.stringify(doc.metadata || {})
            ]);
        }

        await client.query(`
            UPDATE users
            SET verification_status = 'pending', updated_at = NOW()
            WHERE user_id = $1
        `, [userId]);

        await client.query(`
            INSERT INTO audit_logs (actor_user_id, action, target_type, target_id, metadata)
            VALUES ($1, 'verification.request', 'verification_request', $2, $3::jsonb)
        `, [userId, String(verification.verification_id), JSON.stringify({ business_name: payload.business_name })]);

        await client.query('COMMIT');

        return res.status(201).json({
            success: true,
            verification_id: verification.verification_id,
            status: verification.status,
            submitted_at: verification.submitted_at
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Verification request error:', error);
        return res.status(500).json({ error: 'Failed to submit verification request' });
    } finally {
        client.release();
    }
});

// 0f-3. Current user verification state
app.get('/api/verification/me', requireAuth, async (req, res) => {
    try {
        const userId = req.auth.sub;
        const requestResult = await pgPool.query(`
            SELECT verification_id, business_name, city, lga, notes, status, submitted_at, decided_at, rejection_reason
            FROM verification_requests
            WHERE user_id = $1
            ORDER BY submitted_at DESC
            LIMIT 1
        `, [userId]);

        if (requestResult.rowCount === 0) {
            return res.json({ request: null, documents: [] });
        }

        const request = requestResult.rows[0];
        const docsResult = await pgPool.query(`
            SELECT document_id, document_type, document_ref, metadata, created_at
            FROM verification_documents
            WHERE verification_id = $1
            ORDER BY created_at ASC
        `, [request.verification_id]);

        return res.json({ request, documents: docsResult.rows });
    } catch (error) {
        console.error('Verification me error:', error);
        return res.status(500).json({ error: 'Failed to fetch verification status' });
    }
});

// 0f-4. Admin list verification requests
app.get('/api/admin/verifications', requireAuth, requireRole('admin', 'superadmin'), async (req, res) => {
    try {
        const statusFilter = toSafeString(req.query?.status || '', 20).toLowerCase();
        const allowed = ['pending', 'approved', 'rejected'];
        const status = allowed.includes(statusFilter) ? statusFilter : null;

        const baseQuery = `
            SELECT
                vr.verification_id,
                vr.user_id,
                u.email,
                u.display_name,
                vr.business_name,
                vr.city,
                vr.lga,
                vr.status,
                vr.notes,
                vr.submitted_at,
                vr.decided_at,
                vr.rejection_reason,
                (
                    SELECT COUNT(*)
                    FROM verification_documents vd
                    WHERE vd.verification_id = vr.verification_id
                ) AS document_count
            FROM verification_requests vr
            JOIN users u ON u.user_id = vr.user_id
        `;

        const result = status
            ? await pgPool.query(baseQuery + ` WHERE vr.status = $1 ORDER BY vr.submitted_at DESC LIMIT 200`, [status])
            : await pgPool.query(baseQuery + ` ORDER BY vr.submitted_at DESC LIMIT 200`);

        return res.json({ requests: result.rows });
    } catch (error) {
        console.error('Admin verifications list error:', error);
        return res.status(500).json({ error: 'Failed to list verification requests' });
    }
});

// 0f-5. Admin approve verification
app.post('/api/admin/verifications/:id/approve', requireAuth, requireRole('admin', 'superadmin'), async (req, res) => {
    const client = await pgPool.connect();
    try {
        const verificationId = toSafeString(req.params.id || '', 120);
        if (!verificationId) {
            return res.status(400).json({ error: 'verification id is required' });
        }

        await client.query('BEGIN');
        const requestResult = await client.query(`
            SELECT verification_id, user_id, status
            FROM verification_requests
            WHERE verification_id = $1
            LIMIT 1
        `, [verificationId]);
        if (requestResult.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Verification request not found' });
        }

        const request = requestResult.rows[0];
        if (request.status === 'approved') {
            await client.query('ROLLBACK');
            return res.json({ success: true, verification_id: request.verification_id, status: 'approved' });
        }

        await client.query(`
            UPDATE verification_requests
            SET status = 'approved',
                decided_at = NOW(),
                decided_by = $2,
                rejection_reason = NULL,
                updated_at = NOW()
            WHERE verification_id = $1
        `, [verificationId, req.auth.sub]);

        await client.query(`
            UPDATE users
            SET verification_status = 'verified', updated_at = NOW()
            WHERE user_id = $1
        `, [request.user_id]);

        await client.query(`
            INSERT INTO audit_logs (actor_user_id, action, target_type, target_id, metadata)
            VALUES ($1, 'verification.approve', 'verification_request', $2, $3::jsonb)
        `, [req.auth.sub, verificationId, JSON.stringify({})]);

        await client.query('COMMIT');
        return res.json({ success: true, verification_id: verificationId, status: 'approved' });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Approve verification error:', error);
        return res.status(500).json({ error: 'Failed to approve verification request' });
    } finally {
        client.release();
    }
});

// 0f-6. Admin reject verification
app.post('/api/admin/verifications/:id/reject', requireAuth, requireRole('admin', 'superadmin'), async (req, res) => {
    const client = await pgPool.connect();
    try {
        const verificationId = toSafeString(req.params.id || '', 120);
        const reason = toSafeString(req.body?.reason || req.body?.rejection_reason || '', 500);
        if (!verificationId) {
            return res.status(400).json({ error: 'verification id is required' });
        }
        if (!reason) {
            return res.status(400).json({ error: 'rejection reason is required' });
        }

        await client.query('BEGIN');
        const requestResult = await client.query(`
            SELECT verification_id, user_id
            FROM verification_requests
            WHERE verification_id = $1
            LIMIT 1
        `, [verificationId]);
        if (requestResult.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Verification request not found' });
        }
        const request = requestResult.rows[0];

        await client.query(`
            UPDATE verification_requests
            SET status = 'rejected',
                decided_at = NOW(),
                decided_by = $2,
                rejection_reason = $3,
                updated_at = NOW()
            WHERE verification_id = $1
        `, [verificationId, req.auth.sub, reason]);

        await client.query(`
            UPDATE users
            SET verification_status = 'rejected', updated_at = NOW()
            WHERE user_id = $1
        `, [request.user_id]);

        await client.query(`
            INSERT INTO audit_logs (actor_user_id, action, target_type, target_id, metadata)
            VALUES ($1, 'verification.reject', 'verification_request', $2, $3::jsonb)
        `, [req.auth.sub, verificationId, JSON.stringify({ reason })]);

        await client.query('COMMIT');
        return res.json({ success: true, verification_id: verificationId, status: 'rejected' });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Reject verification error:', error);
        return res.status(500).json({ error: 'Failed to reject verification request' });
    } finally {
        client.release();
    }
});

// 0g. One-time bootstrap superadmin assignment
app.post('/api/admin/bootstrap-superadmin', authLimiter, async (req, res) => {
    const email = toSafeString(req.body?.email || '', 254).toLowerCase();
    const bootstrapKey = toSafeString(req.body?.bootstrap_key || '', 256);

    if (!ADMIN_BOOTSTRAP_KEY) {
        return res.status(503).json({ error: 'Bootstrap key is not configured' });
    }
    if (!bootstrapKey || bootstrapKey !== ADMIN_BOOTSTRAP_KEY) {
        return res.status(401).json({ error: 'Invalid bootstrap key' });
    }
    if (!email) {
        return res.status(400).json({ error: 'email is required' });
    }

    const client = await pgPool.connect();
    try {
        await client.query('BEGIN');

        const alreadyResult = await client.query(`
            SELECT 1
            FROM user_roles ur
            JOIN roles r ON r.role_id = ur.role_id
            WHERE r.role_name = 'superadmin'
            LIMIT 1
        `);
        if (alreadyResult.rowCount > 0) {
            await client.query('ROLLBACK');
            return res.status(409).json({ error: 'Superadmin already assigned' });
        }

        const userResult = await client.query(`
            SELECT user_id, email
            FROM users
            WHERE email = $1
            LIMIT 1
        `, [email]);
        if (userResult.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'User not found' });
        }
        const user = userResult.rows[0];

        await client.query(`
            INSERT INTO user_roles (user_id, role_id)
            SELECT $1, role_id FROM roles WHERE role_name = 'superadmin'
            ON CONFLICT DO NOTHING
        `, [user.user_id]);

        await client.query(`
            INSERT INTO audit_logs (actor_user_id, action, target_type, target_id, metadata)
            VALUES (NULL, 'admin.bootstrap_superadmin', 'user', $1, $2::jsonb)
        `, [String(user.user_id), JSON.stringify({ email: user.email })]);

        await client.query('COMMIT');
        return res.json({ success: true, user_id: user.user_id, email: user.email, role: 'superadmin' });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Bootstrap superadmin error:', error);
        return res.status(500).json({ error: 'Failed to bootstrap superadmin' });
    } finally {
        client.release();
    }
});

// 1. Submit diary entry
app.post('/api/diary', diaryWriteLimiter, validateDiaryPayload, async (req, res) => {
    try {
        const entry = req.body;
        
        // Analyze sentiment if vent text exists
        if (entry.vent_text) {
            const sentiment = sentimentAnalyzer.analyze(entry.vent_text);
            entry.sentiment_score = sentiment.score;
            entry.sentiment_label = sentiment.label;
        }
        
        // Store in database
        const result = await pgPool.query(`
            INSERT INTO diary_entries (
                anonymous_token, city, lga,
                diesel_price, staff_absent, spoilage_amount,
                leakage_amount, supplier_failure, harassment_reported,
                price_changed, portion_reduced, took_loss,
                vent_text, sentiment_score, sentiment_label,
                entry_date, created_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, NOW())
            RETURNING entry_id
        `, [
            entry.anonymous_token, entry.city, entry.lga,
            entry.diesel_price, entry.staff_absent, entry.spoilage_amount,
            entry.leakage_amount, entry.supplier_failure, entry.harassment_reported,
            entry.price_changed, entry.portion_reduced, entry.took_loss,
            entry.vent_text, entry.sentiment_score, entry.sentiment_label,
            new Date()
        ]);
        
        // Trigger alert engine
        await alertEngine.processNewEntry(entry);
        
        res.json({ 
            success: true, 
            entry_id: result.rows[0].entry_id,
            sentiment: entry.sentiment_label
        });
        
    } catch (error) {
        console.error('Diary submission error:', error);
        res.status(500).json({ error: 'Failed to submit diary entry' });
    }
});

// 2. Get live dashboard data
app.get('/api/dashboard/live', async (req, res) => {
    try {
        // Try cache first
        const cached = await redis.get('dashboard:live');
        if (cached) {
            return res.json(JSON.parse(cached));
        }
        
        // Get from materialized view
        const result = await pgPool.query(`
            SELECT * FROM mv_live_dashboard
            LIMIT 1
        `);
        
        const dashboard = result.rows[0];
        
        // Cache for 5 minutes
        await redis.setex('dashboard:live', 300, JSON.stringify(dashboard));
        
        res.json(dashboard);
        
    } catch (error) {
        console.error('Dashboard error:', error);
        res.status(500).json({ error: 'Failed to fetch dashboard data' });
    }
});

// 2b. SMS subscription (dashboard)
app.post('/api/sms/subscribe', smsSubscribeLimiter, validateSmsSubscriptionPayload, async (req, res) => {
    try {
        const sub = req.body;
        const result = await pgPool.query(`
            INSERT INTO sms_subscriptions (
                phone_hash, phone_last_four, city, lga,
                alert_diesel, alert_raids, alert_supplier, alert_spoilage, alert_customer,
                is_active, created_at, updated_at
            )
            VALUES (
                crypt($1, gen_salt('bf')), $2, $3, $4,
                $5, $6, $7, $8, $9,
                TRUE, NOW(), NOW()
            )
            RETURNING subscription_id, city, lga, phone_last_four
        `, [
            sub.phone,
            sub.phone_last_four,
            sub.city,
            sub.lga,
            sub.alert_diesel,
            sub.alert_raids,
            sub.alert_supplier,
            sub.alert_spoilage,
            sub.alert_customer
        ]);

        res.json({
            success: true,
            subscription_id: result.rows[0].subscription_id,
            phone_last_four: result.rows[0].phone_last_four,
            city: result.rows[0].city,
            lga: result.rows[0].lga
        });
    } catch (error) {
        console.error('SMS subscribe error:', error);
        res.status(500).json({ error: 'Failed to activate SMS alerts' });
    }
});

// 2c. Worker report submission
app.post('/api/worker/reports', workerReportLimiter, validateWorkerReportPayload, async (req, res) => {
    try {
        const report = req.body;
        const result = await pgPool.query(`
            INSERT INTO worker_reports (
                city, employment_status, whisper_text, report_date, created_at
            ) VALUES ($1, $2, $3, $4, NOW())
            RETURNING report_id
        `, [
            report.city,
            report.status,
            report.whisper,
            new Date()
        ]);

        res.json({ success: true, report_id: result.rows[0].report_id });
    } catch (error) {
        console.error('Worker report error:', error);
        res.status(500).json({ error: 'Failed to submit worker report' });
    }
});

// 2d. Customer feedback submission
app.post('/api/customer/feedback', customerFeedbackLimiter, validateCustomerFeedbackPayload, async (req, res) => {
    try {
        const feedback = req.body;
        if (feedback.qr_token) {
            const payload = verifyQrToken(feedback.qr_token, feedback.qr_signature);
            if (!payload) {
                return res.status(400).json({ error: 'Invalid or expired QR token' });
            }

            const qrResult = await pgPool.query(`
                SELECT
                    qc.campaign_id,
                    qc.is_active,
                    qc.expires_at,
                    r.restaurant_id,
                    r.city,
                    r.lga
                FROM qr_campaigns qc
                JOIN restaurants r ON r.restaurant_id = qc.restaurant_id
                WHERE qc.campaign_id = $1
                  AND qc.restaurant_id = $2
                LIMIT 1
            `, [payload.campaign_id, payload.restaurant_id]);

            if (qrResult.rowCount === 0) {
                return res.status(404).json({ error: 'QR campaign not found' });
            }

            const qr = qrResult.rows[0];
            if (!qr.is_active || new Date(qr.expires_at) <= new Date()) {
                return res.status(400).json({ error: 'QR campaign inactive or expired' });
            }

            feedback.restaurant_id = qr.restaurant_id;
            feedback.restaurant_city = qr.city;
            feedback.restaurant_lga = qr.lga;
        }

        const result = await pgPool.query(`
            INSERT INTO customer_feedback (
                restaurant_id, restaurant_city, restaurant_lga,
                portion_rating, portion_score, price_matched, will_return, comment_text,
                feedback_date, created_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
            RETURNING feedback_id
        `, [
            feedback.restaurant_id,
            feedback.restaurant_city,
            feedback.restaurant_lga || null,
            feedback.portion_rating,
            feedback.portion_score,
            feedback.price_matched,
            feedback.will_return,
            feedback.comment_text,
            new Date()
        ]);

        res.json({ success: true, feedback_id: result.rows[0].feedback_id });
    } catch (error) {
        console.error('Customer feedback error:', error);
        res.status(500).json({ error: 'Failed to submit customer feedback' });
    }
});

// 2e. List confessions
app.get('/api/confessions', async (req, res) => {
    try {
        await ensureConfessionsTable();
        const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 12));
        const result = await pgPool.query(`
            SELECT confession_id, role, city, lga, text, reactions, created_at
            FROM confessions
            ORDER BY created_at DESC
            LIMIT $1
        `, [limit]);

        res.json({
            confessions: result.rows.map((row) => ({
                id: String(row.confession_id),
                role: row.role,
                city: row.city,
                lga: row.lga,
                text: row.text,
                reactions: row.reactions || { heart: 0, share: 0, eye: 0 },
                timestamp: row.created_at
            }))
        });
    } catch (error) {
        console.error('Confessions list error:', error);
        res.status(500).json({ error: 'Failed to fetch confessions' });
    }
});

// 2f. Create confession
app.post('/api/confessions', confessionLimiter, validateConfessionPayload, async (req, res) => {
    try {
        await ensureConfessionsTable();
        const confession = req.body;
        const result = await pgPool.query(`
            INSERT INTO confessions (role, city, lga, text, reactions, created_at)
            VALUES ($1, $2, $3, $4, '{"heart":0,"share":0,"eye":0}'::jsonb, NOW())
            RETURNING confession_id
        `, [
            confession.role,
            confession.city,
            confession.lga || null,
            confession.text
        ]);

        res.json({ success: true, confession_id: result.rows[0].confession_id });
    } catch (error) {
        console.error('Confession create error:', error);
        res.status(500).json({ error: 'Failed to publish confession' });
    }
});

// 2g. Newsletter signup
app.post('/api/newsletter/subscribe', newsletterLimiter, validateNewsletterPayload, async (req, res) => {
    try {
        await ensureNewsletterTable();
        const { email, source } = req.body;
        const result = await pgPool.query(`
            INSERT INTO newsletter_subscriptions (email, source, is_active, created_at, updated_at)
            VALUES ($1, $2, TRUE, NOW(), NOW())
            ON CONFLICT (email)
            DO UPDATE SET is_active = TRUE, source = EXCLUDED.source, updated_at = NOW()
            RETURNING subscription_id, email, source
        `, [email, source]);

        res.json({
            success: true,
            subscription_id: result.rows[0].subscription_id,
            email: result.rows[0].email,
            source: result.rows[0].source
        });
    } catch (error) {
        console.error('Newsletter subscribe error:', error);
        res.status(500).json({ error: 'Failed to subscribe to newsletter' });
    }
});

// 3. Get live pressure feed (homepage heatmap contract)
app.get('/api/pressure/live', async (req, res) => {
    try {
        const result = await pgPool.query(`
            SELECT DISTINCT ON (city, lga)
                city,
                lga,
                overall_pressure_score AS pressure_score,
                avg_diesel_price AS diesel_price,
                staff_shortage_pct AS staff_shortage,
                spoilage_rate_pct AS spoilage_rate,
                leakage_rate_pct AS leakage_rate,
                harassment_reports_per_100 AS harassment_reports,
                owner_sample_size AS sample_size,
                snapshot_time
            FROM city_pressure_index
            WHERE snapshot_time > NOW() - INTERVAL '24 hours'
            ORDER BY city, lga, snapshot_time DESC
        `);

        const cities = result.rows.map((row) => ({
            ...row,
            pressure_score: Number(row.pressure_score || 0),
            diesel_price: Number(row.diesel_price || 0),
            staff_shortage: Number(row.staff_shortage || 0),
            spoilage_rate: Number(row.spoilage_rate || 0),
            leakage_rate: Number(row.leakage_rate || 0),
            harassment_reports: Number(row.harassment_reports || 0),
            sample_size: Number(row.sample_size || 0)
        }));

        const hotspots = cities
            .filter((city) => city.pressure_score >= 60)
            .map((city) => ({
                coordinates: getCityCoordinates(city.city),
                intensity: city.pressure_score,
                severity: getSeverityFromScore(city.pressure_score),
                type: 'pressure_hotspot',
                city: city.city,
                lga: city.lga
            }));

        res.json({ cities, hotspots });
    } catch (error) {
        console.error('Live pressure error:', error);
        res.status(500).json({ error: 'Failed to fetch live pressure data' });
    }
});

// 4. Get current diesel snapshot (homepage heatmap contract)
app.get('/api/diesel/current', async (req, res) => {
    try {
        const byCity = await pgPool.query(`
            SELECT DISTINCT ON (city)
                city AS name,
                price
            FROM diesel_price_tracking
            WHERE recorded_at > NOW() - INTERVAL '7 days'
            ORDER BY city, recorded_at DESC
        `);

        const national = byCity.rows.length > 0
            ? byCity.rows.reduce((sum, row) => sum + Number(row.price || 0), 0) / byCity.rows.length
            : 0;

        res.json({
            national_avg: Number(national.toFixed(2)),
            cities: byCity.rows.map((row) => ({
                name: row.name,
                price: Number(row.price || 0)
            }))
        });
    } catch (error) {
        console.error('Current diesel error:', error);
        res.status(500).json({ error: 'Failed to fetch diesel data' });
    }
});

// 5. Worker hotspots placeholder (contract-compatible)
app.get('/api/worker/hotspots', async (_req, res) => {
    res.json({ hotspots: [] });
});

// 6. Customer complaints placeholder (contract-compatible)
app.get('/api/customer/complaints', async (_req, res) => {
    res.json({ complaints: [] });
});

// 7. Get city pressure index
app.get('/api/pressure/:city', async (req, res) => {
    try {
        const { city } = req.params;
        const { lga, hours = 24 } = req.query;
        const hoursInt = Math.min(168, Math.max(1, parseInt(hours, 10) || 24));
        
        let query = `
            SELECT * FROM city_pressure_index
            WHERE city = $1
        `;
        const params = [city];
        
        if (lga) {
            query += ` AND lga = $2`;
            params.push(lga);
        }
        
        query += ` AND snapshot_time > NOW() - ($${params.length + 1} * INTERVAL '1 hour')
                   ORDER BY snapshot_time DESC`;
        params.push(hoursInt);
        
        const result = await pgPool.query(query, params);
        
        res.json({
            city,
            lga: lga || 'all',
            current: result.rows[0] || null,
            history: result.rows
        });
        
    } catch (error) {
        console.error('Pressure index error:', error);
        res.status(500).json({ error: 'Failed to fetch pressure data' });
    }
});

// 8. Get diesel forecast
app.get('/api/forecast/diesel/:city', async (req, res) => {
    try {
        const { city } = req.params;
        const { days = 7 } = req.query;
        
        const forecast = await predictiveEngine.forecastDieselPrice(city, parseInt(days));
        
        res.json(forecast);
        
    } catch (error) {
        console.error('Forecast error:', error);
        res.status(500).json({ error: 'Failed to generate forecast' });
    }
});

// 9. Get active alerts
app.get('/api/alerts/active', async (req, res) => {
    try {
        const { city, lga } = req.query;
        
        let query = `
            SELECT * FROM alert_history
            WHERE expires_at > NOW()
        `;
        const params = [];
        
        if (city) {
            query += ` AND city = $${params.length + 1}`;
            params.push(city);
        }
        
        if (lga) {
            query += ` AND lga = $${params.length + 1}`;
            params.push(lga);
        }
        
        query += ` ORDER BY severity DESC, created_at DESC
                   LIMIT 50`;
        
        const result = await pgPool.query(query, params);
        
        res.json({
            count: result.rowCount,
            alerts: result.rows
        });
        
    } catch (error) {
        console.error('Alerts error:', error);
        res.status(500).json({ error: 'Failed to fetch alerts' });
    }
});

// 10. Alerts stream (SSE heartbeat + latest snapshot)
app.get('/api/alerts/stream', async (_req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const pushLatest = async () => {
        try {
            const result = await pgPool.query(`
                SELECT *
                FROM alert_history
                WHERE expires_at > NOW()
                ORDER BY severity DESC, created_at DESC
                LIMIT 20
            `);
            res.write(`data: ${JSON.stringify({ alerts: result.rows })}\n\n`);
        } catch (error) {
            res.write(`event: error\ndata: ${JSON.stringify({ message: 'alerts_stream_error' })}\n\n`);
        }
    };

    await pushLatest();
    const interval = setInterval(pushLatest, 20000);

    res.on('close', () => {
        clearInterval(interval);
        res.end();
    });
});

// 11. Get weekly report
app.get('/api/reports/latest', async (req, res) => {
    try {
        const result = await pgPool.query(`
            SELECT * FROM weekly_reports
            ORDER BY report_week DESC
            LIMIT 1
        `);
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'No reports found' });
        }
        
        res.json(result.rows[0]);
        
    } catch (error) {
        console.error('Report error:', error);
        res.status(500).json({ error: 'Failed to fetch report' });
    }
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
