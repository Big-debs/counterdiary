function registerPublicRoutes(app, deps) {
    const {
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
        smsInboundLimiter,
        validateDiaryPayload,
        validateSmsSubscriptionPayload,
        validateWorkerReportPayload,
        validateCustomerFeedbackPayload,
        validateConfessionPayload,
        validateNewsletterPayload,
        verifyQrToken,
        getCityCoordinates,
        getSeverityFromScore
    } = deps;

    app.post('/api/diary', diaryWriteLimiter, validateDiaryPayload, async (req, res) => {
        try {
            const entry = req.body;

            if (entry.vent_text) {
                const sentiment = sentimentAnalyzer.analyze(entry.vent_text);
                entry.sentiment_score = sentiment.score;
                entry.sentiment_label = sentiment.label;
            }

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

    app.get('/api/dashboard/live', async (req, res) => {
        try {
            const cached = await redis.get('dashboard:live');
            if (cached) {
                return res.json(JSON.parse(cached));
            }

            const result = await pgPool.query(`
                SELECT * FROM mv_live_dashboard
                LIMIT 1
            `);

            const dashboard = result.rows[0];
            await redis.setex('dashboard:live', 300, JSON.stringify(dashboard));

            res.json(dashboard);
        } catch (error) {
            console.error('Dashboard error:', error);
            res.status(500).json({ error: 'Failed to fetch dashboard data' });
        }
    });

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

    app.get('/api/worker/hotspots', async (_req, res) => {
        res.json({ hotspots: [] });
    });

    app.get('/api/customer/complaints', async (_req, res) => {
        res.json({ complaints: [] });
    });

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

    app.get('/api/forecast/diesel/:city', async (req, res) => {
        try {
            const { city } = req.params;
            const { days = 7 } = req.query;
            const forecast = await predictiveEngine.forecastDieselPrice(city, parseInt(days, 10));
            res.json(forecast);
        } catch (error) {
            console.error('Forecast error:', error);
            res.status(500).json({ error: 'Failed to generate forecast' });
        }
    });

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
            } catch (_error) {
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

    app.post('/api/sms/inbound', smsInboundLimiter, async (req, res) => {
        try {
            const { From, Body } = req.body;

            if (Body.toLowerCase().includes('stop') ||
                Body.toLowerCase().includes('unsubscribe')) {
                await pgPool.query(`
                    UPDATE sms_subscriptions
                    SET is_active = FALSE,
                        unsubscribed_at = NOW(),
                        unsubscribe_reason = 'user_sms'
                    WHERE phone_hash = crypt($1, phone_hash)
                `, [From]);

                res.set('Content-Type', 'text/xml');
                return res.send(`
                    <Response>
                        <Message>✅ You have unsubscribed from LEDGER alerts. Reply START to resubscribe.</Message>
                    </Response>
                `);
            }

            if (Body.toLowerCase().includes('help')) {
                res.set('Content-Type', 'text/xml');
                return res.send(`
                    <Response>
                        <Message>🆘 EMERGENCY: Contact NEMA 080-3222-8209 or Police 112. For LEDGER support: support@counterdiary.ng</Message>
                    </Response>
                `);
            }

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
}

module.exports = registerPublicRoutes;
