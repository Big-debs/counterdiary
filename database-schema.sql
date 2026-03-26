-- =====================================================
-- THE LEDGER - NIGERIA FOOD INDUSTRY INTELLIGENCE ENGINE
-- PostgreSQL 15+ with TimescaleDB extension
-- =====================================================

-- Enable extensions
CREATE EXTENSION IF NOT EXISTS timescaledb;
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- PostGIS is optional in local dev images.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM pg_available_extensions
        WHERE name = 'postgis'
    ) THEN
        CREATE EXTENSION IF NOT EXISTS postgis;
    ELSE
        RAISE NOTICE 'Skipping postgis extension: not available in current image';
    END IF;
END;
$$;

-- Hypertable conversion helper: do not fail full schema init in dev.
CREATE OR REPLACE FUNCTION try_create_hypertable(
    table_name TEXT,
    time_column TEXT
) RETURNS void AS $$
BEGIN
    PERFORM create_hypertable(table_name, time_column, if_not_exists => TRUE);
EXCEPTION
    WHEN OTHERS THEN
        RAISE NOTICE 'Skipping hypertable conversion for %: %', table_name, SQLERRM;
END;
$$ LANGUAGE plpgsql;

-- =====================================================
-- CORE TABLES
-- =====================================================

-- 1. OWNERS (Anonymous identities)
CREATE TABLE owners (
    owner_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    anonymous_token VARCHAR(64) UNIQUE NOT NULL, -- Client-side generated, hashed
    city VARCHAR(100),
    lga VARCHAR(100),
    state VARCHAR(50),
    business_type VARCHAR(50), -- 'bukka', 'qsr', 'fine_dining', 'caterer'
    employee_count INTEGER,
    year_started INTEGER,
    first_seen TIMESTAMPTZ DEFAULT NOW(),
    last_active TIMESTAMPTZ DEFAULT NOW(),
    is_active BOOLEAN DEFAULT TRUE,
    
    -- We NEVER store: name, address, phone (unless SMS opt-in)
    sms_opt_in BOOLEAN DEFAULT FALSE,
    sms_phone_hash VARCHAR(255), -- bcrypt hash, not raw number
    
    -- Metadata
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_owners_anonymous_token ON owners(anonymous_token);
CREATE INDEX idx_owners_city_lga ON owners(city, lga);
CREATE INDEX idx_owners_last_active ON owners(last_active);

-- 2. DIARY ENTRIES (Owner daily logs)
CREATE TABLE diary_entries (
    entry_id BIGSERIAL PRIMARY KEY,
    owner_id UUID REFERENCES owners(owner_id),
    anonymous_token VARCHAR(64), -- Denormalized for analytics
    city VARCHAR(100),
    lga VARCHAR(100),
    
    -- Core metrics (3-tap)
    diesel_price DECIMAL(10,2), -- ₦ per litre
    diesel_issue BOOLEAN DEFAULT FALSE,
    staff_absent INTEGER DEFAULT 0,
    staff_issue BOOLEAN DEFAULT FALSE,
    spoilage_amount DECIMAL(10,2), -- ₦ estimated
    spoilage_issue BOOLEAN DEFAULT FALSE,
    leakage_amount DECIMAL(10,2), -- ₦ estimated
    leakage_issue BOOLEAN DEFAULT FALSE,
    supplier_failure BOOLEAN DEFAULT FALSE,
    supplier_item VARCHAR(100),
    harassment_reported BOOLEAN DEFAULT FALSE,
    harassment_type VARCHAR(50), -- 'KAI', 'police', 'area_boys', 'other'
    
    -- Business decisions
    price_changed BOOLEAN DEFAULT FALSE,
    portion_reduced BOOLEAN DEFAULT FALSE,
    took_loss BOOLEAN DEFAULT FALSE,
    
    -- Sentiment
    vent_text TEXT,
    sentiment_score DECIMAL(3,2), -- -1.0 to 1.0
    sentiment_label VARCHAR(20), -- 'positive', 'negative', 'neutral'
    
    -- Temporal
    entry_date DATE NOT NULL,
    entry_hour INTEGER, -- 0-23
    entry_dow INTEGER, -- 0-6, 0=Sunday
    created_at TIMESTAMPTZ DEFAULT NOW(),
    
    -- Validation
    is_valid BOOLEAN DEFAULT TRUE,
    validation_notes TEXT
);

-- Convert to hypertable for time-series (best-effort)
SELECT try_create_hypertable('diary_entries', 'created_at');

-- Indexes for analytics
CREATE INDEX idx_diary_entries_owner_date ON diary_entries(owner_id, entry_date);
CREATE INDEX idx_diary_entries_city_date ON diary_entries(city, entry_date);
CREATE INDEX idx_diary_entries_category ON diary_entries(diesel_issue, staff_issue, spoilage_issue, leakage_issue, harassment_reported);
CREATE INDEX idx_diary_entries_sentiment ON diary_entries(sentiment_score);

-- 3. WORKER REPORTS (Anonymous workforce data)
CREATE TABLE worker_reports (
    report_id BIGSERIAL PRIMARY KEY,
    
    -- Demographics (anonymous)
    city VARCHAR(100),
    lga VARCHAR(100),
    
    -- Employment
    employment_status VARCHAR(50), -- 'permanent', 'casual', 'intern', 'unsure'
    industry_sector VARCHAR(50), -- 'restaurant', 'fast_food', 'catering', 'hotel'
    job_role VARCHAR(50), -- 'kitchen', 'waiter', 'cashier', 'management', 'other'
    
    -- Core metrics
    paid_correctly BOOLEAN,
    paid_late BOOLEAN,
    wage_theft_reported BOOLEAN,
    hours_worked INTEGER,
    hours_paid INTEGER,
    daily_wage DECIMAL(10,2),
    has_contract BOOLEAN,
    
    -- Safety & conditions
    harassment_experienced BOOLEAN,
    harassment_type VARCHAR(50),
    safety_concerns BOOLEAN,
    
    -- Sentiment
    whisper_text TEXT,
    sentiment_score DECIMAL(3,2),
    
    -- Temporal
    report_date DATE NOT NULL,
    report_hour INTEGER,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    
    -- Anonymity
    ip_hash VARCHAR(64), -- Salted hash, never store raw IP
    session_id_hash VARCHAR(64)
);

-- Hypertable
SELECT try_create_hypertable('worker_reports', 'created_at');

-- Indexes
CREATE INDEX idx_worker_reports_city_status ON worker_reports(city, employment_status);
CREATE INDEX idx_worker_reports_wage_theft ON worker_reports(wage_theft_reported) WHERE wage_theft_reported = TRUE;
CREATE INDEX idx_worker_reports_date ON worker_reports(report_date);

-- 4. CUSTOMER FEEDBACK (QR code scans)
CREATE TABLE customer_feedback (
    feedback_id BIGSERIAL PRIMARY KEY,
    
    -- Restaurant (anonymized)
    restaurant_id VARCHAR(50), -- QR code identifier
    restaurant_city VARCHAR(100),
    restaurant_lga VARCHAR(100),
    
    -- Feedback metrics
    portion_rating VARCHAR(20), -- 'too_small', 'small', 'just_right', 'large', 'too_large'
    portion_score INTEGER, -- 1-5 derived
    price_matched BOOLEAN,
    will_return BOOLEAN,
    comment_text TEXT,
    
    -- Sentiment
    sentiment_score DECIMAL(3,2),
    
    -- Temporal
    feedback_date DATE NOT NULL,
    feedback_hour INTEGER,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

SELECT try_create_hypertable('customer_feedback', 'created_at');

-- 5. SMS SUBSCRIPTIONS
CREATE TABLE sms_subscriptions (
    subscription_id BIGSERIAL PRIMARY KEY,
    owner_id UUID REFERENCES owners(owner_id),
    phone_hash VARCHAR(255) NOT NULL, -- bcrypt hash
    phone_last_four VARCHAR(4), -- For display: "****1234"
    city VARCHAR(100),
    lga VARCHAR(100),
    
    -- Alert preferences
    alert_diesel BOOLEAN DEFAULT TRUE,
    alert_raids BOOLEAN DEFAULT TRUE,
    alert_supplier BOOLEAN DEFAULT TRUE,
    alert_spoilage BOOLEAN DEFAULT FALSE,
    alert_customer BOOLEAN DEFAULT FALSE,
    
    -- Status
    is_active BOOLEAN DEFAULT TRUE,
    unsubscribed_at TIMESTAMPTZ,
    unsubscribe_reason VARCHAR(50),
    
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- =====================================================
-- AGGREGATION & ANALYTICS TABLES
-- =====================================================

-- 6. CITY PRESSURE INDEX (Hourly snapshots)
CREATE TABLE city_pressure_index (
    snapshot_id BIGSERIAL PRIMARY KEY,
    
    city VARCHAR(100) NOT NULL,
    lga VARCHAR(100),
    snapshot_time TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    
    -- Composite scores (0-100)
    overall_pressure_score DECIMAL(5,2),
    diesel_pressure_score DECIMAL(5,2),
    staff_pressure_score DECIMAL(5,2),
    spoilage_pressure_score DECIMAL(5,2),
    leakage_pressure_score DECIMAL(5,2),
    harassment_pressure_score DECIMAL(5,2),
    customer_pressure_score DECIMAL(5,2),
    
    -- Component metrics
    avg_diesel_price DECIMAL(10,2),
    diesel_week_over_week_pct DECIMAL(5,2),
    staff_shortage_pct DECIMAL(5,2),
    casual_worker_pct DECIMAL(5,2),
    spoilage_rate_pct DECIMAL(5,2),
    leakage_rate_pct DECIMAL(5,2),
    harassment_reports_per_100 INTEGER,
    portion_complaint_rate_pct DECIMAL(5,2),
    
    -- Sample sizes
    owner_sample_size INTEGER,
    worker_sample_size INTEGER,
    customer_sample_size INTEGER,
    
    -- Stress classification
    stress_level VARCHAR(20), -- 'critical', 'high', 'moderate', 'low', 'stable'
    
    UNIQUE(city, lga, snapshot_time)
);

-- Hypertable for time-series (best-effort)
SELECT try_create_hypertable('city_pressure_index', 'snapshot_time');

-- 7. DIESEL PRICE TRACKING (Hourly)
CREATE TABLE diesel_price_tracking (
    price_id BIGSERIAL PRIMARY KEY,
    
    city VARCHAR(100),
    lga VARCHAR(100),
    price DECIMAL(10,2) NOT NULL,
    sample_size INTEGER,
    min_price DECIMAL(10,2),
    max_price DECIMAL(10,2),
    
    -- Derived
    week_over_week_pct DECIMAL(5,2),
    month_over_month_pct DECIMAL(5,2),
    
    recorded_at TIMESTAMPTZ DEFAULT NOW()
);

SELECT try_create_hypertable('diesel_price_tracking', 'recorded_at');

-- 8. ALERT HISTORY
CREATE TABLE alert_history (
    alert_id BIGSERIAL PRIMARY KEY,
    
    alert_type VARCHAR(50) NOT NULL, -- 'harassment', 'diesel_spike', 'supplier_failure', 'spoilage_outbreak'
    severity VARCHAR(20), -- 'critical', 'high', 'medium', 'low'
    city VARCHAR(100),
    lga VARCHAR(100),
    
    -- Alert content
    title TEXT,
    message TEXT NOT NULL,
    
    -- Trigger data
    trigger_count INTEGER,
    threshold_value DECIMAL(10,2),
    actual_value DECIMAL(10,2),
    
    -- Delivery
    sms_sent_count INTEGER,
    push_sent_count INTEGER,
    
    created_at TIMESTAMPTZ DEFAULT NOW(),
    expires_at TIMESTAMPTZ DEFAULT NOW() + INTERVAL '24 hours'
);

-- 9. WEEKLY REPORT ARCHIVE
CREATE TABLE weekly_reports (
    report_id BIGSERIAL PRIMARY KEY,
    
    report_week DATE NOT NULL, -- Monday of that week
    report_url VARCHAR(500),
    pdf_path VARCHAR(500),
    
    -- Summary metrics
    national_diesel_avg DECIMAL(10,2),
    national_stress_index DECIMAL(5,2),
    total_diary_entries INTEGER,
    total_worker_reports INTEGER,
    total_customer_feedback INTEGER,
    
    -- Key findings (JSON for flexibility)
    key_findings JSONB,
    recommendations JSONB,
    
    created_at TIMESTAMPTZ DEFAULT NOW(),
    published_at TIMESTAMPTZ,
    download_count INTEGER DEFAULT 0
);

-- =====================================================
-- MATERIALIZED VIEWS (Performance critical)
-- =====================================================

-- 10. Live dashboard snapshot (refreshed every 5 minutes)
CREATE MATERIALIZED VIEW mv_live_dashboard AS
SELECT 
    NOW() as refresh_time,
    
    -- National stats
    (SELECT AVG(avg_diesel_price) FROM city_pressure_index 
     WHERE snapshot_time > NOW() - INTERVAL '1 hour') as national_diesel_avg,
    
    (SELECT COUNT(*) FROM diary_entries 
     WHERE created_at > NOW() - INTERVAL '24 hours') as diary_entries_24h,
    
    (SELECT COUNT(*) FROM worker_reports 
     WHERE created_at > NOW() - INTERVAL '24 hours') as worker_reports_24h,
    
    -- Active users
    (SELECT COUNT(DISTINCT owner_id) FROM diary_entries 
     WHERE created_at > NOW() - INTERVAL '7 days') as active_owners_7d,
    
    -- Crisis mode
    (SELECT COUNT(*) FROM alert_history 
     WHERE created_at > NOW() - INTERVAL '24 hours'
     AND severity IN ('critical', 'high')) as active_alerts;

CREATE UNIQUE INDEX idx_mv_live_dashboard ON mv_live_dashboard(refresh_time);

-- 11. City ranking by pressure
CREATE MATERIALIZED VIEW mv_city_pressure_ranking AS
SELECT 
    city,
    AVG(overall_pressure_score) as avg_pressure,
    AVG(avg_diesel_price) as diesel_price,
    AVG(staff_shortage_pct) as staff_shortage,
    AVG(casual_worker_pct) as casual_rate,
    AVG(portion_complaint_rate_pct) as portion_complaints,
    COUNT(*) as snapshot_count,
    MAX(snapshot_time) as last_update
FROM city_pressure_index
WHERE snapshot_time > NOW() - INTERVAL '7 days'
GROUP BY city
ORDER BY avg_pressure DESC;

-- =====================================================
-- FUNCTIONS & STORED PROCEDURES
-- =====================================================

-- Calculate pressure score (0-100)
CREATE OR REPLACE FUNCTION calculate_pressure_score(
    diesel_price DECIMAL,
    staff_shortage_pct DECIMAL,
    spoilage_rate_pct DECIMAL,
    leakage_rate_pct DECIMAL,
    harassment_rate DECIMAL
) RETURNS DECIMAL AS $$
BEGIN
    -- Weighted algorithm
    -- Diesel: 35% | Staff: 25% | Spoilage: 15% | Leakage: 15% | Harassment: 10%
    RETURN LEAST(100, GREATEST(0,
        (COALESCE(diesel_price / 10, 0) * 0.35) +
        (COALESCE(staff_shortage_pct, 0) * 0.25) +
        (COALESCE(spoilage_rate_pct, 0) * 0.15) +
        (COALESCE(leakage_rate_pct, 0) * 0.15) +
        (COALESCE(harassment_rate, 0) * 0.10)
    ));
END;
$$ LANGUAGE plpgsql;

-- Refresh all materialized views
CREATE OR REPLACE FUNCTION refresh_analytics_views()
RETURNS void AS $$
BEGIN
    REFRESH MATERIALIZED VIEW CONCURRENTLY mv_live_dashboard;
    REFRESH MATERIALIZED VIEW CONCURRENTLY mv_city_pressure_ranking;
END;
$$ LANGUAGE plpgsql;

-- Schedule: Every 5 minutes (optional when pg_cron is available)
DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM pg_available_extensions
        WHERE name = 'pg_cron'
    ) THEN
        CREATE EXTENSION IF NOT EXISTS pg_cron;
        PERFORM cron.schedule(
            'refresh-analytics',
            '*/5 * * * *',
            'SELECT refresh_analytics_views();'
        );
    END IF;
EXCEPTION
    WHEN OTHERS THEN
        RAISE NOTICE 'Skipping pg_cron schedule setup: %', SQLERRM;
END;
$$;

-- =====================================================
-- TRIGGERS (Automated intelligence)
-- =====================================================

-- Auto-generate alerts when thresholds are crossed
CREATE OR REPLACE FUNCTION check_harassment_threshold()
RETURNS TRIGGER AS $$
DECLARE
    recent_count INTEGER;
    alert_message TEXT;
BEGIN
    -- Count harassment reports in same LGA, last hour
    SELECT COUNT(*) INTO recent_count
    FROM diary_entries
    WHERE harassment_reported = TRUE
    AND city = NEW.city
    AND lga = NEW.lga
    AND created_at > NOW() - INTERVAL '1 hour';
    
    -- Threshold: 3+ reports
    IF recent_count >= 3 THEN
        alert_message := format('🔴 CRITICAL: %s harassment reports in %s, %s in last hour',
            recent_count, NEW.lga, NEW.city);
        
        INSERT INTO alert_history (
            alert_type, severity, city, lga, 
            trigger_count, message, created_at
        ) VALUES (
            'harassment', 'critical', NEW.city, NEW.lga,
            recent_count, alert_message, NOW()
        );
    END IF;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_harassment_alert
    AFTER INSERT ON diary_entries
    FOR EACH ROW
    WHEN (NEW.harassment_reported = TRUE)
    EXECUTE FUNCTION check_harassment_threshold();

-- =====================================================
-- AUTH & RBAC FOUNDATION
-- =====================================================

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
);

CREATE TABLE IF NOT EXISTS roles (
    role_id SERIAL PRIMARY KEY,
    role_name VARCHAR(30) UNIQUE NOT NULL
);

INSERT INTO roles (role_name) VALUES
    ('superadmin'),
    ('admin'),
    ('owner'),
    ('worker'),
    ('customer')
ON CONFLICT (role_name) DO NOTHING;

CREATE TABLE IF NOT EXISTS user_roles (
    user_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
    role_id INTEGER REFERENCES roles(role_id) ON DELETE CASCADE,
    assigned_at TIMESTAMPTZ DEFAULT NOW(),
    assigned_by UUID REFERENCES users(user_id),
    PRIMARY KEY (user_id, role_id)
);

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
);

CREATE TABLE IF NOT EXISTS audit_logs (
    log_id BIGSERIAL PRIMARY KEY,
    actor_user_id UUID REFERENCES users(user_id),
    action VARCHAR(80) NOT NULL,
    target_type VARCHAR(80),
    target_id VARCHAR(120),
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

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
);

CREATE TABLE IF NOT EXISTS verification_documents (
    document_id BIGSERIAL PRIMARY KEY,
    verification_id UUID REFERENCES verification_requests(verification_id) ON DELETE CASCADE,
    document_type VARCHAR(80) NOT NULL,
    document_ref TEXT NOT NULL,
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

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
);

CREATE TABLE IF NOT EXISTS restaurant_members (
    restaurant_id UUID REFERENCES restaurants(restaurant_id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
    role VARCHAR(30) DEFAULT 'owner',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (restaurant_id, user_id)
);

CREATE TABLE IF NOT EXISTS qr_campaigns (
    campaign_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    restaurant_id UUID REFERENCES restaurants(restaurant_id) ON DELETE CASCADE,
    campaign_name VARCHAR(120) NOT NULL,
    is_active BOOLEAN DEFAULT TRUE,
    created_by UUID REFERENCES users(user_id),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    expires_at TIMESTAMPTZ
);

-- Auto-update city pressure index (hourly aggregation)
CREATE OR REPLACE FUNCTION update_city_pressure()
RETURNS void AS $$
BEGIN
    INSERT INTO city_pressure_index (
        city, lga, snapshot_time,
        avg_diesel_price, staff_shortage_pct, spoilage_rate_pct,
        leakage_rate_pct, harassment_reports_per_100,
        owner_sample_size, worker_sample_size, customer_sample_size
    )
    SELECT 
        d.city, d.lga, DATE_TRUNC('hour', NOW()),
        AVG(d.diesel_price) FILTER (WHERE d.diesel_price > 0),
        AVG(CASE WHEN d.staff_absent > 0 THEN 100 ELSE 0 END),
        AVG(CASE WHEN d.spoilage_amount > 0 THEN 100 ELSE 0 END),
        AVG(CASE WHEN d.leakage_amount > 0 THEN 100 ELSE 0 END),
        COUNT(*) FILTER (WHERE d.harassment_reported) * 100.0 / COUNT(*),
        COUNT(DISTINCT d.owner_id),
        COUNT(DISTINCT w.report_id),
        COUNT(DISTINCT c.feedback_id)
    FROM diary_entries d
    LEFT JOIN worker_reports w ON w.city = d.city AND w.lga = d.lga 
        AND w.created_at > NOW() - INTERVAL '24 hours'
    LEFT JOIN customer_feedback c ON c.restaurant_city = d.city AND c.restaurant_lga = d.lga
        AND c.created_at > NOW() - INTERVAL '24 hours'
    WHERE d.created_at > NOW() - INTERVAL '24 hours'
    GROUP BY d.city, d.lga;
END;
$$ LANGUAGE plpgsql;
